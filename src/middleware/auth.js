const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { loadAccountState, tokenVersionOf } = require("../services/accountState");

// A verified token/session is not enough on its own — the account behind it must
// still be active and must not have been revoked since the credential was issued
// (logout, password change/reset, deactivation all bump users.token_version).
// Returns an error message when the caller should be rejected, otherwise null.
async function revocationProblem(user) {
  const state = await loadAccountState(user?.id);
  // Null means the token_version column has not been patched in yet; skip the
  // check rather than lock everyone out.
  if (!state) return null;
  if (!state.isActive) return "ACCOUNT_DISABLED";
  if (tokenVersionOf(user) !== state.tokenVersion) return "SESSION_REVOKED";
  return null;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  let user;
  if (token) {
    try {
      user = jwt.verify(token, env.jwtSecret);
    } catch {
      return res.status(401).json({ message: "Unauthorized" });
    }
  } else if (req.session?.user) {
    user = req.session.user;
  } else {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const problem = await revocationProblem(user);
    if (problem) return res.status(401).json({ message: problem });
  } catch (err) {
    return next(err);
  }

  req.user = user;
  next();
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
      // Revocation counter — requireAuth rejects the token once this no longer
      // matches users.token_version.
      tv: tokenVersionOf(user),
      pdpaConsentAccepted: user.pdpa_consent_accepted === true ||
        user.pdpa_consent_accepted === 1 ||
        user.pdpaConsentAccepted === true
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

module.exports = { requireAuth, signToken };
