// Where the profile picture sits on the Profile page's employee badge.
//
// The placement is dragged on the card itself and saved the moment the drag
// ends, so there is no form and no Save button standing between a stray value
// and the column. That makes two things worth a test: the string that lands in
// `users.badge_photo_pos` is always "dx,dy,zoom" and nothing else, and it comes
// back on the session so the badge looks the same on the next machine the
// person signs in from — which is the entire reason it is not in localStorage.
//
// Requires database/patch_badge_photo_placement.sql.
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closePool, fixtureContext } = require("./helpers/setup");

const ctx = fixtureContext("BADGE");
const app = createApp();

describe("badge photo placement", () => {
  let me;

  before(async () => {
    await ctx.createFixture();
    me = await ctx.login(app, "requester");
  });

  after(async () => {
    await ctx.cleanupFixture();
    await closePool();
  });

  async function placement() {
    const res = await me.get("/api/auth/session");
    assert.equal(res.status, 200);
    return res.body.user.badgePhotoPos;
  }

  it("starts unset — a picture nobody has moved has no placement", async () => {
    assert.equal(await placement(), null);
  });

  it("saves a placement and reports it back on the session", async () => {
    const res = await me.put("/api/users/me/badge-photo").send({ placement: "-12.0,-48.5,1.240" });
    assert.equal(res.status, 200);
    assert.equal(await placement(), "-12.0,-48.5,1.240");
  });

  it("clears back to the centred default", async () => {
    await me.put("/api/users/me/badge-photo").send({ placement: "8.0,-3.0,1.000" });
    const res = await me.put("/api/users/me/badge-photo").send({ placement: null });
    assert.equal(res.status, 200);
    assert.equal(await placement(), null);
  });

  it("refuses anything that is not three numbers", async () => {
    const before = await placement();
    for (const bad of ["", "1,2", "1,2,3,4", "a,b,c", "1;2;3", "<script>", "1,2,3 OR 1=1"]) {
      const res = await me.put("/api/users/me/badge-photo").send({ placement: bad });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    assert.equal(await placement(), before);
  });

  it("is each account's own — one person's drag never moves another's photo", async () => {
    const other = await ctx.login(app, "member");
    await me.put("/api/users/me/badge-photo").send({ placement: "5.0,5.0,1.100" });
    const res = await other.get("/api/auth/session");
    assert.equal(res.body.user.badgePhotoPos, null);
  });

  it("needs a session at all", async () => {
    const supertest = require("supertest");
    const res = await supertest(app).put("/api/users/me/badge-photo").send({ placement: "1.0,1.0,1.000" });
    assert.equal(res.status, 401);
  });
});
