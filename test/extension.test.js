// Integration tests for schedule extension requests: who may raise one, the
// approval chain that moves the project period, and rejection leaving it alone.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext } = require("./helpers/setup");
const {
  PROJECT_START,
  PROJECT_END,
  approveToInProgress,
  createRequest,
  getRequest,
  pendingExtensionFor
} = require("./helpers/flows");

const ctx = fixtureContext("EXT");

let app;
let fixture;
let requester;
let approver1;
let approver2;
let incharge;

const extensionPayload = (overrides = {}) => ({
  requestedStart: PROJECT_START,
  requestedEnd: "2026-09-30",
  reason: "needs more time",
  ...overrides
});

function inProgressRequest() {
  return approveToInProgress({ requester, approver1, approver2, inchargeUserId: fixture.users.member });
}

describe("schedule extension flow", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    approver2 = await ctx.login(app, "approver2");
    incharge = await ctx.login(app, "member");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("cannot be raised before the project period is assigned", async () => {
    const { id } = await createRequest(requester); // PENDING_APPROVAL, no period
    // meeting mode bypasses the worker check so we hit the period check.
    const res = await incharge.post(`/api/requests/${id}/extension-requests?meeting=1`).send(extensionPayload());
    assert.equal(res.status, 400);
  });

  it("may only be raised by the assigned workers", async () => {
    const id = await inProgressRequest();
    const res = await requester.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(res.status, 403);
  });

  it("goes to approver 1 first, and a non-approver cannot act on it", async () => {
    const id = await inProgressRequest();
    const created = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const extensionId = created.body.id;

    const row1 = await pendingExtensionFor(approver1, id);
    assert.ok(row1, "extension should be pending for approver 1");
    assert.equal(await pendingExtensionFor(approver2, id), null);

    // The incharge who raised it is not an approver.
    const res = await incharge.post(`/api/approvals/extension/${extensionId}/approve`).send({});
    assert.equal(res.status, 404);
  });

  it("moves the project period only after the FULL approval chain", async () => {
    const id = await inProgressRequest();
    const created = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(created.status, 201);
    const extensionId = created.body.id;

    const res1 = await approver1.post(`/api/approvals/extension/${extensionId}/approve`).send({});
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // Mid-chain: dates untouched, now waiting on approver 2.
    let detail = await getRequest(requester, id);
    assert.ok(`${detail.planned_end}`.startsWith(PROJECT_END));
    assert.ok(await pendingExtensionFor(approver2, id), "extension should now be pending for approver 2");

    const res2 = await approver2.post(`/api/approvals/extension/${extensionId}/approve`).send({});
    assert.equal(res2.status, 200, JSON.stringify(res2.body));

    detail = await getRequest(requester, id);
    assert.ok(`${detail.planned_end}`.startsWith("2026-09-30"), `planned_end moved: ${detail.planned_end}`);
    assert.ok(detail.extensionHistory.some(ext => ext.status === "APPROVED"));
  });

  it("a rejected extension leaves the project period unchanged", async () => {
    const id = await inProgressRequest();
    const created = await incharge.post(`/api/requests/${id}/extension-requests`).send(
      extensionPayload({ requestedEnd: "2026-10-30" })
    );
    assert.equal(created.status, 201);
    const extensionId = created.body.id;

    const res = await approver1.post(`/api/approvals/extension/${extensionId}/reject`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    assert.ok(`${detail.planned_end}`.startsWith(PROJECT_END), `planned_end must not move: ${detail.planned_end}`);
    assert.ok(detail.extensionHistory.some(ext => ext.status === "REJECTED"));
    // Nothing left in anyone's extension inbox.
    assert.equal(await pendingExtensionFor(approver1, id), null);
    assert.equal(await pendingExtensionFor(approver2, id), null);
  });

  it("only one extension may be open at a time", async () => {
    const id = await inProgressRequest();
    const first = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(first.status, 201);
    const second = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(second.status, 409);

    // Once decided, a new one can be raised.
    const rejected = await approver1.post(`/api/approvals/extension/${first.body.id}/reject`).send({});
    assert.equal(rejected.status, 200);
    const third = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(third.status, 201);
  });

  it("the worker can cancel an open extension without approval", async () => {
    const id = await inProgressRequest();
    const created = await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload());
    assert.equal(created.status, 201);
    const extensionId = created.body.id;

    // Not the worker → forbidden.
    const denied = await requester.post(`/api/requests/${id}/extension-requests/cancel`).send({});
    assert.equal(denied.status, 403);

    const res = await incharge.post(`/api/requests/${id}/extension-requests/cancel`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    assert.ok(`${detail.planned_end}`.startsWith(PROJECT_END));
    assert.equal(detail.extensionHistory.find(ext => ext.id === extensionId).status, "CANCELLED");
    assert.equal(await pendingExtensionFor(approver1, id), null);
    // The approver can no longer act on it.
    const late = await approver1.post(`/api/approvals/extension/${extensionId}/approve`).send({});
    assert.equal(late.status, 404);
    // Nothing left to cancel; a fresh request is allowed again.
    assert.equal((await incharge.post(`/api/requests/${id}/extension-requests/cancel`).send({})).status, 409);
    assert.equal((await incharge.post(`/api/requests/${id}/extension-requests`).send(extensionPayload())).status, 201);
  });
});
