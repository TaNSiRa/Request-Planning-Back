// Integration tests for the Create Request sidebar: the route preview ("where
// this will go") and the similar-past-requests lookup. Both are read-only
// previews the requester sees while typing, so what matters is that they
// describe the SAME chain the create endpoint would build, and that the
// similarity search only ever answers out of this section's closed history.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const { approveToInProgress, pendingStepFor } = require("./helpers/flows");

const ctx = fixtureContext("CSB");
const origin = fixtureContext("CSBO"); // a second section, to raise ACROSS

let app;
let fixture;
let requester;
let approver1;
let approver2;
let incharge;
let originRequester; // an origin-section user raising into the target section

// Drives one request all the way to COMPLETED so it can be found again as past
// work, and returns its request_no.
async function completedRequest(title, systemArea) {
  const id = await approveToInProgress({
    requester,
    approver1,
    approver2,
    inchargeUserId: fixture.users.member
  });
  await query("UPDATE requests SET title=@title, system_area=@area WHERE id=@id", {
    id,
    title,
    area: systemArea
  });
  const submit = await incharge.post(`/api/requests/${id}/complete-work`).send({});
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  for (const approver of [approver1, approver2]) {
    const step = await pendingStepFor(approver, id);
    assert.ok(step, "close step should be pending");
    const res = await approver.post(`/api/approvals/${step.id}/approve`).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const row = (await query("SELECT status, request_no FROM requests WHERE id=@id", { id })).recordset[0];
  assert.equal(row.status, "COMPLETED");
  return row.request_no;
}

describe("create request sidebar previews", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    approver2 = await ctx.login(app, "approver2");
    incharge = await ctx.login(app, "member");

    // A second section whose requester may raise into the first one, plus the
    // stage-1 route that makes their own section sign off first.
    const of = await origin.createFixture();
    await query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_active)
       VALUES (@userId, @sectionId, 1, 0, 1)`,
      { userId: of.users.requester, sectionId: fixture.sectionId }
    );
    const crossRouteId = (await query(
      `INSERT INTO approval_routes (section_id, requester_section_id, name, is_default, is_active)
       OUTPUT INSERTED.id
       VALUES (@targetId, @originId, 'Origin stage-1 route', 0, 1)`,
      { targetId: fixture.sectionId, originId: of.sectionId }
    )).recordset[0].id;
    await query(
      `INSERT INTO approval_route_steps (route_id, sequence_no, step_name, default_approver_user_id, can_assign_work)
       VALUES (@routeId, 1, 'Origin manager', @approver, 0)`,
      { routeId: crossRouteId, approver: of.users.approver1 }
    );
    originRequester = await origin.login(app, "requester", ctx.SECTION_CODE);
  });

  after(async () => {
    await origin.cleanupFixture();
    await ctx.cleanupFixture();
    await closePool();
  });

  it("previews this section's own route when the requester is raising it at home", async () => {
    const res = await requester.get("/api/requests/route-preview?requestType=IMPROVEMENT");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.crossSection, false);
    assert.equal(res.body.originSectionName, null);
    assert.equal(res.body.routeName, "API test route");
    assert.deepEqual(res.body.steps.map(step => step.name), ["Manager approval", "Senior approval"]);
    // Only the step the route lets assign work is the one that picks the team.
    assert.deepEqual(res.body.steps.map(step => step.canAssign), [true, false]);
    assert.deepEqual(res.body.steps.map(step => step.stage), ["TARGET", "TARGET"]);
    // Each step names who it lands on, taken from the route's own approver.
    assert.deepEqual(res.body.steps.map(step => step.approvers), [["CSB approver1"], ["CSB approver2"]]);
  });

  // The sidebar draws ORIGIN and TARGET as two separate boxed stages, so the
  // stage tag and the two route names have to survive the round trip — reading
  // another section's approver as part of your own chain sends people chasing
  // the wrong person.
  it("splits the preview into origin and target stages for a cross-section request", async () => {
    const res = await originRequester.get("/api/requests/route-preview?requestType=IMPROVEMENT");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.crossSection, true);
    assert.equal(res.body.originSectionName, "API Test CSBO");
    assert.equal(res.body.sectionName, "API Test CSB");
    assert.equal(res.body.originRouteName, "Origin stage-1 route");
    assert.equal(res.body.routeName, "API test route");
    assert.deepEqual(res.body.steps.map(step => step.stage), ["ORIGIN", "TARGET", "TARGET"]);
    assert.deepEqual(
      res.body.steps.map(step => step.name),
      ["Origin manager", "Manager approval", "Senior approval"]
    );
    assert.deepEqual(res.body.steps.map(step => step.approvers), [
      ["CSBO approver1"],
      ["CSB approver1"],
      ["CSB approver2"]
    ]);
  });

  it("finds a closed request with a near-identical title", async () => {
    const requestNo = await completedRequest("Camera reject arm on packing line 3", "Line 3 / Packing");

    const res = await requester.get(
      "/api/requests/similar?title=" + encodeURIComponent("Camera reject arm packing line 3")
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const hit = res.body.data.find(item => item.requestNo === requestNo);
    assert.ok(hit, `expected ${requestNo} in ${JSON.stringify(res.body.data)}`);
    assert.ok(hit.matchedOn.includes("title"));
    assert.equal(typeof hit.closedDays, "number");
    assert.ok(hit.closedDays >= 0);
  });

  it("ignores closed work that only shares the request type", async () => {
    await completedRequest("Replace conveyor motor bearing", "Boiler room");

    const res = await requester.get(
      "/api/requests/similar?title=" + encodeURIComponent("Vision camera on the sealing station") +
      "&requestType=IMPROVEMENT"
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(
      !res.body.data.some(item => item.title === "Replace conveyor motor bearing"),
      `unrelated work should not match: ${JSON.stringify(res.body.data)}`
    );
  });

  it("answers empty rather than guessing when there is too little to go on", async () => {
    const res = await requester.get("/api/requests/similar?title=ab");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, []);
  });
});
