// A section admin's authority stops at the sections they administer. Manage
// Users lists every section in the Section-access editor — you have to be able
// to see that one of your requesters also works for Automation — but the rows
// outside your reach are reference only.
//
// The mechanism worth testing is the membership rewrite: it used to deactivate
// EVERY membership row and re-insert whatever the form submitted, which let a
// section admin grant, retune or silently revoke access in somebody else's
// section. Scoped, it must leave those rows byte-for-byte alone while still
// giving a global admin the full replace-all it always had.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query, POLICY_VERSION } = require("./helpers/setup");

const ctx = fixtureContext("SASCOPE");
const app = createApp();
const OTHER_SECTION_CODE = "ZZTSASCOPEOTHER";

const isOn = value => value === true || value === 1;

describe("section admin may only touch the sections they administer", () => {
  let fixture;
  let ownSectionId; // the section our section admin administers
  let otherSectionId; // somebody else's section, which the requester also belongs to
  let roles;
  let requesterId; // home section = ownSection, fully managed by our admin
  let outsiderId; // a plain requester whose HOME section is otherSection
  let peerId; // section admin of otherSection, holding a membership in ownSection
  let admin; // section admin of ownSection
  let sysAdmin;

  // PATCH /users/:id validates the whole identity block, so every call sends it
  // whether or not it is what the test is changing.
  function requesterBody(memberships) {
    return {
      employeeNo: "SASCOPE-REQ",
      email: ctx.testEmail("requester"),
      displayName: "SASCOPE requester",
      roleId: roles.REQUESTER,
      branch: "HQ",
      department: "Automation",
      section: ctx.SECTION_CODE,
      isActive: true,
      memberships
    };
  }

  async function membership(sectionId, userId = requesterId) {
    return (await query(
      `SELECT can_request, can_work, is_active
       FROM user_section_memberships WHERE user_id=@userId AND section_id=@sectionId`,
      { userId, sectionId }
    )).recordset[0];
  }

  // Both memberships full-on, so each test starts from the same place.
  async function resetMemberships() {
    for (const sectionId of [ownSectionId, otherSectionId]) {
      await query(
        `UPDATE user_section_memberships SET can_request=1, can_work=1, is_active=1
         WHERE user_id=@userId AND section_id=@sectionId`,
        { userId: requesterId, sectionId }
      );
    }
  }

  async function dropOtherSection() {
    const row = (await query(
      "SELECT id FROM request_sections WHERE code=@code", { code: OTHER_SECTION_CODE }
    )).recordset[0];
    if (!row) return;
    await query("DELETE FROM user_section_memberships WHERE section_id=@sid", { sid: row.id });
    await query("DELETE FROM request_sections WHERE id=@sid", { sid: row.id });
  }

  before(async () => {
    await dropOtherSection(); // leftovers from a crashed run
    fixture = await ctx.createFixture();
    ownSectionId = fixture.sectionId;
    requesterId = fixture.users.requester;

    const rows = (await query("SELECT id, code FROM roles WHERE code IN ('SECTION_ADMIN','REQUESTER','ADMIN')"))
      .recordset;
    roles = Object.fromEntries(rows.map(r => [r.code, r.id]));
    assert.ok(roles.SECTION_ADMIN, "roles table has no SECTION_ADMIN role");

    otherSectionId = (await query(
      `INSERT INTO request_sections (code, name, description, request_prefix, is_active)
       OUTPUT INSERTED.id
       VALUES (@code, 'API Test SASCOPE other', 'created by npm test — safe to delete', 'ZZSASCOP2', 1)`,
      { code: OTHER_SECTION_CODE }
    )).recordset[0].id;

    // The requester works for both sections — this is the membership the section
    // admin of ownSection must not be able to reach.
    await query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_active)
       VALUES (@userId, @sectionId, 1, 1, 1)`,
      { userId: requesterId, sectionId: otherSectionId }
    );

    // Reuse the fixture's password hash so ctx.login works for these two too.
    const hash = (await query("SELECT TOP 1 password_hash FROM users WHERE id=@id", { id: requesterId }))
      .recordset[0].password_hash;
    // `section` is the HOME section label — the thing that decides whose account
    // this is. The fixture stores section CODES there, which is one of the two
    // forms the ownership check accepts (the other is the display name).
    const newUser = async (name, roleId, section = ctx.SECTION_CODE) => (await query(
      `INSERT INTO users (email, display_name, password_hash, role_id, section, is_active, pdpa_consent_accepted, pdpa_policy_version)
       OUTPUT INSERTED.id
       VALUES (@email, @displayName, @hash, @roleId, @section, 1, 1, @policyVersion)`,
      {
        email: ctx.testEmail(name),
        displayName: `SASCOPE ${name}`,
        hash,
        roleId,
        section,
        policyVersion: POLICY_VERSION
      }
    )).recordset[0].id;

    const adminId = await newUser("sectionadmin", roles.SECTION_ADMIN);
    await query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_section_admin, is_active)
       VALUES (@id, @sectionId, 1, 1, 1, 1)`,
      { id: adminId, sectionId: ownSectionId }
    );
    await newUser("sysadmin", roles.ADMIN);

    // The case this whole file exists for: someone who administers ANOTHER
    // section and was granted can_request (only) in ours. They belong to this
    // section's list, and their access here is this section's to set — but
    // nothing else about the account is.
    peerId = await newUser("peeradmin", roles.SECTION_ADMIN, OTHER_SECTION_CODE);
    await query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_section_admin, is_active)
       VALUES (@id, @own, 1, 0, 0, 1), (@id, @other, 1, 1, 1, 1)`,
      { id: peerId, own: ownSectionId, other: otherSectionId }
    );

    // A PLAIN requester of the other section, granted can_request here. Role is
    // no help — only the home section says this account is not ours.
    outsiderId = await newUser("outsider", roles.REQUESTER, OTHER_SECTION_CODE);
    await query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_active)
       VALUES (@id, @own, 1, 0, 1), (@id, @other, 1, 1, 1)`,
      { id: outsiderId, own: ownSectionId, other: otherSectionId }
    );

    admin = await ctx.login(app, "sectionadmin");
    sysAdmin = await ctx.login(app, "sysadmin");
  });

  after(async () => {
    await dropOtherSection();
    await ctx.cleanupFixture();
    await closePool();
  });

  it("lists every section but marks only the administered one manageable", async () => {
    const res = await admin.get("/api/users/manage-sections");
    assert.equal(res.status, 200);
    const byId = new Map(res.body.data.map(s => [s.id, s]));
    assert.ok(byId.has(ownSectionId), "the section admin's own section must be listed");
    assert.ok(byId.has(otherSectionId), "and so must the other section, for reference");
    assert.equal(byId.get(ownSectionId).manageable, true);
    assert.equal(byId.get(otherSectionId).manageable, false);
  });

  it("marks every section manageable for a global admin", async () => {
    const res = await sysAdmin.get("/api/users/manage-sections");
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0);
    assert.ok(res.body.data.every(s => s.manageable === true), "a global admin manages every section");
  });

  it("applies its edit to its own section and ignores the other one", async () => {
    await resetMemberships();
    // The form cannot send this (the row is disabled), but a hand-rolled request
    // can — the backend is the thing being tested.
    const res = await admin.patch(`/api/users/${requesterId}`).send(requesterBody([
      { sectionId: ownSectionId, canRequest: true, canWork: false },
      { sectionId: otherSectionId, canRequest: false, canWork: false }
    ]));
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const own = await membership(ownSectionId);
    assert.ok(isOn(own.can_request) && !isOn(own.can_work), "its own section takes the change");

    const other = await membership(otherSectionId);
    assert.ok(isOn(other.can_request), "the other section's can_request is not theirs to revoke");
    assert.ok(isOn(other.can_work), "nor its can_work");
    assert.ok(isOn(other.is_active));
  });

  it("cannot deactivate a membership in a section it does not administer", async () => {
    await resetMemberships();
    // Omitting a section from the list is how access is revoked — it must only
    // revoke within scope.
    const res = await admin.patch(`/api/users/${requesterId}`).send(requesterBody([
      { sectionId: ownSectionId, canRequest: true, canWork: true }
    ]));
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.ok(isOn((await membership(otherSectionId)).is_active),
      "the other section's membership must survive an out-of-scope omission");
    assert.ok(isOn((await membership(ownSectionId)).is_active));
  });

  it("cannot grant access to a section it does not administer", async () => {
    await resetMemberships();
    await query(
      "UPDATE user_section_memberships SET is_active=0 WHERE user_id=@userId AND section_id=@sectionId",
      { userId: requesterId, sectionId: otherSectionId }
    );
    const res = await admin.patch(`/api/users/${requesterId}`).send(requesterBody([
      { sectionId: ownSectionId, canRequest: true, canWork: true },
      { sectionId: otherSectionId, canRequest: true, canWork: true }
    ]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!isOn((await membership(otherSectionId)).is_active),
      "an out-of-scope grant must not reinstate the membership");
  });

  it("still revokes within its own section", async () => {
    await resetMemberships();
    const res = await admin.patch(`/api/users/${requesterId}`).send(requesterBody([]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!isOn((await membership(ownSectionId)).is_active), "its own section is revocable");
    assert.ok(isOn((await membership(otherSectionId)).is_active), "the other section is not");
  });

  it("lists another section's admin who holds a membership here", async () => {
    const res = await admin.get("/api/users");
    assert.equal(res.status, 200);
    const ids = res.body.data.map(u => u.id);
    assert.ok(ids.includes(peerId), "a member of my section is listed whatever role they carry");
    assert.ok(!res.body.data.some(u => `${u.role_code}`.toUpperCase() === "ADMIN"),
      "but global admins are not a section admin's business");
  });

  it("refuses to edit that peer's identity through PATCH /users/:id", async () => {
    const res = await admin.patch(`/api/users/${peerId}`).send({
      employeeNo: "SASCOPE-HIJACK",
      email: ctx.testEmail("peeradmin"),
      displayName: "SASCOPE hijacked",
      roleId: roles.REQUESTER,
      branch: "HQ",
      department: "Automation",
      section: ctx.SECTION_CODE,
      isActive: false,
      memberships: [{ sectionId: ownSectionId, canRequest: true, canWork: true }]
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /cannot manage/i);
    const row = (await query(
      "SELECT display_name, role_id, is_active FROM users WHERE id=@id", { id: peerId }
    )).recordset[0];
    assert.equal(row.display_name, "SASCOPE peeradmin", "the name must be untouched");
    assert.equal(row.role_id, roles.SECTION_ADMIN, "and the role");
    assert.ok(isOn(row.is_active), "and the active flag");
  });

  it("can set that peer's access to its OWN section, and only that", async () => {
    const res = await admin.patch(`/api/users/${peerId}/section-access`).send({
      memberships: [
        { sectionId: ownSectionId, canRequest: true, canWork: true },
        { sectionId: otherSectionId, canRequest: false, canWork: false }
      ]
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const own = await membership(ownSectionId, peerId);
    assert.ok(isOn(own.can_work), "granting can_work in my own section is allowed");

    const other = await membership(otherSectionId, peerId);
    assert.ok(isOn(other.can_request) && isOn(other.can_work),
      "the section they administer is untouched");
  });

  it("cannot demote a peer out of the section they administer", async () => {
    // Both routes to a demotion: omitting the row (deactivate) and re-submitting
    // it with the flag cleared, which is all the form can ever send.
    const dropped = await admin.patch(`/api/users/${peerId}/section-access`).send({
      memberships: [{ sectionId: ownSectionId, canRequest: true, canWork: true }]
    });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));

    const cleared = await admin.patch(`/api/users/${peerId}/section-access`).send({
      memberships: [
        { sectionId: ownSectionId, canRequest: true, canWork: true },
        { sectionId: otherSectionId, canRequest: true, canWork: true, isSectionAdmin: false }
      ]
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

    const row = (await query(
      `SELECT is_section_admin, is_active FROM user_section_memberships
       WHERE user_id=@userId AND section_id=@sectionId`,
      { userId: peerId, sectionId: otherSectionId }
    )).recordset[0];
    assert.ok(isOn(row.is_section_admin), "the peer still administers their own section");
    assert.ok(isOn(row.is_active));
  });

  it("cannot reset that peer's password", async () => {
    const res = await admin.post(`/api/users/${peerId}/reset-password`).send({ password: "Peer#987654" });
    assert.equal(res.status, 403);
  });

  // ── A plain requester who simply belongs to another section ──────────────
  // The role guard waves these through (REQUESTER is manageable), so the home
  // section is the only thing standing between them and a full edit.

  it("lists an outside requester who holds a membership here", async () => {
    const res = await admin.get("/api/users");
    assert.equal(res.status, 200);
    assert.ok(res.body.data.map(u => u.id).includes(outsiderId));
  });

  it("refuses to edit an outside requester's identity", async () => {
    const res = await admin.patch(`/api/users/${outsiderId}`).send({
      employeeNo: "SASCOPE-OUT",
      email: ctx.testEmail("outsider"),
      displayName: "SASCOPE hijacked outsider",
      roleId: roles.REQUESTER,
      branch: "HQ",
      department: "Automation",
      section: OTHER_SECTION_CODE,
      isActive: false,
      memberships: [{ sectionId: ownSectionId, canRequest: true, canWork: true }]
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /another section/i);
    const row = (await query(
      "SELECT display_name, is_active FROM users WHERE id=@id", { id: outsiderId }
    )).recordset[0];
    assert.equal(row.display_name, "SASCOPE outsider");
    assert.ok(isOn(row.is_active));
  });

  it("cannot reset an outside requester's password", async () => {
    const res = await admin.post(`/api/users/${outsiderId}/reset-password`).send({ password: "Out#9876543" });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /another section/i);
  });

  it("can still set an outside requester's access to its own section", async () => {
    const res = await admin.patch(`/api/users/${outsiderId}/section-access`).send({
      memberships: [
        { sectionId: ownSectionId, canRequest: true, canWork: true },
        { sectionId: otherSectionId, canRequest: false, canWork: false }
      ]
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(isOn((await membership(ownSectionId, outsiderId)).can_work));
    const other = await membership(otherSectionId, outsiderId);
    assert.ok(isOn(other.can_request) && isOn(other.can_work), "their home section is untouched");
  });

  it("cannot move one of its OWN users into another section", async () => {
    const res = await admin.patch(`/api/users/${requesterId}`).send({
      ...requesterBody([{ sectionId: ownSectionId, canRequest: true, canWork: true }]),
      section: OTHER_SECTION_CODE
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /administer/i);
  });

  it("cannot create a user in a section it does not administer", async () => {
    const res = await admin.post("/api/users").send({
      employeeNo: "SASCOPE-NEW",
      email: ctx.testEmail("planted"),
      displayName: "SASCOPE planted",
      password: "Planted#12345",
      roleId: roles.REQUESTER,
      branch: "HQ",
      department: "Automation",
      section: OTHER_SECTION_CODE,
      memberships: [{ sectionId: ownSectionId, canRequest: true, canWork: true }]
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /administer/i);
    const planted = (await query(
      "SELECT id FROM users WHERE email=@email", { email: ctx.testEmail("planted") }
    )).recordset[0];
    assert.equal(planted, undefined, "no account may be left behind by a refused create");
  });

  it("still fully manages a requester of its own section", async () => {
    const res = await admin.patch(`/api/users/${requesterId}`).send(
      requesterBody([{ sectionId: ownSectionId, canRequest: true, canWork: true }])
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const reset = await admin.post(`/api/users/${requesterId}/reset-password`).send({ password: "Mine#9876543" });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
  });

  it("leaves a global admin's replace-all reach intact", async () => {
    await resetMemberships();
    const res = await sysAdmin.patch(`/api/users/${requesterId}`).send(requesterBody([
      { sectionId: ownSectionId, canRequest: true, canWork: true }
    ]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!isOn((await membership(otherSectionId)).is_active),
      "a global admin's omission still deactivates any section");
    await resetMemberships();
  });
});
