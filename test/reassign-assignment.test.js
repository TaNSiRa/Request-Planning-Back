// Integration tests for PATCH /requests/:id/assignment — re-deciding who works
// on an already-approved request (incharge, supports, support types, project
// period, KPI) from the request detail, long after the approval inbox is done
// with it. The gate: a candidate on the route's LAST approval step, a section
// admin of that section, or a system admin.
// The inbox's own read-only rule lives in approval-inbox-scope.test.js.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, createAdminUsers, fixtureContext } = require("./helpers/setup");
const { query } = require("../src/db/pool");
const {
  PROJECT_START,
  PROJECT_END,
  approveToInProgress,
  assignPayload,
  createRequest,
  getRequest,
  pendingStepFor
} = require("./helpers/flows");

// The fixture tags every display name with its own namespace: "REASSIGN member".
const TAG = "REASSIGN";
const ctx = fixtureContext(TAG);

let app;
let fixture;
let requester;
let approver1;
let approver2;
let coapprover;
let incharge;
let sysadmin;
let sectionadmin;
let othersectionadmin;

// A reassignment body: everything the form posts, with the incharge swapped.
const reassignPayload = (inchargeUserId, overrides = {}) => ({
  inchargeUserId,
  supportUserIds: [],
  plannedStart: PROJECT_START,
  plannedEnd: PROJECT_END,
  isKpi: false,
  supTypes: [],
  ...overrides
});

// Only the assignment mails — the outbox also carries CREATE/APPROVAL/APPROVE
// for the same request, which this test isn't about.
async function outbox(requestId) {
  return (await query(
    `SELECT mail_type, to_email, subject FROM email_outbox
     WHERE request_id=@requestId AND mail_type IN ('ASSIGN','REASSIGN') ORDER BY id`,
    { requestId }
  )).recordset;
}

function inProgressRequest() {
  return approveToInProgress({ requester, approver1, approver2, inchargeUserId: fixture.users.member });
}

describe("reassignment: PATCH /requests/:id/assignment", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
    requester = await ctx.login(app, "requester");
    approver1 = await ctx.login(app, "approver1");
    approver2 = await ctx.login(app, "approver2");
    coapprover = await ctx.login(app, "coapprover");
    incharge = await ctx.login(app, "member");
    await createAdminUsers(ctx, fixture, TAG);
    sysadmin = await ctx.login(app, "sysadmin");
    sectionadmin = await ctx.login(app, "sectionadmin");
    othersectionadmin = await ctx.login(app, "othersectionadmin");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("only the LAST approver on the route may change the assignment", async () => {
    const id = await inProgressRequest();
    const body = reassignPayload(fixture.users.requester);

    // Not the requester who raised it...
    assert.equal((await requester.patch(`/api/requests/${id}/assignment`).send(body)).status, 403);
    // ...not the assigned incharge...
    assert.equal((await incharge.patch(`/api/requests/${id}/assignment`).send(body)).status, 403);
    // ...and not even the earlier approver who originally assigned the work.
    assert.equal((await approver1.patch(`/api/requests/${id}/assignment`).send(body)).status, 403);

    const allowed = await approver2.patch(`/api/requests/${id}/assignment`).send(body);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });

  it("replaces incharge, supports, support types, period and the KPI flag", async () => {
    const id = await inProgressRequest();
    const res = await approver2.patch(`/api/requests/${id}/assignment`).send(reassignPayload(fixture.users.requester, {
      supportUserIds: [fixture.users.coapprover, fixture.users.member],
      plannedEnd: "2026-08-28",
      isKpi: true,
      supTypes: ["Electrical", "Mechanical"]
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    assert.equal(detail.incharge_user_id, fixture.users.requester);
    // The real support list lives in request_supports; the legacy column keeps
    // mirroring the first of them.
    assert.deepEqual(detail.support_user_ids, [fixture.users.coapprover, fixture.users.member]);
    assert.equal(detail.support_user_id, fixture.users.coapprover);
    assert.deepEqual(detail.supTypes.map(st => st.supType).sort(), ["Electrical", "Mechanical"]);
    assert.equal(detail.is_kpi, true);
    assert.match(`${detail.planned_end}`, /2026-08-28/);

    // Work rights follow the new assignment: the new incharge may add todos...
    const asNewIncharge = await requester.post(`/api/requests/${id}/todos`).send({
      title: "after reassignment",
      plannedStart: PROJECT_START,
      plannedEnd: PROJECT_START
    });
    assert.equal(asNewIncharge.status, 201, JSON.stringify(asNewIncharge.body));
    // ...and a support of the request may too (multi-support, not just the
    // legacy first one).
    const asSupport = await incharge.post(`/api/requests/${id}/todos`).send({
      title: "as a support now",
      plannedStart: PROJECT_START,
      plannedEnd: PROJECT_START
    });
    assert.equal(asSupport.status, 201, JSON.stringify(asSupport.body));
  });

  it("writes one edit-history row per field that actually moved", async () => {
    const id = await inProgressRequest();
    const res = await approver2.patch(`/api/requests/${id}/assignment`).send(reassignPayload(fixture.users.requester, {
      supportUserIds: [fixture.users.coapprover],
      plannedEnd: "2026-08-25"
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getRequest(requester, id);
    const byField = new Map(detail.detailEdits.map(row => [row.field, row]));
    // Names, not ids — this popup is read by people.
    assert.equal(byField.get("incharge").old_value, `${TAG} member`);
    assert.equal(byField.get("incharge").new_value, `${TAG} requester`);
    assert.equal(byField.get("support").old_value, "");
    assert.equal(byField.get("support").new_value, `${TAG} coapprover`);
    assert.equal(byField.get("planned_end").new_value, "2026-08-25");
    // The project start never moved, so it left no trace.
    assert.equal(byField.has("planned_start"), false);
    // Every row of one edit shares an edited_at so the popup groups them.
    assert.equal(new Set(detail.detailEdits.map(row => `${row.edited_at}`)).size, 1);
    assert.equal(byField.get("incharge").edited_by, fixture.users.approver2);
  });

  it("re-posting the same assignment changes nothing and adds no history", async () => {
    const id = await inProgressRequest();
    // Exactly what the approval left behind (approval defaults is_kpi to on).
    const same = await approver2
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.member, { isKpi: true }));
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.changed, 0);
    assert.equal((await getRequest(requester, id)).detailEdits.length, 0);
  });

  it("refuses a project period that would strand an existing to-do", async () => {
    const id = await inProgressRequest();
    const todo = await incharge.post(`/api/requests/${id}/todos`).send({
      title: "late todo",
      plannedStart: "2026-08-18",
      plannedEnd: "2026-08-20"
    });
    assert.equal(todo.status, 201, JSON.stringify(todo.body));

    const shrunk = await approver2
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.member, { plannedEnd: "2026-08-10" }));
    assert.equal(shrunk.status, 400);
    assert.match(shrunk.body.message, /late todo/);

    // Nothing was written: the period is still the original one.
    assert.match(`${(await getRequest(requester, id)).planned_end}`, /2026-08-21/);
  });

  it("refuses someone who cannot be given work in this section", async () => {
    const id = await inProgressRequest();
    await query("UPDATE user_section_memberships SET can_work=0 WHERE user_id=@userId AND section_id=@sectionId", {
      userId: fixture.users.coapprover,
      sectionId: fixture.sectionId
    });
    try {
      const res = await approver2
        .patch(`/api/requests/${id}/assignment`)
        .send(reassignPayload(fixture.users.coapprover));
      assert.equal(res.status, 400);
      assert.match(res.body.message, /incharge/i);
    } finally {
      await query("UPDATE user_section_memberships SET can_work=1 WHERE user_id=@userId AND section_id=@sectionId", {
        userId: fixture.users.coapprover,
        sectionId: fixture.sectionId
      });
    }
  });

  it("is closed while the request is still being routed — that belongs to the approval inbox", async () => {
    const { id } = await createRequest(requester);
    const step1 = await pendingStepFor(approver1, id);
    const res1 = await approver1.post(`/api/approvals/${step1.id}/approve`).send(assignPayload(fixture.users.member));
    assert.equal(res1.status, 200, JSON.stringify(res1.body));

    // Assigned at step 1, but step 2 hasn't signed off: still PENDING_APPROVAL.
    const pending = await approver2
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.requester));
    assert.equal(pending.status, 400);
    assert.match(pending.body.message, /in progress/i);
  });

  it("lets a system admin and this section's admin reassign as well", async () => {
    const forAdmin = await inProgressRequest();
    const byAdmin = await sysadmin
      .patch(`/api/requests/${forAdmin}/assignment`)
      .send(reassignPayload(fixture.users.requester));
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    assert.equal((await getRequest(requester, forAdmin)).incharge_user_id, fixture.users.requester);

    const forSectionAdmin = await inProgressRequest();
    const bySectionAdmin = await sectionadmin
      .patch(`/api/requests/${forSectionAdmin}/assignment`)
      .send(reassignPayload(fixture.users.requester));
    assert.equal(bySectionAdmin.status, 200, JSON.stringify(bySectionAdmin.body));
    assert.equal((await getRequest(requester, forSectionAdmin)).incharge_user_id, fixture.users.requester);
  });

  it("refuses a section-admin account that does not administer THIS section", async () => {
    const id = await inProgressRequest();
    const res = await othersectionadmin
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.requester));
    assert.equal(res.status, 403);
  });

  it("emails the new incharge the handover template, and only when the incharge moves", async () => {
    const id = await inProgressRequest();
    // The approval itself already mailed the first incharge the ASSIGN template.
    assert.deepEqual((await outbox(id)).map(row => row.mail_type), ["ASSIGN"]);
    assert.equal((await outbox(id))[0].to_email, ctx.testEmail("member"));

    // Period only — nobody changes hands, so nothing is sent.
    const periodOnly = await approver2
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.member, { isKpi: true, plannedEnd: "2026-08-27" }));
    assert.equal(periodOnly.status, 200, JSON.stringify(periodOnly.body));
    assert.deepEqual((await outbox(id)).map(row => row.mail_type), ["ASSIGN"]);

    // Hand it to someone else: the handover mail goes to the NEW incharge.
    const moved = await approver2
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.requester, { plannedEnd: "2026-08-27" }));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const mails = await outbox(id);
    assert.deepEqual(mails.map(row => row.mail_type), ["ASSIGN", "REASSIGN"]);
    const handover = mails[1];
    assert.equal(handover.to_email, ctx.testEmail("requester"));
    // Its own subject line, not the "assigned a new job" one.
    assert.match(handover.subject, /โอนงาน/);
  });

  // "Edit detail" (the request's own text) opens to the same two admin roles.
  it("lets a system admin and this section's admin correct the request detail", async () => {
    const { id } = await createRequest(requester);
    const edit = {
      requestType: "IMPROVEMENT",
      systemArea: "Line 9",
      description: "corrected by an admin",
      businessImpact: "none"
    };
    const byAdmin = await sysadmin.patch(`/api/requests/${id}/details`).send(edit);
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));

    const bySectionAdmin = await sectionadmin
      .patch(`/api/requests/${id}/details`)
      .send({ ...edit, description: "corrected by the section admin" });
    assert.equal(bySectionAdmin.status, 200, JSON.stringify(bySectionAdmin.body));
    assert.equal((await getRequest(requester, id)).description, "corrected by the section admin");

    // Still closed to a section-admin account that doesn't administer this section.
    const denied = await othersectionadmin.patch(`/api/requests/${id}/details`).send(edit);
    assert.equal(denied.status, 403);
  });

  it("lets a co-approver on the last step reassign too", async () => {
    await query(
      `IF NOT EXISTS (SELECT 1 FROM approval_route_step_approvers WHERE step_id=@stepId AND user_id=@userId)
       INSERT INTO approval_route_step_approvers (step_id, user_id) VALUES (@stepId, @userId)`,
      { stepId: fixture.stepIds[1], userId: fixture.users.coapprover }
    );
    // Snapshotted onto the request's own steps when it is created, so this must
    // be a request raised AFTER the route change.
    const id = await inProgressRequest();
    const res = await coapprover
      .patch(`/api/requests/${id}/assignment`)
      .send(reassignPayload(fixture.users.requester));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await getRequest(requester, id)).incharge_user_id, fixture.users.requester);
  });
});
