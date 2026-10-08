// GET /api/weekly-plan/my-days — the caller's own saved weekly-plan cells over
// a date range (the Personal calendar totals a year's leave from it).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext } = require("./helpers/setup");

const ctx = fixtureContext("MYDAYS");

let app;

before(async () => {
  app = createApp();
  await ctx.createFixture();
});

after(async () => {
  await ctx.cleanupFixture();
  await closePool();
});

describe("weekly plan: my days", () => {
  it("returns only the caller's saved cells, dated, within the range", async () => {
    const me = await ctx.login(app, "member");
    const other = await ctx.login(app, "requester");
    const cell = (s, weekStart, dayIndex, value) =>
      s.put("/api/weekly-plan/cell").send({ weekStart, userId: s.user.id, dayIndex, value });

    // Week of Mon 28 Dec 2026: Wed 30 Dec is in 2026, Fri 1 Jan 2027 is not.
    assert.equal((await cell(me, "2026-12-28", 2, "Annual leave")).status, 200);
    await cell(me, "2026-12-28", 4, "Sick leave");
    // Week of Mon 29 Dec 2025: Thu 1 Jan 2026 starts the year.
    await cell(me, "2025-12-29", 3, "ESIE/Annual leave");
    await cell(other, "2026-03-02", 0, "Annual leave");

    const res = await me.get("/api/weekly-plan/my-days?from=2026-01-01&to=2026-12-31");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.days, { "2026-01-01": "ESIE/Annual leave", "2026-12-30": "Annual leave" });
  });

  it("rejects a malformed range", async () => {
    const me = await ctx.login(app, "member");
    assert.equal((await me.get("/api/weekly-plan/my-days?from=2026&to=2026-12-31")).status, 400);
  });
});
