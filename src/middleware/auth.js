const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    if (req.session?.user) {
      req.user = req.session.user;
      next();
      return;
    }
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    req.user = jwt.verify(token, env.jwtSecret);
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized" });
  }
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      displayName: user.display_name || user.displayName,
      branch: user.branch,
      department: user.department,
      section: user.section,
      roleCode: user.role_code || user.roleCode,
      pdpaConsentAccepted: user.pdpa_consent_accepted === true ||
        user.pdpa_consent_accepted === 1 ||
        user.pdpaConsentAccepted === true
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

module.exports = { requireAuth, signToken };
