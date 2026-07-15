const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { notify } = require("../../services/notificationService");
const { sendMail } = require("../../services/mailService");
const {
  buildApproverEmail,
  buildAssigneeEmail,
  buildParticipantEmail,
  buildExtensionApproverEmail,
  buildExtensionResultEmail
} = require("../../services/emailTemplates");
const { emitSystem } = require("../../services/realtimeService");
const { isAdmin, resolveSection, getSectionName } = require("../../services/sectionService");
const { loadSupportsMap, applySupports, setSupports } = require("../../services/supportService");
const {
  approvalStepUserCondition,
  extensionStepUserCondition,
  stepCandidates,
  extensionStepCandidates
} = require("../../services/approverService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/pending", asyncHandler(async (req, res) => {
  // A step is "yours" when you're its primary approver OR any co-approver.
  const userCond = await approvalStepUserCondition("a", "@userId");
  const result = await query(
    `SELECT a.*, r.request_no, r.title, r.priority, r.due_date, r.request_type, r.system_area,
            r.description, r.business_impact, r.is_kpi, r.incharge_user_id, r.support_user_id, r.planned_start, r.planned_end,
            r.section_id AS target_section_id, r.requester_section_id,
            ts.name AS target_section_name, rs.name AS origin_section_name,
            u.display_name AS requester_name, inc.display_name AS incharge_name, sup.display_name AS support_name,
            u.branch AS requester_branch, u.department AS requester_department, u.section AS requester_section,
            inc.branch AS incharge_branch, inc.department AS incharge_department, inc.section AS incharge_section,
            sup.branch AS support_branch, sup.department AS support_department, sup.section AS support_section,
            CASE WHEN a.sequence_no >= 100 THEN 'CLOSE' ELSE 'REQUEST' END AS approval_kind
     FROM approval_steps a
     JOIN requests r ON r.id = a.request_id
     JOIN users u ON u.id = r.requester_user_id
     JOIN request_sections ts ON ts.id = r.section_id
     LEFT JOIN request_sections rs ON rs.id = r.requester_section_id
     LEFT JOIN users inc ON inc.id = r.incharge_user_id
     LEFT JOIN users sup ON sup.id = r.support_user_id
     WHERE r.section_id=@sectionId
       AND (@isAdmin = 1 OR ${userCond})
       AND a.status='PENDING'
       AND r.status NOT IN ('CANCELLED','REJECTED')
     ORDER BY r.created_at`,
    { userId: req.user.id, sectionId: req.section.id, isAdmin: isAdmin(req.user) ? 1 : 0 }
  );
  const supportsMap = await loadSupportsMap(result.recordset.map(row => row.request_id));
  const rows = [];
  for (const row of result.recordset) {
    const supTypes = (await query(
      "SELECT sup_type, item_id, level_id, level_name FROM request_support_types WHERE request_id=@id ORDER BY sup_type",
      { id: row.request_id }
    )).recordset.map(r => ({
      supType: r.sup_type,
      itemId: r.item_id,
      levelId: r.level_id,
      levelName: r.level_name
    }));
    rows.push(applySupports(
      { ...row, attachments: await getAttachments(row.request_id), supTypes },
      supportsMap.get(row.request_id) || []
    ));
  }
  res.json({ data: rows });
}));

router.get("/extensions/pending", asyncHandler(async (req, res) => {
  const userCond = await extensionStepUserCondition("a", "@userId");
  const result = await query(
    `SELECT a.id AS step_id, a.sequence_no, a.step_name,
            e.*, r.request_no, r.title, requester.display_name AS requester_name, requested_by.display_name AS requested_by_name,
            requester.branch AS requester_branch, requester.department AS requester_department, requester.section AS requester_section,
            requested_by.branch AS requested_by_branch, requested_by.department AS requested_by_department, requested_by.section AS requested_by_section
     FROM schedule_extension_requests e
     JOIN schedule_extension_approval_steps a ON a.extension_id = e.id
     JOIN requests r ON r.id = e.request_id
     JOIN users requester ON requester.id = r.requester_user_id
     JOIN users requested_by ON requested_by.id = e.requested_by
     WHERE r.section_id=@sectionId
       AND e.status='PENDING_APPROVAL'
       AND a.status='PENDING'
       AND (@isAdmin = 1 OR ${userCond})
     ORDER BY e.created_at`,
    { userId: req.user.id, sectionId: req.section.id, isAdmin: isAdmin(req.user) ? 1 : 0 }
  );
  res.json({ data: result.recordset });
}));

router.post("/:stepId/approve", audit("APPROVE", "APPROVAL_STEP", req => req.params.stepId), asyncHandler(async (req, res) => {
  const schema = z.object({
    comment: z.string().optional().nullable(),
    inchargeUserId: z.number().int().optional().nullable(),
    // Legacy single support (older clients) — superseded by supportUserIds.
    supportUserId: z.number().int().optional().nullable(),
    supportUserIds: z.array(z.number().int()).optional().nullable(),
    plannedStart: z.string().optional().nullable(),
    plannedEnd: z.string().optional().nullable(),
    isKpi: z.boolean().optional().nullable(),
    // A support type is either a plain string (matrix off) or an object carrying
    // the picked skill item + required level (matrix on).
    supTypes: z.array(z.union([
      z.string().trim().min(1),
      z.object({
        supType: z.string().trim().min(1).optional(),
        name: z.string().trim().min(1).optional(),
        itemId: z.number().int().optional().nullable(),
        levelId: z.number().int().optional().nullable(),
        levelName: z.string().optional().nullable()
      })
    ])).optional().nullable()
  });
  const input = schema.parse(req.body);
  const normalizedSupTypes = normalizeSupTypes(input.supTypes);
  // Multiple supports: prefer the new array, fall back to the legacy single id.
  // The incharge never doubles as their own support.
  const supportUserIds = [...new Set(
    (input.supportUserIds ?? (input.supportUserId != null ? [input.supportUserId] : []))
      .filter(id => Number.isInteger(id) && id !== input.inchargeUserId)
  )];
  const values = {
    comment: input.comment ?? null,
    inchargeUserId: input.inchargeUserId ?? null,
    plannedStart: input.plannedStart ?? null,
    plannedEnd: input.plannedEnd ?? null,
    isKpi: input.isKpi ?? true
  };
  const step = await getStep(req.params.stepId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Approval step not found" });

  const isCloseApproval = step.sequence_no >= 100;

  // Assignment (incharge/period/support types) is only the job of a handling-
  // section member. A cross-section (origin) approver — e.g. an Automation
  // approver acting in the Maintenance inbox where they don't work — just
  // approves; the handling section assigns to their own people.
  const canAssign = !isCloseApproval && step.can_assign_work && req.sectionAccess.canWork === true;

  if (canAssign) {
    if (!values.inchargeUserId || !values.plannedStart || !values.plannedEnd) {
      return res.status(400).json({ message: "Approval must assign incharge and project period" });
    }
    if (new Date(values.plannedStart) > new Date(values.plannedEnd)) {
      return res.status(400).json({ message: "Project start must be before project end" });
    }
    // Skill-matrix gate: when the picked support types carry a required level,
    // every required skill must be covered by the incharge and support pooled
    // together — one may fill the gaps the other leaves.
    const required = normalizedSupTypes.filter(s => s.itemId && s.levelId);
    if (required.length) {
      const skill = await evaluateSkillSufficiency(required, values.inchargeUserId, supportUserIds);
      if (!skill.combinedOk) {
        return res.status(400).json({ message: "INCHARGE_SKILL_INSUFFICIENT" });
      }
    }
  }

  // Stamp the user who actually decided — with co-approvers any candidate may
  // act, so the step's approver becomes whoever approved it.
  await query(
    `UPDATE approval_steps SET status='APPROVED', approver_user_id=@actorId, decision_comment=@comment, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: Number(req.params.stepId), comment: values.comment, actorId: req.user.id }
  );

  if (canAssign) {
    await query(
      `UPDATE requests SET incharge_user_id=@inchargeUserId, planned_start=@plannedStart, planned_end=@plannedEnd, is_kpi=@isKpi,
       status='PENDING_APPROVAL', updated_at=SYSUTCDATETIME() WHERE id=@requestId`,
      { ...values, requestId: step.request_id }
    );
    // Multi-support list (also mirrors the first into the legacy column).
    await setSupports(step.request_id, supportUserIds);
    // Replace the request's support-type tags with the approver's selection.
    await query("DELETE FROM request_support_types WHERE request_id=@requestId", { requestId: step.request_id });
    for (const st of normalizedSupTypes) {
      await query(
        `INSERT INTO request_support_types (request_id, sup_type, item_id, level_id, level_name)
         VALUES (@requestId, @supType, @itemId, @levelId, @levelName)`,
        { requestId: step.request_id, supType: st.supType, itemId: st.itemId, levelId: st.levelId, levelName: st.levelName }
      );
    }
    // NOTE: the assignee is NOT notified here. Assignment can happen at an early
    // step (e.g. the section manager assigns at step 1) while later approvers
    // haven't signed off yet — telling the incharge now would be premature. The
    // assign notification/email is fired only on FINAL approval (see below).
  }

  const next = (await query(
    `SELECT TOP 1 a.* FROM approval_steps a
     WHERE a.request_id=@requestId AND a.status='WAITING'
       AND ((@isCloseApproval = 1 AND a.sequence_no >= 100) OR (@isCloseApproval = 0 AND a.sequence_no < 100))
     ORDER BY a.sequence_no`,
    { requestId: step.request_id, isCloseApproval: isCloseApproval ? 1 : 0 }
  )).recordset[0];

  if (next) {
    await query("UPDATE approval_steps SET status='PENDING', updated_at=SYSUTCDATETIME() WHERE id=@id", { id: next.id });
    const title = isCloseApproval ? "Close request needs approval" : "Request needs approval";
    // Every candidate on the next step gets pinged; any one of them may act.
    for (const approver of await stepCandidates(next.id)) {
      await notify({ userId: approver.id, requestId: step.request_id, type: "APPROVAL", title, body: step.request_no });
      const mail = await buildApproverEmail(step.request_id, { greetingName: approver.display_name, kind: isCloseApproval ? "CLOSE" : "REQUEST" });
      if (mail && approver.email) {
        await sendMail({ to: approver.email, subject: mail.subject, html: mail.html, text: mail.text, requestId: step.request_id, type: mail.type });
      }
    }
    // Mid-chain approval — the step moved (and assignment may have changed);
    // let every open client refresh their inbox/list live.
    emitSystem("request.updated", { id: step.request_id, status: "PENDING_APPROVAL" });
  } else {
    if (isCloseApproval) {
      await query("UPDATE requests SET status='COMPLETED', closed_by=@userId, closed_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id", {
        id: step.request_id,
        userId: req.user.id
      });
      await notifyRequestParticipants(step.request_id, "COMPLETE", "Request completed", `${step.request_no} has been closed as complete`);
      emitSystem("request.updated", { id: step.request_id, status: "COMPLETED" });
    } else {
      await query("UPDATE requests SET status='IN_PROGRESS', approved_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id", { id: step.request_id });
      const info = (await query(
        "SELECT request_no, requester_user_id, incharge_user_id, support_user_id FROM requests WHERE id=@id",
        { id: step.request_id }
      )).recordset[0];
      // The requester learns their request cleared every approval step...
      await notifyParticipant(step.request_id, info.requester_user_id, "APPROVE", "Request approved",
        `${step.request_no} is now in progress`);
      // ...and only now — after the FINAL approver signed off — do the assigned
      // incharge/support get told they own the work.
      await notifyAssignedUsers(step.request_id, step.request_no, info.incharge_user_id, info.support_user_id, req.user.displayName);
      emitSystem("request.updated", { id: step.request_id, status: "IN_PROGRESS" });
    }
  }

  res.json({ ok: true });
}));

router.post("/:stepId/reject", audit("REJECT", "APPROVAL_STEP", req => req.params.stepId), asyncHandler(async (req, res) => {
  const schema = z.object({ comment: z.string().trim().min(1) });
  const input = schema.parse(req.body);
  const step = await getStep(req.params.stepId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Approval step not found" });

  await query(
    `UPDATE approval_steps SET status='REJECTED', approver_user_id=@actorId, decision_comment=@comment, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: Number(req.params.stepId), comment: input.comment, actorId: req.user.id }
  );
  if (step.sequence_no >= 100) {
    await query("UPDATE requests SET status='IN_PROGRESS', reject_reason=@comment, updated_at=SYSUTCDATETIME() WHERE id=@id", {
      id: step.request_id,
      comment: input.comment
    });
    await query("UPDATE approval_steps SET status='SKIPPED', updated_at=SYSUTCDATETIME() WHERE request_id=@id AND sequence_no >= 100 AND status='WAITING'", {
      id: step.request_id
    });
    await notifyRequestParticipants(step.request_id, "CLOSE_REJECT", "Close approval rejected", `${step.request_no}: ${input.comment}`, input.comment);
    emitSystem("request.updated", { id: step.request_id, status: "IN_PROGRESS" });
  } else {
    await query("UPDATE requests SET status='REJECTED', reject_reason=@comment, updated_at=SYSUTCDATETIME() WHERE id=@id", {
      id: step.request_id,
      comment: input.comment
    });
    await notifyRequestParticipants(step.request_id, "REJECT", "Request rejected", `${step.request_no}: ${input.comment}`, input.comment);
    emitSystem("request.updated", { id: step.request_id, status: "REJECTED" });
  }
  res.json({ ok: true });
}));

router.post("/close/:requestId", audit("COMPLETE", "REQUEST", req => req.params.requestId), asyncHandler(async (req, res) => {
  res.status(400).json({ message: "Close requests through the approval inbox" });
}));

router.post("/extension/:extensionId/approve", audit("APPROVE", "EXTENSION_REQUEST", req => req.params.extensionId), asyncHandler(async (req, res) => {
  const extensionId = Number(req.params.extensionId);
  const step = await getExtensionStep(extensionId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Extension approval step not found" });
  await query(
    `UPDATE schedule_extension_approval_steps
     SET status='APPROVED', approver_user_id=@actorId, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: step.id, actorId: req.user.id }
  );
  const next = (await query(
    `SELECT TOP 1 a.*
     FROM schedule_extension_approval_steps a
     WHERE a.extension_id=@extensionId AND a.status='WAITING'
     ORDER BY a.sequence_no`,
    { extensionId: step.extension_id }
  )).recordset[0];
  if (next) {
    await query("UPDATE schedule_extension_approval_steps SET status='PENDING', updated_at=SYSUTCDATETIME() WHERE id=@id", { id: next.id });
    for (const approver of await extensionStepCandidates(next.id)) {
      await notify({
        userId: approver.id,
        requestId: step.request_id,
        type: "EXTENSION",
        title: "Schedule extension needs approval",
        body: `${step.request_no} extension #${step.extension_id}`
      });
      const mail = await buildExtensionApproverEmail(step.extension_id, { greetingName: approver.display_name });
      if (mail && approver.email) {
        await sendMail({ to: approver.email, subject: mail.subject, html: mail.html, text: mail.text, requestId: step.request_id, type: mail.type });
      }
    }
    emitSystem("request.updated", { id: step.request_id, part: "extension" });
  } else {
    // The end date moved — clear the one-shot overdue stamp so the end-date
    // reminder job can warn again if the NEW end date is missed too.
    await query(
      "UPDATE requests SET planned_start=@start, planned_end=@end, overdue_notified_at=NULL, updated_at=SYSUTCDATETIME() WHERE id=@requestId",
      {
        requestId: step.request_id,
        start: step.requested_start,
        end: step.requested_end
      }
    );
    await query("UPDATE schedule_extension_requests SET status='APPROVED' WHERE id=@extensionId", {
      extensionId: step.extension_id
    });
    // Email both the request creator AND the incharge who requested the change.
    await notifyExtensionParticipants(step.extension_id, step.request_id, "APPROVED");
    emitSystem("request.updated", { id: step.request_id, status: "SCHEDULE_UPDATED" });
  }
  res.json({ ok: true });
}));

router.post("/extension/:extensionId/reject", audit("REJECT", "EXTENSION_REQUEST", req => req.params.extensionId), asyncHandler(async (req, res) => {
  const extensionId = Number(req.params.extensionId);
  const step = await getExtensionStep(extensionId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Extension approval step not found" });
  await query(
    `UPDATE schedule_extension_approval_steps
     SET status='REJECTED', approver_user_id=@actorId, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: step.id, actorId: req.user.id }
  );
  await query(
    `UPDATE schedule_extension_requests
     SET status='REJECTED', rejected_by=@userId, rejected_at=SYSUTCDATETIME()
     WHERE id=@extensionId AND status='PENDING_APPROVAL'`,
    { extensionId: step.extension_id, userId: req.user.id }
  );
  await query(
    `UPDATE schedule_extension_approval_steps
     SET status='SKIPPED', updated_at=SYSUTCDATETIME()
     WHERE extension_id=@extensionId AND status='WAITING'`,
    { extensionId: step.extension_id }
  );
  // Notify (in-app + email) the incharge who requested the change AND the request
  // creator, so both know the project period stays as-is.
  await notifyExtensionParticipants(step.extension_id, step.request_id, "REJECTED");
  emitSystem("request.updated", { id: step.request_id, part: "extension" });
  res.json({ ok: true });
}));

async function getStep(stepId, user, sectionId) {
  const userCond = await approvalStepUserCondition("a", "@userId");
  return (await query(
    `SELECT a.*,
            r.request_no, r.status AS request_status, r.incharge_user_id, r.support_user_id,
            r.planned_start, r.planned_end, r.is_kpi
     FROM approval_steps a
     JOIN requests r ON r.id=a.request_id
     WHERE a.id=@stepId
       AND (r.section_id=@sectionId OR r.requester_section_id=@sectionId)
       AND (@isAdmin=1 OR ${userCond})
       AND a.status='PENDING'`,
    {
      stepId: Number(stepId),
      userId: user.id,
      sectionId,
      isAdmin: isAdmin(user) ? 1 : 0
    }
  )).recordset[0];
}

async function getExtensionStep(extensionId, user, sectionId) {
  const userCond = await extensionStepUserCondition("a", "@userId");
  // a.* already includes extension_id (the FK), so don't alias e.id to it again
  // — a duplicate column name makes the mssql driver return an array.
  return (await query(
    `SELECT a.*, e.request_id, e.requested_by, e.requested_start, e.requested_end,
            r.request_no
     FROM schedule_extension_approval_steps a
     JOIN schedule_extension_requests e ON e.id = a.extension_id
     JOIN requests r ON r.id = e.request_id
     WHERE e.id=@extensionId
       AND r.section_id=@sectionId
       AND e.status='PENDING_APPROVAL'
       AND a.status='PENDING'
       AND (@isAdmin=1 OR ${userCond})`,
    {
      extensionId: Number(extensionId),
      sectionId,
      userId: user.id,
      isAdmin: isAdmin(user) ? 1 : 0
    }
  )).recordset[0];
}

async function notifyAssignedUsers(requestId, requestNo, inchargeUserId, supportUserId, assignedByName) {
  // Only the incharge is notified — support gets no assignment notification/email.
  if (!inchargeUserId) return;
  const sectionName = await getSectionName(requestId);
  const user = (await query(
    "SELECT id, email, display_name FROM users WHERE id=@id", { id: inchargeUserId }
  )).recordset[0];
  if (!user) return;
  await notify({
    userId: user.id,
    requestId,
    type: "ASSIGN",
    title: `${sectionName} assigned`,
    body: requestNo
  });
  const mail = await buildAssigneeEmail(requestId, {
    greetingName: user.display_name,
    roleLabel: "ผู้รับผิดชอบหลัก (Incharge)",
    assignedByName
  });
  if (mail && user.email) {
    await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
  }
}

// Collapse the approver's supTypes payload (strings and/or objects) into a
// de-duplicated list of { supType, itemId, levelId, levelName }. sup_type (the
// skill item name) is always kept so KPI aggregation by name keeps working.
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

async function getAttachments(requestId) {
  try {
    const result = await query(
      `SELECT id, 'request' AS kind, file_name AS fileName, content_type AS contentType, file_size AS fileSize, created_at
       FROM request_attachments
       WHERE request_id=@requestId
       ORDER BY id`,
      { requestId }
    );
    return result.recordset;
  } catch (err) {
    if (`${err.message}`.includes("Invalid object name")) return [];
    throw err;
  }
}

async function notifyRequestParticipants(requestId, type, title, body, comment) {
  const row = (await query(
    `SELECT r.request_no, r.requester_user_id, r.incharge_user_id, r.support_user_id
     FROM requests r
     WHERE r.id=@requestId`,
    { requestId }
  )).recordset[0];
  if (!row) return;
  // Support is intentionally excluded from ALL notifications (in-app + email).
  const ids = [...new Set([row.requester_user_id, row.incharge_user_id].filter(Boolean))];
  for (const userId of ids) {
    await notifyParticipant(requestId, userId, type, title, body || row.request_no, comment, row);
  }
}

// Schedule-extension outcome fan-out to the request creator, the incharge, and
// whoever raised the extension (in-app + email). Support is excluded entirely.
// event: APPROVED|REJECTED.
async function notifyExtensionParticipants(extensionId, requestId, event, comment) {
  const row = (await query(
    "SELECT request_no, requester_user_id, incharge_user_id FROM requests WHERE id=@requestId",
    { requestId }
  )).recordset[0];
  if (!row) return;
  const ext = (await query(
    "SELECT requested_by FROM schedule_extension_requests WHERE id=@extensionId", { extensionId }
  )).recordset[0];
  const approved = event === "APPROVED";
  const title = approved ? "Project period updated" : "Schedule extension rejected";
  const ids = [...new Set(
    [row.requester_user_id, row.incharge_user_id, ext?.requested_by].filter(Boolean)
  )];
  for (const userId of ids) {
    const user = (await query("SELECT email, display_name FROM users WHERE id=@userId", { userId })).recordset[0];
    await notify({ userId, requestId, type: "EXTENSION", title, body: row.request_no });
    if (user?.email) {
      const mail = await buildExtensionResultEmail(extensionId, { event, greetingName: user.display_name, comment });
      if (mail) {
        await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
      }
    }
  }
}

// Notify a single participant in-app + by email (the email template is chosen
// from `type` via buildParticipantEmail). `row` is an optional pre-loaded
// request row so callers in a loop don't re-query it each time.
async function notifyParticipant(requestId, userId, type, title, body, comment, row) {
  if (!userId) return;
  const request = row || (await query(
    "SELECT request_no, requester_user_id FROM requests WHERE id=@requestId", { requestId }
  )).recordset[0];
  const user = (await query("SELECT email, display_name FROM users WHERE id=@userId", { userId })).recordset[0];
  await notify({ userId, requestId, type, title, body: body || request?.request_no });
  if (user?.email) {
    const mail = await buildParticipantEmail(requestId, type, {
      greetingName: user.display_name,
      comment,
      isRequester: userId === request?.requester_user_id
    });
    if (mail) {
      await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
    }
  }
}

module.exports = router;
