// The per-user due-date reminder SCHEDULE: parsing, defaults, presets and the
// working-day arithmetic shared by the daily reminder job, the Profile API and
// the live preview endpoint.
//
// A plan is `{ before: [5, 2], onDue: true, after: [1, 3, 7] }` — lists of
// WORKING days (holidays excluded). Flattened into signed offsets it becomes
// [-5, -2, 0, 1, 3, 7]: negative = before the end date, 0 = the end date, and
// positive = past it. One offset fires at most one email per deadline, which is
// what makes "warn me once at 5 days left" possible at all.
//
// Everything here is pure except that callers pass in a Set of holiday dates.

// Shipped defaults for someone who has never opened the Profile tab. A project
// period is long, so it earns an early heads-up and a follow-up after it slips;
// a to-do period is short, so it gets one of each.
const DEFAULT_PLANS = {
  project: { before: [5, 2], onDue: true, after: [1, 3, 7] },
  todo: { before: [1], onDue: true, after: [1] }
};

// The Profile page's one-click presets. CUSTOM is whatever the person drew on
// the timeline; OFF silences every reminder for that scope.
const PRESETS = {
  LOW: {
    project: { before: [3], onDue: true, after: [3] },
    todo: { before: [1], onDue: true, after: [1] }
  },
  NORMAL: DEFAULT_PLANS,
  HIGH: {
    project: { before: [7, 6, 5, 4, 3, 2, 1], onDue: true, after: [1, 2, 3, 4, 5, 6, 7, 10, 14] },
    todo: { before: [3, 2, 1], onDue: true, after: [1, 2, 3, 5, 7] }
  },
  OFF: {
    project: { before: [], onDue: false, after: [] },
    todo: { before: [], onDue: false, after: [] }
  }
};

const MAX_OFFSET_DAYS = 60;
const MAX_OFFSETS_PER_SIDE = 20;

// ── date helpers ───────────────────────────────────────────────────────────

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

// Where today sits relative to a deadline, in working days:
//   -5 = five working days still to go, 0 = the end date, +3 = three days past.
// This is the same scale the plan's offsets use, so a reminder is due exactly
// when its offset is <= this number.
function signedWorkdayDistance(todayYmd, dueYmd, holidaySet) {
  if (todayYmd === dueYmd) return 0;
  if (todayYmd < dueYmd) return -countWorkdays(todayYmd, dueYmd, holidaySet);
  return countWorkdays(dueYmd, todayYmd, holidaySet);
}

// The calendar date an offset lands on — used by the Profile preview to answer
// "so when exactly do I get mail?". Walks day by day, skipping holidays.
function dateForOffset(dueYmd, offset, holidaySet) {
  if (offset === 0) return dueYmd;
  const step = offset < 0 ? -1 : 1;
  let remaining = Math.abs(offset);
  let day = dueYmd;
  while (remaining > 0) {
    day = addDaysYmd(day, step);
    if (!holidaySet.has(day)) remaining--;
  }
  return day;
}

// ── plan parsing ───────────────────────────────────────────────────────────

// '5, 2, 5' -> [5, 2]. Rejects junk, zero, negatives and anything past the cap;
// the result is de-duplicated and sorted far-to-near, which is also the order
// the Profile page draws its chips in.
function parseOffsetList(raw) {
  const seen = new Set();
  for (const part of `${raw ?? ""}`.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_OFFSET_DAYS) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => b - a).slice(0, MAX_OFFSETS_PER_SIDE);
}

function formatOffsetList(list) {
  return parseOffsetList((list || []).join(",")).join(",");
}

// A user row's stored columns for one scope. A NULL column means "never
// configured" and falls back to the shipped default; an EMPTY string is a real
// choice meaning "no reminders on that side", so the two must not be conflated.
function planFromUserRow(row, scope) {
  const fallback = DEFAULT_PLANS[scope];
  const beforeRaw = row?.[`${scope}_notify_before`];
  const afterRaw = row?.[`${scope}_notify_after`];
  const onDueRaw = row?.[`${scope}_notify_on_due`];
  return {
    before: beforeRaw === null || beforeRaw === undefined ? fallback.before : parseOffsetList(beforeRaw),
    onDue: onDueRaw === null || onDueRaw === undefined ? fallback.onDue : onDueRaw === true || onDueRaw === 1,
    after: afterRaw === null || afterRaw === undefined ? fallback.after : parseOffsetList(afterRaw)
  };
}

// Flatten a plan into the signed offset scale, nearest-deadline last.
function planOffsets(plan) {
  const offsets = [
    ...(plan.before || []).map(d => -d),
    ...(plan.onDue ? [0] : []),
    ...(plan.after || [])
  ];
  return [...new Set(offsets)].sort((a, b) => a - b);
}

function isPlanSilent(plan) {
  return planOffsets(plan).length === 0;
}

// Which point of the schedule today's run should act on.
//   distance — signed working-day distance from the deadline (see above)
//   done     — Set of offsets already logged for this deadline
// Everything whose moment has arrived and isn't logged is "eligible"; only the
// LAST one is mailed and the earlier ones are consumed silently. That is what
// keeps a server that was down for a week from sending a week of backlog, while
// still letting a send that failed at -5 go out at -4 instead.
function chooseDueOffset(plan, distance, done) {
  const eligible = planOffsets(plan).filter(o => o <= distance && !done.has(o));
  if (!eligible.length) return { send: null, skip: [] };
  return { send: eligible[eligible.length - 1], skip: eligible.slice(0, -1) };
}

// NEAR / TODAY / OVERDUE — the three digest flavours the email templates build.
function categoryForOffset(offset) {
  if (offset < 0) return "NEAR";
  return offset === 0 ? "TODAY" : "OVERDUE";
}

module.exports = {
  DEFAULT_PLANS,
  PRESETS,
  MAX_OFFSET_DAYS,
  MAX_OFFSETS_PER_SIDE,
  ymdLocal,
  ymdOfDbDate,
  addDaysYmd,
  countWorkdays,
  signedWorkdayDistance,
  dateForOffset,
  parseOffsetList,
  formatOffsetList,
  planFromUserRow,
  planOffsets,
  isPlanSilent,
  chooseDueOffset,
  categoryForOffset
};
