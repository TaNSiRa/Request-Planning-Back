const { query } = require("../db/pool");

// Per-account state that every authenticated request has to re-check:
//   tokenVersion — bumped to revoke tokens already handed out (logout, password
//                  change/reset, deactivation). See database/patch_token_version.sql.
//   isActive     — so deactivating someone cuts off their live token/session too,
//                  not only their next login.
//
// requireAuth runs on every call, so this is cached in-process for a few seconds
// to keep it off the hot path. Every mutation below goes through bumpTokenVersion
// / forgetAccount, which drop the entry immediately — so on a single-process
// deployment revocation is instant, and the TTL only bounds how long a change
// made straight in the database takes to be noticed.
const CACHE_TTL_MS = 15000;
const cache = new Map();

// Set once when the column turns out to be missing (patch not applied yet), so
// we stop probing on every request. Availability wins over revocation here: an
// unpatched database must not lock the whole company out.
let columnMissing = false;

function isMissingColumn(err) {
  return /Invalid column name/i.test(`${err?.message || ""}`);
}

// Returns { tokenVersion, isActive } or null when the state can't be determined
// (column not patched in yet) — callers treat null as "skip the check".
async function loadAccountState(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (columnMissing) return null;

  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  let row;
  try {
    row = (await query(
      "SELECT token_version, is_active FROM users WHERE id = @id",
      { id }
    )).recordset[0];
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    columnMissing = true;
    console.warn("token_version column is missing — run database/patch_token_version.sql to enable token revocation");
    return null;
  }

  const state = row
    ? { tokenVersion: Number(row.token_version) || 0, isActive: row.is_active === true || row.is_active === 1 }
    // No row at all: the account was deleted outright. Treat as revoked.
    : { tokenVersion: -1, isActive: false };
  cache.set(id, { state, expiresAt: Date.now() + CACHE_TTL_MS });
  return state;
}

// Invalidate every token and session already issued for this user.
async function bumpTokenVersion(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  cache.delete(id);
  if (columnMissing) return;
  try {
    await query(
      "UPDATE users SET token_version = ISNULL(token_version, 0) + 1 WHERE id = @id",
      { id }
    );
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    columnMissing = true;
  }
}

// Drop a cached entry after changing something else about the account (e.g.
// is_active) so the next request re-reads it instead of waiting out the TTL.
function forgetAccount(userId) {
  cache.delete(Number(userId));
}

// Raises or clears "this account still has the password someone else gave it".
// Raised when an admin creates the account, cleared the first time its owner
// sets their own — see database/patch_must_change_password.sql.
//
// Best-effort: before that patch is applied the column does not exist, and
// nothing reads the flag either (sanitizeUser reports false), so doing nothing
// leaves the pre-patch behaviour intact rather than failing a user creation.
async function setMustChangePassword(userId, value) {
  try {
    await query("UPDATE users SET must_change_password=@value WHERE id=@id", { id: Number(userId), value });
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
  }
}

// The `tv` claim to stamp into a new token / session, accepting either a raw
// users row (token_version) or an existing token payload (tv).
function tokenVersionOf(user) {
  return Number(user?.token_version ?? user?.tokenVersion ?? user?.tv ?? 0) || 0;
}

// Tests only — the module-level cache would otherwise leak between cases.
function resetAccountStateCache() {
  cache.clear();
  columnMissing = false;
}

module.exports = {
  bumpTokenVersion,
  forgetAccount,
  loadAccountState,
  resetAccountStateCache,
  setMustChangePassword,
  tokenVersionOf
};
