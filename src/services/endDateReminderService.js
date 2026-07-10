// Daily end-date reminder emails for assigned incharges.
//
// Every working day at 08:30 (server local time, skipping days found in the
// external holiday DB) this service scans all not-yet-completed requests that
// have a project end date (planned_end) and an assigned incharge, then sends
// each incharge up to three digest emails:
//
//   NEAR    — end date is within the incharge's personal "notify me N working
//             days ahead" setting (users.end_date_notify_days, default 5).
//             Working days exclude dates in the holiday DB.
//   TODAY   — end date is today.
//   OVERDUE — end date has passed. Sent ONCE per request: the send is stamped
//             in requests.overdue_notified_at and never repeated (the stamp is
//             cleared when an approved schedule extension moves the end date).
//
// Each digest bundles every matching request into ONE email per category.
//
// The scheduler is a 1-minute poll rather than a setTimeout-to-08:30 so that a
// server that was down (or deployed) after 08:30 still catches up the same
// day; the "already ran today" marker is persisted in app_settings so restarts
// never double-send.

const { query } = require("../db/pool");
const { getHolidayDates } = require("../db/holidayPool");
const { sendMail } = require("./mailService");
const { buildEndDateDigestEmail } = require("./emailTemplates");

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
            r.overdue_notified_at,
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

// Categorise + group per incharge and send the digests. Exported for manual
// runs/tests; runEndDateReminder() is the guarded daily entry point.
async function sendEndDateReminders(todayYmd, holidaySet) {
  const requests = await loadOpenRequests();
  if (!requests.length) return { sent: 0 };

  // incharge id -> { user, NEAR: [], TODAY: [], OVERDUE: [] }
  const byIncharge = new Map();
  for (const r of requests) {
    const endYmd = ymdOfDbDate(r.planned_end);
    if (!endYmd) continue;
    let category = null;
    let remaining = null;
    if (endYmd === todayYmd) {
      category = "TODAY";
    } else if (endYmd < todayYmd) {
      if (!r.overdue_notified_at) category = "OVERDUE";
    } else {
      const notifyDays = Number.isFinite(Number(r.end_date_notify_days)) && Number(r.end_date_notify_days) >= 0
        ? Number(r.end_date_notify_days)
        : 5;
      remaining = countWorkdays(todayYmd, endYmd, holidaySet);
      if (notifyDays > 0 && remaining <= notifyDays) category = "NEAR";
    }
    if (!category) continue;
    if (!byIncharge.has(r.incharge_id)) {
      byIncharge.set(r.incharge_id, {
        email: r.incharge_email,
        name: r.incharge_name,
        notifyDays: Number(r.end_date_notify_days) || 5,
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
  // eslint-disable-next-line no-console
  console.log(`[end-date-reminder] ran for ${todayYmd}: ${sent} digest email(s) sent`);
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

module.exports = { startEndDateReminderScheduler, runEndDateReminder, sendEndDateReminders };
