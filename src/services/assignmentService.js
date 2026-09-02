const { query } = require("../db/pool");
const { notify } = require("./notificationService");
const { sendMail } = require("./mailService");
const { buildAssigneeEmail, buildReassignedEmail } = require("./emailTemplates");
const { getSectionName } = require("./sectionService");

// Everything that makes up "who works on this request": the incharge, the
// support list, the required support types/skills, the project period and the
// KPI flag. It is decided at approval time (approvals.routes.js) and can be
// re-decided afterwards by the route's LAST approver
// (PATCH /requests/:id/assignment) — both go through the helpers here so the
// two paths can never drift apart.

// Collapse a supTypes payload (strings and/or objects) into a de-duplicated
// list of { supType, itemId, levelId, levelName }. sup_type (the skill item
// name) is always kept so KPI aggregation by name keeps working.
function normalizeSupTypes(raw) {
  const seen = new Set();
  const out = [];
  for (const entry of raw ?? []) {
    let name;
    let itemId = null;
    let levelId = null;
    let levelName = null;
    if (typeof entry === "string") {
      name = entry.trim();
    } else if (entry && typeof entry === "object") {
      name = `${entry.supType ?? entry.name ?? ""}`.trim();
      itemId = Number.isInteger(entry.itemId) ? entry.itemId : null;
      levelId = Number.isInteger(entry.levelId) ? entry.levelId : null;
      levelName = entry.levelName ? `${entry.levelName}`.slice(0, 200) : null;
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ supType: name, itemId, levelId, levelName });
  }
  return out;
}

// Replace a request's support-type tags with the given (already normalized) set.
async function saveSupportTypes(requestId, supTypes) {
  await query("DELETE FROM request_support_types WHERE request_id=@requestId", { requestId });
  for (const st of supTypes) {
    await query(
      `INSERT INTO request_support_types (request_id, sup_type, item_id, level_id, level_name)
       VALUES (@requestId, @supType, @itemId, @levelId, @levelName)`,
      { requestId, supType: st.supType, itemId: st.itemId, levelId: st.levelId, levelName: st.levelName }
    );
  }
}

// A person is "sufficient" when, for every required (itemId, levelId), they hold
// that skill at a rank (level sort_order) >= the required rank. Missing skill or
// a lower level = insufficient. Used to gate assignment on the server.
// supportUserIds is the request's full (multi-)support list.
async function evaluateSkillSufficiency(required, inchargeUserId, supportUserIds) {
  const supports = (supportUserIds || []).filter(Boolean);
  const levels = (await query("SELECT id, sort_order FROM skill_matrix_levels")).recordset;
  const rank = new Map(levels.map(l => [l.id, l.sort_order]));
  const userIds = [inchargeUserId, ...supports].filter(Boolean);
  const skillRows = userIds.length
    ? (await query(
      `SELECT user_id, item_id, level_id FROM user_skill_levels
         WHERE user_id IN (${userIds.map((_, i) => `@u${i}`).join(",")})`,
      Object.fromEntries(userIds.map((id, i) => [`u${i}`, id]))
    )).recordset
    : [];
  const byUser = new Map();
  for (const row of skillRows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, new Map());
    byUser.get(row.user_id).set(row.item_id, row.level_id);
  }
  const rankOf = (userId, itemId) => {
    if (!userId) return -1;
    const skills = byUser.get(userId);
    if (!skills) return -1;
    const have = skills.get(itemId);
    if (have == null) return -1;
    const r = rank.get(have);
    return r == null ? -1 : r;
  };
  const isSufficient = userId => {
    if (!userId) return false;
    for (const req of required) {
      const needRank = rank.get(req.levelId);
      if (needRank == null || rankOf(userId, req.itemId) < needRank) return false;
    }
    return true;
  };
  // Combined coverage: each required skill may be satisfied by the incharge OR
  // any support — their skills are pooled, not judged one person at a time.
  const combinedOk = required.every(req => {
    const needRank = rank.get(req.levelId);
    if (needRank == null) return false;
    const best = Math.max(rankOf(inchargeUserId, req.itemId), ...supports.map(id => rankOf(id, req.itemId)), -1);
    return best >= needRank;
  });
  return {
    inchargeOk: isSufficient(inchargeUserId),
    supportOk: supports.some(isSufficient),
    combinedOk
  };
}

// The ids among `userIds` that may actually be given work in this section — the
// same pool the assignment dropdowns are filled from (GET /users/assignees):
// active accounts with can_work = 1 in that section.
async function assignableUserIds(userIds, sectionId) {
  const ids = [...new Set((userIds || []).filter(id => Number.isInteger(id)))];
  if (!ids.length) return new Set();
  const rows = (await query(
    `SELECT u.id
     FROM users u
     JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1
     WHERE u.is_active = 1 AND m.can_work = 1 AND u.id IN (${ids.map((_, i) => `@a${i}`).join(",")})`,
    { sectionId, ...Object.fromEntries(ids.map((id, i) => [`a${i}`, id])) }
  )).recordset;
  return new Set(rows.map(r => r.id));
}

// Tell the incharge they own this work (in-app notification + email). Only the
// incharge is told — support gets no assignment notification/email.
//
// options.reassigned marks a HANDOVER of running work rather than the first
// assignment of a newly approved request: it switches both the notification
// wording and the email template (buildReassignedEmail leads with who the job
// came from and which to-dos are still open). options.previousInchargeName is
// the person it came from.
async function notifyAssignedUsers(requestId, requestNo, inchargeUserId, supportUserId, assignedByName, options = {}) {
  if (!inchargeUserId) return;
  const sectionName = await getSectionName(requestId);
  const user = (await query(
    "SELECT id, email, display_name FROM users WHERE id=@id", { id: inchargeUserId }
  )).recordset[0];
  if (!user) return;
  await notify({
    userId: user.id,
    requestId,
    type: options.reassigned ? "REASSIGN" : "ASSIGN",
    // A re-assignment says so, so the recipient can tell it apart from the
    // original hand-over of a brand new request.
    title: options.reassigned ? `${sectionName} reassigned to you` : `${sectionName} assigned`,
    body: requestNo
  });
  const mail = options.reassigned
    ? await buildReassignedEmail(requestId, {
      greetingName: user.display_name,
      previousInchargeName: options.previousInchargeName,
      assignedByName
    })
    : await buildAssigneeEmail(requestId, {
      greetingName: user.display_name,
      roleLabel: "ผู้รับผิดชอบหลัก (Incharge)",
      assignedByName
    });
  if (mail && user.email) {
    await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
  }
}

// The incharge who just lost the job gets an in-app notice (no email — this is
// housekeeping, not a hand-over).
async function notifyUnassignedUser(requestId, requestNo, userId, sectionName) {
  if (!userId) return;
  await notify({
    userId,
    requestId,
    type: "REASSIGN",
    title: `${sectionName} reassigned to someone else`,
    body: requestNo
  });
}

module.exports = {
  normalizeSupTypes,
  saveSupportTypes,
  evaluateSkillSufficiency,
  assignableUserIds,
  notifyAssignedUsers,
  notifyUnassignedUser
};
