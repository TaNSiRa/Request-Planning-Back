const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth, signToken } = require("../../middleware/auth");
const { writeAudit } = require("../../middleware/audit");
const { clearSession, setLoggedInSession } = require("../../services/securityService");
const { getUserSections, isViewer, isAdmin } = require("../../services/sectionService");
const { getViewerOverrides } = require("../../services/viewerService");
const { verifyMicrosoftIdToken } = require("../../services/microsoftTokenService");
const { getGlobalBool } = require("../../services/settingsService");
const { env } = require("../../config/env");

const router = express.Router();

// IPs currently throttled by the login limiter, so an admin can see and clear
// them. ip -> { blockedAt, resetTime, hits }. In-memory (per process), same as
// the limiter's own store — an entry is pruned once its window has elapsed.
const blockedLogins = new Map();

function pruneBlockedLogins() {
  const now = Date.now();
  for (const [ip, info] of blockedLogins) {
    if (!info.resetTime || new Date(info.resetTime).getTime() <= now) blockedLogins.delete(ip);
  }
}

// Brute-force guard for credential logins. Only FAILED attempts count
// (skipSuccessfulRequests), so an active legitimate user is never locked out,
// while password guessing against an account/IP is throttled hard.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please wait a few minutes and try again." },
  // Runs every time a request is over the limit — record the IP so an admin can
  // find and release it from the Settings page.
  handler: (req, res, next, options) => {
    const existing = blockedLogins.get(req.ip);
    blockedLogins.set(req.ip, {
      blockedAt: existing?.blockedAt || new Date().toISOString(),
      resetTime: req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null,
      hits: req.rateLimit?.used ?? existing?.hits ?? null
    });
    res.status(options.statusCode).json(options.message);
  }
});

// System-wide admin gate (global ADMIN only) — deliberately does NOT honour a
// viewer's read/edit grants, so releasing a login block is real-admin only.
function requireGlobalAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return res.status(403).json({ message: "Forbidden" });
}

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1)
});

const microsoftLoginSchema = z.object({
  idToken: z.string().min(20)
});

router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await findActiveUserByIdentifier(input.email);
  if (!user || !(await bcrypt.compare(input.password, user.password_hash || ""))) {
    return res.status(401).json({ message: "Invalid email, employee no, or password" });
  }

  await writeAudit({ actorId: user.id, action: "LOGIN", entityType: "AUTH", ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await completeLogin(req, user));
}));

// --- Login brute-force block management (global admin) ---------------------

// IPs currently throttled at the login endpoint.
router.get("/login-blocks", requireAuth, requireGlobalAdmin, asyncHandler(async (req, res) => {
  pruneBlockedLogins();
  const data = [...blockedLogins.entries()]
    .map(([ip, info]) => ({ ip, ...info }))
    .sort((a, b) => `${b.blockedAt}`.localeCompare(`${a.blockedAt}`));
  res.json({ data });
}));

// Release one IP.
router.delete("/login-blocks/:ip", requireAuth, requireGlobalAdmin, asyncHandler(async (req, res) => {
  const ip = `${req.params.ip || ""}`.trim();
  if (!ip) return res.status(400).json({ message: "IP is required" });
  await loginLimiter.resetKey(ip);
  blockedLogins.delete(ip);
  await writeAudit({
    actorId: req.user.id,
    action: "UNBLOCK_LOGIN",
    entityType: "AUTH",
    entityId: ip,
    ip: req.ip,
    userAgent: req.headers["user-agent"]
  });
  res.json({ ok: true });
}));

// Release every currently-blocked IP.
router.delete("/login-blocks", requireAuth, requireGlobalAdmin, asyncHandler(async (req, res) => {
  const ips = [...blockedLogins.keys()];
  for (const ip of ips) await loginLimiter.resetKey(ip);
  blockedLogins.clear();
  await writeAudit({
    actorId: req.user.id,
    action: "UNBLOCK_LOGIN_ALL",
    entityType: "AUTH",
    entityId: `${ips.length} ip(s)`,
    ip: req.ip,
    userAgent: req.headers["user-agent"]
  });
  res.json({ ok: true, cleared: ips.length });
}));

router.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  await writeAudit({ actorId: req.user.id, action: "LOGOUT", entityType: "AUTH", ip: req.ip, userAgent: req.headers["user-agent"] });
  clearSession(req, res, () => res.json({ ok: true }));
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const userRow = await findActiveUserById(req.user.id);
  if (!userRow) return res.status(401).json({ message: "Unauthorized" });
  const user = await attachUserContext(sanitizeUser(userRow));
  res.json({ user });
}));

router.get("/sections", requireAuth, asyncHandler(async (req, res) => {
  res.json({ data: await getUserSections(req.user) });
}));

router.get("/session", requireAuth, asyncHandler(async (req, res) => {
  const userRow = await findActiveUserById(req.user.id);
  if (!userRow) return res.status(401).json({ message: "Unauthorized" });
  const user = await attachUserContext(sanitizeUser(userRow));
  res.json({ token: signToken(userRow), user, csrfToken: req.session?.csrfToken || null });
}));

router.get("/csrf-token", requireAuth, asyncHandler(async (req, res) => {
  if (!req.session) return res.json({ csrfToken: null });
  if (!req.session.csrfToken) req.session.csrfToken = setLoggedInSession(req, req.user);
  res.json({ csrfToken: req.session.csrfToken });
}));

router.get("/microsoft/config", asyncHandler(async (req, res) => {
  // Available only when BOTH the admin toggle (microsoft365.enabled) is on AND
  // the OAuth app credentials exist in .env — you can't run OAuth without them.
  const toggledOn = await getGlobalBool("microsoft365.enabled", false);
  const configured = Boolean(env.microsoft.clientId && env.microsoft.tenantId);
  res.json({
    enabled: toggledOn && configured,
    configured,
    clientId: env.microsoft.clientId,
    tenantId: env.microsoft.tenantId,
    scopes: env.microsoft.scopes,
    message: !toggledOn
      ? "Microsoft 365 login is turned off in Settings (microsoft365.enabled)."
      : configured
        ? "Microsoft 365 login is configured."
        : "Fill MS365_CLIENT_ID and MS365_TENANT_ID or MICROSOFT_CLIENT_ID and MICROSOFT_TENANT_ID in .env."
  });
}));

router.post("/microsoft/login", asyncHandler(async (req, res) => {
  const toggledOn = await getGlobalBool("microsoft365.enabled", false);
  if (!toggledOn || !env.microsoft.clientId || !env.microsoft.tenantId) {
    return res.status(403).json({ message: "Microsoft 365 login is disabled" });
  }
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

router.post("/pdpa-consent", requireAuth, asyncHandler(async (req, res) => {
  await query(
    `UPDATE users
     SET pdpa_consent_accepted = 1,
         pdpa_consent_at = SYSUTCDATETIME(),
         pdpa_consent_ip = @ip,
         pdpa_consent_user_agent = @userAgent,
         pdpa_policy_version = @policyVersion,
         updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      id: req.user.id,
      ip: req.ip,
      userAgent: `${req.headers["user-agent"] || ""}`.slice(0, 512),
      policyVersion: "privacy-policy-2026"
    }
  );
  const userRow = await findActiveUserById(req.user.id);
  const csrfToken = setLoggedInSession(req, userRow);
  await writeAudit({
    actorId: req.user.id,
    action: "PDPA_ACCEPT",
    entityType: "USER",
    entityId: req.user.id,
    afterValue: { pdpaConsentAccepted: true, policyVersion: "privacy-policy-2026" },
    ip: req.ip,
    userAgent: req.headers["user-agent"]
  });
  const user = await attachUserContext(sanitizeUser(userRow));
  res.json({ token: signToken(userRow), csrfToken, user });
}));

// Attach the per-request context every login/session response carries: the
// user's accessible sections and, for a viewer, its page-level overrides (the
// section-level ones already ride along on each section's viewerCanEdit flag).
async function attachUserContext(user) {
  user.sections = await getUserSections(user);
  if (isViewer(user)) user.viewerPages = (await getViewerOverrides(user.id)).pages;
  return user;
}

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

async function findActiveUserById(id) {
  const result = await query(
    `SELECT TOP 1 u.*, r.code AS role_code
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = @id AND u.is_active = 1`,
    { id }
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
  const sanitized = await attachUserContext(sanitizeUser(user));
  return { token: signToken(user), csrfToken, user: sanitized };
}

function sanitizeUser(user) {
  const pdpaConsentAccepted = user?.pdpa_consent_accepted === true ||
    user?.pdpa_consent_accepted === 1 ||
    user?.pdpaConsentAccepted === true;
  return {
    id: user.id,
    employeeNo: user.employee_no,
    email: user.email,
    displayName: user.display_name,
    fullName: user.full_name,
    namePrefix: user.name_prefix,
    // May be undefined until patch_positions_org_chart.sql is applied.
    positionId: user.position_id ?? null,
    avatar: user.avatar ?? null,
    branch: user.branch,
    department: user.department,
    section: user.section,
    phone: user.phone,
    endDateNotifyDays: user.end_date_notify_days ?? 5,
    // May be undefined until patch_todo_notify_days.sql is applied.
    todoNotifyDays: user.todo_notify_days ?? 1,
    roleCode: user.role_code,
    pdpaConsentAccepted,
    pdpaConsentAt: user.pdpa_consent_at,
    pdpaPolicyVersion: user.pdpa_policy_version
  };
}

module.exports = router;
