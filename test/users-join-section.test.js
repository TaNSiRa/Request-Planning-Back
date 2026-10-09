// Adding an account that lives in another section to this one (Manage Users ›
// Add existing user): GET /api/users/lookup finds it, POST
// /api/users/:id/join-section gives it a plain membership here and leaves its
// home section alone.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, createAdminUsers, fixtureContext, query } = require("./helpers/setup");

const here = fixtureContext("JOINA");
const home = fixtureContext("JOINB");

let app;
let fixtureHere;
let fixtureHome;
let admins;

before(async () => {
  app = createApp();
  fixtureHere = await here.createFixture();
  fixtureHome = await home.createFixture();
  admins = await createAdminUsers(here, fixtureHere, "JOINA");
});

after(async () => {
  await here.cleanupFixture();
  await home.cleanupFixture();
  await closePool();
});

const membership = async (userId, sectionId) => (await query(
  `SELECT can_request, can_work, is_section_admin, is_active FROM user_section_memberships
   WHERE user_id=@userId AND section_id=@sectionId`, { userId, sectionId }
)).recordset[0];

describe("add an existing user from another section", () => {
  const outsider = () => fixtureHome.users.requester;

  it("finds outsiders only, and only for this section's admins", async () => {
    const admin = await here.login(app, "sectionadmin");
    const res = await admin.get(`/api/users/lookup?q=${encodeURIComponent(home.EMAIL_DOMAIN)}`);
    assert.equal(res.status, 200);
    const ids = res.body.data.map(u => u.id);
    assert.ok(ids.includes(outsider()));
    // Members here are not offered, nor is a global admin.
    assert.ok(!ids.includes(fixtureHere.users.requester));
    const own = await admin.get(`/api/users/lookup?q=${encodeURIComponent(here.EMAIL_DOMAIN)}`);
    assert.ok(!own.body.data.some(u => u.id === admins.sysadmin));
    assert.equal(own.body.data.length, 0);
    const found = res.body.data.find(u => u.id === outsider());
    assert.equal(found.email, home.testEmail("requester"));
    assert.match(found.sections, /API Test JOINB/);

    assert.equal((await admin.get("/api/users/lookup?q=a")).status, 400);
    const plain = await here.login(app, "requester");
    assert.equal((await plain.get(`/api/users/lookup?q=${encodeURIComponent(home.EMAIL_DOMAIN)}`)).status, 403);
    assert.equal((await plain.post(`/api/users/${outsider()}/join-section`).send({})).status, 403);
  });

  it("adds a plain membership here and keeps the home section as it was", async () => {
    const admin = await here.login(app, "sectionadmin");
    assert.equal((await admin.post(`/api/users/${outsider()}/join-section`)
      .send({ canRequest: false, canWork: false })).status, 400);
    // Nothing chosen: Can request only, as the dialog starts.
    const res = await admin.post(`/api/users/${outsider()}/join-section`).send({});
    assert.equal(res.status, 201);
    const joined = await membership(outsider(), fixtureHere.sectionId);
    assert.deepEqual(
      [joined.can_request, joined.can_work, joined.is_section_admin, joined.is_active],
      [true, false, false, true]
    );
    const kept = await membership(outsider(), fixtureHome.sectionId);
    assert.equal(kept.is_active, true);

    // Now a member: no longer offered, and adding again is refused.
    const again = await admin.get(`/api/users/lookup?q=${encodeURIComponent(home.EMAIL_DOMAIN)}`);
    assert.ok(!again.body.data.some(u => u.id === outsider()));
    assert.equal((await admin.post(`/api/users/${outsider()}/join-section`).send({})).status, 409);

    // …and the section shows up for them.
    const them = await home.login(app, "requester");
    const sections = (await them.get("/api/auth/sections")).body.data;
    assert.ok(sections.some(s => s.id === fixtureHere.sectionId));
  });

  it("refuses global admins", async () => {
    const admin = await here.login(app, "sectionadmin");
    assert.equal((await admin.post(`/api/users/${admins.sysadmin}/join-section`).send({})).status, 403);
  });
});
