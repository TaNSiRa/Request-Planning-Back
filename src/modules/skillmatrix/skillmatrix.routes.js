const express = require("express");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { requireAdmin } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Read the whole matrix (all authenticated users).
// ---------------------------------------------------------------------------
router.get("/", asyncHandler(async (req, res) => {
  res.json(await loadMatrix());
}));

async function loadMatrix() {
  const meta = await query("SELECT TOP 1 corner_label FROM skill_matrix_meta WHERE id = 1");
  const levels = await query(
    "SELECT id, name, sort_order FROM skill_matrix_levels ORDER BY sort_order, id"
  );
  const items = await query(
    "SELECT id, name, sort_order FROM skill_matrix_items ORDER BY sort_order, id"
  );
  const cells = await query("SELECT item_id, level_id, description FROM skill_matrix_cells");
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
router.get("/me", asyncHandler(async (req, res) => {
  const rows = await query(
    "SELECT item_id, level_id FROM user_skill_levels WHERE user_id = @userId",
    { userId: req.user.id }
  );
  res.json({ selections: rows.recordset.map(r => ({ itemId: r.item_id, levelId: r.level_id })) });
}));

// Set or clear the user's level for a single skill. levelId = null clears it,
// so tapping the already-selected level toggles it off on the client.
router.put("/me", asyncHandler(async (req, res) => {
  const itemId = Number(req.body?.itemId);
  const hasLevel = req.body?.levelId !== null && req.body?.levelId !== undefined;
  const levelId = hasLevel ? Number(req.body.levelId) : null;
  if (!Number.isInteger(itemId)) return res.status(400).json({ message: "itemId is required" });

  const item = await query("SELECT 1 FROM skill_matrix_items WHERE id = @id", { id: itemId });
  if (!item.recordset.length) return res.status(404).json({ message: "Skill not found" });

  await query("DELETE FROM user_skill_levels WHERE user_id = @userId AND item_id = @itemId", {
    userId: req.user.id,
    itemId
  });

  if (levelId !== null) {
    if (!Number.isInteger(levelId)) return res.status(400).json({ message: "Invalid levelId" });
    const level = await query("SELECT 1 FROM skill_matrix_levels WHERE id = @id", { id: levelId });
    if (!level.recordset.length) return res.status(404).json({ message: "Level not found" });
    await query(
      `INSERT INTO user_skill_levels (user_id, item_id, level_id, updated_at)
       VALUES (@userId, @itemId, @levelId, SYSUTCDATETIME())`,
      { userId: req.user.id, itemId, levelId }
    );
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Admin: replace the whole matrix in one transactional save. The client sends
// every level and item (with a stable `key`); rows/columns keep their id when
// edited, get a new id when added, and are removed when dropped. Cell text is
// rebuilt from each item's `cells` map (keyed by level `key`).
// ---------------------------------------------------------------------------
router.put("/", requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
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

    const existingLevels = (await run("SELECT id FROM skill_matrix_levels")).recordset.map(r => r.id);
    const existingItems = (await run("SELECT id FROM skill_matrix_items")).recordset.map(r => r.id);

    // Upsert levels; remember which client key maps to which real id.
    const levelKeyToId = new Map();
    const keptLevelIds = new Set();
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      const name = `${l.name}`.slice(0, 200);
      let id = Number(l.id);
      if (Number.isInteger(id) && existingLevels.includes(id)) {
        await run("UPDATE skill_matrix_levels SET name = @name, sort_order = @sort WHERE id = @id", {
          name,
          sort: i,
          id
        });
      } else {
        const inserted = await run(
          "INSERT INTO skill_matrix_levels (name, sort_order) OUTPUT INSERTED.id AS id VALUES (@name, @sort)",
          { name, sort: i }
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
        await run("UPDATE skill_matrix_items SET name = @name, sort_order = @sort WHERE id = @id", {
          name,
          sort: i,
          id
        });
      } else {
        const inserted = await run(
          "INSERT INTO skill_matrix_items (name, sort_order) OUTPUT INSERTED.id AS id VALUES (@name, @sort)",
          { name, sort: i }
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
    await run("DELETE FROM skill_matrix_cells");
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
          "INSERT INTO skill_matrix_cells (item_id, level_id, description) VALUES (@itemId, @levelId, @description)",
          { itemId, levelId, description }
        );
      }
    }

    await run(
      `MERGE skill_matrix_meta AS target
       USING (SELECT 1 AS id) AS src ON target.id = src.id
       WHEN MATCHED THEN UPDATE SET corner_label = @corner
       WHEN NOT MATCHED THEN INSERT (id, corner_label) VALUES (1, @corner);`,
      { corner: cornerLabel }
    );

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  res.json(await loadMatrix());
}));

module.exports = router;
