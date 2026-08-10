// The Profile page's two guarantees about who you are:
//
//   1. Employee no, email and display name are unique across accounts. The
//      first two are login identifiers; the display name is the key the app
//      identifies a person BY wherever it is not holding a row (presence,
//      avatars, weekly-plan columns), so two people sharing one merge into one
//      person in all of them.
//   2. A brand-new account still holding the password its creator typed is
//      flagged, and the flag clears the moment the owner replaces it.
//
// The must_change_password half requires database/patch_must_change_password.sql.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { createApp, closePool, fixtureContext, query, PASSWORD } = require("./helpers/setup");

const ctx = fixtureContext("IDENT");
const app = createApp();

describe("profile identity: uniqueness + first-sign-in password", () => {
  let fixture;
  let me;

  before(async () => {
    fixture = await ctx.createFixture();
    me = await ctx.login(app, "requester");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  // The three fields as they must be sent back on any PATCH /users/me — the
  // route validates the whole identity block, not just what changed.
  function profileBody(overrides = {}) {
    return {
      employeeNo: "IDENT-REQ",
      email: ctx.testEmail("requester"),
      displayName: "IDENT requester",
      branch: "HQ",
      department: "Automation",
      section: ctx.SECTION_CODE,
      ...overrides
    };
  }

  it("availability reports another account's display name / email as taken", async () => {
    const res = await me
      .get("/api/users/me/availability")
      .query({ email: ctx.testEmail("member"), displayName: "IDENT member" });
    assert.equal(res.status, 200);
    assert.equal(res.body.taken.email, true);
    assert.equal(res.body.taken.displayName, true);
  });

  it("availability never reports your OWN values as taken", async () => {
    const res = await me
      .get("/api/users/me/availability")
      .query({ email: ctx.testEmail("requester"), displayName: "IDENT requester" });
    assert.equal(res.status, 200);
    assert.equal(res.body.taken.email, false);
    assert.equal(res.body.taken.displayName, false);
  });

  it("availability matches case-insensitively and ignores surrounding space", async () => {
    const res = await me.get("/api/users/me/availability").query({ displayName: "  ident MEMBER  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.taken.displayName, true);
  });

  it("PATCH /users/me refuses a display name another account already uses", async () => {
    const res = await me.patch("/api/users/me").send(profileBody({ displayName: "IDENT member" }));
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "DISPLAY_NAME_TAKEN");
  });

  it("PATCH /users/me refuses an email another account already uses", async () => {
    const res = await me.patch("/api/users/me").send(profileBody({ email: ctx.testEmail("member") }));
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "EMAIL_TAKEN");
  });

  it("PATCH /users/me refuses an employee no another account already uses", async () => {
    await query("UPDATE users SET employee_no='IDENT-MEM' WHERE id=@id", { id: fixture.users.member });
    const res = await me.patch("/api/users/me").send(profileBody({ employeeNo: "IDENT-MEM" }));
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "EMPLOYEE_NO_TAKEN");
  });

  it("PATCH /users/me accepts values only this account uses", async () => {
    const res = await me.patch("/api/users/me").send(profileBody({ displayName: "IDENT requester renamed" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = (await query("SELECT display_name FROM users WHERE id=@id", { id: fixture.users.requester }))
      .recordset[0];
    assert.equal(row.display_name, "IDENT requester renamed");
  });

  it("a flagged account reports mustChangePassword, and setting a password clears it", async () => {
    await query("UPDATE users SET must_change_password=1 WHERE id=@id", { id: fixture.users.member });

    const member = await ctx.login(app, "member");
    assert.equal(member.user.mustChangePassword, true, "login must surface the flag");

    // The forced first-sign-in dialog asks for no current password, so it uses
    // the flag-gated route rather than PATCH /users/me/password.
    const same = await member.post("/api/auth/first-password").send({ newPassword: PASSWORD });
    assert.equal(same.status, 400, "retyping the issued password must not clear the flag");
    assert.match(same.body.message, /different from the one you were given/i);

    const changed = await member.post("/api/auth/first-password").send({ newPassword: "IdentNew#2468" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const row = (await query("SELECT must_change_password FROM users WHERE id=@id", { id: fixture.users.member }))
      .recordset[0];
    assert.ok(row.must_change_password === false || row.must_change_password === 0, "flag must be cleared");

    // And every login from here on says so too — this is what the shell reads
    // to decide whether the dialog stays up.
    const back = await supertest(app)
      .post("/api/auth/login")
      .send({ email: ctx.testEmail("member"), password: "IdentNew#2468" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.user.mustChangePassword, false);
  });

  it("takes no section header — the dialog opens before a section is picked", async () => {
    // The regression this exists for: the route started life on the users
    // router, which resolves a section on every call, so the first-sign-in
    // dialog answered "Section is required" under the New password box. Every
    // other test here goes through ctx.login's helpers, which stamp
    // x-section-code on everything — so only a bare agent call can catch it.
    await query("UPDATE users SET must_change_password=1 WHERE id=@id", { id: fixture.users.coapprover });
    const fresh = await ctx.login(app, "coapprover");
    const res = await fresh.agent
      .post("/api/auth/first-password")
      .set("x-csrf-token", fresh.csrf)
      .send({ newPassword: "IdentNoSect#1234" });
    assert.equal(res.status, 200, `must not need a section: ${JSON.stringify(res.body)}`);
  });

  it("an untouched account is never flagged", async () => {
    const fresh = await ctx.login(app, "approver1");
    assert.equal(fresh.user.mustChangePassword, false);
  });

  it("the no-proof route is closed to an account past its first sign-in", async () => {
    // This is the whole reason it is a separate endpoint: without the flag it
    // must not be usable as a way around the current-password proof that
    // Profile › Security requires.
    const fresh = await ctx.login(app, "approver1");
    const res = await fresh.post("/api/auth/first-password").send({ newPassword: "IdentSneak#1357" });
    assert.equal(res.status, 403);

    // …and the password really did not move.
    const still = await supertest(app)
      .post("/api/auth/login")
      .send({ email: ctx.testEmail("approver1"), password: PASSWORD });
    assert.equal(still.status, 200, "the original password must still work");
  });

  it("Profile › Security still demands the current password", async () => {
    const fresh = await ctx.login(app, "approver2");
    const res = await fresh.patch("/api/users/me/password").send({
      currentPassword: "not-the-password",
      newPassword: "IdentOther#1357"
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /current password is incorrect/i);
  });
});
