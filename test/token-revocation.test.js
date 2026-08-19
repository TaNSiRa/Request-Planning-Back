// Bearer tokens must stop working the moment the account behind them is signed
// out, has its password changed or reset, or is deactivated — rather than
// staying valid for the rest of JWT_EXPIRES_IN.
//
// Requires database/patch_token_version.sql. Without the column the guard is
// skipped by design (availability over revocation) and these tests fail, which
// is the intended signal that the patch has not been applied.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, query, PASSWORD, POLICY_VERSION } = require("./helpers/setup");
const { forgetAccount } = require("../src/services/accountState");

const ctx = fixtureContext("REVOKE");
const app = createApp();

// A bearer-only client: no cookie jar, so every call is authenticated by the
// token alone — exactly the credential this feature is about.
function bearer(token) {
  const withHeaders = req => req.set("authorization", `Bearer ${token}`).set("x-section-code", ctx.SECTION_CODE);
  return {
    get: url => withHeaders(supertest(app).get(url)),
    post: url => withHeaders(supertest(app).post(url)),
    patch: url => withHeaders(supertest(app).patch(url))
  };
}

async function loginToken(name) {
  const res = await supertest(app)
    .post("/api/auth/login")
    .send({ email: ctx.testEmail(name), password: PASSWORD });
  assert.equal(res.status, 200, `login as ${name} failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, "login must return a bearer token");
  return res.body.token;
}

describe("bearer token revocation", () => {
  let fixture;
  let adminId;

  before(async () => {
    fixture = await ctx.createFixture();
    // A global admin inside the fixture's email namespace, so cleanupFixture
    // removes it along with everyone else.
    const adminRole = (await query("SELECT TOP 1 id FROM roles WHERE code='ADMIN'")).recordset[0];
    assert.ok(adminRole, "roles table has no ADMIN role");
    const hash = (await query("SELECT TOP 1 password_hash FROM users WHERE id=@id", { id: fixture.users.requester }))
      .recordset[0].password_hash;
    adminId = (await query(
      `INSERT INTO users (email, display_name, password_hash, role_id, section, is_active, pdpa_consent_accepted, pdpa_policy_version)
       OUTPUT INSERTED.id
       VALUES (@email, 'REVOKE sysadmin', @hash, @roleId, @section, 1, 1, @policyVersion)`,
      {
        email: ctx.testEmail("sysadmin"),
        hash,
        roleId: adminRole.id,
        section: ctx.SECTION_CODE,
        policyVersion: POLICY_VERSION
      }
    )).recordset[0].id;
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("a fresh token works, and stops working after logout", async () => {
    const token = await loginToken("member");

    const before = await bearer(token).get("/api/auth/me");
    assert.equal(before.status, 200, "the token should authenticate before logout");

    const logout = await bearer(token).post("/api/auth/logout");
    assert.equal(logout.status, 200);

    const after = await bearer(token).get("/api/auth/me");
    assert.equal(after.status, 401, "the same token must be dead after logout");
    assert.equal(after.body.message, "SESSION_REVOKED");
  });

  it("changing your own password kills the old token and hands back a working one", async () => {
    const token = await loginToken("requester");
    const newPassword = "Rotated#5678";

    const change = await bearer(token)
      .patch("/api/users/me/password")
      .send({ currentPassword: PASSWORD, newPassword });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    assert.ok(change.body.token, "a replacement token must come back");
    assert.notEqual(change.body.token, token);

    const withOld = await bearer(token).get("/api/auth/me");
    assert.equal(withOld.status, 401, "the pre-change token must be revoked");

    const withNew = await bearer(change.body.token).get("/api/auth/me");
    assert.equal(withNew.status, 200, "the caller's own tab keeps working");

    // Put the fixture password back so the shared PASSWORD constant stays true
    // for anything running after this case.
    const restore = await bearer(change.body.token)
      .patch("/api/users/me/password")
      .send({ currentPassword: newPassword, newPassword: PASSWORD });
    assert.equal(restore.status, 200);
  });

  it("an admin resetting a password signs that user out everywhere", async () => {
    const victimToken = await loginToken("approver1");
    assert.equal((await bearer(victimToken).get("/api/auth/me")).status, 200);

    const adminToken = await loginToken("sysadmin");
    const reset = await bearer(adminToken)
      .post(`/api/users/${fixture.users.approver1}/reset-password`)
      .send({ password: "Reset#91011" });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const after = await bearer(victimToken).get("/api/auth/me");
    assert.equal(after.status, 401, "the reset must invalidate the live token");

    // The admin's own token is untouched.
    assert.equal((await bearer(adminToken).get("/api/auth/me")).status, 200);
  });

  it("a deactivated account cannot keep using a token it already holds", async () => {
    const token = await loginToken("approver2");
    assert.equal((await bearer(token).get("/api/auth/me")).status, 200);

    await query("UPDATE users SET is_active = 0 WHERE id = @id", { id: fixture.users.approver2 });
    forgetAccount(fixture.users.approver2); // skip the short in-process cache

    const after = await bearer(token).get("/api/auth/me");
    assert.equal(after.status, 401);
    assert.equal(after.body.message, "ACCOUNT_DISABLED");

    await query("UPDATE users SET is_active = 1 WHERE id = @id", { id: fixture.users.approver2 });
    forgetAccount(fixture.users.approver2);
  });

  it("weak passwords are refused before anything is revoked", async () => {
    const token = await loginToken("coapprover");
    const res = await bearer(token)
      .patch("/api/users/me/password")
      .send({ currentPassword: PASSWORD, newPassword: "short1" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least 8 characters/i);

    assert.equal((await bearer(token).get("/api/auth/me")).status, 200, "the token survives a rejected change");
  });

  it("uses the token's own identity, not one supplied by the caller", async () => {
    const token = await loginToken("member");
    const res = await bearer(token).get("/api/auth/me");
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, ctx.testEmail("member"));
    assert.ok(adminId, "fixture admin exists");
    assert.notEqual(res.body.user.id, adminId);
  });
});
