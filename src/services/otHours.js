// How many minutes of an OT entry count. Mirrored by _otCount in
// frontend/lib/pages/personal_calendar_page.dart — keep the two in step.
//
//   · An end at or before the start runs past midnight into the next day.
//   · Holiday (Sat / Sun / company holiday): the start is rounded up to the
//     next :00 / :30, so arriving at 08:31 counts from 09:00; the end is taken
//     as it is. Both types.
//   · NORMAL: the whole window less the breaks it covers (at most 70 min a
//     day). SPECIAL: no break taken off.
const BREAKS = [[600, 610], [720, 770], [900, 910]]; // 10:00-10:10, 12:00-12:50, 15:00-15:10
const MAX_BREAK = 70;

function hmToMinutes(hm) {
  const [h, m] = `${hm}`.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Returns { minutes, start, end, breakMinutes } with start/end the counted
// window in minutes from the start day's midnight (end may pass 1440).
function countOt(startTime, endTime, { holiday = false, special = false } = {}) {
  let start = hmToMinutes(startTime);
  let end = hmToMinutes(endTime);
  if (end <= start) end += 1440;
  if (holiday) start = Math.ceil(start / 30) * 30;
  if (end <= start) return { minutes: 0, start, end, breakMinutes: 0 };
  let breakMinutes = 0;
  if (!special) {
    for (const day of [0, 1440]) {
      for (const [from, to] of BREAKS) {
        breakMinutes += Math.max(0, Math.min(end, to + day) - Math.max(start, from + day));
      }
    }
    breakMinutes = Math.min(breakMinutes, MAX_BREAK);
  }
  return { minutes: end - start - breakMinutes, start, end, breakMinutes };
}

module.exports = { countOt };
