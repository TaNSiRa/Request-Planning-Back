const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireAdmin, resolveSection } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/", requireAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value, value_type, is_public, section_id
     FROM app_settings
     WHERE section_id IS NULL OR section_id=@sectionId
     ORDER BY CASE WHEN section_id IS NULL THEN 0 ELSE 1 END, setting_key`,
    { sectionId: req.section.id }
  );
  res.json({ data: result.recordset });
}));

router.get("/request-options", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value
     FROM app_settings
     WHERE setting_key IN ('request.types', 'request.priorities', 'request.supTypes')
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
    supTypes: splitCsv(map["request.supTypes"], [])
  });
}));

// Global org lookup lists (Branch/Department/Section) used to populate the
// dropdowns in Manage Users and Profile — same idea as request-options but
// these are org-wide, not per-request-section.
router.get("/org-options", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT setting_key, setting_value FROM app_settings
     WHERE setting_key IN ('org.branches', 'org.departments', 'org.sections') AND section_id IS NULL`
  );
  const map = {};
  for (const row of result.recordset) map[row.setting_key] = row.setting_value;
  res.json({
    branches: splitCsv(map["org.branches"], []),
    departments: splitCsv(map["org.departments"], []),
    sections: splitCsv(map["org.sections"], [])
  });
}));

router.put("/:key", requireAdmin, audit("EDIT", "SETTING", req => req.params.key), asyncHandler(async (req, res) => {
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
  res.json({ ok: true });
}));

router.get("/approval-routes", requireAdmin, asyncHandler(async (req, res) => {
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

router.post("/approval-routes", requireAdmin, audit("CREATE", "APPROVAL_ROUTE", req => req.body.name), asyncHandler(async (req, res) => {
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
  res.status(201).json({ id: routeId });
}));

router.put("/approval-routes/:routeId", requireAdmin, audit("EDIT", "APPROVAL_ROUTE", req => req.params.routeId), asyncHandler(async (req, res) => {
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
  res.json({ ok: true });
}));

router.delete("/approval-routes/:routeId", requireAdmin, audit("DELETE", "APPROVAL_ROUTE", req => req.params.routeId), asyncHandler(async (req, res) => {
  const routeId = Number(req.params.routeId);
  await query("UPDATE approval_routes SET is_active=0 WHERE id=@routeId AND section_id=@sectionId", {
    routeId,
    sectionId: req.section.id
  });
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
  return key.startsWith("frontend.") || key.startsWith("mail.") || key.startsWith("microsoft365.") || key.startsWith("org.");
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
