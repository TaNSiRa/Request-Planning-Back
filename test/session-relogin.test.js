// Signing in again must work even when the browser still holds the session
// cookie of a sign-in that has since been revoked (a logout on another device,
// a password change, an admin reset, a deactivation).
//
// That cookie's session object still carries `.user`, which is what csrfProtection
// keys on — so before the login endpoints were exempted, the second sign-in came
// back 403 CSRF_REQUIRED and stayed that way: the login page polls /health every
// 10s and `rolling: true` keeps re-upping the dead cookie.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, PASSWORD } = require("./helpers/setup");
const { env } = require("../src/config/env");

const ctx = fixtureContext("RELOGIN");
const app = createApp();

function sessionCookie(res) {
  const jar = res.headers["set-cookie"] || [];
  return jar.find(c => c.startsWith(`${env.session.cookieName}=`)) || null;
}

function sessionId(cookie) {
  return cookie ? `${cookie.split(";")[0].split("=")[1]}` : null;
}

// Revokes every credential the account holds (this is what /auth/logout does on
// another device), leaving THIS agent's cookie behind as the stale one.
async function revokeElsewhere(name) {
  const res = await supertest(app).post("/api/auth/login").send({ email: ctx.testEmail(name), password: PASSWORD });
  assert.equal(res.status, 200, `login as ${name} failed: ${JSON.stringify(res.body)}`);
  const out = await supertest(app)
    .post("/api/auth/logout")
    .set("authorization", `Bearer ${res.body.token}`);
  assert.equal(out.status, 200);
}

// File-scoped so BOTH describes below share one fixture: a per-describe after()
// would tear the users down (and close the pool) before the second one ran.
before(async () => {
  await ctx.createFixture();
});

after(async () => {
  await ctx.cleanupFixture();
  await closePool();
});

describe("signing in again over a stale session", () => {
  it("accepts a fresh login from a cookie jar whose session was revoked elsewhere", async () => {
    const agent = supertest.agent(app);
    const first = await agent.post("/api/auth/login").send({ email: ctx.testEmail("member"), password: PASSWORD });
    assert.equal(first.status, 200);

    await revokeElsewhere("member");

    // No x-csrf-token: a freshly loaded login page has never been given one.
    const again = await agent.post("/api/auth/login").send({ email: ctx.testEmail("member"), password: PASSWORD });
    assert.equal(again.status, 200, `re-login was blocked: ${JSON.stringify(again.body)}`);
    assert.ok(again.body.csrfToken, "the new session hands out a new CSRF token");

    // And the session it just created is usable for a write.
    const write = await agent
      .post("/api/auth/logout")
      .set("x-csrf-token", again.body.csrfToken);
    assert.equal(write.status, 200);
  });

  it("gives the new sign-in a new session id instead of adopting the one presented", async () => {
    const agent = supertest.agent(app);
    const first = await agent.post("/api/auth/login").send({ email: ctx.testEmail("requester"), password: PASSWORD });
    const before = sessionId(sessionCookie(first));
    assert.ok(before, "login sets a session cookie");

    const second = await agent.post("/api/auth/login").send({ email: ctx.testEmail("requester"), password: PASSWORD });
    assert.equal(second.status, 200);
    const after = sessionId(sessionCookie(second));
    assert.ok(after, "the second login re-issues the cookie");
    assert.notEqual(after, before, "session fixation: the id must not carry over");
  });

  it("drops the session cookie when a cookie-authenticated call turns out to be revoked", async () => {
    const agent = supertest.agent(app);
    const login = await agent.post("/api/auth/login").send({ email: ctx.testEmail("approver1"), password: PASSWORD });
    assert.equal(login.status, 200);

    await revokeElsewhere("approver1");

    const res = await agent.get("/api/auth/session");
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "SESSION_REVOKED");
    assert.ok(sessionCookie(res), "the dead cookie is cleared rather than left in the browser");
  });

  it("still demands a CSRF token on an ordinary write with a live session", async () => {
    const agent = supertest.agent(app);
    const login = await agent.post("/api/auth/login").send({ email: ctx.testEmail("approver2"), password: PASSWORD });
    assert.equal(login.status, 200);

    const res = await agent.post("/api/auth/logout");
    assert.equal(res.status, 403, "the login exemption must not widen to anything else");
    assert.equal(res.body.message, "CSRF_REQUIRED");
  });
});

// The server-side idle window only means something if ordinary background noise
// does not keep re-upping it. /api/health is mounted above the session
// middleware for exactly that reason, and /api/auth/keepalive is the deliberate
// way back in.
describe("what keeps a session alive", () => {
  it("does not touch the session cookie on the public health poll", async () => {
    const agent = supertest.agent(app);
    const login = await agent.post("/api/auth/login").send({ email: ctx.testEmail("member"), password: PASSWORD });
    assert.equal(login.status, 200);
    assert.ok(sessionCookie(login), "login issues the cookie");

    const health = await agent.get("/api/health");
    assert.equal(health.status, 200);
    assert.equal(
      sessionCookie(health),
      null,
      "rolling must not re-issue the cookie here, or the idle timeout never expires"
    );
  });

  it("re-issues the cookie on the keepalive ping, and refuses it without a login", async () => {
    const anonymous = await supertest(app).get("/api/auth/keepalive");
    assert.equal(anonymous.status, 401);

    const agent = supertest.agent(app);
    const login = await agent.post("/api/auth/login").send({ email: ctx.testEmail("coapprover"), password: PASSWORD });
    assert.equal(login.status, 200);

    const ping = await agent.get("/api/auth/keepalive");
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true });
    assert.ok(sessionCookie(ping), "the ping is the thing that pushes the idle window out");
  });
});
