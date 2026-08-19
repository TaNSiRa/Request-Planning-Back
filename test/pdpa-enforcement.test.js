// PDPA consent is enforced by the API, not only drawn by the client.
//
// The rest of the suite runs as users who have already consented, so it proves
// the open path and nothing else. These cases cover the closed one: an account
// that has not agreed to the CURRENT policy text can still reach the endpoints
// that let it read its profile, agree, and log out — and nothing else.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext, query, POLICY_VERSION } = require("./helpers/setup");
const { forgetAccount } = require("../src/services/accountState");

const ctx = fixtureContext("PDPA");

let app;
let fixture;

// Put an account back into the "has not consented" state and hand back a fresh
// session for it — the claim rides in the token, so it has to be re-issued.
async function loginWithConsent(name, { accepted, version }) {
  await query(
    `UPDATE users SET pdpa_consent_accepted = @accepted, pdpa_policy_version = @version
     WHERE email = @email`,
    { accepted, version, email: ctx.testEmail(name) }
  );
  forgetAccount(fixture.users[name]);
  return ctx.login(app, name);
}

describe("PDPA consent is enforced server-side", () => {
  before(async () => {
    app = createApp();
    fixture = await ctx.createFixture();
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  it("a consented account reaches the business endpoints as usual", async () => {
    const user = await loginWithConsent("requester", { accepted: 1, version: POLICY_VERSION });
    assert.equal((await user.get("/api/requests")).status, 200);
    assert.equal((await user.get("/api/notifications")).status, 200);
  });

  it("an account that never consented is refused everywhere but the way out", async () => {
    const user = await loginWithConsent("member", { accepted: 0, version: null });

    for (const path of [
      "/api/requests",
      "/api/users/assignees",
      "/api/notifications",
      "/api/weekly-plan",
      "/api/personal-todo",
      "/api/branch-maps",
      "/api/kpi/summary",
      "/api/settings/request-options",
      "/api/org-chart/positions",
      "/api/skill-matrix"
    ]) {
      const res = await user.get(path);
      assert.equal(res.status, 403, `${path} should be closed before consent`);
      assert.equal(res.body.message, "PDPA_CONSENT_REQUIRED", `${path} should say why`);
    }

    // ...and a write is refused just the same.
    const write = await user.post("/api/requests").send({ title: "x" });
    assert.equal(write.status, 403);
    assert.equal(write.body.message, "PDPA_CONSENT_REQUIRED");
  });

  it("the consent page itself stays reachable", async () => {
    const user = await loginWithConsent("member", { accepted: 0, version: null });
    assert.equal((await user.get("/api/auth/me")).status, 200);
    assert.equal((await user.get("/api/auth/session")).status, 200);
    assert.equal((await user.get("/api/auth/sections")).status, 200);
    assert.equal((await user.get("/api/health")).status, 200);
    assert.equal((await user.post("/api/auth/logout")).status, 200);
  });

  it("accepting consent opens the API in the same session", async () => {
    const user = await loginWithConsent("member", { accepted: 0, version: null });
    assert.equal((await user.get("/api/requests")).status, 403);

    const accept = await user.post("/api/auth/pdpa-consent").send({});
    assert.equal(accept.status, 200);
    assert.equal(accept.body.user.pdpaConsentAccepted, true);

    // The cookie session was re-stamped by the accept, so the same agent is in.
    assert.equal((await user.get("/api/requests")).status, 200);
    // ...and so is the bearer token handed back with it.
    const bearer = await user.get("/api/requests").set("Authorization", `Bearer ${accept.body.token}`);
    assert.equal(bearer.status, 200);
  });

  it("consent given to a DIFFERENT policy version does not count (R10.5)", async () => {
    // The account agreed — to last year's text. Raising the version is exactly
    // this: the flag stays 1 and the stored version stops matching.
    const user = await loginWithConsent("member", { accepted: 1, version: "privacy-policy-2019" });

    const res = await user.get("/api/requests");
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "PDPA_CONSENT_REQUIRED");

    // The client decides whether to show the consent page from this flag, so it
    // has to read false for the page to come back up on its own.
    const me = await user.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.pdpaConsentAccepted, false);
  });

  it("a row with consent recorded but no version is not evidence of consent", async () => {
    const user = await loginWithConsent("member", { accepted: 1, version: null });
    assert.equal((await user.get("/api/requests")).status, 403);
  });
});
