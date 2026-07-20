const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireAdmin, requireSectionAdmin, resolveSection } = require("../../services/sectionService");
const { routeStepUserCondition } = require("../../services/approverService");
const { emitSystem } = require("../../services/realtimeService");

// Organization chart per request section + the global job-position master list.
// The chart is a free-form JSON tree (person nodes reference users by id so
// names/positions stay live; group nodes split a branch into named sub-teams
// anywhere). Positions/people endpoints are global, so they are NOT behind
// resolveSection — only the chart itself is section-scoped.
const router = express.Router();
router.use(requireAuth);

// Everything here lives in a manual DB patch (patch_positions_org_chart.sql);
// until it is applied reads degrade to "nothing yet" instead of a 500.
async function tryQuery(sql, params) {
  try {
    return (await query(sql, params)).recordset;
  } catch {
    return null;
  }
}

const missingPatch = { message: "Org chart tables are missing — run database/patch_positions_org_chart.sql" };

// ---------------------------------------------------------------------------
// Job positions (global master list for the Profile / Manage Users dropdowns
// and the org-chart person cards).
// ---------------------------------------------------------------------------

router.get("/positions", asyncHandler(async (req, res) => {
  const rows = await tryQuery(
    "SELECT id, name, abbreviation, sort_order FROM positions WHERE is_active=1 ORDER BY sort_order, name"
  );
  res.json({
    data: (rows || []).map(row => ({
      id: row.id,
      name: row.name,
      abbreviation: row.abbreviation,
      sortOrder: row.sort_order
    }))
  });
}));

const positionSchema = z.object({
  name: z.string().trim().min(1).max(150),
  abbreviation: z.string().trim().min(1).max(30),
  sortOrder: z.number().int().min(0).max(100000).optional()
});

router.post("/positions", requireAdmin, audit("CREATE", "POSITION", req => req.body && req.body.name), asyncHandler(async (req, res) => {
  const input = positionSchema.parse(req.body);
  const exists = await tryQuery("SELECT TOP 1 1 AS ok FROM positions");
  if (exists === null) return res.status(500).json(missingPatch);
  // Reactivate a soft-deleted position with the same name instead of duplicating.
  const dupe = (await query(
    "SELECT TOP 1 id, is_active FROM positions WHERE LOWER(name)=LOWER(@name)", { name: input.name }
  )).recordset[0];
  if (dupe && (dupe.is_active === true || dupe.is_active === 1)) {
    return res.status(409).json({ message: "A position with this name already exists" });
  }
  let id;
  if (dupe) {
    id = dupe.id;
    await query(
      "UPDATE positions SET abbreviation=@abbreviation, sort_order=@sortOrder, is_active=1 WHERE id=@id",
      { id, abbreviation: input.abbreviation, sortOrder: input.sortOrder ?? 0 }
    );
  } else {
    const result = await query(
      `INSERT INTO positions (name, abbreviation, sort_order)
       OUTPUT INSERTED.id
       VALUES (@name, @abbreviation, @sortOrder)`,
      { name: input.name, abbreviation: input.abbreviation, sortOrder: input.sortOrder ?? 0 }
    );
    id = result.recordset[0].id;
  }
  emitSystem("orgchart.updated", { positions: true });
  res.status(201).json({ id });
}));

router.put("/positions/:id(\\d+)", requireAdmin, audit("EDIT", "POSITION", req => req.params.id), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = positionSchema.parse(req.body);
  const existing = await tryQuery("SELECT TOP 1 id FROM positions WHERE id=@id AND is_active=1", { id });
  if (existing === null) return res.status(500).json(missingPatch);
  if (!existing.length) return res.status(404).json({ message: "Position not found" });
  const clash = (await query(
    "SELECT TOP 1 id FROM positions WHERE LOWER(name)=LOWER(@name) AND id<>@id AND is_active=1",
    { name: input.name, id }
  )).recordset[0];
  if (clash) return res.status(409).json({ message: "Another position already uses this name" });
  await query(
    "UPDATE positions SET name=@name, abbreviation=@abbreviation, sort_order=@sortOrder WHERE id=@id",
    { id, name: input.name, abbreviation: input.abbreviation, sortOrder: input.sortOrder ?? 0 }
  );
  emitSystem("orgchart.updated", { positions: true });
  res.json({ ok: true });
}));

// Retire a position. Soft delete — users.position_id FK-references it and any
// user still holding it keeps displaying the stored name.
router.delete("/positions/:id(\\d+)", requireAdmin, audit("DELETE", "POSITION", req => req.params.id), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await tryQuery("SELECT TOP 1 id FROM positions WHERE id=@id AND is_active=1", { id });
  if (existing === null) return res.status(500).json(missingPatch);
  if (!existing.length) return res.status(404).json({ message: "Position not found" });
  await query("UPDATE positions SET is_active=0 WHERE id=@id", { id });
  emitSystem("orgchart.updated", { positions: true });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// People picker: every active user in the system (ALL sections), so a chart
// can pull anyone in — each section's chart may look completely different.
// ---------------------------------------------------------------------------

router.get("/people", asyncHandler(async (req, res) => {
  let rows = await tryQuery(
    `SELECT u.id, u.employee_no, u.display_name, u.full_name, u.name_prefix,
            u.branch, u.department, u.section,
            u.position_id, p.name AS position_name, p.abbreviation AS position_abbr
     FROM users u
     LEFT JOIN positions p ON p.id = u.position_id
     WHERE u.is_active = 1
     ORDER BY u.display_name`
  );
  if (rows === null) {
    // Patch not applied yet — still serve the picker, just without positions.
    rows = (await query(
      `SELECT u.id, u.employee_no, u.display_name, u.full_name, u.name_prefix,
              u.branch, u.department, u.section,
              NULL AS position_id, NULL AS position_name, NULL AS position_abbr
       FROM users u
       WHERE u.is_active = 1
       ORDER BY u.display_name`
    )).recordset;
  }
  res.json({ data: rows });
}));

// ---------------------------------------------------------------------------
// The chart itself — one per request section.
// ---------------------------------------------------------------------------

function parseChart(raw) {
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && Array.isArray(parsed.roots)) return parsed;
  } catch {
    /* fall through */
  }
  return null;
}

router.get("/", resolveSection, asyncHandler(async (req, res) => {
  const rows = await tryQuery(
    `SELECT TOP 1 c.chart, c.updated_at, u.display_name AS updated_by_name
     FROM org_charts c
     LEFT JOIN users u ON u.id = c.updated_by
     WHERE c.section_id = @sectionId`,
    { sectionId: req.section.id }
  );
  const row = rows?.[0];
  // Everyone who approves on this section's active routes (primary + co-
  // approvers) — the chart marks their cards with an approver badge.
  const approverCond = await routeStepUserCondition("ars", "u.id");
  const approverRows = await tryQuery(
    `SELECT DISTINCT u.id
     FROM users u
     WHERE u.is_active = 1 AND EXISTS (
       SELECT 1 FROM approval_route_steps ars
       JOIN approval_routes ar ON ar.id = ars.route_id AND ar.is_active = 1
       WHERE ar.section_id = @sectionId AND ${approverCond}
     )`,
    { sectionId: req.section.id }
  );
  res.json({
    installed: rows !== null,
    chart: parseChart(row?.chart),
    updatedAt: row?.updated_at || null,
    updatedByName: row?.updated_by_name || null,
    approverUserIds: (approverRows || []).map(r => r.id)
  });
}));

// Free-form tree: any node can be a person (a picked user) or a group label
// that splits the branch (e.g. Automation → Mechanical / System Development).
const nodeSchema = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    type: z.enum(["person", "group"]),
    userId: z.number().int().positive().nullable().optional(),
    label: z.string().max(200).optional().default(""),
    children: z.array(nodeSchema).max(100).optional().default([])
  })
);

const chartSchema = z.object({
  chart: z.object({ roots: z.array(nodeSchema).max(50) })
});

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children || []);
  return total;
}

router.put("/", resolveSection, requireSectionAdmin, audit("EDIT", "ORG_CHART", req => req.section && req.section.id), asyncHandler(async (req, res) => {
  const input = chartSchema.parse(req.body);
  if (countNodes(input.chart.roots) > 1000) {
    return res.status(400).json({ message: "Chart is too large (max 1000 nodes)" });
  }
  const exists = await tryQuery("SELECT TOP 1 1 AS ok FROM org_charts");
  if (exists === null) return res.status(500).json(missingPatch);
  const chartJson = JSON.stringify(input.chart);
  await query(
    `MERGE org_charts AS target
     USING (SELECT @sectionId AS section_id) AS source
     ON target.section_id = source.section_id
     WHEN MATCHED THEN UPDATE SET chart=@chart, updated_by=@userId, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (section_id, chart, updated_by, updated_at)
       VALUES (@sectionId, @chart, @userId, SYSUTCDATETIME());`,
    { sectionId: req.section.id, chart: chartJson, userId: req.user.id }
  );
  emitSystem("orgchart.updated", { sectionId: req.section.id });
  res.json({ ok: true });
}));

module.exports = router;
