const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { notify } = require("../../services/notificationService");
const { sendMail } = require("../../services/mailService");
const { emitSystem } = require("../../services/realtimeService");
const { isAdmin, resolveSection } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/pending", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT a.*, ars.can_assign_work, r.request_no, r.title, r.priority, r.due_date, r.request_type, r.system_area,
            r.description, r.business_impact, r.is_kpi, r.incharge_user_id, r.support_user_id, r.planned_start, r.planned_end,
            u.display_name AS requester_name, inc.display_name AS incharge_name, sup.display_name AS support_name,
            u.branch AS requester_branch, u.department AS requester_department, u.section AS requester_section,
            inc.branch AS incharge_branch, inc.department AS incharge_department, inc.section AS incharge_section,
            sup.branch AS support_branch, sup.department AS support_department, sup.section AS support_section,
            CASE WHEN a.sequence_no >= 100 THEN 'CLOSE' ELSE 'REQUEST' END AS approval_kind
     FROM approval_steps a
     JOIN requests r ON r.id = a.request_id
     JOIN users u ON u.id = r.requester_user_id
     LEFT JOIN users inc ON inc.id = r.incharge_user_id
     LEFT JOIN users sup ON sup.id = r.support_user_id
     LEFT JOIN approval_route_steps ars ON ars.route_id = a.route_id AND ars.sequence_no =
       CASE WHEN a.sequence_no >= 100 THEN a.sequence_no - 100 ELSE a.sequence_no END
     WHERE r.section_id=@sectionId
       AND (@isAdmin = 1 OR a.approver_user_id=@userId)
       AND a.status='PENDING'
     ORDER BY r.created_at`,
    { userId: req.user.id, sectionId: req.section.id, isAdmin: isAdmin(req.user) ? 1 : 0 }
  );
  const rows = [];
  for (const row of result.recordset) {
    rows.push({ ...row, attachments: await getAttachments(row.request_id) });
  }
  res.json({ data: rows });
}));

router.get("/extensions/pending", asyncHandler(async (req, res) => {
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
       AND (@isAdmin = 1 OR a.approver_user_id=@userId)
     ORDER BY e.created_at`,
    { userId: req.user.id, sectionId: req.section.id, isAdmin: isAdmin(req.user) ? 1 : 0 }
  );
  res.json({ data: result.recordset });
}));

router.post("/:stepId/approve", audit("APPROVE", "APPROVAL_STEP", req => req.params.stepId), asyncHandler(async (req, res) => {
  const schema = z.object({
    comment: z.string().optional().nullable(),
    inchargeUserId: z.number().int().optional().nullable(),
    supportUserId: z.number().int().optional().nullable(),
    plannedStart: z.string().optional().nullable(),
    plannedEnd: z.string().optional().nullable(),
    isKpi: z.boolean().optional().nullable()
  });
  const input = schema.parse(req.body);
  const values = {
    comment: input.comment ?? null,
    inchargeUserId: input.inchargeUserId ?? null,
    supportUserId: input.supportUserId ?? null,
    plannedStart: input.plannedStart ?? null,
    plannedEnd: input.plannedEnd ?? null,
    isKpi: input.isKpi ?? true
  };
  const step = await getStep(req.params.stepId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Approval step not found" });

  const isCloseApproval = step.sequence_no >= 100;

  if (!isCloseApproval && step.can_assign_work) {
    if (!values.inchargeUserId || !values.plannedStart || !values.plannedEnd) {
      return res.status(400).json({ message: "Approval must assign incharge and project period" });
    }
    if (new Date(values.plannedStart) > new Date(values.plannedEnd)) {
      return res.status(400).json({ message: "Project start must be before project end" });
    }
  }

  await query(
    `UPDATE approval_steps SET status='APPROVED', decision_comment=@comment, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: Number(req.params.stepId), comment: values.comment }
  );

  if (!isCloseApproval && step.can_assign_work) {
    await query(
      `UPDATE requests SET incharge_user_id=@inchargeUserId, support_user_id=@supportUserId, planned_start=@plannedStart, planned_end=@plannedEnd, is_kpi=@isKpi,
       status='PENDING_APPROVAL', updated_at=SYSUTCDATETIME() WHERE id=@requestId`,
      { ...values, requestId: step.request_id }
    );
    if (step.sequence_no === 1 ||
        step.incharge_user_id !== values.inchargeUserId ||
        step.support_user_id !== values.supportUserId) {
      await notifyAssignedUsers(step.request_id, step.request_no, values.inchargeUserId, values.supportUserId);
    }
  }

  const next = (await query(
    `SELECT TOP 1 a.*, u.email, u.display_name FROM approval_steps a
     JOIN users u ON u.id = a.approver_user_id
     WHERE a.request_id=@requestId AND a.status='WAITING'
       AND ((@isCloseApproval = 1 AND a.sequence_no >= 100) OR (@isCloseApproval = 0 AND a.sequence_no < 100))
     ORDER BY a.sequence_no`,
    { requestId: step.request_id, isCloseApproval: isCloseApproval ? 1 : 0 }
  )).recordset[0];

  if (next) {
    await query("UPDATE approval_steps SET status='PENDING', updated_at=SYSUTCDATETIME() WHERE id=@id", { id: next.id });
    const title = isCloseApproval ? "Close request needs approval" : "Request needs approval";
    await notify({ userId: next.approver_user_id, requestId: step.request_id, type: "APPROVAL", title, body: step.request_no });
    await sendMail({ to: next.email, subject: `[Automation Request] Approval required: ${step.request_no}`, html: `<p>Please approve ${step.request_no}</p>`, requestId: step.request_id, type: "APPROVAL" });
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
      await notifyRequestParticipants(step.request_id, "APPROVE", "Request approved", `${step.request_no} is now in progress`);
      emitSystem("request.updated", { id: step.request_id, status: "IN_PROGRESS" });
    }
  }

  res.json({ ok: true });
}));

router.post("/:stepId/reject", audit("REJECT", "APPROVAL_STEP", req => req.params.stepId), asyncHandler(async (req, res) => {
  const schema = z.object({ comment: z.string().min(3) });
  const input = schema.parse(req.body);
  const step = await getStep(req.params.stepId, req.user, req.section.id);
  if (!step) return res.status(404).json({ message: "Approval step not found" });

  await query(
    `UPDATE approval_steps SET status='REJECTED', decision_comment=@comment, decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: Number(req.params.stepId), comment: input.comment }
  );
  if (step.sequence_no >= 100) {
    await query("UPDATE requests SET status='IN_PROGRESS', reject_reason=@comment, updated_at=SYSUTCDATETIME() WHERE id=@id", {
      id: step.request_id,
      comment: input.comment
    });
    await query("UPDATE approval_steps SET status='SKIPPED', updated_at=SYSUTCDATETIME() WHERE request_id=@id AND sequence_no >= 100 AND status='WAITING'", {
      id: step.request_id
    });
    await notifyRequestParticipants(step.request_id, "REJECT", "Close approval rejected", `${step.request_no}: ${input.comment}`);
    emitSystem("request.updated", { id: step.request_id, status: "IN_PROGRESS" });
  } else {
    await query("UPDATE requests SET status='REJECTED', reject_reason=@comment, updated_at=SYSUTCDATETIME() WHERE id=@id", {
      id: step.request_id,
      comment: input.comment
    });
    await notifyRequestParticipants(step.request_id, "REJECT", "Request rejected", `${step.request_no}: ${input.comment}`);
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
     SET status='APPROVED', decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: step.id }
  );
  const next = (await query(
    `SELECT TOP 1 a.*, u.email, u.display_name
     FROM schedule_extension_approval_steps a
     JOIN users u ON u.id = a.approver_user_id
     WHERE a.extension_id=@extensionId AND a.status='WAITING'
     ORDER BY a.sequence_no`,
    { extensionId: step.extension_id }
  )).recordset[0];
  if (next) {
    await query("UPDATE schedule_extension_approval_steps SET status='PENDING', updated_at=SYSUTCDATETIME() WHERE id=@id", { id: next.id });
    await notify({
      userId: next.approver_user_id,
      requestId: step.request_id,
      type: "EXTENSION",
      title: "Schedule extension needs approval",
      body: `${step.request_no} extension #${step.extension_id}`
    });
    await sendMail({
      to: next.email,
      subject: `[Automation Request] Extension approval required: ${step.request_no}`,
      html: `<p>Please review schedule extension request for <strong>${step.request_no}</strong>.</p>`,
      requestId: step.request_id,
      type: "EXTENSION"
    });
  } else {
    await query("UPDATE requests SET planned_start=@start, planned_end=@end, updated_at=SYSUTCDATETIME() WHERE id=@requestId", {
      requestId: step.request_id,
      start: step.requested_start,
      end: step.requested_end
    });
    await query("UPDATE schedule_extension_requests SET status='APPROVED' WHERE id=@extensionId", {
      extensionId: step.extension_id
    });
    await notifyRequestParticipants(step.request_id, "EXTENSION", "Project period updated", "Schedule extension approved");
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
     SET status='REJECTED', decided_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@stepId`,
    { stepId: step.id }
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
  await notify({
    userId: step.requested_by,
    requestId: step.request_id,
    type: "EXTENSION",
    title: "Schedule extension rejected",
    body: `Extension #${step.extension_id} was rejected`
  });
  res.json({ ok: true });
}));

async function getStep(stepId, user, sectionId) {
  return (await query(
    `SELECT a.*, ars.can_assign_work,
            r.request_no, r.status AS request_status, r.incharge_user_id, r.support_user_id,
            r.planned_start, r.planned_end, r.is_kpi
     FROM approval_steps a
     JOIN requests r ON r.id=a.request_id
     LEFT JOIN approval_route_steps ars ON ars.route_id = a.route_id AND ars.sequence_no =
       CASE WHEN a.sequence_no >= 100 THEN a.sequence_no - 100 ELSE a.sequence_no END
     WHERE a.id=@stepId
       AND r.section_id=@sectionId
       AND (@isAdmin=1 OR a.approver_user_id=@userId)
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
  return (await query(
    `SELECT a.*, e.id AS extension_id, e.request_id, e.requested_by, e.requested_start, e.requested_end,
            r.request_no
     FROM schedule_extension_approval_steps a
     JOIN schedule_extension_requests e ON e.id = a.extension_id
     JOIN requests r ON r.id = e.request_id
     WHERE e.id=@extensionId
       AND r.section_id=@sectionId
       AND e.status='PENDING_APPROVAL'
       AND a.status='PENDING'
       AND (@isAdmin=1 OR a.approver_user_id=@userId)`,
    {
      extensionId: Number(extensionId),
      sectionId,
      userId: user.id,
      isAdmin: isAdmin(user) ? 1 : 0
    }
  )).recordset[0];
}

async function notifyAssignedUsers(requestId, requestNo, inchargeUserId, supportUserId) {
  const ids = [inchargeUserId, supportUserId].filter(Boolean);
  if (!ids.length) return;
  const result = await query(
    `SELECT id, email, display_name FROM users WHERE id IN (${ids.map((_, index) => `@id${index}`).join(",")})`,
    Object.fromEntries(ids.map((id, index) => [`id${index}`, id]))
  );
  for (const user of result.recordset) {
    await notify({
      userId: user.id,
      requestId,
      type: "ASSIGN",
      title: "Automation work assigned",
      body: requestNo
    });
    await sendMail({
      to: user.email,
      subject: `[Automation Request] Assigned: ${requestNo}`,
      html: `<p>You have been assigned to automation request <strong>${requestNo}</strong>.</p>`,
      requestId,
      type: "ASSIGN"
    });
  }
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

async function notifyRequestParticipants(requestId, type, title, body) {
  const row = (await query(
    `SELECT r.request_no, r.requester_user_id, r.incharge_user_id, r.support_user_id
     FROM requests r
     WHERE r.id=@requestId`,
    { requestId }
  )).recordset[0];
  if (!row) return;
  const ids = [...new Set([row.requester_user_id, row.incharge_user_id, row.support_user_id].filter(Boolean))];
  for (const userId of ids) {
    const user = (await query("SELECT email FROM users WHERE id=@userId", { userId })).recordset[0];
    await notify({
      userId,
      requestId,
      type,
      title,
      body: body || row.request_no
    });
    if (user?.email) {
      await sendMail({
        to: user.email,
        subject: `[Automation Request] ${title}: ${row.request_no}`,
        html: `<p>${body || row.request_no}</p>`,
        requestId,
        type
      });
    }
  }
}

module.exports = router;
