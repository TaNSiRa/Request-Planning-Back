// A section admin has to be able to edit their OWN section access (can_request
// / can_work) — Manage Users is the only place those flags exist, and the list
// used to filter them out for not being a plain requester.
//
// The interesting half is what self-edit must NOT become: a way to change your
// own role, deactivate yourself, drop yourself out of the section you
// administer, or (via the replace-all membership rewrite, which a non-global
// actor performs with is_section_admin forced to 0) silently demote yourself.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");

const ctx = fixtureContext("SELFED");
const app = createApp();

describe("section admin editing their own Manage Users row", () => {
  let fixture;
  let sectionId;
  let roles;
  let adminId;
  let otherAdminId;
  let admin;

  // The identity block PATCH /users/:id validates in full, so every call has to
  // send it whether or not it is what the test is changing.
  function body(overrides = {}) {
    return {
      employeeNo: "SELFED-SA",
      email: ctx.testEmail("sectionadmin"),
      displayName: "SELFED sectionadmin",
      roleId: roles.SECTION_ADMIN,
      branch: "HQ",
      department: "Automation",
      section: ctx.SECTION_CODE,
      isActive: true,
      memberships: [{ sectionId, canRequest: true, canWork: true, isSectionAdmin: false }],
      ...overrides
    };
  }

  async function membership(userId) {
    return (await query(
      `SELECT can_request, can_work, is_section_admin, is_active
       FROM user_section_memberships WHERE user_id=@userId AND section_id=@sectionId`,
      { userId, sectionId }
    )).recordset[0];
  }

  before(async () => {
    fixture = await ctx.createFixture();
    sectionId = fixture.sectionId;
    const rows = (await query("SELECT id, code FROM roles WHERE code IN ('SECTION_ADMIN','REQUESTER','ADMIN')"))
      .recordset;
    roles = Object.fromEntries(rows.map(r => [r.code, r.id]));
    assert.ok(roles.SECTION_ADMIN, "roles table has no SECTION_ADMIN role");

    // Reuse the fixture's password hash so ctx.login works for these two too.
    const hash = (await query("SELECT TOP 1 password_hash FROM users WHERE id=@id", { id: fixture.users.requester }))
      .recordset[0].password_hash;
    for (const name of ["sectionadmin", "othersectionadmin"]) {
      const id = (await query(
        `INSERT INTO users (email, display_name, password_hash, role_id, section, is_active, pdpa_consent_accepted)
         OUTPUT INSERTED.id
         VALUES (@email, @displayName, @hash, @roleId, @section, 1, 1)`,
        {
          email: ctx.testEmail(name),
          displayName: `SELFED ${name}`,
          hash,
          roleId: roles.SECTION_ADMIN,
          section: ctx.SECTION_CODE
        }
      )).recordset[0].id;
      await query(
        `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_section_admin, is_active)
         VALUES (@id, @sectionId, 1, 1, 1, 1)`,
        { id, sectionId }
      );
      if (name === "sectionadmin") adminId = id; else otherAdminId = id;
    }
    admin = await ctx.login(app, "sectionadmin");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("sees their own row in the user list, alongside every other member", async () => {
    const res = await admin.get("/api/users");
    assert.equal(res.status, 200);
    const ids = res.body.data.map(u => u.id);
    assert.ok(ids.includes(adminId), "a section admin must see their own row");
    assert.ok(ids.includes(fixture.users.requester), "and still sees the requesters they manage");
    // Listed since 2026-08-11: another section admin holding a membership here is
    // a member of this section, and their access to it is this section's to set.
    // Seeing the row is not managing it — the identity guard below still holds.
    assert.ok(ids.includes(otherAdminId), "and a peer section admin who is a member here");
  });

  it("can turn their own can_request / can_work off and on", async () => {
    const off = await admin.patch(`/api/users/${adminId}`).send(
      body({ memberships: [{ sectionId, canRequest: false, canWork: false, isSectionAdmin: false }] })
    );
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const afterOff = await membership(adminId);
    assert.ok(afterOff.can_request === false || afterOff.can_request === 0);
    assert.ok(afterOff.can_work === false || afterOff.can_work === 0);

    const on = await admin.patch(`/api/users/${adminId}`).send(body());
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const afterOn = await membership(adminId);
    assert.ok(afterOn.can_request === true || afterOn.can_request === 1);
    assert.ok(afterOn.can_work === true || afterOn.can_work === 1);
  });

  it("keeps its section-admin flag through a self-edit that cannot grant one", async () => {
    // The form sends isSectionAdmin: false (a section admin is never offered
    // the toggle) — the flag has to survive anyway, or the edit is a demotion.
    const res = await admin.patch(`/api/users/${adminId}`).send(body());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await membership(adminId);
    assert.ok(row.is_section_admin === true || row.is_section_admin === 1, "must still administer the section");
    assert.ok(row.is_active === true || row.is_active === 1);
  });

  it("cannot change their own role", async () => {
    const res = await admin.patch(`/api/users/${adminId}`).send(body({ roleId: roles.REQUESTER }));
    assert.equal(res.status, 403);
    assert.match(res.body.message, /own role/i);
    assert.equal((await query("SELECT role_id FROM users WHERE id=@id", { id: adminId })).recordset[0].role_id,
      roles.SECTION_ADMIN);
  });

  it("cannot promote itself to global admin either", async () => {
    const res = await admin.patch(`/api/users/${adminId}`).send(body({ roleId: roles.ADMIN }));
    assert.equal(res.status, 403);
  });

  it("cannot deactivate their own account", async () => {
    const res = await admin.patch(`/api/users/${adminId}`).send(body({ isActive: false }));
    assert.equal(res.status, 403);
    assert.match(res.body.message, /deactivate/i);
  });

  it("cannot drop itself out of the section it administers", async () => {
    const res = await admin.patch(`/api/users/${adminId}`).send(body({ memberships: [] }));
    assert.equal(res.status, 403);
    assert.match(res.body.message, /administer/i);
    const row = await membership(adminId);
    assert.ok(row.is_active === true || row.is_active === 1);
  });

  it("still cannot edit ANOTHER section admin", async () => {
    const res = await admin.patch(`/api/users/${otherAdminId}`).send(
      body({ email: ctx.testEmail("othersectionadmin"), displayName: "SELFED othersectionadmin" })
    );
    assert.equal(res.status, 403);
    assert.match(res.body.message, /cannot manage/i);
  });

  it("still cannot reset its own password from the admin endpoint", async () => {
    const res = await admin.post(`/api/users/${adminId}/reset-password`).send({ password: "SelfEd#98765" });
    assert.equal(res.status, 403);
  });
});
