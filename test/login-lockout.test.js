// Account lockout after repeated failed sign-ins (Control 3, R3.3).
//
// The per-IP rate limiter is a different control and is deliberately not what
// is being tested here: these cases use a fresh app per test so the limiter's
// in-memory counter never gets in the way, and they assert on the state that
// lives on the ACCOUNT — which is the part that survives a restart and follows
// the user across addresses.
//
// Set BEFORE helpers/setup pulls in src/config/env — the per-IP limiter would
// otherwise answer 429 partway through and the account counter would never get
// the failures it is supposed to be counting. node --test gives each file its
// own process, so this does not leak into the other suites.
process.env.LOGIN_RATE_LIMIT_MAX = "10000";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, query, PASSWORD } = require("./helpers/setup");
const { MAX_FAILURES } = require("../src/services/loginLockout");

const ctx = fixtureContext("LOCK");

let fixture;

const WRONG = "definitely-not-the-password";

// A fresh app each time: express-rate-limit keeps its counter in the instance,
// so a new one means the only thing that can refuse a login is the lockout.
function freshLogin(email, password) {
  return supertest(createApp()).post("/api/auth/login").send({ email, password });
}

async function lockState(email) {
  return (await query(
    "SELECT failed_login_count AS failures, login_locked_until AS until FROM users WHERE email = @email",
    { email }
  )).recordset[0];
}

describe("account lockout after repeated failed sign-ins", () => {
  before(async () => {
    fixture = await ctx.createFixture();
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  beforeEach(async () => {
    // Every case starts from an open account.
    await query(
      "UPDATE users SET failed_login_count = 0, login_locked_until = NULL WHERE email LIKE @pattern",
      { pattern: `%@${ctx.EMAIL_DOMAIN}` }
    );
  });

  it(`locks the account on the ${MAX_FAILURES}th consecutive failure`, async () => {
    const email = ctx.testEmail("requester");

    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      const res = await freshLogin(email, WRONG);
      assert.equal(res.status, 401);
      assert.equal(
        res.body.message,
        "Invalid email, employee no, or password",
        "a wrong password says the same thing every time, locked or not"
      );
      const state = await lockState(email);
      assert.equal(state.failures, attempt);
      if (attempt < MAX_FAILURES) {
        assert.equal(state.until, null, `no lock before attempt ${MAX_FAILURES}`);
      }
    }

    const locked = await lockState(email);
    assert.ok(locked.until, "the account is locked after the last failure");
    const minutesOut = (new Date(locked.until).getTime() - Date.now()) / 60000;
    assert.ok(minutesOut > 13 && minutesOut <= 15, `lock should run ~15 minutes, got ${minutesOut.toFixed(1)}`);
  });

  it("refuses the CORRECT password while locked, and says why", async () => {
    const email = ctx.testEmail("requester");
    for (let i = 0; i < MAX_FAILURES; i++) await freshLogin(email, WRONG);

    const res = await freshLogin(email, PASSWORD);
    assert.equal(res.status, 401, "a lock that let the right password through would stop nothing");
    assert.match(res.body.message, /locked for another \d+ minute/);
  });

  it("a wrong password on a locked account still gives nothing away", async () => {
    const email = ctx.testEmail("requester");
    for (let i = 0; i < MAX_FAILURES; i++) await freshLogin(email, WRONG);

    const res = await freshLogin(email, WRONG);
    assert.equal(res.body.message, "Invalid email, employee no, or password");
  });

  it("a successful sign-in clears the count so typos never add up", async () => {
    const email = ctx.testEmail("approver1");
    for (let i = 0; i < MAX_FAILURES - 1; i++) await freshLogin(email, WRONG);
    assert.equal((await lockState(email)).failures, MAX_FAILURES - 1);

    const ok = await freshLogin(email, PASSWORD);
    assert.equal(ok.status, 200);

    const state = await lockState(email);
    assert.equal(state.failures, 0);
    assert.equal(state.until, null);
  });

  it("an expired lock lets the account back in on its own", async () => {
    const email = ctx.testEmail("approver2");
    await query(
      `UPDATE users SET failed_login_count = @failures,
                        login_locked_until = DATEADD(MINUTE, -1, SYSUTCDATETIME())
       WHERE email = @email`,
      { failures: MAX_FAILURES, email }
    );
    const res = await freshLogin(email, PASSWORD);
    assert.equal(res.status, 200, "a lock in the past is not a lock");
    assert.equal((await lockState(email)).until, null, "and it is cleared on the way through");
  });

  it("an unknown account cannot be used to probe for lock state", async () => {
    const res = await freshLogin(`nobody-${Date.now()}@${ctx.EMAIL_DOMAIN}`, WRONG);
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Invalid email, employee no, or password");
  });

  it("an admin password reset unlocks the account", async () => {
    const email = ctx.testEmail("member");
    for (let i = 0; i < MAX_FAILURES; i++) await freshLogin(email, WRONG);
    assert.ok((await lockState(email)).until, "locked to begin with");

    const app = createApp();
    const adminRoleId = (await query("SELECT id FROM roles WHERE code = 'ADMIN'")).recordset[0].id;
    const previousRole = (await query("SELECT role_id FROM users WHERE email = @email", {
      email: ctx.testEmail("approver1")
    })).recordset[0].role_id;
    await query("UPDATE users SET role_id = @roleId WHERE email = @email", {
      roleId: adminRoleId,
      email: ctx.testEmail("approver1")
    });
    try {
      const admin = await ctx.login(app, "approver1");
      const reset = await admin
        .post(`/api/users/${fixture.users.member}/reset-password`)
        .send({ password: "Reset#20260814" });
      assert.equal(reset.status, 200, JSON.stringify(reset.body));

      const state = await lockState(email);
      assert.equal(state.until, null);
      assert.equal(state.failures, 0);

      const back = await freshLogin(email, "Reset#20260814");
      assert.equal(back.status, 200, "the new password works immediately, not in 15 minutes");
    } finally {
      await query("UPDATE users SET role_id = @roleId WHERE email = @email", {
        roleId: previousRole,
        email: ctx.testEmail("approver1")
      });
    }
  });
});
