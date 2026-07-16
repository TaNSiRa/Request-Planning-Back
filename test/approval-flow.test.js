// Integration tests for the core request/approval flow. They talk to the real
// API (supertest, in-process) backed by the LOCAL dev database — setup.js
// refuses to run against anything but 127.0.0.1. Run with: npm test
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const {
  assignPayload,
  createRequest,
  getRequest,
  pendingStepFor,
  requestPayload
} = require("./helpers/flows");

const ctx = fixtureContext("FLOW");

let app;
let fixture;
let requester;
let approver1;
let approver2;
let member;
let coapprover;

describe("request approval flow", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    approver2 = await ctx.login(app, "approver2");
    member = await ctx.login(app, "member");
    coapprover = await ctx.login(app, "coapprover");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("rejects a wrong password", async () => {
    const res = await supertest(app)
      .post("/api/auth/login")
      .send({ email: ctx.testEmail("requester"), password: "wrong-password" });
    assert.equal(res.status, 401);
  });

  it("blocks unauthenticated API access", async () => {
    const res = await supertest(app).get(`/api/requests?sectionCode=${ctx.SECTION_CODE}`);
    assert.equal(res.status, 401);
  });

  it("blocks a logged-in write that is missing the CSRF token", async () => {
    const res = await requester.agent
      .post("/api/requests")
      .set("x-section-code", ctx.SECTION_CODE)
      .send(requestPayload());
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "CSRF_REQUIRED");
  });

  it("creates a request as PENDING_APPROVAL with step 1 waiting on approver 1", async () => {
    const { id, requestNo } = await createRequest(requester);
    assert.ok(requestNo.startsWith(`${ctx.REQUEST_PREFIX}-`));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "PENDING_APPROVAL");
    assert.equal(detail.approvals.length, 2);
    assert.equal(detail.approvals[0].status, "PENDING");
    assert.equal(detail.approvals[0].approver_user_id, fixture.users.approver1);
    assert.equal(detail.approvals[1].status, "WAITING");

    // It shows up in approver 1's inbox, but NOT in approver 2's yet.
    assert.ok(await pendingStepFor(approver1, id));
    assert.equal(await pendingStepFor(approver2, id), null);
  });

  it("does not let a non-approver act on a pending step", async () => {
    const { id } = await createRequest(requester);
    const step = await pendingStepFor(approver1, id);

    // A plain member never sees the step in their inbox...
    assert.equal(await pendingStepFor(member, id), null);
    // ...and hitting the endpoint directly is refused too.
    const res = await member.post(`/api/approvals/${step.id}/approve`).send(assignPayload(fixture.users.member));
    assert.equal(res.status, 404);
  });

  it("requires the assigning approver to set incharge and project period", async () => {
    const { id } = await createRequest(requester);
    const step = await pendingStepFor(approver1, id);
    const res = await approver1.post(`/api/approvals/${step.id}/approve`).send({ comment: "ok" });
    assert.equal(res.status, 400);
  });

  it("rejects a project period whose start is after its end", async () => {
    const { id } = await createRequest(requester);
    const step = await pendingStepFor(approver1, id);
    const res = await approver1.post(`/api/approvals/${step.id}/approve`).send(
      assignPayload(fixture.users.member, { plannedStart: "2026-09-30", plannedEnd: "2026-09-01" })
    );
    assert.equal(res.status, 400);
  });

  it("runs the full two-step chain: assign, approve, approve → IN_PROGRESS", async () => {
    const { id } = await createRequest(requester);

    const step1 = await pendingStepFor(approver1, id);
    const res1 = await approver1.post(`/api/approvals/${step1.id}/approve`).send(assignPayload(fixture.users.member));
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // After step 1 the request is still pending, now in approver 2's inbox.
    let detail = await getRequest(requester, id);
    assert.equal(detail.status, "PENDING_APPROVAL");
    assert.equal(detail.incharge_user_id, fixture.users.member);

    const step2 = await pendingStepFor(approver2, id);
    assert.ok(step2, "step 2 should now be pending for approver 2");
    const res2 = await approver2.post(`/api/approvals/${step2.id}/approve`).send({ comment: "approved" });
    assert.equal(res2.status, 200, JSON.stringify(res2.body));

    detail = await getRequest(requester, id);
    assert.equal(detail.status, "IN_PROGRESS");
    assert.ok(detail.approved_at);
    assert.ok(detail.approvals.every(step => step.status === "APPROVED"));
  });

  it("rejecting a request requires a comment and ends it as REJECTED", async () => {
    const { id } = await createRequest(requester);
    const step = await pendingStepFor(approver1, id);

    const noComment = await approver1.post(`/api/approvals/${step.id}/reject`).send({ comment: "" });
    assert.equal(noComment.status, 400);

    const res = await approver1.post(`/api/approvals/${step.id}/reject`).send({ comment: "not needed" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "REJECTED");
    assert.equal(detail.reject_reason, "not needed");
    // The rejected request must leave every inbox.
    assert.equal(await pendingStepFor(approver1, id), null);
  });

  it("only the requester may cancel their request", async () => {
    const { id } = await createRequest(requester);

    const asMember = await member.patch(`/api/requests/${id}/cancel`).send({ reason: "nope" });
    assert.equal(asMember.status, 403);

    const asOwner = await requester.patch(`/api/requests/${id}/cancel`).send({ reason: "changed my mind" });
    assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "CANCELLED");
    // Cancelling clears the pending step from the approver's inbox.
    assert.equal(await pendingStepFor(approver1, id), null);
  });

  it("lets a co-approver act on a step (any candidate may decide)", async () => {
    // Attach the co-approver to route step 2; requests created from here on
    // snapshot them as a step-2 candidate alongside approver 2.
    await query(
      "INSERT INTO approval_route_step_approvers (step_id, user_id) VALUES (@stepId, @userId)",
      { stepId: fixture.stepIds[1], userId: fixture.users.coapprover }
    );

    const { id } = await createRequest(requester);
    const step1 = await pendingStepFor(approver1, id);
    const res1 = await approver1.post(`/api/approvals/${step1.id}/approve`).send(assignPayload(fixture.users.member));
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // Step 2 is in BOTH candidates' inboxes; the co-approver acts.
    const step2 = await pendingStepFor(coapprover, id);
    assert.ok(step2, "co-approver should see step 2 in their inbox");
    assert.ok(await pendingStepFor(approver2, id), "primary approver sees it too");

    const res2 = await coapprover.post(`/api/approvals/${step2.id}/approve`).send({ comment: "acting for approver2" });
    assert.equal(res2.status, 200, JSON.stringify(res2.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "IN_PROGRESS");
    // The step records whoever actually decided.
    const decided = detail.approvals.find(step => step.sequence_no === 2);
    assert.equal(decided.approver_user_id, fixture.users.coapprover);
    // And it leaves the primary approver's inbox once decided.
    assert.equal(await pendingStepFor(approver2, id), null);
  });
});
