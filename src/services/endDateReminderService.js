// Daily due-date reminder emails for assigned incharges.
//
// Every working day at 08:30 (server local time, skipping days found in the
// external holiday DB) this service runs two scans:
//
// 1) PROJECT PERIOD (always on) — all not-yet-completed requests that have a
//    project end date (planned_end) and an assigned incharge.
// 2) TO-DO PERIOD (opt-in per section) — every unfinished to-do item of those
//    requests, judged on the to-do's OWN planned_end. Only sections whose
//    'todoReminder.enabled' setting is on take part, so switching it on for
//    one section never affects another.
//
// WHEN a person is warned is their own schedule, edited on Profile ›
// การแจ้งเตือน and stored per scope as lists of working days (see
// reminderPlan.js): before the end date, on it, and after it. Flattened they
// are signed offsets — -5, -2, 0, +1, +3, +7 — and each offset fires AT MOST
// ONCE per deadline. That is the whole point of the design: "warn me when 5
// days are left" no longer means "warn me on days 5, 4, 3, 2 and 1".
//
// Each fired offset produces one of three digest flavours: NEAR (offset < 0),
// TODAY (0) and OVERDUE (> 0), bundling every matching item of that incharge
// into a single email.
//
// The one-shot behaviour lives in due_reminder_log, keyed by
// (target, user, DUE DATE, offset):
//   * a row is written only after a real delivery, so a run where mail was off
//     or SMTP failed still warns on one of the remaining offsets;
//   * offsets whose moment passed while the job was down are consumed as
//     'SKIPPED' so a catch-up sends one email instead of a backlog burst;
//   * because the DUE DATE is part of the key, moving a deadline (approved
//     extension, edited to-do) re-arms the whole schedule with no stamp-clearing
//     code anywhere else in the app.
//
// The scheduler is a 1-minute poll rather than a setTimeout-to-08:30 so that a
// server that was down (or deployed) after 08:30 still catches up the same
// day; the "already ran today" marker is persisted in app_settings so restarts
// never double-send.

const { query } = require("../db/pool");
const { getHolidayDates } = require("../db/holidayPool");
const { sendMail } = require("./mailService");
const { buildEndDateDigestEmail, buildTodoDueDigestEmail } = require("./emailTemplates");
const { getReminderSections, reminderConfigFor } = require("./settingsService");
const {
  ymdLocal,
  ymdOfDbDate,
  addDaysYmd,
  signedWorkdayDistance,
  planFromUserRow,
  chooseDueOffset,
  categoryForOffset
} = require("./reminderPlan");

const RUN_HOUR = 8;
const RUN_MINUTE = 30;
const LAST_RUN_KEY = "endDateReminder.lastRunDate";

// Requests still "not complete" for reminder purposes. PENDING_APPROVAL has no
// incharge/planned_end yet; COMPLETED/CANCELLED/REJECTED are finished.
const OPEN_STATUSES = ["IN_PROGRESS", "ON_HOLD", "WAITING_CLOSE"];

let running = false;

async function getLastRunDate() {
  const row = (await query(
    "SELECT setting_value FROM app_settings WHERE section_id IS NULL AND setting_key=@key",
    { key: LAST_RUN_KEY }
  )).recordset[0];
  return row ? `${row.setting_value || ""}`.trim() : null;
}

async function setLastRunDate(ymd) {
  await query(
    `MERGE app_settings AS target
     USING (SELECT @key AS setting_key) AS source
     ON target.setting_key = source.setting_key AND target.section_id IS NULL
     WHEN MATCHED THEN UPDATE SET setting_value=@value, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (section_id, setting_key, setting_value, value_type, is_public, description)
       VALUES (NULL, @key, @value, 'string', 0, 'Last date the end-date reminder job ran (YYYY-MM-DD)');`,
    { key: LAST_RUN_KEY, value: ymd }
  );
}

// Every offset already dealt with for one deadline, sent or skipped.
async function loadReminderLog(targetType, targetIds) {
  const done = new Map(); // `${targetId}|${dueYmd}` -> Set(offset)
  const ids = targetIds.map(id => Number(id)).filter(Number.isFinite);
  if (!ids.length) return done;
  const rows = (await query(
    `SELECT target_id, user_id, due_date, offset_days FROM due_reminder_log
     WHERE target_type=@targetType AND target_id IN (${ids.join(",")})`,
    { targetType }
  )).recordset;
  for (const row of rows) {
    const key = `${row.target_id}|${row.user_id}|${ymdOfDbDate(row.due_date)}`;
    if (!done.has(key)) done.set(key, new Set());
    done.get(key).add(Number(row.offset_days));
  }
  return done;
}

async function writeReminderLog(targetType, targetId, userId, dueYmd, offsets, status) {
  for (const offset of offsets) {
    // The unique index is the real guard: two runs racing (or a manual run
    // beside the daily one) must not double-send, so a duplicate is a no-op.
    await query(
      `IF NOT EXISTS (SELECT 1 FROM due_reminder_log
                       WHERE target_type=@targetType AND target_id=@targetId AND user_id=@userId
                         AND due_date=@dueDate AND offset_days=@offset)
         INSERT INTO due_reminder_log (target_type, target_id, user_id, due_date, offset_days, status)
         VALUES (@targetType, @targetId, @userId, @dueDate, @offset, @status);`,
      { targetType, targetId, userId, dueDate: dueYmd, offset, status }
    );
  }
}

// Fields every plan owner needs: the six schedule columns plus the on-hold
// switch. Aliased to the names planFromUserRow() expects.
const PLAN_COLUMNS = `inc.project_notify_before, inc.project_notify_on_due, inc.project_notify_after,
            inc.todo_notify_before, inc.todo_notify_on_due, inc.todo_notify_after,
            inc.reminder_pause_on_hold`;

async function loadOpenRequests() {
  const statusList = OPEN_STATUSES.map(s => `'${s}'`).join(",");
  return (await query(
    `SELECT r.id, r.request_no, r.title, r.priority, r.status, r.planned_end, r.section_id,
            u.display_name AS requester_name,
            inc.id AS incharge_id, inc.email AS incharge_email,
            inc.display_name AS incharge_name,
            ${PLAN_COLUMNS},
            s.name AS section_name, s.code AS section_code,
            todo.todo_total, todo.todo_done
     FROM requests r
     JOIN users u ON u.id = r.requester_user_id
     JOIN users inc ON inc.id = r.incharge_user_id
     JOIN request_sections s ON s.id = r.section_id
     OUTER APPLY (
       SELECT COUNT(1) AS todo_total,
              COALESCE(SUM(CASE WHEN t.is_done = 1 THEN 1 ELSE 0 END), 0) AS todo_done
       FROM request_todos t WHERE t.request_id = r.id
     ) todo
     WHERE r.status IN (${statusList})
       AND r.planned_end IS NOT NULL
       AND inc.is_active = 1`
  )).recordset;
}

// A request/to-do the incharge asked to be left alone about: paused work keeps
// its deadline but stops nagging until someone resumes it.
function pausedOnHold(row) {
  const paused = row.reminder_pause_on_hold;
  return row.status === "ON_HOLD" && (paused === null || paused === undefined || paused === true || paused === 1);
}

// Group one scope's due items per incharge, decide which offset fires today and
// send the digests. `items` rows must carry: an id, the incharge fields, a
// planned_end and (for requests) a status.
//
// Exported for manual runs/tests; runEndDateReminder() is the guarded daily
// entry point.
async function dispatchReminders({ targetType, scope, rows, idOf, todayYmd, holidaySet, buildEmail, requestIdOf }) {
  if (!rows.length) return { sent: 0 };
  const log = await loadReminderLog(targetType, rows.map(idOf));

  // incharge id -> { email, name, NEAR: [], TODAY: [], OVERDUE: [] }
  const byIncharge = new Map();
  for (const row of rows) {
    const dueYmd = ymdOfDbDate(row.planned_end);
    if (!dueYmd) continue;
    if (pausedOnHold(row)) continue;
    const plan = planFromUserRow(row, scope);
    const distance = signedWorkdayDistance(todayYmd, dueYmd, holidaySet);
    const done = log.get(`${idOf(row)}|${row.incharge_id}|${dueYmd}`) || new Set();
    const { send, skip } = chooseDueOffset(plan, distance, done);
    // Offsets whose day has already gone by are consumed without an email, so a
    // week of downtime produces one reminder rather than seven.
    if (skip.length) await writeReminderLog(targetType, idOf(row), row.incharge_id, dueYmd, skip, "SKIPPED");
    if (send === null) continue;
    const category = categoryForOffset(send);
    if (!byIncharge.has(row.incharge_id)) {
      byIncharge.set(row.incharge_id, {
        id: row.incharge_id,
        email: row.incharge_email,
        name: row.incharge_name,
        NEAR: [], TODAY: [], OVERDUE: []
      });
    }
    byIncharge.get(row.incharge_id)[category].push({
      ...row,
      due_ymd: dueYmd,
      offset_days: send,
      // What the email prints next to each item: days left for NEAR, days late
      // for OVERDUE.
      remaining_workdays: send < 0 ? -send : 0,
      overdue_workdays: send > 0 ? send : 0
    });
  }

  let sent = 0;
  for (const group of byIncharge.values()) {
    if (!group.email) continue;
    for (const category of ["NEAR", "TODAY", "OVERDUE"]) {
      const items = group[category];
      if (!items.length) continue;
      // The lead time quoted in the intro is the nearest item's own countdown,
      // not a stored setting — a digest can bundle several different offsets.
      const notifyDays = Math.max(...items.map(i => i.remaining_workdays || i.overdue_workdays || 0));
      const mail = buildEmail(category, { greetingName: group.name, notifyDays, items });
      if (!mail) continue;
      // One recipient's digest must never take down the rest of the run — a
      // request deleted mid-scan, a bad address, an outbox write that fails:
      // log it and carry on to the next incharge.
      try {
        const result = await sendMail({
          to: group.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          // A digest spans several items — record the outbox row against the
          // first one so the mail is still traceable from a request.
          requestId: requestIdOf(items[0]),
          sectionId: null,
          type: mail.type
        });
        if (!result.sent) continue;
        sent++;
        // Stamped only after a real delivery, so a failed or disabled send
        // retries on the next offset of the same schedule.
        for (const item of items) {
          await writeReminderLog(
            targetType, idOf(item), group.id, item.due_ymd, [item.offset_days], "SENT");
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[${targetType.toLowerCase()}-reminder] ${category} digest to ${group.email} failed: ${err.message}`);
      }
    }
  }
  return { sent };
}

async function sendEndDateReminders(todayYmd, holidaySet) {
  const requests = await loadOpenRequests();
  if (!requests.length) return { sent: 0 };
  // Each section decides whether it wants project-period reminders at all.
  // Defaults ON, so a section that never touched Settings keeps the behaviour
  // it has always had.
  const configs = await getReminderSections();
  const rows = requests.filter(r => reminderConfigFor(configs, r.section_id).project);
  return dispatchReminders({
    targetType: "REQUEST",
    scope: "project",
    rows,
    idOf: row => row.id,
    requestIdOf: row => row.id,
    todayYmd,
    holidaySet,
    buildEmail: buildEndDateDigestEmail
  });
}

// Unfinished to-do items of open requests, restricted to the sections that
// switched the to-do reminder on. `sectionIds` is never empty here.
async function loadOpenTodos(sectionIds) {
  const statusList = OPEN_STATUSES.map(s => `'${s}'`).join(",");
  // Ids come from our own settings table (integers), so inlining them is safe
  // and keeps this to a single round trip.
  const sectionList = sectionIds.map(id => Number(id)).filter(Number.isFinite).join(",");
  return (await query(
    `SELECT t.id AS todo_id, t.title AS todo_title, t.planned_end,
            r.id AS request_id, r.request_no, r.title AS request_title, r.priority,
            r.section_id, r.status,
            inc.id AS incharge_id, inc.email AS incharge_email, inc.display_name AS incharge_name,
            ${PLAN_COLUMNS},
            s.name AS section_name, s.code AS section_code
     FROM request_todos t
     JOIN requests r ON r.id = t.request_id
     JOIN users inc ON inc.id = r.incharge_user_id
     JOIN request_sections s ON s.id = r.section_id
     WHERE t.is_done = 0
       AND t.planned_end IS NOT NULL
       AND r.status IN (${statusList})
       AND r.section_id IN (${sectionList})
       AND inc.is_active = 1
     ORDER BY t.planned_end, t.id`
  )).recordset;
}

// Second scan: warn on each to-do item's own period. Opt-in per section via the
// 'todoReminder.enabled' setting, so a section that leaves it off keeps getting
// project-period reminders only. Exported for manual runs/tests.
async function sendTodoDueReminders(todayYmd, holidaySet) {
  const configs = await getReminderSections();
  const enabled = [...configs.entries()].filter(([, cfg]) => cfg.todo);
  if (!enabled.length) return { sent: 0 };

  const todos = await loadOpenTodos(enabled.map(([sectionId]) => sectionId));
  return dispatchReminders({
    targetType: "TODO",
    scope: "todo",
    rows: todos,
    idOf: row => row.todo_id,
    requestIdOf: row => row.request_id,
    todayYmd,
    holidaySet,
    buildEmail: buildTodoDueDigestEmail
  });
}

async function runEndDateReminder(now = new Date()) {
  const todayYmd = ymdLocal(now);
  const lastRun = await getLastRunDate();
  if (lastRun === todayYmd) return;

  // Look far enough back/forward for both the "is today a holiday?" check and
  // the working-day countdown of every near-due request.
  const { dates } = await getHolidayDates(addDaysYmd(todayYmd, -90), addDaysYmd(todayYmd, 90));
  const holidaySet = new Set(dates);

  await setLastRunDate(todayYmd); // stamp first so a crash mid-send can't double-send
  if (holidaySet.has(todayYmd)) {
    // eslint-disable-next-line no-console
    console.log(`[end-date-reminder] ${todayYmd} is a holiday — no reminders today`);
    return;
  }
  const { sent } = await sendEndDateReminders(todayYmd, holidaySet);
  // The to-do scan is opt-in per section and must never take the project-period
  // scan down with it (e.g. before database/patch_todo_due_reminder.sql is run).
  let todoSent = 0;
  try {
    ({ sent: todoSent } = await sendTodoDueReminders(todayYmd, holidaySet));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[end-date-reminder] to-do scan failed: ${err.message}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[end-date-reminder] ran for ${todayYmd}: ${sent} project digest(s), ${todoSent} to-do digest(s) sent`);
}

function startEndDateReminderScheduler() {
  const tick = async () => {
    if (running) return;
    const now = new Date();
    if (now.getHours() < RUN_HOUR || (now.getHours() === RUN_HOUR && now.getMinutes() < RUN_MINUTE)) return;
    running = true;
    try {
      await runEndDateReminder(now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[end-date-reminder] run failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 60 * 1000);
  tick();
}

module.exports = {
  startEndDateReminderScheduler,
  runEndDateReminder,
  sendEndDateReminders,
  sendTodoDueReminders
};
