const crypto = require("crypto");
const session = require("express-session");
const { env } = require("../config/env");

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

function sessionMiddleware() {
  return session({
    name: env.session.cookieName,
    secret: env.session.secret,
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
    roleCode: user.role_code || user.roleCode
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

function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  if (!req.session?.user && !req.headers.authorization) {
    next();
    return;
  }

  const expectedToken = req.session.csrfToken;
  const actualToken = req.get("x-csrf-token");
  if (!expectedToken || !actualToken || actualToken !== expectedToken) {
    res.status(403).json({ message: "CSRF_REQUIRED" });
    return;
  }
  next();
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
