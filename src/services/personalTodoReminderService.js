// Email reminders for cards on the personal Kanban to-do board.
//
// Unlike the due-date digests in endDateReminderService.js — which run ONCE a
// day at 08:30 off a deadline the system already knows — these are alarms the
// person set themselves, on a card only they can see, at a time of day only
// they chose. So this scheduler ticks every minute and fires on the MINUTE the
// user asked for.
//
// One reminder is a start date + a time. On top of that it may repeat every N
// days, weeks (on chosen weekdays) or months, and the repeat may run until a
// date or forever. There is no end time and no all-day: a reminder is a single
// moment, not a calendar block. A card may carry any number of them.
//
// The one-shot ledger is `last_sent_key`, the occurrence that was last
// DELIVERED written as 'YYYY-MM-DD HH:mm'. An occurrence whose key is already
// stored never fires again, so a restart mid-minute cannot double-send; and
// because the key contains the day and time, editing either one re-arms the
// reminder with no stamp-clearing code (the routes clear the key only when the
// schedule itself actually changed).
//
// Times are SERVER LOCAL time throughout — the board is used from one office
// and the picker in the browser shows the same clock.

const { query } = require("../db/pool");
const { sendMail } = require("./mailService");
const { buildPersonalTodoReminderEmail } = require("./emailTemplates");
const { ymdLocal } = require("./reminderPlan");

// How late an occurrence may be and still be worth an email. A repeating
// reminder is only ever judged on today, but a one-off alarm the server slept
// through for a week is noise: past this it is consumed silently, exactly as
// the daily job writes SKIPPED rows rather than sending a backlog burst.
const CATCH_UP_HOURS = 12;

const UNITS = new Set(["day", "week", "month"]);
const MAX_REPEAT_EVERY = 99;

let running = false;

// ---------------------------------------------------------------------------
// Pure schedule logic (exported for the tests, which never touch a clock)
// ---------------------------------------------------------------------------

/** 'HH:mm' → minutes past midnight, or null if it isn't a time. */
function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(`${value ?? ""}`.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${`${h}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`;
}

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(`${value ?? ""}`.trim());
}

/** ISO weekday of a 'YYYY-MM-DD': 1 = Monday … 7 = Sunday. */
function isoWeekdayOfYmd(ymd) {
  const day = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** '1,3,5' → sorted [1,3,5], ignoring anything that isn't an ISO weekday. */
function parseWeekdays(value) {
  const out = new Set();
  for (const part of `${value ?? ""}`.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 7) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. */
function daysBetweenYmd(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The Monday of the week a 'YYYY-MM-DD' falls in, as 'YYYY-MM-DD'. */
function weekStartYmd(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (isoWeekdayOfYmd(ymd) - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Does `dayYmd` fall on this reminder's schedule?
 *
 * A non-repeating reminder happens on its start date and nowhere else. A
 * repeating one counts intervals from the start date and stops after
 * `until_date` (when there is one).
 */
function fallsOn(reminder, dayYmd) {
  const start = `${reminder.start_date ?? ""}`.trim();
  if (!isYmd(start) || !isYmd(dayYmd)) return false;
  if (dayYmd < start) return false;

  const recurring = reminder.is_recurring === true || reminder.is_recurring === 1;
  if (!recurring) return dayYmd === start;

  const until = `${reminder.until_date ?? ""}`.trim();
  if (isYmd(until) && dayYmd > until) return false;

  const every = Math.max(1, Math.min(MAX_REPEAT_EVERY, Number(reminder.repeat_every) || 1));
  const unit = `${reminder.repeat_unit ?? "week"}`.toLowerCase();

  if (unit === "day") return daysBetweenYmd(start, dayYmd) % every === 0;

  if (unit === "week") {
    // Which days of a repeating week. Empty = the start date's own weekday,
    // which is what "repeat every week" means with nothing ticked.
    const days = parseWeekdays(reminder.weekdays);
    const wanted = days.length ? days : [isoWeekdayOfYmd(start)];
    if (!wanted.includes(isoWeekdayOfYmd(dayYmd))) return false;
    // Counted between WEEKS, not between the two dates: with "every 2 weeks"
    // ticked on Mon+Fri, the Monday before the start date's Friday still
    // belongs to week 0.
    const weeks = daysBetweenYmd(weekStartYmd(start), weekStartYmd(dayYmd)) / 7;
    return Number.isInteger(weeks) && weeks % every === 0;
  }

  if (unit === "month") {
    const [sy, sm, sd] = start.split("-").map(Number);
    const [dy, dm, dd] = dayYmd.split("-").map(Number);
    const months = (dy - sy) * 12 + (dm - sm);
    if (months < 0 || months % every !== 0) return false;
    // A 31st lands on the last day of a shorter month rather than skipping it.
    const lastOfMonth = new Date(Date.UTC(dy, dm, 0)).getUTCDate();
    return dd === Math.min(sd, lastOfMonth);
  }

  return false;
}

/**
 * The occurrence of `reminder` that is due at `now`, or null if none is.
 *
 * Returns `{ key, minutesLate }` — `key` is what goes in last_sent_key, and
 * `minutesLate` is how long ago the moment passed, which is what decides
 * whether it is delivered or quietly consumed.
 */
function dueOccurrence(reminder, now) {
  const at = parseHm(reminder.remind_time);
  if (at === null) return null;
  const todayYmd = ymdLocal(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Today is what a repeat is judged on. A one-off whose day has passed is
  // still considered, so an alarm set for a moment the server was down is
  // either delivered late or consumed — never left armed forever.
  const recurring = reminder.is_recurring === true || reminder.is_recurring === 1;
  const dayYmd = !recurring && `${reminder.start_date ?? ""}`.trim() < todayYmd
    ? `${reminder.start_date ?? ""}`.trim()
    : todayYmd;
  if (!fallsOn(reminder, dayYmd)) return null;

  const minutesLate = daysBetweenYmd(dayYmd, todayYmd) * 24 * 60 + (nowMinutes - at);
  if (minutesLate < 0) return null;

  const key = `${dayYmd} ${formatHm(at)}`;
  if (key === `${reminder.last_sent_key ?? ""}`.trim()) return null;
  return { key, minutesLate };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

// The personal board is deliberately NOT section scoped, but 'mail.enabled' is
// a per-SECTION switch — so a personal reminder is filed against the first
// section this person belongs to that has email switched on. No such section
// means their organisation has not turned email on for them at all: sendMail
// then records the message in the outbox as 'disabled' and delivers nothing,
// which is the same answer every other notification gets.
async function mailSectionFor(userId) {
  const row = (await query(
    `SELECT TOP 1 m.section_id
     FROM user_section_memberships m
     JOIN app_settings s ON s.section_id = m.section_id AND s.setting_key = 'mail.enabled'
     WHERE m.user_id = @userId AND LOWER(LTRIM(RTRIM(s.setting_value))) = 'true'
     ORDER BY m.section_id`,
    { userId }
  )).recordset;
  return row[0]?.section_id ?? null;
}

// Every armed reminder, with the card it belongs to and the person to mail.
// A card whose own master switch is off, a card that has been deleted from the
// board, and an inactive user all drop out here rather than in the loop.
async function loadArmedReminders() {
  return (await query(
    `SELECT r.id, r.user_id, r.item_uid, r.start_date, r.remind_time, r.is_recurring,
            r.repeat_every, r.repeat_unit, r.weekdays, r.until_date, r.last_sent_key,
            i.content, c.title AS column_title, c.color AS column_color,
            u.email, u.display_name
     FROM personal_todo_reminders r
     JOIN personal_todo_items i ON i.user_id = r.user_id AND i.uid = r.item_uid
     JOIN personal_todo_columns c ON c.id = i.column_id
     JOIN users u ON u.id = r.user_id
     WHERE r.enabled = 1 AND i.reminder_enabled = 1 AND u.is_active = 1
     ORDER BY r.user_id, r.id`
  )).recordset;
}

// `sent` false consumes the occurrence without claiming it was delivered — the
// late one-off above.
async function stampOccurrence(id, key, sent) {
  await query(
    `UPDATE personal_todo_reminders
     SET last_sent_key = @key,
         last_sent_at = ${sent ? "SYSUTCDATETIME()" : "last_sent_at"},
         updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    { id, key }
  );
}

/**
 * One pass. Fires every reminder whose moment has come, one digest per person
 * (several cards can share a minute), and stamps the ledger only after a real
 * delivery — a run where email was switched off retries on the next tick.
 *
 * Exported so a test can drive it with any `now` it likes.
 */
async function runPersonalTodoReminders(now = new Date()) {
  const rows = await loadArmedReminders();
  if (!rows.length) return { sent: 0, skipped: 0 };

  // user id -> { email, name, items: [...] }
  const byUser = new Map();
  let skipped = 0;
  for (const row of rows) {
    const due = dueOccurrence(row, now);
    if (!due) continue;
    // Too late to be useful: consume the occurrence so it cannot pile up, but
    // send nothing.
    if (due.minutesLate > CATCH_UP_HOURS * 60) {
      await stampOccurrence(row.id, due.key, false);
      skipped++;
      continue;
    }
    if (!row.email) continue;
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, { id: row.user_id, email: row.email, name: row.display_name, items: [] });
    }
    byUser.get(row.user_id).items.push({ ...row, occurrenceKey: due.key });
  }

  let sent = 0;
  for (const group of byUser.values()) {
    const mail = buildPersonalTodoReminderEmail({ greetingName: group.name, items: group.items });
    if (!mail) continue;
    // One person's reminder must never cost everybody else theirs.
    try {
      const result = await sendMail({
        to: group.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        requestId: null,
        sectionId: await mailSectionFor(group.id),
        type: mail.type
      });
      if (!result.sent) continue; // unstamped — the next tick tries again
      sent++;
      for (const item of group.items) await stampOccurrence(item.id, item.occurrenceKey, true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[personal-todo-reminder] digest to ${group.email} failed: ${err.message}`);
    }
  }
  return { sent, skipped };
}

function startPersonalTodoReminderScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPersonalTodoReminders(new Date());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[personal-todo-reminder] run failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 60 * 1000);
  tick();
}

module.exports = {
  startPersonalTodoReminderScheduler,
  runPersonalTodoReminders,
  mailSectionFor,
  // Pure helpers — shared with the routes' validation and the tests.
  dueOccurrence,
  fallsOn,
  parseHm,
  formatHm,
  parseWeekdays,
  isoWeekdayOfYmd,
  isYmd,
  UNITS,
  MAX_REPEAT_EVERY
};
