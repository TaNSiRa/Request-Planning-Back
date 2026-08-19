const { query } = require("../db/pool");

// Per-ACCOUNT brute-force lockout (Control 3, R3.3), sitting behind the
// per-IP rate limiter rather than replacing it. The two catch different things:
// the limiter stops one machine hammering the endpoint, this stops one account
// being guessed slowly from many addresses — and unlike the limiter's in-memory
// counter, this survives a restart, so a deploy is not a way to clear it.
//
// Columns come from database/patch_login_lockout.sql. Until that is applied
// every function here is a no-op: an unpatched database must keep working, the
// same way token revocation degrades in services/accountState.js.

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

let columnsMissing = false;

function isMissingColumn(err) {
  return /Invalid column name/i.test(`${err?.message || ""}`);
}

// Returns the moment the lock lifts, or null when the account is open.
function lockedUntil(userRow) {
  const value = userRow?.login_locked_until;
  if (!value) return null;
  const until = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(until.getTime())) return null;
  // The column is written with SYSUTCDATETIME(), so compare in UTC.
  return until.getTime() > Date.now() ? until : null;
}

// One more wrong password. Returns { locked, until } describing the state the
// account is in AFTER this failure, so the caller can log it.
async function recordFailure(userId) {
  if (columnsMissing || !userId) return { locked: false, until: null };
  try {
    const row = (await query(
      `UPDATE users
       SET failed_login_count = ISNULL(failed_login_count, 0) + 1,
           login_locked_until = CASE
             WHEN ISNULL(failed_login_count, 0) + 1 >= @maxFailures
               THEN DATEADD(MINUTE, @lockMinutes, SYSUTCDATETIME())
             ELSE login_locked_until
           END
       OUTPUT INSERTED.failed_login_count AS failures, INSERTED.login_locked_until AS until
       WHERE id = @id`,
      { id: userId, maxFailures: MAX_FAILURES, lockMinutes: LOCK_MINUTES }
    )).recordset[0];
    if (!row) return { locked: false, until: null };
    return { locked: Number(row.failures) >= MAX_FAILURES, until: row.until || null };
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    columnsMissing = true;
    // eslint-disable-next-line no-console
    console.warn("login lockout columns are missing — run database/patch_login_lockout.sql to enable account lockout");
    return { locked: false, until: null };
  }
}

// The right password arrived: the account is open again and the count starts
// over. Also clears a lock that has already expired, so the row does not keep
// stale values around.
async function recordSuccess(userId) {
  if (columnsMissing || !userId) return;
  try {
    await query(
      "UPDATE users SET failed_login_count = 0, login_locked_until = NULL WHERE id = @id",
      { id: userId }
    );
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    columnsMissing = true;
  }
}

// Tests only.
function resetLockoutState() {
  columnsMissing = false;
}

module.exports = { MAX_FAILURES, LOCK_MINUTES, lockedUntil, recordFailure, recordSuccess, resetLockoutState };
