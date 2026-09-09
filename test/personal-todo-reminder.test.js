// Per-card email reminders on the personal Kanban to-do board.
//
// Two halves: the pure schedule arithmetic (no database, no clock — every case
// is a fixed `now`), and the API that stores the reminders alongside a board
// which is still saved replace-all.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const {
  fallsOn,
  dueOccurrence,
  parseHm,
  parseWeekdays,
  runPersonalTodoReminders
} = require("../src/services/personalTodoReminderService");

const ctx = fixtureContext("PTREM");

let app;
let fixture;

before(async () => {
  app = createApp();
  fixture = await ctx.createFixture();
});

after(async () => {
  await ctx.cleanupFixture();
  await closePool();
});

// A local-time Date, so the service's getHours()/getDate() read what we mean.
function at(ymd, hm) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, min] = hm.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe("personal to-do reminder schedule", () => {
  it("parses times and weekday lists, rejecting nonsense", () => {
    assert.equal(parseHm("09:30"), 570);
    assert.equal(parseHm("9:05"), 545);
    assert.equal(parseHm("24:00"), null);
    assert.equal(parseHm("nope"), null);
    assert.deepEqual(parseWeekdays("1,3,5"), [1, 3, 5]);
    assert.deepEqual(parseWeekdays("5,1,1,9,x"), [1, 5]);
    assert.deepEqual(parseWeekdays(null), []);
  });

  it("a one-off happens on its start date and nowhere else", () => {
    const r = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 0 };
    assert.equal(fallsOn(r, "2026-09-10"), true);
    assert.equal(fallsOn(r, "2026-09-11"), false);
    assert.equal(fallsOn(r, "2026-09-09"), false);
  });

  it("repeats every N days from the start date", () => {
    const r = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 1, repeat_every: 3, repeat_unit: "day" };
    assert.equal(fallsOn(r, "2026-09-10"), true);
    assert.equal(fallsOn(r, "2026-09-12"), false);
    assert.equal(fallsOn(r, "2026-09-13"), true);
    assert.equal(fallsOn(r, "2026-09-09"), false); // before the start
  });

  it("repeats on chosen weekdays, counting whole weeks for the interval", () => {
    // Start Thu 2026-09-10, every 2 weeks, on Monday + Friday.
    const r = {
      start_date: "2026-09-10", remind_time: "09:00", is_recurring: 1,
      repeat_every: 2, repeat_unit: "week", weekdays: "1,5"
    };
    // Same week as the start: its Friday counts, its Monday is before the start.
    assert.equal(fallsOn(r, "2026-09-11"), true);  // Fri, week 0
    assert.equal(fallsOn(r, "2026-09-07"), false); // Mon before the start date
    assert.equal(fallsOn(r, "2026-09-14"), false); // Mon, week 1 — skipped
    assert.equal(fallsOn(r, "2026-09-21"), true);  // Mon, week 2
    assert.equal(fallsOn(r, "2026-09-25"), true);  // Fri, week 2
    assert.equal(fallsOn(r, "2026-09-24"), false); // Thu is not ticked
  });

  it("a weekly repeat with no weekdays ticked follows the start date's own day", () => {
    const r = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 1, repeat_every: 1, repeat_unit: "week" };
    assert.equal(fallsOn(r, "2026-09-17"), true);  // the next Thursday
    assert.equal(fallsOn(r, "2026-09-18"), false);
  });

  it("a monthly repeat lands on the last day of a shorter month", () => {
    const r = { start_date: "2026-01-31", remind_time: "09:00", is_recurring: 1, repeat_every: 1, repeat_unit: "month" };
    assert.equal(fallsOn(r, "2026-02-28"), true);
    assert.equal(fallsOn(r, "2026-03-31"), true);
    assert.equal(fallsOn(r, "2026-03-30"), false);
  });

  it("stops after the until date, and never stops without one", () => {
    const base = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 1, repeat_every: 1, repeat_unit: "day" };
    assert.equal(fallsOn({ ...base, until_date: "2026-09-12" }, "2026-09-12"), true);
    assert.equal(fallsOn({ ...base, until_date: "2026-09-12" }, "2026-09-13"), false);
    assert.equal(fallsOn({ ...base, until_date: null }, "2027-09-13"), true);
  });

  it("fires on the minute, once, and not before", () => {
    const r = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 0, last_sent_key: null };
    assert.equal(dueOccurrence(r, at("2026-09-10", "08:59")), null);
    const due = dueOccurrence(r, at("2026-09-10", "09:00"));
    assert.equal(due.key, "2026-09-10 09:00");
    assert.equal(due.minutesLate, 0);
    // Already delivered — the ledger key is what stops a second send.
    assert.equal(dueOccurrence({ ...r, last_sent_key: "2026-09-10 09:00" }, at("2026-09-10", "09:30")), null);
  });

  it("a one-off the server slept through is late, not lost", () => {
    const r = { start_date: "2026-09-10", remind_time: "09:00", is_recurring: 0, last_sent_key: null };
    // Two hours late: still worth delivering.
    assert.equal(dueOccurrence(r, at("2026-09-10", "11:00")).minutesLate, 120);
    // Two days late: the caller consumes this without sending (> CATCH_UP_HOURS).
    assert.ok(dueOccurrence(r, at("2026-09-12", "09:00")).minutesLate > 12 * 60);
  });

  it("a repeat is only ever judged on today", () => {
    const r = {
      start_date: "2026-09-10", remind_time: "09:00", is_recurring: 1,
      repeat_every: 1, repeat_unit: "day", last_sent_key: "2026-09-11 09:00"
    };
    // Yesterday's missed occurrence is gone; today's is armed.
    const due = dueOccurrence(r, at("2026-09-12", "09:05"));
    assert.equal(due.key, "2026-09-12 09:00");
    assert.equal(due.minutesLate, 5);
  });
});

describe("personal to-do reminder API", () => {
  // Every card the reminders hang off is addressed by its client-generated uid,
  // because the board PUT reassigns row ids on every save.
  const UID_A = "card-aaaa-0001";
  const UID_B = "card-bbbb-0002";

  async function seedBoard(session) {
    await session.get("/api/personal-todo");
    return session.put("/api/personal-todo").send({
      columns: [{
        title: "Today",
        color: "#2f6bed",
        items: [
          { content: "Send the monthly report", uid: UID_A },
          { content: "Call the supplier", uid: UID_B }
        ]
      }]
    });
  }

  it("carries the card uid and the card's own reminder switch through a save", async () => {
    const session = await ctx.login(app, "requester");
    const saved = await seedBoard(session);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.remindersAvailable, true);
    const items = saved.body.columns[0].items;
    assert.deepEqual(items.map(i => i.uid), [UID_A, UID_B]);
    // A card nobody has silenced is on.
    assert.deepEqual(items.map(i => i.reminderEnabled), [true, true]);
    assert.deepEqual(items.map(i => i.reminders), [[], []]);

    const silenced = await session.put("/api/personal-todo").send({
      columns: [{
        title: "Today",
        color: "#2f6bed",
        items: [
          { content: "Send the monthly report", uid: UID_A, reminderEnabled: false },
          { content: "Call the supplier", uid: UID_B }
        ]
      }]
    });
    assert.deepEqual(silenced.body.columns[0].items.map(i => i.reminderEnabled), [false, true]);
  });

  it("stores several reminders on one card and returns them with the board", async () => {
    const session = await ctx.login(app, "approver1");
    await seedBoard(session);
    const res = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [
        { startDate: "2026-09-10", time: "9:00" },
        {
          startDate: "2026-09-10", time: "16:30", recurring: true,
          repeatEvery: 2, repeatUnit: "week", weekdays: [5, 1, 1], untilDate: "2026-12-31"
        }
      ]
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.reminders.length, 2);
    // '9:00' is stored as the canonical '09:00' so it is one occurrence key.
    assert.equal(res.body.reminders[0].time, "09:00");
    assert.equal(res.body.reminders[0].recurring, false);
    const weekly = res.body.reminders[1];
    assert.equal(weekly.recurring, true);
    assert.equal(weekly.repeatEvery, 2);
    assert.deepEqual(weekly.weekdays, [1, 5]); // de-duplicated and sorted
    assert.equal(weekly.untilDate, "2026-12-31");

    // They come back with the board, on the right card.
    const board = await session.get("/api/personal-todo");
    const items = board.body.columns[0].items;
    assert.equal(items.find(i => i.uid === UID_A).reminders.length, 2);
    assert.equal(items.find(i => i.uid === UID_B).reminders.length, 0);
  });

  it("drops the repeat fields of a reminder that does not repeat", async () => {
    const session = await ctx.login(app, "approver2");
    await seedBoard(session);
    const res = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{
        startDate: "2026-09-10", time: "09:00", recurring: false,
        repeatEvery: 4, repeatUnit: "month", weekdays: [1, 2], untilDate: "2026-12-31"
      }]
    });
    const r = res.body.reminders[0];
    assert.equal(r.recurring, false);
    assert.deepEqual(r.weekdays, []);
    assert.equal(r.untilDate, null);
  });

  it("re-saving an unchanged schedule keeps its ledger; changing it re-arms", async () => {
    const session = await ctx.login(app, "member");
    await seedBoard(session);
    const created = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ startDate: "2026-09-10", time: "09:00" }]
    });
    const id = created.body.reminders[0].id;
    await query(
      "UPDATE personal_todo_reminders SET last_sent_key='2026-09-10 09:00' WHERE id=@id", { id }
    );

    // Same schedule, sent back with its id: the delivered occurrence stands.
    await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ id, startDate: "2026-09-10", time: "09:00" }]
    });
    let row = (await query(
      "SELECT last_sent_key FROM personal_todo_reminders WHERE id=@id", { id })).recordset[0];
    assert.equal(row.last_sent_key, "2026-09-10 09:00");

    // Moved to another time: the new moment must be able to fire.
    await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ id, startDate: "2026-09-10", time: "17:00" }]
    });
    row = (await query(
      "SELECT last_sent_key FROM personal_todo_reminders WHERE id=@id", { id })).recordset[0];
    assert.equal(row.last_sent_key, null);
  });

  it("deleting the card takes its reminders out of service, and UNDO brings them back with their ledger", async () => {
    const session = await ctx.login(app, "member");
    await seedBoard(session);
    const created = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ startDate: "2026-09-10", time: "09:00" }]
    });
    await session.put(`/api/personal-todo/items/${UID_B}/reminders`).send({
      reminders: [{ startDate: "2026-09-11", time: "10:00" }]
    });
    // It has already rung once today. That fact is the thing an undo must not
    // lose, or the restored card mails the same reminder a second time.
    const id = created.body.reminders[0].id;
    await query(
      "UPDATE personal_todo_reminders SET last_sent_key='2026-09-10 09:00' WHERE id=@id", { id });

    // Save the board without card A.
    const deleted = await session.put("/api/personal-todo").send({
      columns: [{
        title: "Today", color: "#2f6bed",
        items: [{ content: "Call the supplier", uid: UID_B }]
      }]
    });
    const left = deleted.body.columns[0].items;
    assert.equal(left.length, 1);
    assert.equal(left[0].reminders.length, 1, "the other card keeps its own");

    // Orphaned, not deleted — and gone from the board either way.
    const row = (await query(
      "SELECT orphaned_at, last_sent_key FROM personal_todo_reminders WHERE id=@id", { id }
    )).recordset[0];
    assert.ok(row.orphaned_at, "kept, marked as orphaned");
    assert.equal(row.last_sent_key, "2026-09-10 09:00");

    // Undo: the card comes back and adopts its alarms again, ledger intact.
    const undone = await session.put("/api/personal-todo").send({
      columns: [{
        title: "Today", color: "#2f6bed",
        items: [
          { content: "Send the monthly report", uid: UID_A },
          { content: "Call the supplier", uid: UID_B }
        ]
      }]
    });
    const back = undone.body.columns[0].items.find(i => i.uid === UID_A);
    assert.equal(back.reminders.length, 1);
    assert.equal(back.reminders[0].id, id, "the same row, not a new one");
    const after = (await query(
      "SELECT orphaned_at, last_sent_key FROM personal_todo_reminders WHERE id=@id", { id }
    )).recordset[0];
    assert.equal(after.orphaned_at, null);
    assert.equal(after.last_sent_key, "2026-09-10 09:00", "already-sent stays already-sent");
  });

  it("an orphaned reminder rings for nobody, and is swept once the undo is long past", async () => {
    const session = await ctx.login(app, "member");
    await seedBoard(session);
    const created = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ startDate: "2026-09-20", time: "07:00" }]
    });
    const id = created.body.reminders[0].id;
    await session.put("/api/personal-todo").send({
      columns: [{ title: "Today", color: "#2f6bed", items: [{ content: "Call the supplier", uid: UID_B }] }]
    });

    // Its moment arrives while it is orphaned: nothing is sent.
    const userId = fixture.users.member;
    const before = await countOutbox(userId);
    await runPersonalTodoReminders(at("2026-09-20", "07:00"));
    assert.equal(await countOutbox(userId), before);

    // Older than the keep window — the next board save clears it out for good.
    await query(
      "UPDATE personal_todo_reminders SET orphaned_at = DATEADD(day, -30, SYSUTCDATETIME()) WHERE id=@id",
      { id });
    await session.put("/api/personal-todo").send({
      columns: [{ title: "Today", color: "#2f6bed", items: [{ content: "Call the supplier", uid: UID_B }] }]
    });
    const gone = (await query(
      "SELECT COUNT(*) AS n FROM personal_todo_reminders WHERE id=@id", { id })).recordset[0];
    assert.equal(Number(gone.n), 0);
  });

  it("rejects a nonsense uid and keeps one user's reminders off another's board", async () => {
    const session = await ctx.login(app, "requester");
    const bad = await session.put("/api/personal-todo/items/no/reminders").send({ reminders: [] });
    assert.equal(bad.status, 400);

    const other = await ctx.login(app, "approver2");
    const board = await other.get("/api/personal-todo");
    const mine = board.body.columns.flatMap(c => c.items).filter(i => i.reminders.length);
    // approver2 only ever set the one reminder of its own test above.
    for (const item of mine) {
      for (const r of item.reminders) assert.equal(r.recurring, false);
    }
  });

  it("bundles every card ringing in the same minute into ONE email", async () => {
    await enableSectionMail();
    const session = await ctx.login(app, "coapprover");
    await seedBoard(session);
    for (const uid of [UID_A, UID_B]) {
      await session.put(`/api/personal-todo/items/${uid}/reminders`).send({
        reminders: [{ startDate: "2026-09-10", time: "09:00" }]
      });
    }
    const userId = fixture.users.coapprover;
    const before = await countOutbox(userId);

    await runPersonalTodoReminders(at("2026-09-10", "09:00"));
    assert.equal(await countOutbox(userId) - before, 1, "one digest for both cards");
  });

  it("an occurrence already in the ledger never rings again", async () => {
    await enableSectionMail();
    const session = await ctx.login(app, "approver2");
    await seedBoard(session);
    const created = await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ startDate: "2026-09-15", time: "09:00" }]
    });
    await query(
      "UPDATE personal_todo_reminders SET last_sent_key='2026-09-15 09:00' WHERE id=@id",
      { id: created.body.reminders[0].id }
    );
    const userId = fixture.users.approver2;
    const before = await countOutbox(userId);
    await runPersonalTodoReminders(at("2026-09-15", "09:00"));
    assert.equal(await countOutbox(userId), before);
  });

  it("a card whose own switch is off rings for nobody", async () => {
    await enableSectionMail();
    const session = await ctx.login(app, "requester");
    await session.put("/api/personal-todo").send({
      columns: [{
        title: "Today", color: "#2f6bed",
        items: [{ content: "Silenced card", uid: UID_A, reminderEnabled: false }]
      }]
    });
    await session.put(`/api/personal-todo/items/${UID_A}/reminders`).send({
      reminders: [{ startDate: "2026-09-14", time: "08:00" }]
    });
    const userId = fixture.users.requester;
    const before = await countOutbox(userId);
    await runPersonalTodoReminders(at("2026-09-14", "08:00"));
    assert.equal(await countOutbox(userId), before);
  });
});

// The personal board has no section of its own, so a personal reminder is filed
// against the first section of the recipient's that has email switched on.
// Without this the digest is written to the outbox as 'disabled' — which is a
// real behaviour, but not the one these tests are about.
async function enableSectionMail() {
  await query(
    `MERGE app_settings AS target
     USING (SELECT @sectionId AS section_id) AS source
     ON target.section_id = source.section_id AND target.setting_key = 'mail.enabled'
     WHEN MATCHED THEN UPDATE SET setting_value = 'true'
     WHEN NOT MATCHED THEN
       INSERT (section_id, setting_key, setting_value, value_type, is_public, description)
       VALUES (@sectionId, 'mail.enabled', 'true', 'boolean', 0, 'created by npm test');`,
    { sectionId: fixture.sectionId }
  );
}

// The digest is not tied to a request, so it is counted by its mail type and
// the recipient's address rather than through a request id.
async function countOutbox(userId) {
  const row = (await query(
    `SELECT COUNT(*) AS n FROM email_outbox
     WHERE mail_type = 'PERSONAL_TODO_REMINDER'
       AND to_email = (SELECT email FROM users WHERE id = @userId)`,
    { userId }
  )).recordset[0];
  return Number(row.n);
}
