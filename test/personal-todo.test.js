// Integration tests for the personal Kanban to-do board (/api/personal-todo).
// The board is per-user and NOT section-scoped: it seeds three default columns
// on first read, saves replace-all, and stays isolated between users.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");

const ctx = fixtureContext("PTODO");

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

describe("personal to-do board", () => {
  it("seeds Wait / In Process / Done on first read", async () => {
    const session = await ctx.login(app, "requester");
    const res = await session.get("/api/personal-todo");
    assert.equal(res.status, 200);
    const titles = res.body.columns.map(c => c.title);
    assert.deepEqual(titles, ["Wait", "In Process", "Done"]);
    // Every column starts empty and carries an id + colour.
    for (const col of res.body.columns) {
      assert.ok(Number.isInteger(col.id));
      assert.equal(col.items.length, 0);
      assert.match(col.color, /^#/);
    }
  });

  it("does not re-seed once columns exist (even if all are deleted)", async () => {
    const session = await ctx.login(app, "approver1");
    await session.get("/api/personal-todo"); // seed
    // Save an empty board — an explicit "no columns" must be honoured.
    const cleared = await session.put("/api/personal-todo").send({ columns: [] });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.columns.length, 0);
    const reread = await session.get("/api/personal-todo");
    assert.equal(reread.body.columns.length, 0);
  });

  it("saves columns and cards in order, dropping blank cards", async () => {
    const session = await ctx.login(app, "member");
    await session.get("/api/personal-todo");
    const res = await session.put("/api/personal-todo").send({
      columns: [
        { title: "Backlog", color: "#2f6bed", items: [{ content: "Task A" }, { content: "  " }, { content: "Task B" }] },
        { title: "Done", color: "#23a35a", items: [{ content: "Shipped" }] }
      ]
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.columns.map(c => c.title), ["Backlog", "Done"]);
    // Blank card dropped; order preserved.
    assert.deepEqual(res.body.columns[0].items.map(i => i.content), ["Task A", "Task B"]);
    assert.deepEqual(res.body.columns[1].items.map(i => i.content), ["Shipped"]);

    // Re-reading returns the same board.
    const reread = await session.get("/api/personal-todo");
    assert.deepEqual(reread.body.columns.map(c => c.title), ["Backlog", "Done"]);
    assert.deepEqual(reread.body.columns[0].items.map(i => i.content), ["Task A", "Task B"]);
  });

  it("moving a card between columns persists (replace-all)", async () => {
    const session = await ctx.login(app, "member");
    // member already has Backlog/Done from the previous test. Move "Task A" to Done.
    const res = await session.put("/api/personal-todo").send({
      columns: [
        { title: "Backlog", color: "#2f6bed", items: [{ content: "Task B" }] },
        { title: "Done", color: "#23a35a", items: [{ content: "Shipped" }, { content: "Task A" }] }
      ]
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.columns[0].items.map(i => i.content), ["Task B"]);
    assert.deepEqual(res.body.columns[1].items.map(i => i.content), ["Shipped", "Task A"]);
  });

  it("remembers column widths, the board default, and the left-to-right order", async () => {
    const session = await ctx.login(app, "requester");
    const saved = await session.put("/api/personal-todo").send({
      defaultWidth: 340,
      columns: [
        { title: "Wide", color: "#2f6bed", width: 420, items: [] },
        // No width → follows the board default.
        { title: "Default", color: "#23a35a", items: [] },
        // Out of range → clamped into the allowed band, never rejected.
        { title: "Tiny", color: "#e0982a", width: 40, items: [] }
      ]
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.defaultWidth, 340);
    assert.equal(saved.body.columns[0].width, 420);
    assert.equal(saved.body.columns[1].width, null);
    assert.equal(saved.body.columns[2].width, 200);

    // Reordering is just a different column order on the next save.
    const moved = await session.put("/api/personal-todo").send({
      defaultWidth: 340,
      columns: [
        { title: "Default", color: "#23a35a", items: [] },
        { title: "Wide", color: "#2f6bed", width: 420, items: [] },
        { title: "Tiny", color: "#e0982a", width: 200, items: [] }
      ]
    });
    assert.deepEqual(moved.body.columns.map(c => c.title), ["Default", "Wide", "Tiny"]);

    const reread = await session.get("/api/personal-todo");
    assert.deepEqual(reread.body.columns.map(c => c.title), ["Default", "Wide", "Tiny"]);
    assert.deepEqual(reread.body.columns.map(c => c.width), [null, 420, 200]);
    assert.equal(reread.body.defaultWidth, 340);
  });

  it("keeps each user's board private", async () => {
    // member's board (set above) must not leak into approver2's freshly seeded one.
    const session = await ctx.login(app, "approver2");
    const res = await session.get("/api/personal-todo");
    assert.deepEqual(res.body.columns.map(c => c.title), ["Wait", "In Process", "Done"]);
  });

  it("rejects an unauthenticated request", async () => {
    const supertest = require("supertest");
    const res = await supertest(app).get("/api/personal-todo");
    assert.equal(res.status, 401);
  });
});
