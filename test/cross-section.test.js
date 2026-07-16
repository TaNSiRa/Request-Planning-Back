// Integration tests for the 2-stage cross-section approval flow: a request
// raised by a user from ANOTHER section (origin) into this section (target)
// must clear the origin's stage-1 route before the target's own route runs.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const {
  assignPayload,
  createRequest,
  getRequest,
  pendingStepFor
} = require("./helpers/flows");

const target = fixtureContext("XST"); // executing/handling section
const origin = fixtureContext("XSO"); // the requester's home section

let app;
let tf; // target fixture
let of; // origin fixture
let originRequester;      // origin user acting IN the target section
let originRequesterHome;  // same user acting in their own section
let originApprover;       // origin approver acting IN the target section
let targetApprover1;
let targetApprover2;

describe("cross-section approval flow", () => {
  before(async () => {
    app = createApp();
    tf = await target.createFixture();
    of = await origin.createFixture();

    // Origin users can raise (but not work on) requests in the target section.
    for (const userId of [of.users.requester, of.users.approver1]) {
      await query(
        `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_active)
         VALUES (@userId, @sectionId, 1, 0, 1)`,
        { userId, sectionId: tf.sectionId }
      );
    }

    // Stage-1 route: requests originating from the origin section and executed
    // by the target section are first approved by the origin's approver.
    const crossRouteId = (await query(
      `INSERT INTO approval_routes (section_id, requester_section_id, name, is_default, is_active)
       OUTPUT INSERTED.id
       VALUES (@targetId, @originId, 'Origin stage-1 route', 0, 1)`,
      { targetId: tf.sectionId, originId: of.sectionId }
    )).recordset[0].id;
    await query(
      `INSERT INTO approval_route_steps (route_id, sequence_no, step_name, default_approver_user_id, can_assign_work)
       VALUES (@routeId, 1, 'Origin manager', @approver, 0)`,
      { routeId: crossRouteId, approver: of.users.approver1 }
    );

    originRequester = await origin.login(app, "requester", target.SECTION_CODE);
    originRequesterHome = await origin.login(app, "requester");
    originApprover = await origin.login(app, "approver1", target.SECTION_CODE);
    targetApprover1 = await target.login(app, "approver1");
    targetApprover2 = await target.login(app, "approver2");
  });

  after(async () => {
    // Target first: it owns the cross route + requests that reference the
    // origin section, which must go before the origin section can be dropped.
    await target.cleanupFixture();
    await origin.cleanupFixture();
    await closePool();
  });

  it("prepends the origin stage: 3 steps, origin approver first", async () => {
    const { id } = await createRequest(originRequester);

    const detail = await getRequest(originRequester, id);
    assert.equal(detail.status, "PENDING_APPROVAL");
    assert.equal(detail.requester_section_id, of.sectionId);
    assert.equal(detail.section_id, tf.sectionId);
    assert.equal(detail.approvals.length, 3);
    assert.equal(detail.approvals[0].approver_user_id, of.users.approver1);
    assert.equal(detail.approvals[0].status, "PENDING");
    assert.equal(detail.approvals[1].approver_user_id, tf.users.approver1);
    assert.equal(detail.approvals[1].status, "WAITING");

    // Until the origin stage clears, the target approvers see nothing.
    assert.ok(await pendingStepFor(originApprover, id));
    assert.equal(await pendingStepFor(targetApprover1, id), null);
  });

  it("shows the request in the origin section's own list too", async () => {
    const { id } = await createRequest(originRequester);
    const res = await originRequesterHome.get("/api/requests");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.some(row => row.id === id), "request should appear in the origin section list");
  });

  it("hands off to the target route after the origin stage clears", async () => {
    const { id } = await createRequest(originRequester);

    // Origin approver just approves — assignment belongs to the handling section.
    const step1 = await pendingStepFor(originApprover, id);
    const res1 = await originApprover.post(`/api/approvals/${step1.id}/approve`).send({ comment: "origin ok" });
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // Now the target's own route takes over, with assignment on its step.
    const step2 = await pendingStepFor(targetApprover1, id);
    assert.ok(step2, "target approver 1 should now see the request");
    const res2 = await targetApprover1.post(`/api/approvals/${step2.id}/approve`).send(assignPayload(tf.users.member));
    assert.equal(res2.status, 200, JSON.stringify(res2.body));

    const step3 = await pendingStepFor(targetApprover2, id);
    assert.ok(step3, "target approver 2 should see the final step");
    const res3 = await targetApprover2.post(`/api/approvals/${step3.id}/approve`).send({});
    assert.equal(res3.status, 200, JSON.stringify(res3.body));

    const detail = await getRequest(originRequester, id);
    assert.equal(detail.status, "IN_PROGRESS");
    assert.equal(detail.incharge_user_id, tf.users.member);
    assert.ok(detail.approvals.every(step => step.status === "APPROVED"));
  });

  it("a rejection at the origin stage ends the request before the target sees it", async () => {
    const { id } = await createRequest(originRequester);

    const step1 = await pendingStepFor(originApprover, id);
    const res = await originApprover.post(`/api/approvals/${step1.id}/reject`).send({ comment: "not justified" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(originRequester, id);
    assert.equal(detail.status, "REJECTED");
    assert.equal(await pendingStepFor(targetApprover1, id), null);
  });
});
