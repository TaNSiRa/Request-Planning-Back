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

// Email delivery is switched on/off PER SECTION ('mail.enabled'). Every real
// notification is sent about a request, so sendMail can always resolve the
// owning section; the section-less fallback below only guards odd callers.
// A section with no row yet is OFF — a brand-new section never surprises anyone
// with email until its admin turns it on. (patch_section_mail_and_reminders.sql
// seeds every existing section from the old global switch so nothing goes dark.)
async function isMailEnabledForSection(sectionId) {
  const value = sectionId == null
    ? await getGlobalSetting("mail.enabled")
    : await getSectionSetting("mail.enabled", sectionId);
  return `${value ?? ""}`.trim().toLowerCase() === "true";
}

function isTrue(value) {
  return `${value ?? ""}`.trim().toLowerCase() === "true";
}

// Due-date reminder emails: the SECTION owns only the on/off switches —
//   projectReminder.enabled — the request's project period (planned_end).
//                             Defaults ON: it is the original behaviour, and a
//                             section that never opens Settings keeps it.
//   todoReminder.enabled    — each to-do item's own period. Defaults OFF.
// How many working days ahead to warn is a PERSONAL preference edited on the
// Profile page (users.end_date_notify_days / users.todo_notify_days), so two
// people in the same section can want different lead times.
function defaultReminderConfig() {
  return { project: true, todo: false };
}

// Every section's reminder config in one round trip, for the daily job:
// Map<sectionId, { project, todo }>. Use reminderConfigFor() to read it so
// sections with no rows at all get the defaults.
async function getReminderSections() {
  const rows = (await query(
    `SELECT section_id, setting_key, setting_value FROM app_settings
     WHERE section_id IS NOT NULL
       AND setting_key IN ('projectReminder.enabled', 'todoReminder.enabled')`
  )).recordset;
  const configs = new Map();
  for (const row of rows) {
    if (!configs.has(row.section_id)) configs.set(row.section_id, defaultReminderConfig());
    const config = configs.get(row.section_id);
    if (row.setting_key === "projectReminder.enabled") config.project = isTrue(row.setting_value);
    else config.todo = isTrue(row.setting_value);
  }
  return configs;
}

function reminderConfigFor(configs, sectionId) {
  return configs.get(sectionId) || defaultReminderConfig();
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
  isMailEnabledForSection,
  getReminderSections,
  reminderConfigFor,
  getUserDisplayOrder,
  sortUsersByDisplayOrder
};
