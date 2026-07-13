const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireAdmin, requireSectionAdmin, resolveSection, isAdmin } = require("../../services/sectionService");
const { verifyMail, isMailConfigured, sendMail } = require("../../services/mailService");
const { normalizeMaxAttachments, getUserDisplayOrder } = require("../../services/settingsService");
const { verifyHoliday } = require("../../db/holidayPool");
const { emitSystem } = require("../../services/realtimeService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

// System-level settings only a global admin may see or edit — a section admin
// manages section-level settings only. Kept in sync with the frontend list in
// settings_page.dart (SettingsPage.isSystemSetting).
function isSystemSetting(key) {
  return key === "mail.enabled" ||
    key === "microsoft365.enabled" ||
    key === "security.idleTimeoutMinutes" ||
    `${key}`.startsWith("org.") ||
    `${key}`.startsWith("holiday.");
}

// Test the external holiday DB connection (SAR / Master_Holiday).
router.get("/holiday/verify", requireAdmin, asyncHandler(async (req, res) => {
  res.json(await verifyHoliday());
}));

// Check the SMTP connection/credentials without sending anything.
router.get("/mail/verify", requireAdmin, asyncHandler(async (req, res) => {
  res.json({ configured: isMailConfigured(), ...(await verifyMail()) });
}));

// Send a real test email to prove end-to-end delivery works.
router.post("/mail/test", requireAdmin, audit("TEST", "MAIL"), asyncHandler(async (req, res) => {
  const schema = z.object({ to: z.string().email() });
  const input = schema.parse(req.body);
  const result = await sendMail({
    to: input.to,
    subject: "Test email — Request & Planning",
    html: "<p>This is a test email from the Request &amp; Planning system. If you received it, SMTP delivery is working.</p>",
    type: "TEST",
    // A test send verifies SMTP regardless of the mail.enabled master switch.
    ignoreEnabledFlag: true
  });
  res.json(result);
}));

// Rows that live in app_settings but are NOT user-facing settings, so the
// Settings page must not list them as editable raw values:
//  - endDateReminder.*   — job bookkeeping (the daily 08:30 end-date reminder
//    stamps the date it last ran so a restart never re-sends that day's mails)
//  - meeting.groupOrder.* / users.displayOrder — saved UI arrangements, edited
//    with the arrows on the Meeting page / weekly plan, not as raw JSON here
function isInternalSetting(key) {
  return `${key}`.startsWith("endDateReminder.") ||
    `${key}`.startsWith("meeting.groupOrder.") ||
    key === "users.displayOrder";
}

// Section-level settings that must always be visible in the Settings UI even
// before a row exists in app_settings — shown with their default until edited
// (PUT /settings/:key inserts the row on first save).
const SECTION_SETTING_DEFAULTS = [
  { key: "request.maxAttachments", value: "5", type: "number", description: "Max files attached to a request" },
  { key: "todo.maxAttachments", value: "5", type: "number", description: "Max files attached to a todo item" }
];

router.get("/", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value, value_type, is_public, section_id
     FROM app_settings
     WHERE section_id IS NULL OR section_id=@sectionId
     ORDER BY CASE WHEN section_id IS NULL THEN 0 ELSE 1 END, setting_key`,
    { sectionId: req.section.id }
  );
  const visible = result.recordset.filter(row => !isInternalSetting(row.setting_key));
  const rows = isAdmin(req.user)
    ? visible
    : visible.filter(row => !isSystemSetting(row.setting_key));
  for (const def of SECTION_SETTING_DEFAULTS) {
    if (!rows.some(row => row.setting_key === def.key && row.section_id === req.section.id)) {
      rows.push({
        setting_key: def.key,
        setting_value: def.value,
        value_type: def.type,
        is_public: true,
        section_id: req.section.id
      });
    }
  }
  res.json({ data: rows });
}));

router.get("/request-options", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value
     FROM app_settings
     WHERE setting_key IN ('request.types', 'request.priorities', 'request.supTypes', 'request.maxAttachments', 'todo.maxAttachments')
       AND (section_id=@sectionId OR section_id IS NULL)
     ORDER BY CASE WHEN section_id=@sectionId THEN 0 ELSE 1 END`
    , { sectionId: req.section.id }
  );
  const map = {};
  for (const row of result.recordset) {
    if (map[row.setting_key] == null) map[row.setting_key] = row.setting_value;
  }
  res.json({
    types: splitCsv(map["request.types"], ["PLC", "SCADA", "Touch Screen", "Flutter App", "Express.js", "Node-RED", "Report", "Other"]),
    priorities: splitCsv(map["request.priorities"], ["LOW", "NORMAL", "HIGH", "URGENT"]),
    supTypes: splitCsv(map["request.supTypes"], []),
    maxRequestAttachments: normalizeMaxAttachments(map["request.maxAttachments"]),
    maxTodoAttachments: normalizeMaxAttachments(map["todo.maxAttachments"])
  });
}));

// Public per-section feature flags read by every authenticated user (e.g. to
// decide whether the Skill Matrix page shows in the sidebar). Defaults to on
// when the section has no explicit setting.
router.get("/features", asyncHandler(async (req, res) => {
  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key='skillMatrix.enabled' AND section_id=@sectionId",
    { sectionId: req.section.id }
  );
  const raw = result.recordset[0]?.setting_value;
  const skillMatrixEnabled = raw == null ? true : `${raw}`.trim().toLowerCase() === "true";
  res.json({ skillMatrixEnabled });
}));

// Global org lookup lists (Branch/Department/Section) used to populate the
// dropdowns in Manage Users and Profile — same idea as request-options but
// these are org-wide, not per-request-section.
router.get("/org-options", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value FROM app_settings
     WHERE setting_key IN ('org.branches', 'org.departments') AND section_id IS NULL`
  );
  const map = {};
  for (const row of result.recordset) map[row.setting_key] = row.setting_value;
  // Section options are the live request sections — no separate org.sections CSV
  // to keep in sync (that duplicated the "Sections & branches" card).
  const sectionRows = (await query(
    "SELECT name FROM request_sections WHERE is_active = 1 ORDER BY name"
  )).recordset;
  res.json({
    branches: splitCsv(map["org.branches"], []),
    departments: splitCsv(map["org.departments"], []),
    sections: sectionRows.map(row => row.name).filter(Boolean)
  });
}));

// Meeting-mode group ordering, shared by the whole section (everyone in the
// meeting sees the same order). Any section member may read and update it —
// the meeting screen is a collaborative view, so no admin gate.
// Stored per grouping mode as app_settings key 'meeting.groupOrder.<mode>'
// (0 incharge, 1 type, 2 status, 3 priority) holding a JSON array of group
// titles, first = top; groups not listed follow the default order.
router.get("/meeting-group-order", asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT setting_key, setting_value FROM app_settings
     WHERE section_id=@sectionId AND setting_key LIKE 'meeting.groupOrder.%'`,
    { sectionId: req.section.id }
  )).recordset;
  const data = {};
  for (const row of rows) {
    const mode = row.setting_key.split(".").pop();
    try {
      const parsed = JSON.parse(row.setting_value);
      if (Array.isArray(parsed)) data[mode] = parsed.map(v => `${v}`);
    } catch {
      // Ignore malformed rows; the client falls back to the default order.
    }
  }
  res.json({ data });
}));

router.put("/meeting-group-order", asyncHandler(async (req, res) => {
  const schema = z.object({
    groupBy: z.number().int().min(0).max(3),
    order: z.array(z.string().max(300)).max(500)
  });
  const input = schema.parse(req.body);
  await query(
    `MERGE app_settings AS target
     USING (SELECT @key AS setting_key, @sectionId AS section_id) AS source
     ON target.setting_key = source.setting_key AND COALESCE(target.section_id, 0) = COALESCE(source.section_id, 0)
     WHEN MATCHED THEN UPDATE SET setting_value=@value, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, value_type, is_public)
       VALUES (@sectionId, @key, @value, 'json', 1);`,
    {
      sectionId: req.section.id,
      key: `meeting.groupOrder.${input.groupBy}`,
      value: JSON.stringify(input.order)
    }
  );
  emitSystem("settings.updated", { sectionId: req.section.id, key: "meeting.groupOrder" });
  res.json({ ok: true });
}));

// Fixed display order of the section's users (JSON array of user ids, first =
// top), edited with the arrows on the Meeting weekly plan. Like the meeting
// group order, any section member may read AND update it — the meeting screen
// is collaborative and everyone must see the same arrangement. Registered
// BEFORE the generic "/:key" PUT so it isn't swallowed by it.
router.get("/user-order", asyncHandler(async (req, res) => {
  res.json({ order: await getUserDisplayOrder(req.section.id) });
}));

router.put("/user-order", asyncHandler(async (req, res) => {
  const schema = z.object({ order: z.array(z.number().int().positive()).max(500) });
  const input = schema.parse(req.body);
  await query(
    `MERGE app_settings AS target
     USING (SELECT @key AS setting_key, @sectionId AS section_id) AS source
     ON target.setting_key = source.setting_key AND COALESCE(target.section_id, 0) = COALESCE(source.section_id, 0)
     WHEN MATCHED THEN UPDATE SET setting_value=@value, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, value_type, is_public, description)
       VALUES (@sectionId, @key, @value, 'json', 1, 'Fixed user display order (user ids, first = top)');`,
    {
      sectionId: req.section.id,
      key: "users.displayOrder",
      value: JSON.stringify(input.order)
    }
  );
  emitSystem("settings.updated", { sectionId: req.section.id, key: "users.displayOrder" });
  res.json({ ok: true });
}));

router.put("/:key", requireSectionAdmin, audit("EDIT", "SETTING", req => req.params.key), asyncHandler(async (req, res) => {
  if (!isAdmin(req.user) && isSystemSetting(req.params.key)) {
    return res.status(403).json({ message: "Only a system administrator can edit this setting" });
  }
  const schema = z.object({ value: z.string(), valueType: z.string().optional().default("string"), isPublic: z.boolean().optional().default(false) });
  const input = schema.parse(req.body);
  const sectionId = isGlobalSetting(req.params.key) ? null : req.section.id;
  await query(
    `MERGE app_settings AS target
     USING (SELECT @key AS setting_key, @sectionId AS section_id) AS source
     ON target.setting_key = source.setting_key AND COALESCE(target.section_id, 0) = COALESCE(source.section_id, 0)
     WHEN MATCHED THEN UPDATE SET setting_value=@value, value_type=@valueType, is_public=@isPublic, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, value_type, is_public)
       VALUES (@sectionId, @key, @value, @valueType, @isPublic);`,
    { sectionId, key: req.params.key, value: input.value, valueType: input.valueType, isPublic: input.isPublic }
  );
  emitSystem("settings.updated", { sectionId, key: req.params.key });
  res.json({ ok: true });
}));

router.get("/approval-routes", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT ar.id AS route_id, ar.name, ar.request_type, ar.is_default, ar.is_active,
            ar.requester_section_id, rs.name AS requester_section_name,
            ars.id AS step_id, ars.sequence_no, ars.step_name, ars.can_assign_work,
            ars.default_approver_user_id, u.display_name AS approver_name,
            u.branch AS approver_branch, u.department AS approver_department, u.section AS approver_section
     FROM approval_routes ar
     JOIN approval_route_steps ars ON ars.route_id=ar.id
     LEFT JOIN users u ON u.id=ars.default_approver_user_id
     LEFT JOIN request_sections rs ON rs.id=ar.requester_section_id
     WHERE ar.section_id=@sectionId
     ORDER BY ar.is_default DESC, ar.name, ars.sequence_no`,
    { sectionId: req.section.id }
  );
  res.json({ data: nestRoutes(result.recordset) });
}));

router.post("/approval-routes", requireSectionAdmin, audit("CREATE", "APPROVAL_ROUTE", req => req.body.name), asyncHandler(async (req, res) => {
  const input = routeSchema.parse(req.body);
  const result = await query(
    `INSERT INTO approval_routes (section_id, requester_section_id, name, request_type, is_default, is_active)
     OUTPUT INSERTED.id
     VALUES (@sectionId, @requesterSectionId, @name, @requestType, @isDefault, @isActive)`,
    {
      sectionId: req.section.id,
      requesterSectionId: input.requesterSectionId || null,
      name: input.name,
      requestType: input.requestType || null,
      isDefault: input.isDefault,
      isActive: input.isActive
    }
  );
  const routeId = result.recordset[0].id;
  await replaceRouteSteps(routeId, input.steps);
  emitSystem("settings.updated", { sectionId: req.section.id, key: "approvalRoutes" });
  res.status(201).json({ id: routeId });
}));

router.put("/approval-routes/:routeId", requireSectionAdmin, audit("EDIT", "APPROVAL_ROUTE", req => req.params.routeId), asyncHandler(async (req, res) => {
  const routeId = Number(req.params.routeId);
  const input = routeSchema.parse(req.body);
  const existing = (await query("SELECT id FROM approval_routes WHERE id=@routeId AND section_id=@sectionId", {
    routeId,
    sectionId: req.section.id
  })).recordset[0];
  if (!existing) return res.status(404).json({ message: "Approval route not found" });
  await query(
    `UPDATE approval_routes
     SET name=@name, request_type=@requestType, requester_section_id=@requesterSectionId,
         is_default=@isDefault, is_active=@isActive
     WHERE id=@routeId AND section_id=@sectionId`,
    {
      routeId,
      sectionId: req.section.id,
      name: input.name,
      requestType: input.requestType || null,
      requesterSectionId: input.requesterSectionId || null,
      isDefault: input.isDefault,
      isActive: input.isActive
    }
  );
  await replaceRouteSteps(routeId, input.steps);
  emitSystem("settings.updated", { sectionId: req.section.id, key: "approvalRoutes" });
  res.json({ ok: true });
}));

router.delete("/approval-routes/:routeId", requireSectionAdmin, audit("DELETE", "APPROVAL_ROUTE", req => req.params.routeId), asyncHandler(async (req, res) => {
  const routeId = Number(req.params.routeId);
  const existing = (await query("SELECT id FROM approval_routes WHERE id=@routeId AND section_id=@sectionId", {
    routeId,
    sectionId: req.section.id
  })).recordset[0];
  if (!existing) return res.status(404).json({ message: "Approval route not found" });
  // A route that has already driven a real request (or extension) is referenced by
  // approval_steps history and can't be hard-deleted without losing that trail —
  // block it and let the admin turn the route off ("Active") instead.
  const used = (await query(
    `SELECT (SELECT COUNT(*) FROM approval_steps WHERE route_id=@routeId)
          + (SELECT COUNT(*) FROM schedule_extension_approval_steps WHERE route_id=@routeId) AS used`,
    { routeId }
  )).recordset[0].used;
  if (used > 0) return res.status(409).json({ message: "ROUTE_IN_USE" });
  await query("DELETE FROM approval_route_steps WHERE route_id=@routeId", { routeId });
  await query("DELETE FROM approval_routes WHERE id=@routeId AND section_id=@sectionId", {
    routeId,
    sectionId: req.section.id
  });
  emitSystem("settings.updated", { sectionId: req.section.id, key: "approvalRoutes" });
  res.json({ ok: true });
}));

function splitCsv(value, fallback) {
  const items = `${value || ""}`.split(",").map(item => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

const routeSchema = z.object({
  name: z.string().min(2),
  requestType: z.string().optional().nullable(),
  // Origin section for a cross-section stage-1 route; null = normal internal route.
  requesterSectionId: z.number().int().positive().optional().nullable(),
  isDefault: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
  steps: z.array(z.object({
    id: z.number().int().optional().nullable(),
    sequenceNo: z.number().int().positive(),
    stepName: z.string().min(2),
    approverUserId: z.number().int().positive(),
    canAssignWork: z.boolean().optional().default(false)
  })).min(1)
});

function isGlobalSetting(key) {
  return key.startsWith("frontend.") || key.startsWith("mail.") || key.startsWith("microsoft365.")
    || key.startsWith("org.") || key.startsWith("holiday.");
}

function nestRoutes(rows) {
  const routes = new Map();
  for (const row of rows) {
    if (!routes.has(row.route_id)) {
      routes.set(row.route_id, {
        id: row.route_id,
        name: row.name,
        requestType: row.request_type,
        requesterSectionId: row.requester_section_id,
        requesterSectionName: row.requester_section_name,
        isDefault: row.is_default === true || row.is_default === 1,
        isActive: row.is_active === true || row.is_active === 1,
        steps: []
      });
    }
    routes.get(row.route_id).steps.push({
      id: row.step_id,
      sequenceNo: row.sequence_no,
      stepName: row.step_name,
      approverUserId: row.default_approver_user_id,
      approverName: row.approver_name,
      canAssignWork: row.can_assign_work === true || row.can_assign_work === 1
    });
  }
  return [...routes.values()];
}

async function replaceRouteSteps(routeId, steps) {
  await query("DELETE FROM approval_route_steps WHERE route_id=@routeId", { routeId });
  for (const step of steps.sort((a, b) => a.sequenceNo - b.sequenceNo)) {
    await query(
      `INSERT INTO approval_route_steps (route_id, sequence_no, step_name, default_approver_user_id, can_assign_work)
       VALUES (@routeId, @sequenceNo, @stepName, @approverUserId, @canAssignWork)`,
      {
        routeId,
        sequenceNo: step.sequenceNo,
        stepName: step.stepName,
        approverUserId: step.approverUserId,
        canAssignWork: step.canAssignWork
      }
    );
  }
}

module.exports = router;
