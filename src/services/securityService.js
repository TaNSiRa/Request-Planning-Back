const crypto = require("crypto");
const session = require("express-session");
const { env } = require("../config/env");
const { tokenVersionOf } = require("./accountState");
const { hasCurrentConsent } = require("./pdpa");

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sameSiteValue() {
  const value = env.session.cookieSameSite;
  if (!["strict", "lax", "none"].includes(value)) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be strict, lax, or none");
  }
  return value;
}

// MemoryStore drops an expired session only when something reads it
// (`getSession` in express-session/session/memory.js). Nobody ever reads the
// session of a person who closed their browser, so those sit in the heap until
// the process restarts. `store.all()` walks every entry THROUGH that same read
// path, so calling it on a timer is a sweep — no expiry logic of our own, no
// extra dependency.
//
// This does not make MemoryStore a shared store: sessions still live in one
// process, which is only correct while the API runs as a single instance.
// Moving to SQL Server (`connect-mssql-v2`) is the change to make before ever
// running more than one.
const sessionStore = new session.MemoryStore();

const SWEEP_MINUTES = 5;
setInterval(() => {
  sessionStore.all(error => {
    // eslint-disable-next-line no-console
    if (error) console.error(`[session] sweep failed: ${error.message}`);
  });
}, SWEEP_MINUTES * 60 * 1000).unref();

function sessionMiddleware() {
  return session({
    name: env.session.cookieName,
    secret: env.session.secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.session.cookieSecure,
      sameSite: sameSiteValue(),
      maxAge: env.session.idleTimeoutMinutes * 60 * 1000
    }
  });
}

function buildSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name || user.displayName,
    branch: user.branch,
    department: user.department,
    section: user.section,
    roleCode: user.role_code || user.roleCode,
    // Same revocation counter the JWT carries, so a session cookie is cut off by
    // a password reset or deactivation exactly like a bearer token.
    tv: tokenVersionOf(user),
    // Same rule as the bearer token: consent is per policy version.
    pdpaConsentAccepted: hasCurrentConsent(user),
    pdpaVersion: user.pdpa_policy_version ?? user.pdpaVersion ?? null
  };
}

function setLoggedInSession(req, user) {
  req.session.user = buildSessionUser(user);
  req.session.csrfToken = createCsrfToken();
  return req.session.csrfToken;
}

function clearSession(req, res, callback) {
  if (!req.session) {
    callback();
    return;
  }
  req.session.destroy(() => {
    res.clearCookie(env.session.cookieName);
    callback();
  });
}

// CSRF is only exploitable against credentials the BROWSER attaches on its own —
// i.e. the session cookie. A Bearer token has to be set by same-origin JS, which
// an attacker's page cannot do, so a caller presenting only `Authorization` and
// no session cookie needs no CSRF token (and could never have obtained one).
// Gate strictly on "is there a logged-in session cookie".
function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  if (!req.session?.user) {
    next();
    return;
  }

  const expectedToken = req.session.csrfToken;
  const actualToken = req.get("x-csrf-token");
  if (!expectedToken || !actualToken || !safeEquals(actualToken, expectedToken)) {
    res.status(403).json({ message: "CSRF_REQUIRED" });
    return;
  }
  next();
}

// Constant-time compare so the token can't be recovered a character at a time
// by timing the 403s.
function safeEquals(a, b) {
  const left = Buffer.from(`${a}`, "utf8");
  const right = Buffer.from(`${b}`, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function forceHttps(req, res, next) {
  if (!env.forceHttps || req.secure || req.headers["x-forwarded-proto"] === "https") {
    next();
    return;
  }
  res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
}

module.exports = {
  clearSession,
  createCsrfToken,
  csrfProtection,
  forceHttps,
  sessionMiddleware,
  setLoggedInSession
};
