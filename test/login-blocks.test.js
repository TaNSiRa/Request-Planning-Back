// Settings › Login blocks: the per-IP limiter and the per-account lock are
// tripped by the SAME five wrong passwords, so they have to be seen and
// released together. Runs with the production limiter (5 per IP) — one limiter
// for the whole process — so both guards are really in play.
//
// The wrong passwords come from a made-up address of this suite's own. Releasing
// an IP unlocks EVERY account that failed from it, and the lockout suite runs in
// parallel from the same loopback address — sharing it let one of our releases
// reset that suite's count mid-loop. Set BEFORE helpers/setup loads env, so
// X-Forwarded-For is trusted for this process only.
process.env.TRUST_PROXY_HOPS = "1";
const SUITE_IP = "203.0.113.77";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, query, PASSWORD } = require("./helpers/setup");
const { MAX_FAILURES } = require("../src/services/loginLockout");
const { listBlockedIps, releaseIp } = require("../src/services/loginIpBlocks");

const ctx = fixtureContext("LBLK");
const WRONG = "definitely-not-the-password";

let fixture;

describe("login blocks: IP and account released together", () => {
  before(async () => {
    fixture = await ctx.createFixture();
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  beforeEach(async () => {
    // Only this fixture's accounts: test files run in parallel, and the
    // lockout suite's locks must not be cleared from under it. Each case builds
    // a fresh app, so the limiter starts empty anyway.
    await query(
      "UPDATE users SET failed_login_count = 0, login_locked_until = NULL WHERE email LIKE @pattern",
      { pattern: `%@${ctx.EMAIL_DOMAIN}` }
    );
    // The limiter is created once when auth.routes loads, so a new app does NOT
    // bring a new one — free the loopback address the previous case used up.
    for (const ip of [...listBlockedIps().map(b => b.ip), SUITE_IP, "::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
      await releaseIp(ip);
    }
  });

  // A fresh app (fresh limiter) with approver1 signed in as global admin BEFORE
  // any failure, since the exhausted limiter would refuse the admin's own login.
  async function setup(fn) {
    const app = createApp();
    const adminRoleId = (await query("SELECT id FROM roles WHERE code = 'ADMIN'")).recordset[0].id;
    const email = ctx.testEmail("approver1");
    const previousRole = (await query("SELECT role_id FROM users WHERE email = @email", { email })).recordset[0].role_id;
    await query("UPDATE users SET role_id = @roleId WHERE email = @email", { roleId: adminRoleId, email });
    try {
      const admin = await ctx.login(app, "approver1");
      await fn(app, admin);
    } finally {
      await query("UPDATE users SET role_id = @roleId WHERE email = @email", { roleId: previousRole, email });
    }
  }

  async function failFiveTimes(app, email) {
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await supertest(app).post("/api/auth/login").set("X-Forwarded-For", SUITE_IP).send({ email, password: WRONG });
      assert.equal(res.status, 401);
    }
  }

  it("both the IP and the account are listed right after the 5th failure", async () => {
    await setup(async (app, admin) => {
      const email = ctx.testEmail("requester");
      await failFiveTimes(app, email);

      const res = await admin.get("/api/auth/login-blocks");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.length, 1, "the IP shows without waiting for a 6th attempt");
      const account = res.body.accounts.find(a => a.id === fixture.users.requester);
      assert.ok(account, "the locked account is listed in Settings too");
      assert.ok(account.ips.includes(res.body.data[0].ip), "with the IP it failed from");
    });
  });

  it("unlocking the account from Settings also frees the IP", async () => {
    await setup(async (app, admin) => {
      const email = ctx.testEmail("requester");
      await failFiveTimes(app, email);

      const unlock = await admin.post(`/api/auth/login-blocks/accounts/${fixture.users.requester}/unlock`).send({});
      assert.equal(unlock.status, 200, JSON.stringify(unlock.body));

      const back = await supertest(app).post("/api/auth/login").set("X-Forwarded-For", SUITE_IP).send({ email, password: PASSWORD });
      assert.equal(back.status, 200, `neither 429 (IP) nor 401 (account): ${JSON.stringify(back.body)}`);
      const after = await admin.get("/api/auth/login-blocks");
      assert.equal(after.body.data.length, 0);
      // Only our own accounts: the lockout suite's locks show here too while it runs.
      const ours = new Set(Object.values(fixture.users));
      assert.equal(after.body.accounts.filter(a => ours.has(a.id)).length, 0);
    });
  });

  it("releasing the IP also unlocks the account it locked", async () => {
    await setup(async (app, admin) => {
      const email = ctx.testEmail("requester");
      await failFiveTimes(app, email);
      const ip = (await admin.get("/api/auth/login-blocks")).body.data[0].ip;

      const release = await admin.del(`/api/auth/login-blocks/${encodeURIComponent(ip)}`);
      assert.equal(release.status, 200, JSON.stringify(release.body));

      const back = await supertest(app).post("/api/auth/login").set("X-Forwarded-For", SUITE_IP).send({ email, password: PASSWORD });
      assert.equal(back.status, 200, JSON.stringify(back.body));
    });
  });

  it("Manage Users › Unlock also frees the IP", async () => {
    await setup(async (app, admin) => {
      const email = ctx.testEmail("requester");
      await failFiveTimes(app, email);

      const unlock = await admin.post(`/api/users/${fixture.users.requester}/unlock`).send({});
      assert.equal(unlock.status, 200, JSON.stringify(unlock.body));

      const back = await supertest(app).post("/api/auth/login").set("X-Forwarded-For", SUITE_IP).send({ email, password: PASSWORD });
      assert.equal(back.status, 200, JSON.stringify(back.body));
    });
  });
});
