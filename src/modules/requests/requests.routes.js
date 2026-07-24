const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { sendMail } = require("../../services/mailService");
const { buildApproverEmail, buildParticipantEmail, buildExtensionApproverEmail, buildImportantTodoDoneEmail } = require("../../services/emailTemplates");
const { notify } = require("../../services/notificationService");
const { emitSystem } = require("../../services/realtimeService");
const { storeDataUrlAttachment, readAttachmentAsDataUrl, deleteStoredAttachment } = require("../../services/attachmentStorage");
const { isAdmin, resolveSection } = require("../../services/sectionService");
const { blockViewerWrites } = require("../../middleware/viewerGuard");
const { getMaxAttachments, MAX_ATTACHMENTS_CEILING } = require("../../services/settingsService");
const { loadSupportsMap, getSupports, applySupports, isSupportUser } = require("../../services/supportService");
const {
  approvalStepUserCondition,
  routeStepApproverIds,
  saveStepApprovers,
  saveExtensionStepApprovers,
  stepCandidates,
  extensionStepCandidates,
  requestStepCandidateMap
} = require("../../services/approverService");

const router = express.Router();
router.use(requireAuth);

// Which section a request belongs to — used by deep links that lack ?section=
// so the SPA can auto-enter the right section instead of asking the recipient
// to pick one first. Registered BEFORE resolveSection because no section is
// selected yet at that point in the app.
router.get("/:id/section", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid request id" });
  const row = (await query(
    `SELECT s.code, s.name
     FROM requests r
     JOIN request_sections s ON s.id = r.section_id
     WHERE r.id = @id`,
    { id }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "Request not found" });
  res.json({ sectionCode: row.code, sectionName: row.name });
}));

router.use(resolveSection);
// Raising a NEW request belongs to the Create Request page; every other write
// here (cancel, todos, complete, hold, extension) belongs to the Request List.
router.use(blockViewerWrites(req => (req.method === "POST" && req.path === "/" ? "create" : "list")));

router.get("/", asyncHandler(async (req, res) => {
  const { status, q, type, from, to } = req.query;
  const canViewAll = req.sectionAccess.canViewAll ? 1 : 0;
  const result = await query(
    `SELECT r.*, u.display_name AS requester_name, au.display_name AS incharge_name, su.display_name AS support_name,
            u.full_name AS requester_full_name, au.full_name AS incharge_full_name, su.full_name AS support_full_name,
            u.branch AS requester_branch, u.department AS requester_department, u.section AS requester_section,
            au.branch AS incharge_branch, au.department AS incharge_department, au.section AS incharge_section,
            su.branch AS support_branch, su.department AS support_department, su.section AS support_section,
            todo.todo_total, todo.todo_done, todo.todo_progress_percent,
            (SELECT t2.id, t2.title, t2.planned_start, t2.planned_end, t2.is_done, t2.is_important
               FROM request_todos t2
               WHERE t2.request_id = r.id
               ORDER BY t2.sort_order, t2.id
               FOR JSON PATH) AS todos_json
     FROM requests r
     JOIN users u ON u.id = r.requester_user_id
     LEFT JOIN users au ON au.id = r.incharge_user_id
     LEFT JOIN users su ON su.id = r.support_user_id
     OUTER APPLY (
       SELECT COUNT(1) AS todo_total,
              COALESCE(SUM(CASE WHEN t.is_done = 1 THEN 1 ELSE 0 END), 0) AS todo_done,
              CASE
                WHEN COUNT(1) = 0 THEN 0
                ELSE CAST(ROUND(COALESCE(SUM(CASE WHEN t.is_done = 1 THEN 1 ELSE 0 END), 0) * 100.0 / COUNT(1), 0) AS INT)
              END AS todo_progress_percent
       FROM request_todos t
       WHERE t.request_id = r.id
     ) todo
     WHERE (@status IS NULL OR r.status = @status)
       AND (r.section_id = @sectionId OR r.requester_section_id = @sectionId)
       AND (@type IS NULL OR r.request_type = @type)
       AND (@q IS NULL OR r.title LIKE '%' + @q + '%' OR r.request_no LIKE '%' + @q + '%')
       AND (@from IS NULL OR r.created_at >= @from)
       AND (@to IS NULL OR r.created_at <= @to)
     ORDER BY r.created_at DESC`,
    {
      status: status || null,
      type: type || null,
      q: q || null,
      from: from || null,
      to: to || null,
      userId: req.user.id,
      sectionId: req.section.id,
      canViewAll
    }
  );
  const rows = result.recordset.map(row => {
    const { todos_json, ...rest } = row;
    return { ...rest, todos: todos_json ? JSON.parse(todos_json) : [] };
  });
  // Attach every request's full support list (multi-support) in one query.
  const supportsMap = await loadSupportsMap(rows.map(row => row.id));
  for (const row of rows) applySupports(row, supportsMap.get(row.id) || []);
  res.json({ data: rows });
}));

router.get("/attachments/:kind/:attachmentId/data-url", asyncHandler(async (req, res) => {
  const attachment = await getAttachmentForDownload(
    req.params.kind,
    Number(req.params.attachmentId),
    req.user,
    req.section.id,
    req.sectionAccess
  );
  if (!attachment) return res.status(404).json({ message: "Attachment not found" });
  const dataUrl = attachment.storage_path
    ? await readAttachmentAsDataUrl(attachment.storage_path, attachment.content_type)
    : attachment.data_url;
  if (!dataUrl) return res.status(404).json({ message: "Attachment content not found" });
  res.json({ dataUrl });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const request = (await query(
    `SELECT r.*, requester.display_name AS requester_name, inc.display_name AS incharge_name, sup.display_name AS support_name,
            requester.branch AS requester_branch, requester.department AS requester_department, requester.section AS requester_section,
            inc.branch AS incharge_branch, inc.department AS incharge_department, inc.section AS incharge_section,
            sup.branch AS support_branch, sup.department AS support_department, sup.section AS support_section,
            ts.name AS target_section_name, os.name AS origin_section_name
     FROM requests r
     JOIN users requester ON requester.id = r.requester_user_id
     JOIN request_sections ts ON ts.id = r.section_id
     LEFT JOIN request_sections os ON os.id = r.requester_section_id
     LEFT JOIN users inc ON inc.id = r.incharge_user_id
     LEFT JOIN users sup ON sup.id = r.support_user_id
     WHERE r.id=@id AND (r.section_id=@sectionId OR r.requester_section_id=@sectionId)`,
    { id, sectionId: req.section.id }
  )).recordset[0];
  if (!request) return res.status(404).json({ message: "Request not found" });
  // Any member of the section may view a request in that section (the query is
  // already scoped by section_id). Mutations stay gated by their own checks
  // (e.g. assertCanManageRequestWork, requester/admin).
  const todos = (await query("SELECT * FROM request_todos WHERE request_id=@id ORDER BY sort_order, id", { id })).recordset;
  const todoAttachments = await getTodoAttachments(id);
  for (const todo of todos) {
    todo.attachments = todoAttachments.get(todo.id) || [];
  }
  const attachments = await getAttachments(id);
  const extensionHistory = await getExtensionHistory(id);
  const approvals = (await query(
    `SELECT a.*, u.display_name AS approver_name,
            u.branch AS approver_branch, u.department AS approver_department, u.section AS approver_section
     FROM approval_steps a LEFT JOIN users u ON u.id = a.approver_user_id
     WHERE a.request_id=@id ORDER BY sequence_no`,
    { id }
  )).recordset;
  // Co-approvers: expose each step's full candidate list, and show all names on
  // steps that are still undecided ("A or B"); decided steps keep the actor.
  const candidateMap = await requestStepCandidateMap(id);
  for (const step of approvals) {
    const candidates = candidateMap.get(step.id) || [];
    step.candidate_ids = candidates.map(c => c.id);
    step.candidate_names = candidates.map(c => c.name);
    if (candidates.length > 1 && (step.status === "PENDING" || step.status === "WAITING")) {
      step.approver_name = candidates.map(c => c.name).join(" / ");
    }
  }
  const supTypes = (await query(
    "SELECT sup_type, item_id, level_id, level_name FROM request_support_types WHERE request_id=@id ORDER BY sup_type", { id }
  )).recordset.map(r => ({
    supType: r.sup_type,
    itemId: r.item_id,
    levelId: r.level_id,
    levelName: r.level_name
  }));
  applySupports(request, await getSupports(id));
  res.json({ data: { ...request, todos, approvals, attachments, extensionHistory, supTypes } });
}));

router.get("/:id/export.txt", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const detail = (await query(
    `SELECT r.*, requester.display_name AS requester_name, inc.display_name AS incharge_name, sup.display_name AS support_name,
            requester.branch AS requester_branch, requester.department AS requester_department, requester.section AS requester_section,
            inc.branch AS incharge_branch, inc.department AS incharge_department, inc.section AS incharge_section,
            sup.branch AS support_branch, sup.department AS support_department, sup.section AS support_section
     FROM requests r
     JOIN users requester ON requester.id = r.requester_user_id
     LEFT JOIN users inc ON inc.id = r.incharge_user_id
     LEFT JOIN users sup ON sup.id = r.support_user_id
     WHERE r.id=@id AND (r.section_id=@sectionId OR r.requester_section_id=@sectionId)`,
    { id, sectionId: req.section.id }
  )).recordset[0];
  if (!detail) return res.status(404).send("Request not found");
  // Show every support (multi-support) in the exported Support line.
  applySupports(detail, await getSupports(id));
  // View-only export: allowed for any member of the request's section.
  const todos = (await query("SELECT * FROM request_todos WHERE request_id=@id ORDER BY sort_order, id", { id })).recordset;
  const todoAttachments = await getTodoAttachments(id);
  const attachments = await getAttachments(id);
  const lines = [
    `${req.section.name.toUpperCase()} FORM`,
    "=======================",
    `Request No: ${detail.request_no}`,
    `Title: ${detail.title}`,
    `Type: ${detail.request_type}`,
    `System Area: ${detail.system_area || "-"}`,
    `Priority: ${detail.priority}`,
    `Status: ${detail.status}`,
    `Requester: ${detail.requester_name}`,
    `Requester Branch/Department/Section: ${detail.requester_branch || "-"} / ${detail.requester_department || "-"} / ${detail.requester_section || "-"}`,
    `Incharge: ${detail.incharge_name || "-"}`,
    `Incharge Branch/Department/Section: ${detail.incharge_branch || "-"} / ${detail.incharge_department || "-"} / ${detail.incharge_section || "-"}`,
    `Support: ${detail.support_name || "-"}`,
    `Support Branch/Department/Section: ${detail.support_branch || "-"} / ${detail.support_department || "-"} / ${detail.support_section || "-"}`,
    `Due Date: ${formatDate(detail.due_date)}`,
    `Project Period: ${formatDate(detail.planned_start)} - ${formatDate(detail.planned_end)}`,
    "",
    "Description",
    detail.description || "-",
    "",
    "Business Impact",
    detail.business_impact || "-",
    "",
    `Attachments: ${attachments.length}`,
    "",
    "Todo List",
    ...todos.map((todo, index) => {
      const files = todoAttachments.get(todo.id) || [];
      const fileNames = files.length ? ` | Files: ${files.map(file => file.fileName).join(", ")}` : "";
      return `${index + 1}. [${todo.is_done ? "x" : " "}] ${todo.title} (${formatDate(todo.planned_start)} - ${formatDate(todo.planned_end)})${fileNames}`;
    })
  ];
  res.header("Content-Type", "text/plain; charset=utf-8").send(lines.join("\n"));
}));

router.post("/", audit("CREATE", "REQUEST", req => req.body.title), asyncHandler(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    requestType: z.string().min(1),
    systemArea: z.string().min(1),
    priority: z.string().min(1).default("NORMAL"),
    dueDate: z.string(),
    description: z.string().min(1),
    businessImpact: z.string().min(1),
    attachments: attachmentSchema()
  });
  const input = schema.parse(req.body);
  const { attachments, ...requestInput } = input;
  const values = {
    ...requestInput,
    systemArea: input.systemArea ?? null,
    businessImpact: input.businessImpact ?? null
  };
  // The request lives in the section it's created in (the executing/handling
  // section). The requester's home section (from their profile) is the origin;
  // if it differs, a stage-1 origin approval is inserted ahead of this section's
  // route. See resolveRequesterSection.
  const maxAttachments = await getMaxAttachments(req.section.id, "request");
  assertAttachmentLimit(attachments, maxAttachments);
  const requesterSectionId = await resolveRequesterSection(req.user.section, req.section.id);
  const number = await generateRequestNumber(req.section.id, req.section.requestPrefix || "AR");
  const insert = await query(
    // is_kpi starts false — the approver decides whether it counts as KPI when
    // they assign the work, not the requester at creation time.
    `INSERT INTO requests (section_id, requester_section_id, request_no, requester_user_id, title, request_type, system_area, priority, due_date, description, business_impact, status, is_kpi)
     OUTPUT INSERTED.id
     VALUES (@sectionId, @requesterSectionId, @number, @userId, @title, @requestType, @systemArea, @priority, @dueDate, @description, @businessImpact, 'PENDING_APPROVAL', 0)`,
    { ...values, sectionId: req.section.id, requesterSectionId, number, userId: req.user.id }
  );
  const requestId = insert.recordset[0].id;
  await saveAttachments(requestId, attachments, maxAttachments);
  await createApprovalSteps(requestId, req.section.id, requesterSectionId, input.requestType);
  await notifyRequestParticipants(requestId, "CREATE", "Request submitted", number);
  await notifyFirstApprover(requestId, number);
  emitSystem("request.created", { id: requestId, requestNo: number, status: "PENDING_APPROVAL" });
  res.status(201).json({ id: requestId, requestNo: number });
}));

router.patch("/:id/cancel", audit("CANCEL", "REQUEST"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const row = (await query(
    "SELECT * FROM requests WHERE id=@id AND (section_id=@sectionId OR requester_section_id=@sectionId)", {
    id,
    sectionId: req.section.id
  })).recordset[0];
  if (!row) return res.status(404).json({ message: "Request not found" });
  if (row.requester_user_id !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ message: "Only requester can cancel this request" });
  }
  await query("UPDATE requests SET status='CANCELLED', cancel_reason=@reason, cancelled_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id", {
    id,
    reason: req.body.reason || null
  });
  // Clear anything that was still waiting on this request so it doesn't linger in
  // approvers' inboxes: pending/waiting approval steps and any open schedule
  // extension request + its approval steps.
  await query(
    "UPDATE approval_steps SET status='SKIPPED', updated_at=SYSUTCDATETIME() WHERE request_id=@id AND status IN ('PENDING','WAITING')",
    { id }
  );
  await query(
    `UPDATE schedule_extension_approval_steps SET status='SKIPPED', updated_at=SYSUTCDATETIME()
     WHERE status IN ('PENDING','WAITING')
       AND extension_id IN (SELECT id FROM schedule_extension_requests WHERE request_id=@id)`,
    { id }
  );
  await query(
    "UPDATE schedule_extension_requests SET status='REJECTED' WHERE request_id=@id AND status='PENDING_APPROVAL'",
    { id }
  );
  await notifyRequestParticipants(id, "CANCEL", "Request cancelled", row.request_no);
  emitSystem("request.updated", { id, status: "CANCELLED" });
  res.json({ ok: true });
}));

// Flip the KPI flag straight from the request-detail page. Until now is_kpi
// could only be set by the assigning approver at approve-time; this lets it be
// corrected afterwards. Only a system admin, or an approver on this request's
// route, may change it — and only once the request has been assigned (a planned
// period exists), since KPI is meaningless before assignment.
router.patch("/:id/kpi", audit("EDIT", "REQUEST", req => req.params.id), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { isKpi } = z.object({ isKpi: z.boolean() }).parse(req.body);
  const row = (await query(
    "SELECT * FROM requests WHERE id=@id AND (section_id=@sectionId OR requester_section_id=@sectionId)",
    { id, sectionId: req.section.id }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "Request not found" });
  if (!row.planned_start) {
    return res.status(400).json({ message: "Request must be assigned before KPI can be set" });
  }
  let allowed = isAdmin(req.user);
  if (!allowed) {
    // Primary approver or any co-approver on the request's route may flip KPI.
    const cond = await approvalStepUserCondition("a", "@userId");
    const step = (await query(
      `SELECT TOP 1 a.id FROM approval_steps a WHERE a.request_id=@id AND ${cond}`,
      { id, userId: req.user.id }
    )).recordset[0];
    allowed = !!step;
  }
  if (!allowed) {
    return res.status(403).json({ message: "Only a system admin or an approver can change KPI" });
  }
  await query("UPDATE requests SET is_kpi=@isKpi, updated_at=SYSUTCDATETIME() WHERE id=@id", { id, isKpi });
  emitSystem("request.updated", { id, isKpi });
  res.json({ ok: true });
}));

router.post("/:id/todos", audit("CREATE", "TODO"), asyncHandler(async (req, res) => {
  const schema = z.object({
    title: z.string().trim().min(1),
    description: z.string().optional().nullable(),
    plannedStart: z.string(),
    plannedEnd: z.string(),
    sortOrder: z.number().int().optional().default(0),
    isImportant: z.boolean().optional().default(false),
    attachments: attachmentSchema()
  });
  const input = schema.parse(req.body);
  const { attachments, ...todoInput } = input;
  const values = {
    ...todoInput,
    description: input.description ?? null
  };
  await assertCanManageRequestWork(Number(req.params.id), req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  await assertTodoWindow(Number(req.params.id), req.section.id, input.plannedStart, input.plannedEnd);
  const maxAttachments = await getMaxAttachments(req.section.id, "todo");
  assertAttachmentLimit(attachments, maxAttachments);
  // A new todo always joins at the end of the manual (drag) order — callers
  // that don't set sortOrder get MAX(sort_order)+1 instead of a flat 0, which
  // would otherwise drop it above every reordered row.
  const sortOrder = input.sortOrder || (await query(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM request_todos WHERE request_id=@id",
    { id: Number(req.params.id) }
  )).recordset[0].next;
  const result = await query(
    `INSERT INTO request_todos (request_id, title, description, planned_start, planned_end, sort_order, is_important, created_by)
     OUTPUT INSERTED.id VALUES (@id, @title, @description, @plannedStart, @plannedEnd, @sortOrder, @isImportant, @userId)`,
    { ...values, sortOrder, id: Number(req.params.id), userId: req.user.id }
  );
  const todoId = result.recordset[0].id;
  await saveTodoAttachments(Number(req.params.id), todoId, attachments, maxAttachments);
  emitSystem("request.updated", { id: Number(req.params.id), part: "todos" });
  res.status(201).json({ id: todoId });
}));

// Drag-and-drop ordering. The client posts the todo ids in their new visual
// order and we renumber sort_order 1..n. Registered BEFORE /:id/todos/:todoId
// so "reorder" is not matched as a todo id.
router.patch("/:id/todos/reorder", audit("REORDER", "TODO", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({ ids: z.array(z.number().int().positive()).min(1) });
  const { ids } = schema.parse(req.body);
  const id = Number(req.params.id);
  await assertCanManageRequestWork(id, req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  // Only ids that really belong to this request are renumbered; anything the
  // client didn't send keeps its old sort_order and trails behind.
  const owned = new Set(
    (await query("SELECT id FROM request_todos WHERE request_id=@id", { id })).recordset.map(row => row.id)
  );
  let position = 0;
  for (const todoId of ids) {
    if (!owned.has(todoId)) continue;
    position += 1;
    await query("UPDATE request_todos SET sort_order=@sortOrder WHERE id=@todoId AND request_id=@id", {
      sortOrder: position,
      todoId,
      id
    });
  }
  emitSystem("request.updated", { id, part: "todos" });
  res.json({ ok: true });
}));

router.patch("/:id/todos/:todoId", audit("EDIT", "TODO", req => req.params.todoId), asyncHandler(async (req, res) => {
  const schema = z.object({
    title: z.string().trim().min(1),
    description: z.string().optional().nullable(),
    plannedStart: z.string(),
    plannedEnd: z.string(),
    isDone: z.boolean().optional().default(false),
    // Optional so callers that don't know about the star (e.g. the done-toggle)
    // leave the stored value untouched via COALESCE below.
    isImportant: z.boolean().optional(),
    attachments: attachmentSchema({ defaultEmpty: false })
  });
  const input = schema.parse(req.body);
  const { attachments, ...todoInput } = input;
  const values = {
    ...todoInput,
    description: input.description ?? null,
    isImportant: input.isImportant === undefined ? null : input.isImportant
  };
  await assertCanManageRequestWork(Number(req.params.id), req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  await assertTodoWindow(Number(req.params.id), req.section.id, input.plannedStart, input.plannedEnd);
  // Snapshot before the update so we can detect an important todo flipping to
  // done (that transition emails the requester, incharge, and approvers).
  const before = (await query(
    "SELECT is_done, is_important FROM request_todos WHERE id=@todoId AND request_id=@id",
    { todoId: Number(req.params.todoId), id: Number(req.params.id) }
  )).recordset[0];
  await query(
    `UPDATE request_todos SET title=@title, description=@description, planned_start=@plannedStart, planned_end=@plannedEnd,
      is_done=@isDone, is_important=COALESCE(@isImportant, is_important),
      completed_at=CASE WHEN @isDone=1 THEN SYSUTCDATETIME() ELSE NULL END,
      -- Moving planned_end needs no reminder bookkeeping: due_reminder_log is
      -- keyed by due date, so a new deadline re-arms the whole schedule.
      updated_at=SYSUTCDATETIME()
     WHERE id=@todoId AND request_id=@id`,
    { ...values, todoId: Number(req.params.todoId), id: Number(req.params.id) }
  );
  if (Object.prototype.hasOwnProperty.call(req.body, "attachments")) {
    const maxAttachments = await getMaxAttachments(req.section.id, "todo");
    // Enforce the cap only when NEW files are being added — a todo whose
    // existing files exceed a later-lowered cap must stay editable as-is.
    if ((attachments || []).some(isNewAttachment)) {
      assertAttachmentLimit(attachments, maxAttachments);
    }
    await replaceTodoAttachments(Number(req.params.id), Number(req.params.todoId), attachments, maxAttachments);
  }
  const wasDone = before?.is_done === true || before?.is_done === 1;
  const importantNow = input.isImportant ?? (before?.is_important === true || before?.is_important === 1);
  if (before && !wasDone && input.isDone && importantNow) {
    await notifyImportantTodoDone(Number(req.params.id), Number(req.params.todoId), req.user);
  }
  emitSystem("request.updated", { id: Number(req.params.id), part: "todos" });
  res.json({ ok: true });
}));

router.delete("/:id/todos/:todoId", audit("DELETE", "TODO", req => req.params.todoId), asyncHandler(async (req, res) => {
  await assertCanManageRequestWork(Number(req.params.id), req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  await deleteTodoAttachmentFiles(Number(req.params.id), Number(req.params.todoId));
  await query("DELETE FROM request_todos WHERE id=@todoId AND request_id=@id", {
    todoId: Number(req.params.todoId),
    id: Number(req.params.id)
  });
  emitSystem("request.updated", { id: Number(req.params.id), part: "todos" });
  res.json({ ok: true });
}));

router.post("/:id/complete-work", audit("COMPLETE_WORK", "REQUEST"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await assertCanManageRequestWork(id, req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  const request = (await query("SELECT request_no, status FROM requests WHERE id=@id AND section_id=@sectionId", {
    id,
    sectionId: req.section.id
  })).recordset[0];
  if (!request) return res.status(404).json({ message: "Request not found" });
  if (request.status !== "IN_PROGRESS") {
    return res.status(400).json({ message: "Only in-progress requests can be submitted for close approval" });
  }
  const pending = (await query("SELECT COUNT(*) AS count FROM request_todos WHERE request_id=@id AND is_done=0", { id })).recordset[0].count;
  if (pending > 0) return res.status(400).json({ message: "All todo items must be completed first" });
  await query("UPDATE requests SET status='WAITING_CLOSE', work_completed_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id", { id });
  await createCloseApprovalSteps(id, req.section.id);
  await notifyFirstCloseApprover(id);
  await notifyRequestParticipants(id, "WAITING_CLOSE", "Work submitted for close", "Waiting for approver to close this request");
  emitSystem("request.updated", { id, status: "WAITING_CLOSE" });
  res.json({ ok: true });
}));

// Toggle a request between IN_PROGRESS and ON_HOLD. The assigned incharge or an
// admin may pause/resume work; in Meeting mode (?meeting=1) any section member may.
router.post("/:id/hold", audit("HOLD", "REQUEST"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const request = (await query(
    "SELECT request_no, status, incharge_user_id FROM requests WHERE id=@id AND section_id=@sectionId",
    { id, sectionId: req.section.id }
  )).recordset[0];
  if (!request) return res.status(404).json({ message: "Request not found" });
  const isIncharge = request.incharge_user_id === req.user.id;
  const fromMeeting = req.query.meeting === "1";
  if (!isIncharge && !req.sectionAccess?.isAdmin && !fromMeeting) {
    return res.status(403).json({ message: "Only the assigned incharge can hold this request" });
  }
  if (request.status !== "IN_PROGRESS" && request.status !== "ON_HOLD") {
    return res.status(400).json({ message: "Only in-progress requests can be put on hold" });
  }
  const next = request.status === "ON_HOLD" ? "IN_PROGRESS" : "ON_HOLD";
  await query("UPDATE requests SET status=@next, updated_at=SYSUTCDATETIME() WHERE id=@id", { id, next });
  await notifyRequestParticipants(
    id,
    next,
    next === "ON_HOLD" ? "Request put on hold" : "Request resumed",
    next === "ON_HOLD" ? "This request has been put on hold" : "This request is back in progress"
  );
  emitSystem("request.updated", { id, status: next });
  res.json({ ok: true, status: next });
}));

router.post("/:id/extension-requests", audit("CREATE", "EXTENSION_REQUEST"), asyncHandler(async (req, res) => {
  const schema = z.object({ requestedStart: z.string(), requestedEnd: z.string(), reason: z.string().min(1) });
  const input = schema.parse(req.body);
  const requestId = Number(req.params.id);
  await assertCanManageRequestWork(requestId, req.user, req.sectionAccess, req.section.id, {
    allowSectionMember: req.query.meeting === "1"
  });
  const request = (await query("SELECT planned_start, planned_end, request_type FROM requests WHERE id=@id AND section_id=@sectionId", {
    id: requestId,
    sectionId: req.section.id
  })).recordset[0];
  if (!request) return res.status(404).json({ message: "Request not found" });
  if (!request.planned_start || !request.planned_end) {
    return res.status(400).json({ message: "Project period has not been assigned yet" });
  }
  const result = await query(
    `INSERT INTO schedule_extension_requests (request_id, requested_by, previous_start, previous_end, requested_start, requested_end, reason, status)
     OUTPUT INSERTED.id VALUES (@id, @userId, @previousStart, @previousEnd, @requestedStart, @requestedEnd, @reason, 'PENDING_APPROVAL')`,
    {
      ...input,
      id: requestId,
      userId: req.user.id,
      previousStart: request.planned_start,
      previousEnd: request.planned_end
    }
  );
  await createExtensionApprovalSteps(result.recordset[0].id, req.section.id, request.request_type);
  await notifyFirstExtensionApprover(requestId, result.recordset[0].id);
  emitSystem("request.updated", { id: requestId, part: "extension" });
  res.status(201).json({ id: result.recordset[0].id });
}));

// Maps the requester's profile section text (e.g. "Maintenance") to a
// request_sections id. Returns null when it can't be resolved or resolves to the
// handling section itself (internal request — no stage-1 origin approval).
async function resolveRequesterSection(userSectionText, handlingSectionId) {
  const text = `${userSectionText || ""}`.trim();
  if (!text) return null;
  const row = (await query(
    `SELECT TOP 1 id FROM request_sections
     WHERE is_active=1 AND (code=@code OR name=@text OR name LIKE @prefix)
     ORDER BY CASE WHEN code=@code THEN 0 WHEN name=@text THEN 1 ELSE 2 END, id`,
    { code: text.toUpperCase(), text, prefix: text + "%" }
  )).recordset[0];
  if (!row || row.id === handlingSectionId) return null;
  return row.id;
}

async function getRouteSteps(routeId) {
  const steps = (await query(
    `SELECT id, sequence_no, step_name, default_approver_user_id, can_assign_work
     FROM approval_route_steps WHERE route_id=@routeId ORDER BY sequence_no`,
    { routeId }
  )).recordset;
  // Attach each step's full candidate list (primary + co-approvers) so the
  // per-request steps can snapshot it. Falls back to [primary] pre-patch.
  const approverMap = await routeStepApproverIds(routeId);
  for (const step of steps) {
    const list = approverMap.get(step.id) || [];
    if (step.default_approver_user_id && !list.includes(step.default_approver_user_id)) {
      list.unshift(step.default_approver_user_id);
    }
    step.approver_ids = list;
  }
  return steps;
}

// Stage-1 cross-section route: requests from requesterSectionId executed by targetSectionId.
async function findCrossRoute(targetSectionId, requesterSectionId, requestType) {
  const result = await query(
    `SELECT TOP 1 id
     FROM approval_routes
     WHERE section_id=@targetSectionId
       AND requester_section_id=@requesterSectionId
       AND is_active=1
       AND (request_type=@requestType OR request_type IS NULL)
     ORDER BY
       CASE WHEN request_type=@requestType THEN 0 WHEN is_default=1 THEN 1 ELSE 2 END,
       is_default DESC, id`,
    { targetSectionId, requesterSectionId, requestType: requestType || null }
  );
  return result.recordset[0] || null;
}

// Builds the forward approval chain. When the request is cross-section, the
// requester section's origin-approval route runs first (stage 1), then the
// target section's internal route (stage 2). Steps are renumbered 1..n.
async function createApprovalSteps(requestId, targetSectionId, requesterSectionId, requestType) {
  const combined = [];
  if (requesterSectionId && requesterSectionId !== targetSectionId) {
    const crossRoute = await findCrossRoute(targetSectionId, requesterSectionId, requestType);
    if (crossRoute) {
      for (const step of await getRouteSteps(crossRoute.id)) combined.push({ routeId: crossRoute.id, step });
    }
  }
  const route = await findApprovalRoute(targetSectionId, requestType);
  if (!route) {
    const err = new Error("No active approval route is configured for this section");
    err.status = 400;
    throw err;
  }
  for (const step of await getRouteSteps(route.id)) combined.push({ routeId: route.id, step });

  let seq = 1;
  for (const { routeId, step } of combined) {
    const inserted = await query(
      `INSERT INTO approval_steps (request_id, route_id, sequence_no, approver_user_id, step_name, can_assign_work, status)
       OUTPUT INSERTED.id
       VALUES (@requestId, @routeId, @seq, @approver, @stepName, @canAssign, @status)`,
      {
        requestId,
        routeId,
        seq,
        approver: step.default_approver_user_id,
        stepName: step.step_name,
        canAssign: step.can_assign_work ? 1 : 0,
        status: seq === 1 ? "PENDING" : "WAITING"
      }
    );
    // Snapshot the step's co-approver candidates (any of them may act).
    await saveStepApprovers(inserted.recordset[0].id, step.approver_ids || []);
    seq++;
  }
}

async function createCloseApprovalSteps(requestId, sectionId) {
  await query("DELETE FROM approval_steps WHERE request_id=@requestId AND sequence_no >= 100 AND status IN ('WAITING','PENDING')", { requestId });
  const request = (await query("SELECT request_type FROM requests WHERE id=@requestId AND section_id=@sectionId", {
    requestId,
    sectionId
  })).recordset[0];
  const route = await findApprovalRoute(sectionId, request?.request_type);
  if (!route) {
    const err = new Error("No active approval route is configured for this section");
    err.status = 400;
    throw err;
  }
  for (const step of await getRouteSteps(route.id)) {
    const inserted = await query(
      `INSERT INTO approval_steps (request_id, route_id, sequence_no, approver_user_id, step_name, can_assign_work, status)
       OUTPUT INSERTED.id
       VALUES (@requestId, @routeId, @seq, @approver, @stepName, @canAssign, @status)`,
      {
        requestId,
        routeId: route.id,
        seq: step.sequence_no + 100,
        approver: step.default_approver_user_id,
        stepName: `Close - ${step.step_name}`,
        canAssign: step.can_assign_work ? 1 : 0,
        status: step.sequence_no === 1 ? "PENDING" : "WAITING"
      }
    );
    await saveStepApprovers(inserted.recordset[0].id, step.approver_ids || []);
  }
}

// Internal/target routes only (cross-section stage-1 routes are excluded here).
async function findApprovalRoute(sectionId, requestType) {
  const result = await query(
    `SELECT TOP 1 id
     FROM approval_routes
     WHERE section_id=@sectionId
       AND requester_section_id IS NULL
       AND is_active=1
       AND (request_type=@requestType OR request_type IS NULL)
     ORDER BY
       CASE WHEN request_type=@requestType THEN 0 WHEN is_default=1 THEN 1 ELSE 2 END,
       is_default DESC,
       id`,
    { sectionId, requestType: requestType || null }
  );
  return result.recordset[0] || null;
}

async function createExtensionApprovalSteps(extensionId, sectionId, requestType) {
  const route = await findApprovalRoute(sectionId, requestType);
  if (!route) {
    const err = new Error("No active approval route is configured for this section");
    err.status = 400;
    throw err;
  }
  for (const step of await getRouteSteps(route.id)) {
    const inserted = await query(
      `INSERT INTO schedule_extension_approval_steps (extension_id, route_id, sequence_no, approver_user_id, step_name, status)
       OUTPUT INSERTED.id
       VALUES (@extensionId, @routeId, @seq, @approver, @stepName, @status)`,
      {
        extensionId,
        routeId: route.id,
        seq: step.sequence_no,
        approver: step.default_approver_user_id,
        stepName: `Extension - ${step.step_name}`,
        status: step.sequence_no === 1 ? "PENDING" : "WAITING"
      }
    );
    await saveExtensionStepApprovers(inserted.recordset[0].id, step.approver_ids || []);
  }
}

async function notifyFirstApprover(requestId, requestNo) {
  const step = (await query(
    "SELECT TOP 1 id FROM approval_steps WHERE request_id=@requestId AND sequence_no=1",
    { requestId }
  )).recordset[0];
  if (!step) return;
  // Every candidate on the step (primary + co-approvers) gets notified —
  // whoever acts first decides for the step.
  for (const approver of await stepCandidates(step.id)) {
    await notify({ userId: approver.id, requestId, type: "APPROVAL", title: "New request needs approval", body: requestNo });
    const mail = await buildApproverEmail(requestId, { greetingName: approver.display_name, kind: "REQUEST" });
    if (mail && approver.email) {
      await sendMail({ to: approver.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
    }
  }
}

async function notifyFirstExtensionApprover(requestId, extensionId) {
  const row = (await query(
    `SELECT TOP 1 a.id AS step_id, r.request_no
     FROM schedule_extension_approval_steps a
     JOIN schedule_extension_requests e ON e.id = a.extension_id
     JOIN requests r ON r.id = e.request_id
     WHERE e.id=@extensionId AND e.request_id=@requestId AND a.status='PENDING'
     ORDER BY a.sequence_no`,
    { requestId, extensionId }
  )).recordset[0];
  if (!row) return;
  for (const approver of await extensionStepCandidates(row.step_id)) {
    await notify({
      userId: approver.id,
      requestId,
      type: "EXTENSION",
      title: "Schedule extension needs approval",
      body: `${row.request_no} extension #${extensionId}`
    });
    const mail = await buildExtensionApproverEmail(extensionId, { greetingName: approver.display_name });
    if (mail && approver.email) {
      await sendMail({ to: approver.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
    }
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

async function getTodoAttachments(requestId) {
  try {
    const result = await query(
      `SELECT id, 'todo' AS kind, todo_id AS todoId, file_name AS fileName, content_type AS contentType, file_size AS fileSize, created_at
       FROM todo_attachments
       WHERE request_id=@requestId
       ORDER BY todo_id, id`,
      { requestId }
    );
    const grouped = new Map();
    for (const attachment of result.recordset) {
      if (!grouped.has(attachment.todoId)) grouped.set(attachment.todoId, []);
      grouped.get(attachment.todoId).push(attachment);
    }
    return grouped;
  } catch (err) {
    if (`${err.message}`.includes("Invalid object name")) return new Map();
    throw err;
  }
}

// Rejects a payload that exceeds the section's configured attachment cap with a
// clear message (instead of silently dropping the extras).
function assertAttachmentLimit(attachments, maxAttachments) {
  if ((attachments?.length || 0) <= maxAttachments) return;
  const err = new Error(`Attachments are limited to ${maxAttachments} file${maxAttachments === 1 ? "" : "s"}`);
  err.status = 400;
  throw err;
}

async function saveAttachments(requestId, attachments = [], maxAttachments = 5) {
  const context = await getAttachmentStorageContext(requestId, { bucket: "Request Files" });
  for (const attachment of attachments.slice(0, maxAttachments)) {
    if (!isNewAttachment(attachment)) continue;
    const stored = await storeDataUrlAttachment(attachment, context);
    await query(
      `INSERT INTO request_attachments (request_id, file_name, content_type, data_url, storage_path, file_size)
       VALUES (@requestId, @fileName, @contentType, NULL, @storagePath, @fileSize)`,
      {
        requestId,
        fileName: attachment.fileName,
        contentType: stored.contentType,
        storagePath: stored.storagePath,
        fileSize: stored.fileSize
      }
    );
  }
}

async function saveTodoAttachments(requestId, todoId, attachments = [], maxAttachments = 5) {
  const bucket = await getTodoAttachmentBucket(requestId, todoId);
  const context = await getAttachmentStorageContext(requestId, { bucket });
  for (const attachment of attachments.slice(0, maxAttachments)) {
    if (!isNewAttachment(attachment)) continue;
    const stored = await storeDataUrlAttachment(attachment, context);
    await query(
      `INSERT INTO todo_attachments (request_id, todo_id, file_name, content_type, data_url, storage_path, file_size)
       VALUES (@requestId, @todoId, @fileName, @contentType, NULL, @storagePath, @fileSize)`,
      {
        requestId,
        todoId,
        fileName: attachment.fileName,
        contentType: stored.contentType,
        storagePath: stored.storagePath,
        fileSize: stored.fileSize
      }
    );
  }
}

async function getTodoAttachmentBucket(requestId, todoId) {
  const result = await query(
    `SELECT todo_index
     FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) AS todo_index
       FROM request_todos
       WHERE request_id=@requestId
     ) ranked
     WHERE id=@todoId`,
    { requestId, todoId }
  );
  const index = Number(result.recordset[0]?.todo_index) || 1;
  return `${String(index).padStart(3, "0")}_todo`;
}

async function replaceTodoAttachments(requestId, todoId, attachments = [], maxAttachments = 5) {
  const existing = (await query(
    `SELECT id, storage_path
     FROM todo_attachments
     WHERE request_id=@requestId AND todo_id=@todoId`,
    { requestId, todoId }
  )).recordset;
  const existingIds = new Set(existing.map(row => Number(row.id)));
  const keepIds = new Set(
    attachments
      .map(attachment => Number(attachment.id))
      .filter(id => Number.isInteger(id) && existingIds.has(id))
  );
  const removed = existing.filter(row => !keepIds.has(Number(row.id)));
  for (const attachment of removed) {
    await deleteStoredAttachment(attachment.storage_path);
  }
  if (removed.length) {
    const params = { requestId, todoId };
    const ids = removed.map((row, index) => {
      params[`id${index}`] = row.id;
      return `@id${index}`;
    });
    await query(
      `DELETE FROM todo_attachments
       WHERE request_id=@requestId AND todo_id=@todoId AND id IN (${ids.join(",")})`,
      params
    );
  }
  await saveTodoAttachments(requestId, todoId, attachments, maxAttachments);
}

async function deleteTodoAttachmentFiles(requestId, todoId) {
  const existing = (await query(
    `SELECT storage_path
     FROM todo_attachments
     WHERE request_id=@requestId AND todo_id=@todoId`,
    { requestId, todoId }
  )).recordset;
  for (const attachment of existing) {
    await deleteStoredAttachment(attachment.storage_path);
  }
}

function isNewAttachment(attachment) {
  return typeof attachment?.dataUrl === "string" && attachment.dataUrl.startsWith("data:");
}

async function getAttachmentStorageContext(requestId, { bucket } = {}) {
  const result = await query(
    `SELECT r.request_no, r.created_at, requester.branch, requester.department, s.name AS request_section
     FROM requests r
     JOIN users requester ON requester.id = r.requester_user_id
     LEFT JOIN request_sections s ON s.id = r.section_id
     WHERE r.id=@requestId`,
    { requestId }
  );
  const row = result.recordset[0] || {};
  return {
    branch: row.branch,
    department: row.department,
    section: row.request_section,
    createdAt: row.created_at,
    requestNo: row.request_no,
    bucket
  };
}

async function getAttachmentForDownload(kind, attachmentId, user, sectionId, sectionAccess) {
  const isTodo = kind === "todo";
  const table = isTodo ? "todo_attachments" : "request_attachments";
  const result = await query(
    `SELECT a.id, a.request_id, a.file_name, a.content_type, a.data_url, a.storage_path,
            r.section_id, r.requester_user_id, r.incharge_user_id, r.support_user_id
     FROM ${table} a
     JOIN requests r ON r.id = a.request_id
     WHERE a.id=@attachmentId AND r.section_id=@sectionId`,
    { attachmentId, sectionId }
  );
  const row = result.recordset[0];
  if (!row) return null;
  // View-only download: any member of the request's section may read attachments.
  return row;
}

async function getExtensionHistory(requestId) {
  const result = await query(
    `SELECT e.*, requested_by.display_name AS requested_by_name,
            requested_by.branch AS requested_by_branch, requested_by.department AS requested_by_department, requested_by.section AS requested_by_section,
            first_user.display_name AS first_approved_by_name,
            first_user.branch AS first_approved_by_branch, first_user.department AS first_approved_by_department, first_user.section AS first_approved_by_section,
            second_user.display_name AS second_approved_by_name,
            second_user.branch AS second_approved_by_branch, second_user.department AS second_approved_by_department, second_user.section AS second_approved_by_section,
            rejected_user.display_name AS rejected_by_name,
            rejected_user.branch AS rejected_by_branch, rejected_user.department AS rejected_by_department, rejected_user.section AS rejected_by_section
     FROM schedule_extension_requests e
     JOIN users requested_by ON requested_by.id = e.requested_by
     LEFT JOIN users first_user ON first_user.id = e.first_approved_by
     LEFT JOIN users second_user ON second_user.id = e.second_approved_by
     LEFT JOIN users rejected_user ON rejected_user.id = e.rejected_by
     WHERE e.request_id=@requestId
     ORDER BY e.created_at DESC`,
    { requestId }
  );
  for (const extension of result.recordset) {
    extension.approvalSteps = (await query(
      `SELECT a.*, u.display_name AS approver_name
       FROM schedule_extension_approval_steps a
       LEFT JOIN users u ON u.id = a.approver_user_id
       WHERE a.extension_id=@extensionId
       ORDER BY a.sequence_no`,
      { extensionId: extension.id }
    )).recordset;
  }
  return result.recordset;
}

function attachmentSchema({ defaultEmpty = true } = {}) {
  const schema = z.array(z.object({
    id: z.number().int().positive().optional().nullable(),
    kind: z.string().max(30).optional().nullable(),
    fileName: z.string().min(1).max(255),
    contentType: z.string().max(100).optional().nullable(),
    dataUrl: z.string().optional().nullable()
  }).refine(
    attachment => Boolean(attachment.id) || isNewAttachment(attachment),
    { message: "Attachment must include an existing id or a data URL" }
    // Hard safety ceiling only — the real per-section cap (default 5) is checked
    // against the section's request/todo.maxAttachments setting per route.
  )).max(MAX_ATTACHMENTS_CEILING);
  return defaultEmpty ? schema.optional().default([]) : schema.optional();
}

async function generateRequestNumber(sectionId, requestPrefix = "AR") {
  const now = new Date();
  const yy = `${now.getUTCFullYear()}`.slice(-2);
  const mm = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getUTCDate()}`.padStart(2, "0");
  const safePrefix = `${requestPrefix || "AR"}`.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "AR";
  const prefix = `${safePrefix}-${yy}${mm}${dd}-`;
  const result = await query(
    `SELECT TOP 1 request_no
     FROM requests
     WHERE section_id=@sectionId AND request_no LIKE @prefix + '%'
     ORDER BY request_no DESC`,
    { prefix, sectionId }
  );
  const latest = result.recordset[0]?.request_no || "";
  const latestNo = Number.parseInt(latest.slice(prefix.length), 10);
  const nextNo = Number.isFinite(latestNo) ? latestNo + 1 : 1;
  return `${prefix}${String(nextNo).padStart(4, "0")}`;
}

async function notifyFirstCloseApprover(requestId) {
  const row = (await query(
    `SELECT TOP 1 a.id AS step_id, r.request_no
     FROM approval_steps a
     JOIN requests r ON r.id = a.request_id
     WHERE a.request_id=@requestId AND a.sequence_no >= 100 AND a.status='PENDING'
     ORDER BY a.sequence_no`,
    { requestId }
  )).recordset[0];
  if (!row) return;
  for (const approver of await stepCandidates(row.step_id)) {
    await notify({
      userId: approver.id,
      requestId,
      type: "CLOSE",
      title: "Work complete needs close approval",
      body: row.request_no
    });
    const mail = await buildApproverEmail(requestId, { greetingName: approver.display_name, kind: "CLOSE" });
    if (mail && approver.email) {
      await sendMail({ to: approver.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
    }
  }
}

// A starred (important) todo was just completed — email + in-app notify the
// requester, the assigned incharge, and every approver on the request's
// approval route (main and close steps alike), deduplicated.
async function notifyImportantTodoDone(requestId, todoId, completedBy) {
  const request = (await query(
    `SELECT r.request_no, r.requester_user_id, r.incharge_user_id
     FROM requests r WHERE r.id=@requestId`,
    { requestId }
  )).recordset[0];
  const todo = (await query(
    `SELECT t.title, t.description,
            (SELECT COUNT(1) FROM request_todos WHERE request_id=@requestId) AS todo_total,
            (SELECT COUNT(1) FROM request_todos WHERE request_id=@requestId AND is_done=1) AS todo_done
     FROM request_todos t WHERE t.id=@todoId AND t.request_id=@requestId`,
    { requestId, todoId }
  )).recordset[0];
  if (!request || !todo) return;
  const approverIds = (await query(
    "SELECT DISTINCT approver_user_id FROM approval_steps WHERE request_id=@requestId AND approver_user_id IS NOT NULL",
    { requestId }
  )).recordset.map(r => r.approver_user_id);
  // Include co-approvers on every step (any of them may act on the route).
  for (const list of (await requestStepCandidateMap(requestId)).values()) {
    for (const c of list) if (!approverIds.includes(c.id)) approverIds.push(c.id);
  }
  const ids = [...new Set([request.requester_user_id, request.incharge_user_id, ...approverIds].filter(Boolean))];
  for (const userId of ids) {
    const user = (await query(
      "SELECT email, display_name FROM users WHERE id=@userId AND is_active=1",
      { userId }
    )).recordset[0];
    if (!user) continue;
    await notify({
      userId,
      requestId,
      type: "TODO_IMPORTANT_DONE",
      title: "Important todo completed",
      body: `${request.request_no} · ${todo.title}`
    });
    if (!user.email) continue;
    const mail = await buildImportantTodoDoneEmail(requestId, {
      greetingName: user.display_name,
      todoTitle: todo.title,
      todoDescription: todo.description,
      completedByName: completedBy?.display_name || completedBy?.displayName || null,
      todoDone: todo.todo_done,
      todoTotal: todo.todo_total
    });
    if (mail) {
      await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
    }
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
    const user = (await query("SELECT email, display_name FROM users WHERE id=@userId", { userId })).recordset[0];
    await notify({
      userId,
      requestId,
      type,
      title,
      body: body || row.request_no
    });
    if (user?.email) {
      const mail = await buildParticipantEmail(requestId, type, {
        greetingName: user.display_name,
        comment,
        isRequester: userId === row.requester_user_id
      });
      if (mail) {
        await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text, requestId, type: mail.type });
      }
    }
  }
}

async function assertTodoWindow(requestId, sectionId, plannedStart, plannedEnd) {
  const row = (await query(
    "SELECT planned_start, planned_end FROM requests WHERE id=@requestId AND section_id=@sectionId",
    { requestId, sectionId }
  )).recordset[0];
  if (!row?.planned_start || !row?.planned_end) return;
  // Compare at day granularity. The frontend already constrains todo dates to the
  // project period at the date level; the stored timestamps carry a time-of-day
  // (and mssql reads DATE/DATETIME columns back as UTC midnight), so a full
  // timestamp comparison spuriously rejected a boundary-day todo whenever the
  // server ran off UTC (e.g. Asia/Bangkok +07).
  const dayOf = (value) => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const s = `${value}`;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : new Date(s).toISOString().slice(0, 10);
  };
  const todoStart = dayOf(plannedStart);
  const todoEnd = dayOf(plannedEnd);
  const projectStart = dayOf(row.planned_start);
  const projectEnd = dayOf(row.planned_end);
  if (todoStart < projectStart || todoEnd > projectEnd || todoStart > todoEnd) {
    const err = new Error("Todo period must be inside assigned project period");
    err.status = 400;
    throw err;
  }
}

async function assertCanManageRequestWork(requestId, user, sectionAccess, sectionId, options = {}) {
  const request = (await query(
    `SELECT requester_user_id, incharge_user_id, support_user_id
     FROM requests
     WHERE id=@requestId AND section_id=@sectionId`,
    { requestId, sectionId }
  )).recordset[0];
  if (!request) {
    const err = new Error("Request not found");
    err.status = 404;
    throw err;
  }
  const canManage =
    sectionAccess?.isAdmin ||
    request.incharge_user_id === user.id ||
    request.support_user_id === user.id ||
    // Meeting mode lets any section member collaborate on todos. The request is
    // already scoped to the caller's section by the query above.
    options.allowSectionMember === true ||
    // Any of the request's (multiple) supports may manage work items too.
    (await isSupportUser(requestId, user.id));
  if (!canManage) {
    const err = new Error("Only assigned incharge/support can update work items");
    err.status = 403;
    throw err;
  }
  return request;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toISOString().slice(0, 10);
}

module.exports = router;
