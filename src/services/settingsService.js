const { query } = require("../db/pool");

// Reads a global (section_id IS NULL) app setting value, or null if unset.
async function getGlobalSetting(key) {
  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key=@key AND section_id IS NULL",
    { key }
  );
  return result.recordset[0]?.setting_value ?? null;
}

// Reads a global boolean setting. Stored as the string 'true'/'false'.
async function getGlobalBool(key, fallback = false) {
  const value = await getGlobalSetting(key);
  if (value == null) return fallback;
  return `${value}`.trim().toLowerCase() === "true";
}

// Reads a section-scoped app setting value, or null if unset.
async function getSectionSetting(key, sectionId) {
  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key=@key AND section_id=@sectionId",
    { key, sectionId }
  );
  return result.recordset[0]?.setting_value ?? null;
}

// Attachment-count limits are configurable per section by section admins
// (request.maxAttachments / todo.maxAttachments). Defaults keep the historic
// cap of 5; anything outside 0..99 is treated as unset.
const MAX_ATTACHMENTS_DEFAULT = 5;
const MAX_ATTACHMENTS_CEILING = 99;

function normalizeMaxAttachments(raw) {
  const n = Number.parseInt(`${raw ?? ""}`.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_ATTACHMENTS_CEILING) return MAX_ATTACHMENTS_DEFAULT;
  return n;
}

// kind: "request" (files on the request form) | "todo" (files on a todo item).
async function getMaxAttachments(sectionId, kind) {
  const key = kind === "todo" ? "todo.maxAttachments" : "request.maxAttachments";
  return normalizeMaxAttachments(await getSectionSetting(key, sectionId));
}

// Per-section fixed user display order — a JSON array of user ids stored as
// the 'users.displayOrder' setting. Edited with the arrows on the Meeting
// weekly plan; applied to every user list/dropdown (weekly plan rows,
// assignee pickers, incharge filters) so people always appear in the same
// position everywhere.
async function getUserDisplayOrder(sectionId) {
  const raw = await getSectionSetting("users.displayOrder", sectionId);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(v => Number(v)).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

// Users whose id appears in orderIds come first (in that order); everyone else
// follows, keeping the caller's original (e.g. alphabetical) order — sort() is
// stable, so equal ranks preserve input order.
function sortUsersByDisplayOrder(rows, orderIds, idOf = row => row.id) {
  if (!orderIds.length) return rows;
  const pos = new Map(orderIds.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    const pa = pos.has(idOf(a)) ? pos.get(idOf(a)) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(idOf(b)) ? pos.get(idOf(b)) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

module.exports = {
  getGlobalSetting,
  getGlobalBool,
  getSectionSetting,
  getMaxAttachments,
  normalizeMaxAttachments,
  MAX_ATTACHMENTS_CEILING,
  getUserDisplayOrder,
  sortUsersByDisplayOrder
};
