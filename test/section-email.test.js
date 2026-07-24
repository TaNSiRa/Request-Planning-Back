// Integration tests for the per-section email switches:
//   mail.enabled            — whether the system delivers ANY email for a section
//   projectReminder.enabled — daily warning on the request's project end date
//   todoReminder.enabled    — daily warning on each to-do item's own end date
// plus the one-shot near-due / overdue behaviour of the to-do pass.
//
// SMTP is blank in tests (helpers/setup blanks SMTP_HOST), so nothing is ever
// delivered — but sendMail always records the message in email_outbox first,
// and its `status` column tells us which gate it passed:
//   'disabled'       — the section's mail switch is off
//   'pending_config' — the switch is on, SMTP just isn't configured
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const { approveToInProgress, PROJECT_END } = require("./helpers/flows");
const { sendEndDateReminders, sendTodoDueReminders } = require("../src/services/endDateReminderService");

const ctx = fixtureContext("SECMAIL");

// Inside the fixture's project period (2026-08-03 … 2026-08-21) so the to-do
// window check passes. TODAY is the "today" handed to the to-do scan.
const TODAY = "2026-08-10";
const OVERDUE_END = "2026-08-06";
const TODAY_END = "2026-08-10";
const NEAR_END = "2026-08-12"; // 2 working days ahead — inside the default window
const FAR_END = "2026-08-20"; // 10 days ahead — outside it

let app;
let fixture;
let requester;
let approver1;
let approver2;
let incharge; // the "member" user, assigned as incharge and made section admin

const todoPayload = (title, plannedEnd) => ({
  title,
  plannedStart: "2026-08-04",
  plannedEnd
});

async function newRequest() {
  return approveToInProgress({
    requester, approver1, approver2, inchargeUserId: fixture.users.member
  });
}

async function addTodo(requestId, title, plannedEnd) {
  const res = await incharge.post(`/api/requests/${requestId}/todos`).send(todoPayload(title, plannedEnd));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

async function putSetting(key, value, valueType = "bool") {
  const res = await incharge.put(`/api/settings/${key}`).send({ value: `${value}`, valueType, isPublic: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

// The reminder SCHEDULE is a PERSONAL preference edited on Profile › การแจ้งเตือน,
// not a section setting: lists of working days before / on / after the due date.
async function setTodoPlan({ before = "1", onDue = true, after = "1" } = {}) {
  await query(
    `UPDATE users SET todo_notify_before=@before, todo_notify_on_due=@onDue, todo_notify_after=@after
     WHERE id=@userId`,
    { before, onDue, after, userId: fixture.users.member }
  );
}

// Pretend a reminder for this offset already went out, the way a successful
// delivery would. `due` must be the to-do's CURRENT planned_end — the log is
// keyed by due date, which is what makes a moved deadline warn again.
async function stampTodoReminder(todoId, due, offset) {
  await query(
    `INSERT INTO due_reminder_log (target_type, target_id, user_id, due_date, offset_days, status)
     VALUES ('TODO', @todoId, @userId, @due, @offset, 'SENT')`,
    { todoId, userId: fixture.users.member, due, offset }
  );
}

// Outbox rows for this fixture's section. A reminder digest bundles every
// matching item of one incharge across requests and is filed against the first
// of them, so these are scoped by section rather than by request.
async function outbox(mailTypeLike = "%") {
  return (await query(
    `SELECT mail_type, status, body_html FROM email_outbox
     WHERE section_id=@sectionId AND mail_type LIKE @like ORDER BY id`,
    { sectionId: fixture.sectionId, like: mailTypeLike }
  )).recordset;
}

async function clearOutbox() {
  await query("DELETE FROM email_outbox WHERE section_id=@sectionId", { sectionId: fixture.sectionId });
}

// sendEndDateReminders() deliberately scans EVERY section — a section with no
// 'projectReminder.enabled' row defaults to on. Under `node --test` the other
// test files run in parallel against the same database, so an unrestricted scan
// would write outbox rows into their requests and collide with their cleanup
// (FK errors in whichever file loses the race). Before each project-period scan
// we therefore switch every OTHER section off, and `after` puts them back
// exactly as they were — including the real dev sections.
let projectSwitchBackup = null;

async function isolateProjectScanToThisSection() {
  if (projectSwitchBackup === null) {
    projectSwitchBackup = (await query(
      `SELECT section_id, setting_value FROM app_settings
       WHERE setting_key='projectReminder.enabled' AND section_id IS NOT NULL AND section_id<>@sectionId`,
      { sectionId: fixture.sectionId }
    )).recordset;
  }
  await query(
    `MERGE app_settings AS t
     USING (SELECT id FROM request_sections WHERE is_active=1 AND id<>@sectionId) AS src
     ON t.setting_key='projectReminder.enabled' AND t.section_id = src.id
     WHEN MATCHED THEN UPDATE SET setting_value='false'
     WHEN NOT MATCHED BY TARGET THEN
       INSERT (section_id, setting_key, setting_value, value_type, is_public)
       VALUES (src.id, 'projectReminder.enabled', 'false', 'bool', 0);`,
    { sectionId: fixture.sectionId }
  );
}

async function restoreProjectSwitches() {
  if (projectSwitchBackup === null) return;
  // Anything we created or flipped goes away...
  await query(
    "DELETE FROM app_settings WHERE setting_key='projectReminder.enabled' AND section_id IS NOT NULL AND section_id<>@sectionId",
    { sectionId: fixture.sectionId }
  );
  // ...then the rows that genuinely existed come back with their old values.
  for (const row of projectSwitchBackup) {
    await query(
      `INSERT INTO app_settings (section_id, setting_key, setting_value, value_type, is_public)
       VALUES (@sectionId, 'projectReminder.enabled', @value, 'bool', 0)`,
      { sectionId: row.section_id, value: row.setting_value }
    );
  }
  projectSwitchBackup = null;
}

describe("per-section email switches", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    approver2 = await ctx.login(app, "approver2");
    // Section-admin authority needs BOTH the SECTION_ADMIN role and the
    // per-section membership flag (see resolveSection). Granted before login so
    // the session picks the role up.
    await query(
      "UPDATE users SET role_id=(SELECT TOP 1 id FROM roles WHERE code='SECTION_ADMIN') WHERE id=@userId",
      { userId: fixture.users.member }
    );
    await query(
      "UPDATE user_section_memberships SET is_section_admin=1 WHERE user_id=@userId AND section_id=@sectionId",
      { userId: fixture.users.member, sectionId: fixture.sectionId }
    );
    incharge = await ctx.login(app, "member");
  });

  after(async () => {
    await restoreProjectSwitches();
    await ctx.cleanupFixture();
    await closePool();
  });

  it("lists every email switch as a setting of THIS section, with its default", async () => {
    const res = await incharge.get("/api/settings");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byKey = new Map(res.body.data.map(row => [row.setting_key, row]));

    // A brand-new section emails nobody until its admin opts in...
    assert.equal(byKey.get("mail.enabled")?.setting_value, "false");
    // ...but project-period reminders are the original behaviour, so they are on...
    assert.equal(byKey.get("projectReminder.enabled")?.setting_value, "true");
    // ...and the to-do pass is the opt-in extra.
    assert.equal(byKey.get("todoReminder.enabled")?.setting_value, "false");
    // The lead time is personal (Profile), never a section setting.
    assert.equal(byKey.get("todoReminder.notifyDays"), undefined);

    for (const key of ["mail.enabled", "projectReminder.enabled", "todoReminder.enabled"]) {
      assert.equal(byKey.get(key).section_id, fixture.sectionId, `${key} must be scoped to this section`);
    }
  });

  it("mail.enabled gates delivery for this section only", async () => {
    await putSetting("mail.enabled", false);
    await clearOutbox();
    await newRequest(); // approval notifications fire on create/approve
    const whileOff = await outbox();
    assert.ok(whileOff.length > 0, "messages are still recorded while the switch is off");
    assert.deepEqual([...new Set(whileOff.map(row => row.status))], ["disabled"],
      "nothing is delivered while this section's switch is off");

    await putSetting("mail.enabled", true);
    await clearOutbox();
    await newRequest();
    const whileOn = await outbox();
    assert.ok(whileOn.length > 0);
    assert.deepEqual([...new Set(whileOn.map(row => row.status))], ["pending_config"],
      "with the switch on, mail only stops at the (blank) SMTP config");
  });

  it("projectReminder.enabled turns the project-period digest off for this section", async () => {
    const id = await newRequest();
    assert.ok(id);

    await putSetting("projectReminder.enabled", false);
    await isolateProjectScanToThisSection();
    await clearOutbox();
    await sendEndDateReminders(PROJECT_END, new Set());
    assert.deepEqual(await outbox("END_DATE_%"), [], "switched off, the section gets no project digest");

    await putSetting("projectReminder.enabled", true);
    await isolateProjectScanToThisSection();
    await clearOutbox();
    await sendEndDateReminders(PROJECT_END, new Set());
    const digests = await outbox("END_DATE_%");
    assert.equal(digests.length, 1, "switched on, one digest bundles the section's requests");
    assert.equal(digests[0].mail_type, "END_DATE_TODAY", "the fixture period ends on PROJECT_END");
  });

  it("todoReminder.enabled sends nothing while it is off", async () => {
    const id = await newRequest();
    await addTodo(id, "off-switch overdue todo", OVERDUE_END);
    await addTodo(id, "off-switch due today todo", TODAY_END);
    await putSetting("todoReminder.enabled", false);

    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    assert.deepEqual(await outbox("TODO_DUE_%"), []);
  });

  it("switched on, digests each category once and ignores done / far-off to-dos", async () => {
    const id = await newRequest();
    await addTodo(id, "an overdue todo", OVERDUE_END);
    await addTodo(id, "a due today todo", TODAY_END);
    await addTodo(id, "a near due todo", NEAR_END);
    await addTodo(id, "a far off todo", FAR_END);
    const doneId = await addTodo(id, "a finished todo", OVERDUE_END);
    const done = await incharge.patch(`/api/requests/${id}/todos/${doneId}`)
      .send({ ...todoPayload("a finished todo", OVERDUE_END), isDone: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    await putSetting("todoReminder.enabled", true);
    await setTodoPlan({ before: "2" }); // NEAR_END is 2 working days from TODAY
    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());

    const digests = await outbox("TODO_DUE_%");
    // One email per category for the single incharge — every matching to-do of
    // that category is bundled into it, not sent one by one.
    assert.deepEqual(digests.map(row => row.mail_type).sort(),
      ["TODO_DUE_NEAR", "TODO_DUE_OVERDUE", "TODO_DUE_TODAY"]);

    assert.match(digests.find(row => row.mail_type === "TODO_DUE_NEAR").body_html, /a near due todo/);
    const allHtml = digests.map(row => row.body_html).join("");
    assert.doesNotMatch(allHtml, /a far off todo/, "a to-do outside the window is not warned about");
    assert.doesNotMatch(allHtml, /a finished todo/, "a completed to-do is never warned about");
  });

  it("uses each person's own to-do schedule from their Profile", async () => {
    const id = await newRequest();
    await addTodo(id, "a lead time todo", NEAR_END); // 2 working days from TODAY
    await putSetting("todoReminder.enabled", true);

    // The shipped default warns one working day ahead, so a to-do 2 days out is
    // not due a warning yet.
    await setTodoPlan({ before: "1" });
    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    assert.deepEqual(await outbox("TODO_DUE_NEAR"), []);

    // Add a 2-days-ahead point to this one person's schedule and it warns.
    await setTodoPlan({ before: "2,1" });
    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    const near = await outbox("TODO_DUE_NEAR");
    assert.equal(near.length, 1);
    assert.match(near[0].body_html, /a lead time todo/);
  });

  it("fires each point of the schedule once, then moves to the next", async () => {
    const id = await newRequest();
    const todoId = await addTodo(id, "the countdown todo", NEAR_END); // 2 days out
    await putSetting("todoReminder.enabled", true);
    // Warn at 2 AND at 1 day left. The old behaviour mailed on both days because
    // both were "inside the window"; now each point fires on its own day only.
    await setTodoPlan({ before: "2,1" });

    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    const first = await outbox("TODO_DUE_NEAR");
    assert.equal(first.length, 1);
    assert.match(first[0].body_html, /the countdown todo/);

    // Record that delivery, then run the same day again: this to-do is quiet
    // (other near-due to-dos of the section may still fill a digest).
    await stampTodoReminder(todoId, NEAR_END, -2);
    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    assert.deepEqual(
      (await outbox("TODO_DUE_NEAR")).filter(row => /the countdown todo/.test(row.body_html)), [],
      "a point that already went out is never re-sent");

    // A day on, one day is left — the schedule's next point, so it fires.
    await clearOutbox();
    await sendTodoDueReminders("2026-08-11", new Set());
    const second = await outbox("TODO_DUE_NEAR");
    assert.equal(second.length, 1, "the next point down the countdown still fires");
    assert.match(second[0].body_html, /the countdown todo/);
  });

  it("catches up with one email, not a backlog, after a gap", async () => {
    const id = await newRequest();
    const todoId = await addTodo(id, "the catch-up todo", "2026-08-11"); // 1 working day out
    await putSetting("todoReminder.enabled", true);
    // Points at 5, 3 and 1 days left: on TODAY only 1 day is left, so the first
    // two are already in the past — as if the job had been down all week.
    await setTodoPlan({ before: "5,3,1" });

    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    assert.equal((await outbox("TODO_DUE_NEAR")).length, 1,
      "a week of missed points collapses into one email");

    // The missed points are consumed, so they can never fire late.
    const skipped = (await query(
      `SELECT offset_days FROM due_reminder_log
       WHERE target_type='TODO' AND target_id=@todoId AND status='SKIPPED'
       ORDER BY offset_days`,
      { todoId }
    )).recordset;
    assert.deepEqual(skipped.map(row => row.offset_days), [-5, -3]);
  });

  it("warns again about a to-do whose end date was moved", async () => {
    const id = await newRequest();
    const todoId = await addTodo(id, "the moved todo", OVERDUE_END);
    await putSetting("todoReminder.enabled", true);
    await setTodoPlan({ before: "", onDue: false, after: "1" }); // isolate OVERDUE

    // Every overdue point of this deadline has already been delivered.
    await stampTodoReminder(todoId, OVERDUE_END, 1);
    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    assert.deepEqual(
      (await outbox("TODO_DUE_OVERDUE")).filter(row => /the moved todo/.test(row.body_html)), [],
      "an already-warned to-do is never nagged again for the same deadline");

    // Moving the end date is a NEW deadline. Nothing is cleared anywhere — the
    // log is keyed by due date, so the whole schedule is eligible again.
    const moved = await incharge.patch(`/api/requests/${id}/todos/${todoId}`)
      .send(todoPayload("the moved todo", "2026-08-07"));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    await clearOutbox();
    await sendTodoDueReminders(TODAY, new Set());
    const overdue = await outbox("TODO_DUE_OVERDUE");
    assert.equal(overdue.length, 1);
    assert.match(overdue[0].body_html, /the moved todo/);
  });
});
