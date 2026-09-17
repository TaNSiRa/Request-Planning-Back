// Integration tests for Create Request drafts: the five-draft cap, that a draft
// is private to its owner and section, that auto-save's PUT never resurrects a
// deleted draft, and that submitting a request raised from a draft removes it.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const { requestPayload } = require("./helpers/flows");

const ctx = fixtureContext("DRF");

let app;
let fixture;
let requester;
let member;

async function clearDrafts() {
  await query("DELETE FROM request_drafts WHERE section_id=@sid", { sid: fixture.sectionId });
}

describe("create request drafts", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    member = await ctx.login(app, "member");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("saves, lists, loads and overwrites a draft", async () => {
    await clearDrafts();
    const created = await requester.post("/api/requests/drafts").send({
      title: "Half-written",
      requestType: "IMPROVEMENT",
      description: "first pass",
      attachments: [{ fileName: "a.txt", contentType: "text/plain", dataUrl: "data:text/plain;base64,aGk=" }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.attachmentCount, 1);

    const saved = await requester.put(`/api/requests/drafts/${created.body.id}`).send({
      title: "Nearly done",
      description: "second pass"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.attachmentCount, 0);

    const list = await requester.get("/api/requests/drafts");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.max, 5);
    assert.deepEqual(list.body.data.map(d => d.title), ["Nearly done"]);

    const one = await requester.get(`/api/requests/drafts/${created.body.id}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.payload.description, "second pass");
  });

  it("refuses a sixth draft", async () => {
    await clearDrafts();
    for (let i = 0; i < 5; i += 1) {
      const res = await requester.post("/api/requests/drafts").send({ title: `Draft ${i}` });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const sixth = await requester.post("/api/requests/drafts").send({ title: "One too many" });
    assert.equal(sixth.status, 409, JSON.stringify(sixth.body));
    assert.equal(sixth.body.code, "DRAFT_LIMIT");
  });

  it("keeps drafts private to their owner", async () => {
    await clearDrafts();
    const mine = await requester.post("/api/requests/drafts").send({ title: "Mine" });
    assert.equal((await member.get("/api/requests/drafts")).body.data.length, 0);
    assert.equal((await member.get(`/api/requests/drafts/${mine.body.id}`)).status, 404);
    assert.equal((await member.put(`/api/requests/drafts/${mine.body.id}`).send({ title: "x" })).status, 404);
    await member.del(`/api/requests/drafts/${mine.body.id}`);
    assert.equal((await requester.get(`/api/requests/drafts/${mine.body.id}`)).status, 200);
  });

  it("does not bring a deleted draft back through a late auto-save", async () => {
    await clearDrafts();
    const draft = await requester.post("/api/requests/drafts").send({ title: "Gone soon" });
    assert.equal((await requester.del(`/api/requests/drafts/${draft.body.id}`)).status, 200);
    const late = await requester.put(`/api/requests/drafts/${draft.body.id}`).send({ title: "Late save" });
    assert.equal(late.status, 404);
    assert.equal((await requester.get("/api/requests/drafts")).body.data.length, 0);
  });

  it("deletes the draft once a request raised from it is submitted", async () => {
    await clearDrafts();
    const draft = await requester.post("/api/requests/drafts").send({ title: "Submit me" });
    const other = await requester.post("/api/requests/drafts").send({ title: "Keep me" });
    const res = await requester.post("/api/requests").send(requestPayload({ draftId: draft.body.id }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const list = await requester.get("/api/requests/drafts");
    assert.deepEqual(list.body.data.map(d => d.id), [other.body.id]);
  });
});
