// The approval inbox's visibility rule: a section admin SEES every pending step
// of the section they administer, even standing on no approval route — but only
// as a watcher. can_act on each row says whether this viewer may decide it, and
// the decision endpoints refuse anyone who isn't a candidate on the step (a
// system admin excepted, as before).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, createAdminUsers, fixtureContext } = require("./helpers/setup");
const { query } = require("../src/db/pool");
const { assignPayload, createRequest, getRequest, pendingStepFor } = require("./helpers/flows");

const TAG = "INBOXSCOPE";
const ctx = fixtureContext(TAG);

let app;
let fixture;
let requester;
let approver1;
let member;
let sectionadmin;
let othersectionadmin;

describe("approval inbox: a section admin watches, the route decides", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    member = await ctx.login(app, "member");
    await createAdminUsers(ctx, fixture, TAG);
    sectionadmin = await ctx.login(app, "sectionadmin");
    othersectionadmin = await ctx.login(app, "othersectionadmin");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("lists every pending step of the section for its admin, flagged read-only", async () => {
    const { id } = await createRequest(requester);

    // On no route step at all, yet the request sitting on approver 1's desk is
    // in their inbox — marked as not theirs to decide.
    const watched = await pendingStepFor(sectionadmin, id);
    assert.ok(watched, "section admin should see the pending step");
    assert.equal(watched.can_act, false);

    // The real approver sees the same step as actionable.
    const own = await pendingStepFor(approver1, id);
    assert.equal(own.can_act, true);

    // Nobody else gets it.
    assert.equal(await pendingStepFor(member, id), null, "a plain member sees nothing");
    assert.equal(
      await pendingStepFor(othersectionadmin, id),
      null,
      "a section admin of another section sees nothing here"
    );
  });

  it("refuses the decision endpoints to a watching section admin", async () => {
    const { id } = await createRequest(requester);
    const step = await pendingStepFor(sectionadmin, id);

    const approve = await sectionadmin
      .post(`/api/approvals/${step.id}/approve`)
      .send(assignPayload(fixture.users.member));
    assert.equal(approve.status, 404, JSON.stringify(approve.body));
    const reject = await sectionadmin
      .post(`/api/approvals/${step.id}/reject`)
      .send({ comment: "not mine to reject" });
    assert.equal(reject.status, 404, JSON.stringify(reject.body));

    // Untouched: the step is still pending for the approver who owns it.
    assert.ok(await pendingStepFor(approver1, id));
    assert.equal((await getRequest(requester, id)).status, "PENDING_APPROVAL");
  });

  it("still lets a section admin who IS on the route approve normally", async () => {
    // Put the section admin on route step 2 as a co-approver.
    const sectionAdminId = (await query("SELECT id FROM users WHERE email=@email", {
      email: ctx.testEmail("sectionadmin")
    })).recordset[0].id;
    await query(
      `IF NOT EXISTS (SELECT 1 FROM approval_route_step_approvers WHERE step_id=@stepId AND user_id=@userId)
       INSERT INTO approval_route_step_approvers (step_id, user_id) VALUES (@stepId, @userId)`,
      { stepId: fixture.stepIds[1], userId: sectionAdminId }
    );

    const { id } = await createRequest(requester);
    const step1 = await pendingStepFor(approver1, id);
    const res1 = await approver1.post(`/api/approvals/${step1.id}/approve`).send(assignPayload(fixture.users.member));
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // Step 2 is genuinely theirs now — actionable, and it goes through.
    const step2 = await pendingStepFor(sectionadmin, id);
    assert.ok(step2);
    assert.equal(step2.can_act, true);
    const res2 = await sectionadmin.post(`/api/approvals/${step2.id}/approve`).send({ comment: "on the route" });
    assert.equal(res2.status, 200, JSON.stringify(res2.body));
    assert.equal((await getRequest(requester, id)).status, "IN_PROGRESS");
  });
});
