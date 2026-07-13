const { query } = require("../db/pool");

// Multiple support users per request (request_supports table, see
// database/patch_multi_support.sql). The legacy requests.support_user_id column
// keeps mirroring the FIRST support so older queries/exports stay correct.

function missingTable(err) {
  return `${err.message}`.includes("Invalid object name");
}

// request_id -> [{ id, name, fullName }] for the given requests (chunked to
// stay well under the SQL parameter limit). Returns an empty map when the
// multi-support patch hasn't been applied yet.
async function loadSupportsMap(requestIds) {
  const ids = [...new Set(requestIds.filter(id => Number.isInteger(id)))];
  const map = new Map();
  if (!ids.length) return map;
  try {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      const params = {};
      const placeholders = chunk.map((id, i) => {
        params[`r${i}`] = id;
        return `@r${i}`;
      });
      const rows = (await query(
        `SELECT rs.request_id, rs.user_id, u.display_name, u.full_name
         FROM request_supports rs
         JOIN users u ON u.id = rs.user_id
         WHERE rs.request_id IN (${placeholders.join(",")})
         ORDER BY rs.request_id, rs.sort_order, rs.user_id`,
        params
      )).recordset;
      for (const row of rows) {
        if (!map.has(row.request_id)) map.set(row.request_id, []);
        map.get(row.request_id).push({ id: row.user_id, name: row.display_name, fullName: row.full_name });
      }
    }
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  return map;
}

async function getSupports(requestId) {
  return (await loadSupportsMap([requestId])).get(requestId) || [];
}

// Attach the support list to a row. support_name (the field every existing
// display/export/email already renders) becomes the comma-joined names so all
// supports show everywhere without touching each consumer.
function applySupports(row, supports) {
  row.supports = supports;
  row.support_user_ids = supports.map(s => s.id);
  if (supports.length) row.support_name = supports.map(s => s.name).join(", ");
  return row;
}

// Replace a request's support list. Also mirrors the first support into the
// legacy requests.support_user_id column.
async function setSupports(requestId, userIds) {
  const ids = [...new Set((userIds || []).filter(id => Number.isInteger(id)))];
  try {
    await query("DELETE FROM request_supports WHERE request_id=@requestId", { requestId });
    for (let i = 0; i < ids.length; i++) {
      await query(
        "INSERT INTO request_supports (request_id, user_id, sort_order) VALUES (@requestId, @userId, @sortOrder)",
        { requestId, userId: ids[i], sortOrder: i }
      );
    }
  } catch (err) {
    // Patch not applied — the legacy single column below still stores the first.
    if (!missingTable(err)) throw err;
  }
  await query("UPDATE requests SET support_user_id=@supportUserId WHERE id=@requestId", {
    requestId,
    supportUserId: ids[0] ?? null
  });
  return ids;
}

// Whether the user is one of the request's supports (beyond the legacy column).
async function isSupportUser(requestId, userId) {
  try {
    const row = (await query(
      "SELECT TOP 1 1 AS ok FROM request_supports WHERE request_id=@requestId AND user_id=@userId",
      { requestId, userId }
    )).recordset[0];
    return Boolean(row);
  } catch (err) {
    if (missingTable(err)) return false;
    throw err;
  }
}

module.exports = { loadSupportsMap, getSupports, applySupports, setSupports, isSupportUser };
