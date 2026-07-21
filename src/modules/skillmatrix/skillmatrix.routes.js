const express = require("express");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { requireSectionManager, resolveSection } = require("../../services/sectionService");
const { blockViewerWrites } = require("../../middleware/viewerGuard");
const { emitSystem } = require("../../services/realtimeService");

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Read this section's matrix (any member of the section). The matrix is scoped
// per section, so the section is taken from the x-section-code header.
// ---------------------------------------------------------------------------
router.get("/", resolveSection, asyncHandler(async (req, res) => {
  res.json(await loadMatrix(req.section.id));
}));

async function loadMatrix(sectionId) {
  const meta = await query(
    "SELECT TOP 1 corner_label FROM skill_matrix_meta WHERE section_id = @sectionId",
    { sectionId }
  );
  const levels = await query(
    "SELECT id, name, sort_order FROM skill_matrix_levels WHERE section_id = @sectionId ORDER BY sort_order, id",
    { sectionId }
  );
  const items = await query(
    "SELECT id, name, sort_order FROM skill_matrix_items WHERE section_id = @sectionId ORDER BY sort_order, id",
    { sectionId }
  );
  const cells = await query(
    "SELECT item_id, level_id, description FROM skill_matrix_cells WHERE section_id = @sectionId",
    { sectionId }
  );
  return {
    cornerLabel: meta.recordset[0]?.corner_label ?? "Items/Level",
    levels: levels.recordset.map(r => ({ id: r.id, name: r.name, sortOrder: r.sort_order })),
    items: items.recordset.map(r => ({ id: r.id, name: r.name, sortOrder: r.sort_order })),
    cells: cells.recordset.map(r => ({
      itemId: r.item_id,
      levelId: r.level_id,
      description: r.description ?? ""
    }))
  };
}

// ---------------------------------------------------------------------------
// The current user's own level per skill (one level per item, or none).
// ---------------------------------------------------------------------------
router.get("/me", resolveSection, asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT usl.item_id, usl.level_id
     FROM user_skill_levels usl
     JOIN skill_matrix_items i ON i.id = usl.item_id AND i.section_id = @sectionId
     WHERE usl.user_id = @userId`,
    { userId: req.user.id, sectionId: req.section.id }
  );
  res.json({ selections: rows.recordset.map(r => ({ itemId: r.item_id, levelId: r.level_id })) });
}));

// Users may view their own levels, but level edits are managed by a section
// manager from the section-scoped member endpoint below.
router.put("/me", asyncHandler(async (req, res) => {
  res.status(403).json({ message: "Skill levels are read-only for your own account" });
}));

// Set or clear one skill level for [userId]. Shared by the self endpoint and the
// admin per-member endpoint. Writes the response itself (validation errors or ok).
async function setSkillLevel(userId, body, res, sectionId) {
  const itemId = Number(body?.itemId);
  const hasLevel = body?.levelId !== null && body?.levelId !== undefined;
  const levelId = hasLevel ? Number(body.levelId) : null;
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "itemId is required" });

  // The item/level must belong to THIS section's matrix.
  const item = await query(
    "SELECT 1 FROM skill_matrix_items WHERE id = @id AND section_id = @sectionId",
    { id: itemId, sectionId }
  );
  if (!item.recordset.length) return res.status(404).json({ message: "Skill not found" });

  await query("DELETE FROM user_skill_levels WHERE user_id = @userId AND item_id = @itemId", {
    userId,
    itemId
  });

  if (levelId !== null) {
    if (!Number.isInteger(levelId)) return res.status(400).json({ message: "Invalid levelId" });
    const level = await query(
      "SELECT 1 FROM skill_matrix_levels WHERE id = @id AND section_id = @sectionId",
      { id: levelId, sectionId }
    );
    if (!level.recordset.length) return res.status(404).json({ message: "Level not found" });
    await query(
      `INSERT INTO user_skill_levels (user_id, item_id, level_id, updated_at)
       VALUES (@userId, @itemId, @levelId, SYSUTCDATETIME())`,
      { userId, itemId, levelId }
    );
  }
  emitSystem("skillmatrix.updated", { userId, itemId });
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin / section admin / internal-route approver: manage each section member's
// ratings. Both endpoints are section-scoped (resolveSection) so a non-global
// manager only reaches their own section's members.
// ---------------------------------------------------------------------------
router.get("/users", resolveSection, requireSectionManager, asyncHandler(async (req, res) => {
  const users = (await query(
    `SELECT u.id, u.display_name, u.full_name
     FROM users u
     JOIN user_section_memberships m
       ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1 AND m.can_work = 1
     WHERE u.is_active = 1
     ORDER BY u.display_name`,
    { sectionId: req.section.id }
  )).recordset;

  let selections = [];
  if (users.length) {
    const params = Object.fromEntries(users.map((u, i) => [`u${i}`, u.id]));
    selections = (await query(
      `SELECT usl.user_id, usl.item_id, usl.level_id
       FROM user_skill_levels usl
       JOIN skill_matrix_items i ON i.id = usl.item_id AND i.section_id = @sectionId
       WHERE usl.user_id IN (${users.map((_, i) => `@u${i}`).join(",")})`,
      { ...params, sectionId: req.section.id }
    )).recordset;
  }

  res.json({
    users: users.map(u => ({ userId: u.id, displayName: u.display_name, fullName: u.full_name })),
    selections: selections.map(r => ({ userId: r.user_id, itemId: r.item_id, levelId: r.level_id }))
  });
}));

router.put("/users/:userId(\\d+)", resolveSection, blockViewerWrites("skillMatrix"), requireSectionManager, asyncHandler(async (req, res) => {
  const targetId = Number(req.params.userId);
  const member = await query(
    `SELECT 1 FROM user_section_memberships
     WHERE user_id = @targetId AND section_id = @sectionId AND is_active = 1`,
    { targetId, sectionId: req.section.id }
  );
  if (!member.recordset.length) {
    return res.status(403).json({ message: "User is not a member of this section" });
  }
  await setSkillLevel(targetId, req.body, res, req.section.id);
}));

// ---------------------------------------------------------------------------
// Section managers (global admin / section admin / internal-route approver):
// replace the whole matrix in one transactional save. The client sends every
// level and item (with a stable `key`); rows/columns keep their id when
// edited, get a new id when added, and are removed when dropped. Cell text is
// rebuilt from each item's `cells` map (keyed by level `key`).
// ---------------------------------------------------------------------------
router.put("/", resolveSection, blockViewerWrites("skillMatrix"), requireSectionManager, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sectionId = req.section.id;
  const cornerLabel = `${body.cornerLabel ?? "Items/Level"}`.slice(0, 200);
  const levels = Array.isArray(body.levels) ? body.levels : [];
  const items = Array.isArray(body.items) ? body.items : [];

  for (const l of levels) {
    if (!`${l?.name ?? ""}`.trim()) return res.status(400).json({ message: "Every column needs a name" });
  }
  for (const it of items) {
    if (!`${it?.name ?? ""}`.trim()) return res.status(400).json({ message: "Every row needs a name" });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const run = (text, params = {}) => {
      const request = new sql.Request(tx);
      for (const [key, value] of Object.entries(params)) {
        request.input(key, value === undefined ? null : value);
      }
      return request.query(text);
    };

    const existingLevels = (await run(
      "SELECT id FROM skill_matrix_levels WHERE section_id = @sectionId", { sectionId }
    )).recordset.map(r => r.id);
    const existingItems = (await run(
      "SELECT id FROM skill_matrix_items WHERE section_id = @sectionId", { sectionId }
    )).recordset.map(r => r.id);

    // Upsert levels; remember which client key maps to which real id.
    const levelKeyToId = new Map();
    const keptLevelIds = new Set();
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      const name = `${l.name}`.slice(0, 200);
      let id = Number(l.id);
      if (Number.isInteger(id) && existingLevels.includes(id)) {
        await run(
          "UPDATE skill_matrix_levels SET name = @name, sort_order = @sort WHERE id = @id AND section_id = @sectionId",
          { name, sort: i, id, sectionId }
        );
      } else {
        const inserted = await run(
          "INSERT INTO skill_matrix_levels (name, sort_order, section_id) OUTPUT INSERTED.id AS id VALUES (@name, @sort, @sectionId)",
          { name, sort: i, sectionId }
        );
        id = inserted.recordset[0].id;
      }
      levelKeyToId.set(`${l.key ?? id}`, id);
      keptLevelIds.add(id);
    }

    // Upsert items.
    const itemKeyToId = new Map();
    const keptItemIds = new Set();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = `${it.name}`.slice(0, 300);
      let id = Number(it.id);
      if (Number.isInteger(id) && existingItems.includes(id)) {
        await run(
          "UPDATE skill_matrix_items SET name = @name, sort_order = @sort WHERE id = @id AND section_id = @sectionId",
          { name, sort: i, id, sectionId }
        );
      } else {
        const inserted = await run(
          "INSERT INTO skill_matrix_items (name, sort_order, section_id) OUTPUT INSERTED.id AS id VALUES (@name, @sort, @sectionId)",
          { name, sort: i, sectionId }
        );
        id = inserted.recordset[0].id;
      }
      itemKeyToId.set(`${it.key ?? id}`, id);
      keptItemIds.add(id);
    }

    const removedLevelIds = existingLevels.filter(id => !keptLevelIds.has(id));
    const removedItemIds = existingItems.filter(id => !keptItemIds.has(id));

    // Rebuild the whole cell grid, then drop the rows/columns that went away
    // (along with any user selections that pointed at them).
    await run("DELETE FROM skill_matrix_cells WHERE section_id = @sectionId", { sectionId });
    for (const id of removedLevelIds) {
      await run("DELETE FROM user_skill_levels WHERE level_id = @id", { id });
    }
    for (const id of removedItemIds) {
      await run("DELETE FROM user_skill_levels WHERE item_id = @id", { id });
    }
    for (const id of removedItemIds) {
      await run("DELETE FROM skill_matrix_items WHERE id = @id", { id });
    }
    for (const id of removedLevelIds) {
      await run("DELETE FROM skill_matrix_levels WHERE id = @id", { id });
    }

    for (const it of items) {
      const itemId = itemKeyToId.get(`${it.key ?? it.id}`);
      const cells = it.cells && typeof it.cells === "object" ? it.cells : {};
      for (const [levelKey, rawDesc] of Object.entries(cells)) {
        const levelId = levelKeyToId.get(`${levelKey}`);
        const description = `${rawDesc ?? ""}`.trim();
        if (!itemId || !levelId || !description) continue;
        await run(
          "INSERT INTO skill_matrix_cells (item_id, level_id, description, section_id) VALUES (@itemId, @levelId, @description, @sectionId)",
          { itemId, levelId, description, sectionId }
        );
      }
    }

    await run(
      `MERGE skill_matrix_meta AS target
       USING (SELECT @sectionId AS section_id) AS src ON target.section_id = src.section_id
       WHEN MATCHED THEN UPDATE SET corner_label = @corner
       WHEN NOT MATCHED THEN INSERT (section_id, corner_label) VALUES (@sectionId, @corner);`,
      { corner: cornerLabel, sectionId }
    );

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  emitSystem("skillmatrix.updated", { sectionId });
  res.json(await loadMatrix(sectionId));
}));

module.exports = router;
