// Test bootstrap. Must be required BEFORE anything under src/ — dotenv never
// overwrites env vars that are already set, so these overrides win over .env.
process.env.SMTP_HOST = ""; // never deliver real email from a test run
process.env.FORCE_HTTPS = "false";
process.env.SESSION_COOKIE_SECURE = "false"; // supertest talks plain http

const bcrypt = require("bcryptjs");
const supertest = require("supertest");
const { env } = require("../../src/config/env");

// Hard safety gate: tests insert and delete rows, so they may only ever run
// against a local database — never the production server.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "(localdb)"]);
if (!LOCAL_HOSTS.has(`${env.sql.server || ""}`.trim().toLowerCase())) {
  throw new Error(
    `Refusing to run tests against SQL_SERVER=${env.sql.server}. ` +
    "Tests create and delete data, so point SQL_SERVER in backend/.env to " +
    "127.0.0.1 (the local dev database) before running npm test."
  );
}

const { query, getPool } = require("../../src/db/pool");
const { createApp } = require("../../src/app");

const PASSWORD = "ApiTest#1234";

// Each test FILE runs in its own process, in parallel with the others, against
// the same database — so every file gets its own fixture namespace via a short
// unique tag (section code, request prefix, and user email domain all derive
// from it). Rows are tagged so cleanup can find them, including leftovers from
// a crashed earlier run.
function fixtureContext(tag) {
  const TAG = `${tag}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!TAG) throw new Error("fixtureContext needs a non-empty tag");
  const SECTION_CODE = `ZZT${TAG}`;
  const REQUEST_PREFIX = `ZZ${TAG}`.slice(0, 10);
  const EMAIL_DOMAIN = `${TAG.toLowerCase()}.apitest.rap.local`;
  const testEmail = name => `${name}@${EMAIL_DOMAIN}`;

  // Section + 2-step route + five users: requester, two approvers (route steps
  // 1 and 2), a co-approver (attached to a step only when a test does so), and
  // a plain member. Everyone is a REQUESTER-role member of the section;
  // approver rights come from the route steps only.
  async function createFixture() {
    await cleanupFixture();
    const role = (await query("SELECT TOP 1 id FROM roles WHERE code='REQUESTER'")).recordset[0];
    if (!role) throw new Error("roles table has no REQUESTER role — is this the RAP dev database?");

    const sectionId = (await query(
      `INSERT INTO request_sections (code, name, description, request_prefix, is_active)
       OUTPUT INSERTED.id
       VALUES (@code, @name, 'created by npm test — safe to delete', @prefix, 1)`,
      { code: SECTION_CODE, name: `API Test ${TAG}`, prefix: REQUEST_PREFIX }
    )).recordset[0].id;

    const hash = await bcrypt.hash(PASSWORD, 8);
    const users = {};
    for (const name of ["requester", "approver1", "approver2", "member", "coapprover"]) {
      users[name] = (await query(
        `INSERT INTO users (email, display_name, password_hash, role_id, section, is_active, pdpa_consent_accepted)
         OUTPUT INSERTED.id
         VALUES (@email, @displayName, @hash, @roleId, @section, 1, 1)`,
        { email: testEmail(name), displayName: `${TAG} ${name}`, hash, roleId: role.id, section: SECTION_CODE }
      )).recordset[0].id;
      await query(
        `INSERT INTO user_section_memberships (user_id, section_id, can_request, can_work, is_active)
         VALUES (@userId, @sectionId, 1, 1, 1)`,
        { userId: users[name], sectionId }
      );
    }

    const routeId = (await query(
      `INSERT INTO approval_routes (section_id, name, is_default, is_active)
       OUTPUT INSERTED.id
       VALUES (@sectionId, 'API test route', 1, 1)`,
      { sectionId }
    )).recordset[0].id;
    await query(
      `INSERT INTO approval_route_steps (route_id, sequence_no, step_name, default_approver_user_id, can_assign_work)
       VALUES (@routeId, 1, 'Manager approval', @approver1, 1),
              (@routeId, 2, 'Senior approval', @approver2, 0)`,
      { routeId, approver1: users.approver1, approver2: users.approver2 }
    );
    const stepIds = (await query(
      "SELECT id FROM approval_route_steps WHERE route_id=@routeId ORDER BY sequence_no", { routeId }
    )).recordset.map(row => row.id);

    return { sectionId, routeId, stepIds, users };
  }

  // Deletes everything the fixture (or the tests it powers) created, children
  // before parents. Idempotent — safe to call when nothing exists yet.
  async function cleanupFixture() {
    const section = (await query(
      "SELECT id FROM request_sections WHERE code=@code", { code: SECTION_CODE }
    )).recordset[0];

    if (section) {
      const sid = section.id;
      const inRequests = "(SELECT id FROM requests WHERE section_id=@sid OR requester_section_id=@sid)";
      const steps = [
        `DELETE FROM notifications WHERE section_id=@sid OR request_id IN ${inRequests}`,
        `DELETE FROM email_outbox WHERE section_id=@sid OR request_id IN ${inRequests}`,
        `DELETE FROM audit_logs WHERE section_id=@sid`,
        `DELETE FROM request_support_types WHERE request_id IN ${inRequests}`,
        `DELETE FROM request_supports WHERE request_id IN ${inRequests}`,
        `DELETE FROM todo_attachments WHERE todo_id IN (SELECT id FROM request_todos WHERE request_id IN ${inRequests})`,
        `DELETE FROM request_todos WHERE request_id IN ${inRequests}`,
        `DELETE FROM request_attachments WHERE request_id IN ${inRequests}`,
        `DELETE FROM schedule_extension_step_approvers WHERE step_id IN (SELECT id FROM schedule_extension_approval_steps WHERE extension_id IN (SELECT id FROM schedule_extension_requests WHERE request_id IN ${inRequests}))`,
        `DELETE FROM schedule_extension_approval_steps WHERE extension_id IN (SELECT id FROM schedule_extension_requests WHERE request_id IN ${inRequests})`,
        `DELETE FROM schedule_extension_requests WHERE request_id IN ${inRequests}`,
        `DELETE FROM approval_step_approvers WHERE step_id IN (SELECT id FROM approval_steps WHERE request_id IN ${inRequests})`,
        `DELETE FROM approval_steps WHERE request_id IN ${inRequests}`,
        `DELETE FROM requests WHERE section_id=@sid OR requester_section_id=@sid`,
        `DELETE FROM approval_route_step_approvers WHERE step_id IN (SELECT id FROM approval_route_steps WHERE route_id IN (SELECT id FROM approval_routes WHERE section_id=@sid OR requester_section_id=@sid))`,
        `DELETE FROM approval_route_steps WHERE route_id IN (SELECT id FROM approval_routes WHERE section_id=@sid OR requester_section_id=@sid)`,
        `DELETE FROM approval_routes WHERE section_id=@sid OR requester_section_id=@sid`,
        `DELETE FROM user_section_memberships WHERE section_id=@sid`,
        `DELETE FROM app_settings WHERE section_id=@sid`,
        `DELETE FROM request_sections WHERE id=@sid`
      ];
      for (const sqlText of steps) {
        // Optional tables (later DB patches) may not exist on every dev DB.
        try {
          await query(sqlText, { sid });
        } catch (err) {
          if (!`${err.message}`.includes("Invalid object name")) throw err;
        }
      }
    }

    const userIds = (await query(
      "SELECT id FROM users WHERE email LIKE @pattern", { pattern: `%@${EMAIL_DOMAIN}` }
    )).recordset.map(row => row.id);
    if (userIds.length) {
      const params = Object.fromEntries(userIds.map((id, i) => [`u${i}`, id]));
      const inUsers = `(${userIds.map((_, i) => `@u${i}`).join(",")})`;
      for (const sqlText of [
        `DELETE FROM notifications WHERE user_id IN ${inUsers}`,
        `DELETE FROM audit_logs WHERE actor_user_id IN ${inUsers}`,
        `DELETE FROM user_skill_levels WHERE user_id IN ${inUsers}`,
        `DELETE FROM user_section_memberships WHERE user_id IN ${inUsers}`,
        `DELETE FROM users WHERE id IN ${inUsers}`
      ]) {
        try {
          await query(sqlText, params);
        } catch (err) {
          if (!`${err.message}`.includes("Invalid object name")) throw err;
        }
      }
    }
  }

  // Logs in through the real /api/auth/login endpoint. Returns a cookie-holding
  // agent plus get/post/patch/del helpers that stamp the CSRF + section headers
  // every call needs. sectionCode may be overridden to act in ANOTHER section's
  // context (cross-section tests).
  async function login(app, name, sectionCode = SECTION_CODE) {
    const agent = supertest.agent(app);
    const res = await agent.post("/api/auth/login").send({ email: testEmail(name), password: PASSWORD });
    if (res.status !== 200) {
      throw new Error(`login as ${testEmail(name)} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const csrf = res.body.csrfToken;
    const withHeaders = req => req.set("x-csrf-token", csrf).set("x-section-code", sectionCode);
    return {
      agent,
      csrf,
      user: res.body.user,
      get: url => withHeaders(agent.get(url)),
      post: url => withHeaders(agent.post(url)),
      patch: url => withHeaders(agent.patch(url)),
      del: url => withHeaders(agent.delete(url))
    };
  }

  return { SECTION_CODE, REQUEST_PREFIX, EMAIL_DOMAIN, testEmail, createFixture, cleanupFixture, login };
}

async function closePool() {
  try {
    (await getPool()).close();
  } catch {
    // pool was never opened
  }
}

module.exports = {
  createApp,
  closePool,
  fixtureContext,
  query,
  PASSWORD
};
