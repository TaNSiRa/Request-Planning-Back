const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireAdmin } = require("../../services/sectionService");

// Branch map images + clickable section areas for the section-picker page.
// These endpoints are deliberately NOT behind resolveSection — the picker runs
// BEFORE a section is chosen, so no X-Section-Code header exists yet.
const router = express.Router();
router.use(requireAuth);

function normalizeBranch(value) {
  return `${value || ""}`.trim().toUpperCase();
}

function parseAreas(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The table lives in a manual DB patch (patch_branch_maps.sql); until it is
// applied every read degrades to "no maps" so the picker falls back to cards.
async function tryQuery(sql, params) {
  try {
    return (await query(sql, params)).recordset;
  } catch {
    return null;
  }
}

async function getOrgBranches() {
  const rows = await tryQuery(
    "SELECT setting_value FROM app_settings WHERE setting_key='org.branches' AND section_id IS NULL"
  );
  return `${rows?.[0]?.setting_value || ""}`
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

// Branch list for the picker dropdown: org.branches order first, then any
// extra branches that already have a map row.
router.get("/", asyncHandler(async (req, res) => {
  const orgBranches = await getOrgBranches();
  const rows = (await tryQuery(
    `SELECT branch,
            CASE WHEN image_data IS NULL OR image_data = '' THEN 0 ELSE 1 END AS has_image,
            areas
     FROM branch_maps`
  )) || [];
  const byBranch = new Map(rows.map(row => [normalizeBranch(row.branch), row]));
  const names = [...orgBranches];
  for (const row of rows) {
    if (!names.some(name => normalizeBranch(name) === normalizeBranch(row.branch))) names.push(row.branch);
  }
  res.json({
    branches: names.map(name => {
      const row = byBranch.get(normalizeBranch(name));
      return {
        branch: name,
        hasImage: row ? row.has_image === 1 || row.has_image === true : false,
        areaCount: row ? parseAreas(row.areas).length : 0
      };
    })
  });
}));

// Full map of one branch: the image data URL + polygon areas enriched with the
// live section code/name/description (labels stay current after renames).
router.get("/:branch", asyncHandler(async (req, res) => {
  const branch = normalizeBranch(req.params.branch);
  const rows = await tryQuery(
    "SELECT TOP 1 branch, image_data, areas FROM branch_maps WHERE UPPER(branch) = @branch",
    { branch }
  );
  const row = rows?.[0];
  const sections = (await tryQuery(
    "SELECT id, code, name, description FROM request_sections WHERE is_active = 1"
  )) || [];
  const sectionById = new Map(sections.map(section => [section.id, section]));
  const areas = parseAreas(row?.areas).map(area => {
    const section = sectionById.get(area.sectionId);
    return {
      id: `${area.id || ""}`,
      sectionId: area.sectionId,
      sectionCode: section?.code || null,
      sectionName: section?.name || null,
      sectionDescription: section?.description || null,
      label: `${area.label || ""}`,
      detail: `${area.detail || ""}`,
      points: Array.isArray(area.points) ? area.points : []
    };
  });
  res.json({ branch: row?.branch || req.params.branch, image: row?.image_data || null, areas });
}));

const areaSchema = z.object({
  id: z.string().max(64).optional().default(""),
  sectionId: z.number().int().positive(),
  label: z.string().max(120).optional().default(""),
  detail: z.string().max(500).optional().default(""),
  points: z.array(z.array(z.number().min(0).max(1)).length(2)).min(3).max(200)
});

const saveSchema = z.object({
  // undefined = keep the current image; null/"" = remove it; string = replace.
  image: z.string().max(15_000_000).nullable().optional(),
  areas: z.array(areaSchema).max(200).default([])
});

// Replace a branch's map (image and/or areas). System admin only.
router.put("/:branch", requireAdmin, audit("EDIT", "BRANCH_MAP", req => req.params.branch), asyncHandler(async (req, res) => {
  const branch = normalizeBranch(req.params.branch);
  if (!branch || branch.length > 100) return res.status(400).json({ message: "Invalid branch" });
  const input = saveSchema.parse(req.body);
  if (input.image && !/^data:image\//.test(input.image)) {
    return res.status(400).json({ message: "Image must be a data:image/... URL" });
  }

  const orgBranches = await getOrgBranches();
  if (orgBranches.length && !orgBranches.some(name => normalizeBranch(name) === branch)) {
    return res.status(400).json({ message: "Unknown branch — add it to org.branches first" });
  }

  const areasJson = JSON.stringify(input.areas);
  const imageProvided = input.image !== undefined;
  // null/"" clears the image; undefined keeps whatever is stored.
  const imageValue = input.image || null;
  const existing = await tryQuery("SELECT id FROM branch_maps WHERE UPPER(branch) = @branch", { branch });
  if (existing === null) {
    return res.status(500).json({ message: "branch_maps table is missing — run database/patch_branch_maps.sql" });
  }
  if (existing.length) {
    await query(
      `UPDATE branch_maps
       SET areas=@areas,
           ${imageProvided ? "image_data=@image," : ""}
           updated_by=@userId, updated_at=SYSUTCDATETIME()
       WHERE UPPER(branch) = @branch`,
      imageProvided
        ? { branch, areas: areasJson, image: imageValue, userId: req.user.id }
        : { branch, areas: areasJson, userId: req.user.id }
    );
  } else {
    await query(
      `INSERT INTO branch_maps (branch, image_data, areas, updated_by, updated_at)
       VALUES (@branch, @image, @areas, @userId, SYSUTCDATETIME())`,
      { branch, image: imageValue, areas: areasJson, userId: req.user.id }
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
