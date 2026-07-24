// Unit tests for the reminder schedule maths (no database, no email).
//
// This is the layer that decides WHICH point of a person's schedule fires on a
// given day, so it is where the "warn me once at 5 days left, not every day
// from 5 down to 1" rule actually lives.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseOffsetList,
  planFromUserRow,
  planOffsets,
  signedWorkdayDistance,
  dateForOffset,
  chooseDueOffset,
  categoryForOffset,
  DEFAULT_PLANS
} = require("../src/services/reminderPlan");

const NO_HOLIDAYS = new Set();

describe("reminder schedule", () => {
  it("parses a day list, dropping junk and duplicates", () => {
    assert.deepEqual(parseOffsetList("5, 2, 5, 0, -3, abc, 61, 60"), [60, 5, 2]);
    assert.deepEqual(parseOffsetList(""), []);
    assert.deepEqual(parseOffsetList(null), []);
  });

  it("tells a never-configured column from a deliberately empty one", () => {
    const untouched = planFromUserRow({}, "project");
    assert.deepEqual(untouched, DEFAULT_PLANS.project, "null columns fall back to the defaults");

    const silenced = planFromUserRow(
      { project_notify_before: "", project_notify_on_due: false, project_notify_after: "" }, "project");
    assert.deepEqual(planOffsets(silenced), [], "empty strings mean the person switched it off");
  });

  it("flattens a plan onto one signed scale", () => {
    const plan = { before: [5, 2], onDue: true, after: [1, 3, 7] };
    assert.deepEqual(planOffsets(plan), [-5, -2, 0, 1, 3, 7]);
    assert.equal(categoryForOffset(-5), "NEAR");
    assert.equal(categoryForOffset(0), "TODAY");
    assert.equal(categoryForOffset(3), "OVERDUE");
  });

  it("measures distance in working days, skipping holidays", () => {
    assert.equal(signedWorkdayDistance("2026-08-10", "2026-08-15", NO_HOLIDAYS), -5);
    assert.equal(signedWorkdayDistance("2026-08-15", "2026-08-15", NO_HOLIDAYS), 0);
    assert.equal(signedWorkdayDistance("2026-08-18", "2026-08-15", NO_HOLIDAYS), 3);

    // Two company holidays inside the run-up push the same calendar gap closer.
    const holidays = new Set(["2026-08-12", "2026-08-13"]);
    assert.equal(signedWorkdayDistance("2026-08-10", "2026-08-15", holidays), -3);
  });

  it("maps an offset back to the calendar date the preview shows", () => {
    assert.equal(dateForOffset("2026-08-15", -5, NO_HOLIDAYS), "2026-08-10");
    assert.equal(dateForOffset("2026-08-15", 0, NO_HOLIDAYS), "2026-08-15");
    assert.equal(dateForOffset("2026-08-15", 3, NO_HOLIDAYS), "2026-08-18");
    assert.equal(dateForOffset("2026-08-15", -5, new Set(["2026-08-12", "2026-08-13"])), "2026-08-08");
  });

  const plan = { before: [5, 3, 1], onDue: true, after: [1, 3] };

  it("fires one point per day and never repeats it", () => {
    // Five days out: the -5 point is due.
    assert.deepEqual(chooseDueOffset(plan, -5, new Set()), { send: -5, skip: [] });
    // Four days out with -5 already sent: nothing — this is the bug that started
    // all of it, where every remaining day mailed again.
    assert.deepEqual(chooseDueOffset(plan, -4, new Set([-5])), { send: null, skip: [] });
    // Three days out: the next point down the countdown.
    assert.deepEqual(chooseDueOffset(plan, -3, new Set([-5])), { send: -3, skip: [] });
    // The due day and the overdue follow-ups behave the same way.
    assert.deepEqual(chooseDueOffset(plan, 0, new Set([-5, -3, -1])), { send: 0, skip: [] });
    assert.deepEqual(chooseDueOffset(plan, 3, new Set([-5, -3, -1, 0, 1])), { send: 3, skip: [] });
    assert.deepEqual(chooseDueOffset(plan, 9, new Set([-5, -3, -1, 0, 1, 3])), { send: null, skip: [] });
  });

  it("retries a point that was never delivered", () => {
    // -5 failed to send (nothing logged), so at 4 days out it still goes — the
    // "if it couldn't send on day 5, send on 4, 3, 2 or 1 instead" rule.
    assert.deepEqual(chooseDueOffset(plan, -4, new Set()), { send: -5, skip: [] });
  });

  it("collapses a missed stretch into one email", () => {
    // The job was down from -5 to -1: one email goes out for the closest point
    // and the older ones are consumed rather than sent late.
    assert.deepEqual(chooseDueOffset(plan, -1, new Set()), { send: -1, skip: [-5, -3] });
  });

  it("sends nothing when the person switched their schedule off", () => {
    const silent = { before: [], onDue: false, after: [] };
    assert.deepEqual(chooseDueOffset(silent, 12, new Set()), { send: null, skip: [] });
  });
});
