const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth, signToken } = require("../../middleware/auth");
const { writeAudit } = require("../../middleware/audit");
const { clearSession, setLoggedInSession } = require("../../services/securityService");
const { getUserSections } = require("../../services/sectionService");
const { verifyMicrosoftIdToken } = require("../../services/microsoftTokenService");
const { env } = require("../../config/env");

const router = express.Router();

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1)
});

const microsoftLoginSchema = z.object({
  idToken: z.string().min(20)
});

router.post("/login", asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await findActiveUserByIdentifier(input.email);
  if (!user || !(await bcrypt.compare(input.password, user.password_hash || ""))) {
    return res.status(401).json({ message: "Invalid email, employee no, or password" });
  }

  await writeAudit({ actorId: user.id, action: "LOGIN", entityType: "AUTH", ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await completeLogin(req, user));
}));

router.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  await writeAudit({ actorId: req.user.id, action: "LOGOUT", entityType: "AUTH", ip: req.ip, userAgent: req.headers["user-agent"] });
  clearSession(req, res, () => res.json({ ok: true }));
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.branch, u.department, u.section, u.phone, r.code AS role_code
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = @id`,
    { id: req.user.id }
  );
  const user = sanitizeUser(result.recordset[0]);
  user.sections = await getUserSections(user);
  res.json({ user });
}));

router.get("/sections", requireAuth, asyncHandler(async (req, res) => {
  res.json({ data: await getUserSections(req.user) });
}));

router.get("/session", requireAuth, asyncHandler(async (req, res) => {
  const user = sanitizeUser({
    ...req.user,
    display_name: req.user.displayName,
    role_code: req.user.roleCode
  });
  user.sections = await getUserSections(user);
  res.json({ token: signToken(req.user), user, csrfToken: req.session?.csrfToken || null });
}));

router.get("/csrf-token", requireAuth, asyncHandler(async (req, res) => {
  if (!req.session) return res.json({ csrfToken: null });
  if (!req.session.csrfToken) req.session.csrfToken = setLoggedInSession(req, req.user);
  res.json({ csrfToken: req.session.csrfToken });
}));

router.get("/microsoft/config", (req, res) => {
  res.json({
    enabled: Boolean(env.microsoft.clientId && env.microsoft.tenantId),
    clientId: env.microsoft.clientId,
    tenantId: env.microsoft.tenantId,
    scopes: env.microsoft.scopes,
    message: env.microsoft.clientId && env.microsoft.tenantId
      ? "Microsoft 365 login is configured."
      : "Fill MS365_CLIENT_ID and MS365_TENANT_ID or MICROSOFT_CLIENT_ID and MICROSOFT_TENANT_ID in .env."
  });
});

router.post("/microsoft/login", asyncHandler(async (req, res) => {
  const input = microsoftLoginSchema.parse(req.body);
  const claims = await verifyMicrosoftIdToken(input.idToken);
  const email = claims.preferred_username || claims.email || claims.upn || "";
  if (!email) return res.status(401).json({ message: "Microsoft account email was not found" });

  const user = await findActiveUserByEmail(email);
  if (!user) {
    await writeAudit({
      action: "MICROSOFT_LOGIN_FAILED",
      entityType: "AUTH",
      entityId: email,
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });
    return res.status(401).json({ message: "Microsoft account is not registered in this system" });
  }

  await writeAudit({
    actorId: user.id,
    action: "MICROSOFT_LOGIN",
    entityType: "AUTH",
    entityId: email,
    ip: req.ip,
    userAgent: req.headers["user-agent"]
  });
  res.json(await completeLogin(req, user));
}));

async function findActiveUserByEmail(email) {
  const result = await query(
    `SELECT TOP 1 u.*, r.code AS role_code
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = LOWER(@email) AND u.is_active = 1`,
    { email: `${email || ""}`.trim() }
  );
  return result.recordset[0] || null;
}

async function findActiveUserByIdentifier(identifier) {
  const value = `${identifier || ""}`.trim();
  const result = await query(
    `SELECT TOP 1 u.*, r.code AS role_code
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE (LOWER(u.email) = LOWER(@identifier) OR u.employee_no = @identifier)
       AND u.is_active = 1
     ORDER BY CASE WHEN LOWER(u.email) = LOWER(@identifier) THEN 0 ELSE 1 END, u.id`,
    { identifier: value }
  );
  return result.recordset[0] || null;
}

async function completeLogin(req, user) {
  await query("UPDATE users SET last_login_at = SYSUTCDATETIME() WHERE id = @id", { id: user.id });
  const csrfToken = setLoggedInSession(req, user);
  const sanitized = sanitizeUser(user);
  sanitized.sections = await getUserSections(sanitized);
  return { token: signToken(user), csrfToken, user: sanitized };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    employeeNo: user.employee_no,
    email: user.email,
    displayName: user.display_name,
    branch: user.branch,
    department: user.department,
    section: user.section,
    phone: user.phone,
    roleCode: user.role_code
  };
}

module.exports = router;
