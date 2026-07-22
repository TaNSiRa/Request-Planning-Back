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
// Each scan sends the responsible incharge up to three digest emails:
//
//   NEAR    — end date is within the "notify me N working days ahead" window
//             (requests: the incharge's users.end_date_notify_days, default 5;
//             to-dos: the section's todoReminder.notifyDays, default 2).
//             Working days exclude dates in the holiday DB.
//   TODAY   — end date is today.
//   OVERDUE — end date has passed. Sent ONCE: the send is stamped in
//             requests.overdue_notified_at / request_todos.overdue_notified_at
//             and never repeated (the request stamp is cleared when an approved
//             schedule extension moves the end date, the to-do stamp when the
//             to-do's planned_end is edited).
//
// Each digest bundles every matching item into ONE email per category.
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

const RUN_HOUR = 8;
const RUN_MINUTE = 30;
const LAST_RUN_KEY = "endDateReminder.lastRunDate";

// Requests still "not complete" for reminder purposes. PENDING_APPROVAL has no
// incharge/planned_end yet; COMPLETED/CANCELLED/REJECTED are finished.
const OPEN_STATUSES = ["IN_PROGRESS", "ON_HOLD", "WAITING_CLOSE"];

let running = false;

function ymdLocal(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// planned_end comes back from mssql as a JS Date at UTC midnight — read it in
// UTC so the server timezone can't shift it a day.
function ymdOfDbDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Working days strictly after `fromYmd` up to and including `toYmd`, skipping
// holiday dates. With no holiday DB configured this is plain calendar days.
function countWorkdays(fromYmd, toYmd, holidaySet) {
  let count = 0;
  let day = fromYmd;
  while (day < toYmd) {
    day = addDaysYmd(day, 1);
    if (!holidaySet.has(day)) count++;
  }
  return count;
}

// A personal "warn me N working days ahead" value from the users table. Falls
// back to `fallback` when the column is missing (pre-patch) or holds nonsense;
// 0 is a real value meaning "no early warning", so it must survive.
function normalizeNotifyDays(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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

async function loadOpenRequests() {
  const statusList = OPEN_STATUSES.map(s => `'${s}'`).join(",");
  return (await query(
    `SELECT r.id, r.request_no, r.title, r.priority, r.status, r.planned_end,
            r.overdue_notified_at, r.section_id,
            u.display_name AS requester_name,
            inc.id AS incharge_id, inc.email AS incharge_email,
            inc.display_name AS incharge_name, inc.end_date_notify_days,
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

// Which bucket an end date falls in, shared by both scans.
//   endYmd          — the item's end date (YYYY-MM-DD)
//   notifyDays      — how many working days ahead to warn (0 disables NEAR)
//   overdueNotified — truthy when the one-shot overdue mail already went out
// Returns { category: NEAR|TODAY|OVERDUE|null, remaining } — `remaining` is the
// working-day countdown, set for NEAR only.
function categorise(endYmd, todayYmd, holidaySet, notifyDays, overdueNotified) {
  if (endYmd === todayYmd) return { category: "TODAY", remaining: null };
  if (endYmd < todayYmd) {
    return { category: overdueNotified ? null : "OVERDUE", remaining: null };
  }
  const remaining = countWorkdays(todayYmd, endYmd, holidaySet);
  return { category: notifyDays > 0 && remaining <= notifyDays ? "NEAR" : null, remaining };
}

// Categorise + group per incharge and send the digests. Exported for manual
// runs/tests; runEndDateReminder() is the guarded daily entry point.
async function sendEndDateReminders(todayYmd, holidaySet) {
  const requests = await loadOpenRequests();
  if (!requests.length) return { sent: 0 };
  // Each section decides whether it wants project-period reminders at all.
  // Defaults ON, so a section that never touched Settings keeps the behaviour
  // it has always had.
  const configs = await getReminderSections();

  // incharge id -> { user, NEAR: [], TODAY: [], OVERDUE: [] }
  const byIncharge = new Map();
  for (const r of requests) {
    if (!reminderConfigFor(configs, r.section_id).project) continue;
    const endYmd = ymdOfDbDate(r.planned_end);
    if (!endYmd) continue;
    const notifyDays = normalizeNotifyDays(r.end_date_notify_days, 5);
    const { category, remaining } = categorise(
      endYmd, todayYmd, holidaySet, notifyDays, r.overdue_notified_at);
    if (!category) continue;
    if (!byIncharge.has(r.incharge_id)) {
      byIncharge.set(r.incharge_id, {
        email: r.incharge_email,
        name: r.incharge_name,
        notifyDays,
        NEAR: [], TODAY: [], OVERDUE: []
      });
    }
    byIncharge.get(r.incharge_id)[category].push({ ...r, remaining_workdays: remaining });
  }

  let sent = 0;
  for (const group of byIncharge.values()) {
    if (!group.email) continue;
    for (const category of ["NEAR", "TODAY", "OVERDUE"]) {
      const items = group[category];
      if (!items.length) continue;
      const mail = buildEndDateDigestEmail(category, {
        greetingName: group.name,
        notifyDays: group.notifyDays,
        items
      });
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
          // A digest spans several requests — record the outbox row against the
          // first one so the mail is still traceable from a request.
          requestId: items[0].id,
          sectionId: null,
          type: mail.type
        });
        if (result.sent) sent++;
        // Overdue is a one-shot: stamp only after a real delivery so a failed or
        // disabled send retries on the next daily run.
        if (category === "OVERDUE" && result.sent) {
          for (const item of items) {
            await query(
              "UPDATE requests SET overdue_notified_at=SYSUTCDATETIME() WHERE id=@id AND overdue_notified_at IS NULL",
              { id: item.id }
            );
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[end-date-reminder] ${category} digest to ${group.email} failed: ${err.message}`);
      }
    }
  }
  return { sent };
}

// Unfinished to-do items of open requests, restricted to the sections that
// switched the to-do reminder on. `sectionIds` is never empty here.
async function loadOpenTodos(sectionIds) {
  const statusList = OPEN_STATUSES.map(s => `'${s}'`).join(",");
  // Ids come from our own settings table (integers), so inlining them is safe
  // and keeps this to a single round trip.
  const sectionList = sectionIds.map(id => Number(id)).filter(Number.isFinite).join(",");
  return (await query(
    `SELECT t.id AS todo_id, t.title AS todo_title, t.planned_end, t.overdue_notified_at,
            r.id AS request_id, r.request_no, r.title AS request_title, r.priority, r.section_id,
            inc.id AS incharge_id, inc.email AS incharge_email, inc.display_name AS incharge_name,
            inc.todo_notify_days,
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
  if (!todos.length) return { sent: 0 };

  // incharge id -> { email, name, notifyDays, NEAR: [], TODAY: [], OVERDUE: [] }
  const byIncharge = new Map();
  for (const t of todos) {
    const endYmd = ymdOfDbDate(t.planned_end);
    if (!endYmd) continue;
    // How far ahead to warn is the incharge's OWN preference (Profile), exactly
    // like end_date_notify_days for the project period — the section only owns
    // the on/off switch. Default 1: a to-do period is short.
    const notifyDays = normalizeNotifyDays(t.todo_notify_days, 1);
    const { category, remaining } = categorise(
      endYmd, todayYmd, holidaySet, notifyDays, t.overdue_notified_at);
    if (!category) continue;
    if (!byIncharge.has(t.incharge_id)) {
      byIncharge.set(t.incharge_id, {
        email: t.incharge_email,
        name: t.incharge_name,
        notifyDays,
        NEAR: [], TODAY: [], OVERDUE: []
      });
    }
    byIncharge.get(t.incharge_id)[category].push({ ...t, remaining_workdays: remaining });
  }

  let sent = 0;
  for (const group of byIncharge.values()) {
    if (!group.email) continue;
    for (const category of ["NEAR", "TODAY", "OVERDUE"]) {
      const items = group[category];
      if (!items.length) continue;
      const mail = buildTodoDueDigestEmail(category, {
        greetingName: group.name,
        notifyDays: group.notifyDays,
        items
      });
      if (!mail) continue;
      // Same isolation as the project-period scan: one failed digest must not
      // cost every other incharge their reminders.
      try {
        const result = await sendMail({
          to: group.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          // A digest spans several to-dos — record the outbox row against the
          // first one's request so the mail is still traceable.
          requestId: items[0].request_id,
          sectionId: null,
          type: mail.type
        });
        if (result.sent) sent++;
        // One-shot, same as the request-level overdue mail: stamp only after a
        // real delivery so a failed send retries on the next daily run.
        if (category === "OVERDUE" && result.sent) {
          for (const item of items) {
            await query(
              "UPDATE request_todos SET overdue_notified_at=SYSUTCDATETIME() WHERE id=@id AND overdue_notified_at IS NULL",
              { id: item.todo_id }
            );
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[todo-due-reminder] ${category} digest to ${group.email} failed: ${err.message}`);
      }
    }
  }
  return { sent };
}

async function runEndDateReminder(now = new Date()) {
  const todayYmd = ymdLocal(now);
  const lastRun = await getLastRunDate();
  if (lastRun === todayYmd) return;

  // Look far enough back/forward for both the "is today a holiday?" check and
  // the working-day countdown of every near-due request.
  const { dates } = await getHolidayDates(addDaysYmd(todayYmd, -1), addDaysYmd(todayYmd, 90));
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
