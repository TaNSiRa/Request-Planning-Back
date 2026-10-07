// The OT hour rule (src/services/otHours.js); the Flutter dialog mirrors it.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { countOt } = require("../src/services/otHours");

const mins = (start, end, opts) => countOt(start, end, opts).minutes;

describe("OT hours", () => {
  it("counts a working-day OT minute by minute, outside the breaks", () => {
    assert.equal(mins("17:40", "20:40"), 180);
    assert.equal(mins("17:43", "20:41"), 178);
  });

  it("takes off only the part of each break the OT covers, 70 minutes at most", () => {
    assert.equal(mins("10:05", "11:00"), 50); // half of the 10:00 break
    assert.equal(mins("09:55", "15:30"), 335 - 70); // all three breaks
    assert.equal(mins("08:00", "17:00"), 540 - 70);
  });

  it("takes no break off a special OT, but still rounds a holiday start up", () => {
    assert.equal(mins("09:55", "15:30", { special: true }), 335);
    assert.equal(mins("08:31", "13:00", { holiday: true, special: true }), 240); // from 09:00
  });

  it("counts a holiday from the next half hour, to the real end", () => {
    assert.equal(mins("08:30", "11:00", { holiday: true }), 140); // 2.5 h less the 10:00 break
    assert.equal(mins("08:31", "13:00", { holiday: true }), 180); // counted from 09:00
    assert.equal(mins("08:30", "17:10", { holiday: true }), 450); // a full shift: 7 h 30 min
    assert.equal(mins("08:30", "10:59", { holiday: true }), 139);
    assert.equal(mins("08:40", "08:59", { holiday: true }), 0);
  });

  it("runs past midnight when the end is not after the start", () => {
    assert.equal(mins("22:00", "01:30"), 210);
  });
});
