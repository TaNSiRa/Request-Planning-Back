// Integration tests for what happens AFTER approval: todos, meeting mode,
// on-hold, work completion + close-approval chain, and the KPI flag.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext } = require("./helpers/setup");
const {
  PROJECT_START,
  approveToInProgress,
  createRequest,
  getRequest,
  pendingStepFor
} = require("./helpers/flows");

const ctx = fixtureContext("LIFE");

let app;
let fixture;
let requester;
let approver1;
let approver2;
let incharge; // the "member" user, assigned as incharge on every request here

const todoPayload = (overrides = {}) => ({
  title: "test todo",
  plannedStart: "2026-08-04",
  plannedEnd: "2026-08-05",
  ...overrides
});

// A fresh IN_PROGRESS request assigned to `incharge`.
function inProgressRequest() {
  return approveToInProgress({ requester, approver1, approver2, inchargeUserId: fixture.users.member });
}

describe("work lifecycle: todos, hold, close, KPI", () => {
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

  it("only the assigned incharge/support may manage todos — unless in meeting mode", async () => {
    const id = await inProgressRequest();

    // The requester is not assigned to the work...
    const denied = await requester.post(`/api/requests/${id}/todos`).send(todoPayload());
    assert.equal(denied.status, 403);

    // ...the incharge is...
    const asIncharge = await incharge.post(`/api/requests/${id}/todos`).send(todoPayload());
    assert.equal(asIncharge.status, 201, JSON.stringify(asIncharge.body));

    // ...and meeting mode (?meeting=1) opens todos to any section member.
    const asMeeting = await requester.post(`/api/requests/${id}/todos?meeting=1`).send(todoPayload({ title: "from meeting" }));
    assert.equal(asMeeting.status, 201, JSON.stringify(asMeeting.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.todos.length, 2);
  });

  it("keeps todo dates inside the assigned project period", async () => {
    const id = await inProgressRequest();
    const res = await incharge.post(`/api/requests/${id}/todos`).send(
      todoPayload({ plannedEnd: "2026-12-01" }) // past project end
    );
    assert.equal(res.status, 400);

    const before = await incharge.post(`/api/requests/${id}/todos`).send(
      todoPayload({ plannedStart: "2026-01-01" }) // before project start
    );
    assert.equal(before.status, 400);
  });

  it("blocks complete-work while a todo is unfinished, allows it once all are done", async () => {
    const id = await inProgressRequest();
    const todo = await incharge.post(`/api/requests/${id}/todos`).send(todoPayload());
    assert.equal(todo.status, 201);

    const blocked = await incharge.post(`/api/requests/${id}/complete-work`).send({});
    assert.equal(blocked.status, 400);

    const done = await incharge.patch(`/api/requests/${id}/todos/${todo.body.id}`).send(
      todoPayload({ isDone: true })
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const ok = await incharge.post(`/api/requests/${id}/complete-work`).send({});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "WAITING_CLOSE");
    assert.ok(detail.work_completed_at);

    // The close chain reuses the route: step 1 goes back to approver 1,
    // flagged as a CLOSE approval (sequence >= 100).
    const closeStep = await pendingStepFor(approver1, id);
    assert.ok(closeStep, "close step should be pending for approver 1");
    assert.equal(closeStep.approval_kind, "CLOSE");
    assert.ok(closeStep.sequence_no >= 100);
  });

  it("completes the request after the full close-approval chain", async () => {
    const id = await inProgressRequest();
    const submit = await incharge.post(`/api/requests/${id}/complete-work`).send({});
    assert.equal(submit.status, 200, JSON.stringify(submit.body));

    const close1 = await pendingStepFor(approver1, id);
    const res1 = await approver1.post(`/api/approvals/${close1.id}/approve`).send({});
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    const close2 = await pendingStepFor(approver2, id);
    assert.ok(close2, "close step 2 should be pending for approver 2");
    const res2 = await approver2.post(`/api/approvals/${close2.id}/approve`).send({});
    assert.equal(res2.status, 200, JSON.stringify(res2.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "COMPLETED");
    assert.ok(detail.closed_at);
    assert.equal(detail.closed_by, fixture.users.approver2);
  });

  it("rejecting the close approval sends the request back to IN_PROGRESS", async () => {
    const id = await inProgressRequest();
    await incharge.post(`/api/requests/${id}/complete-work`).send({});

    const closeStep = await pendingStepFor(approver1, id);
    const res = await approver1.post(`/api/approvals/${closeStep.id}/reject`).send({ comment: "work incomplete" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.status, "IN_PROGRESS");
    // The rest of the close chain is skipped, nothing lingers in inboxes.
    assert.equal(await pendingStepFor(approver2, id), null);
    // The work can be resubmitted after fixing.
    const resubmit = await incharge.post(`/api/requests/${id}/complete-work`).send({});
    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
  });

  it("complete-work is only valid on an IN_PROGRESS request", async () => {
    const { id } = await createRequest(requester); // still PENDING_APPROVAL
    const res = await incharge.post(`/api/requests/${id}/complete-work?meeting=1`).send({});
    assert.equal(res.status, 400);
  });

  it("only the incharge may toggle hold, and it flips IN_PROGRESS ↔ ON_HOLD", async () => {
    const id = await inProgressRequest();

    const denied = await requester.post(`/api/requests/${id}/hold`).send({});
    assert.equal(denied.status, 403);

    const hold = await incharge.post(`/api/requests/${id}/hold`).send({});
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    assert.equal(hold.body.status, "ON_HOLD");
    assert.equal((await getRequest(requester, id)).status, "ON_HOLD");

    const resume = await incharge.post(`/api/requests/${id}/hold`).send({});
    assert.equal(resume.status, 200);
    assert.equal(resume.body.status, "IN_PROGRESS");
  });

  it("hold is refused for a request that is not in progress", async () => {
    const { id } = await createRequest(requester); // PENDING_APPROVAL
    // meeting mode bypasses the incharge check, so we hit the status check.
    const res = await incharge.post(`/api/requests/${id}/hold?meeting=1`).send({});
    assert.equal(res.status, 400);
  });

  it("KPI flag: only after assignment, and only by an approver", async () => {
    const { id } = await createRequest(requester);
    // Not assigned yet → even an approver is refused.
    const early = await approver1.patch(`/api/requests/${id}/kpi`).send({ isKpi: true });
    assert.equal(early.status, 400);

    const assignedId = await inProgressRequest();
    // Assignment defaults the KPI flag to true.
    assert.equal((await getRequest(requester, assignedId)).is_kpi, true);

    // The requester is not an approver → refused.
    const denied = await requester.patch(`/api/requests/${assignedId}/kpi`).send({ isKpi: false });
    assert.equal(denied.status, 403);

    // A route approver may flip it.
    const res = await approver1.patch(`/api/requests/${assignedId}/kpi`).send({ isKpi: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await getRequest(requester, assignedId)).is_kpi, false);
  });
});
