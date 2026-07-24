const express = require("express");
const { z } = require("zod");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");

// Personal Kanban to-do board. One private board per user — deliberately NOT
// section scoped (it follows the person across every section/branch), so this
// router only requires auth and never resolves a section. Columns and cards are
// loaded together and saved replace-all, mirroring the weekly-plan PUT: for a
// single-user board there is no concurrent-editor problem to guard against.
const router = express.Router();
router.use(requireAuth);

// Seeded when a user opens their board for the very first time.
const DEFAULT_COLUMNS = [
  { title: "Wait", color: "#e0982a" },
  { title: "In Process", color: "#2f6bed" },
  { title: "Done", color: "#23a35a" }
];

// Column widths (patch_personal_todo_layout.sql) are optional: if the patch
// has not been applied yet the board still works, it just stops remembering the
// sizes. Checked once per process, then cached.
const MIN_COL_WIDTH = 200;
const MAX_COL_WIDTH = 640;
const DEFAULT_COL_WIDTH = 280;
let layoutColumnsReady = null;

async function hasLayoutColumns() {
  if (layoutColumnsReady !== null) return layoutColumnsReady;
  try {
    const row = (await query(
      `SELECT COUNT(*) AS n FROM sys.columns
       WHERE (object_id = OBJECT_ID('personal_todo_columns') AND name = 'width')
          OR (object_id = OBJECT_ID('users') AND name = 'personal_todo_col_width')`
    )).recordset[0];
    layoutColumnsReady = Number(row?.n ?? 0) >= 2;
  } catch {
    layoutColumnsReady = false;
  }
  return layoutColumnsReady;
}

// Clamp an incoming width to something a board can actually show; null/invalid
// means "no explicit width — follow the board default".
function normaliseWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(n)));
}

async function loadBoard(userId) {
  const withLayout = await hasLayoutColumns();
  const columns = (await query(
    `SELECT id, title, color, sort_order${withLayout ? ", width" : ""} FROM personal_todo_columns
     WHERE user_id = @userId ORDER BY sort_order, id`,
    { userId }
  )).recordset;
  const items = (await query(
    `SELECT id, column_id, content, sort_order FROM personal_todo_items
     WHERE user_id = @userId ORDER BY sort_order, id`,
    { userId }
  )).recordset;
  const itemsByColumn = new Map();
  for (const it of items) {
    if (!itemsByColumn.has(it.column_id)) itemsByColumn.set(it.column_id, []);
    itemsByColumn.get(it.column_id).push({ id: it.id, content: it.content });
  }
  return columns.map(c => ({
    id: c.id,
    title: c.title,
    color: c.color ?? null,
    // null → this column follows the board's default width.
    width: withLayout ? (c.width ?? null) : null,
    items: itemsByColumn.get(c.id) ?? []
  }));
}

// The user's default column width (what new columns start at). Falls back to
// the shared default when unset or when the layout patch is missing.
async function loadDefaultWidth(userId) {
  if (!(await hasLayoutColumns())) return DEFAULT_COL_WIDTH;
  const row = (await query(
    "SELECT personal_todo_col_width FROM users WHERE id = @userId",
    { userId }
  )).recordset[0];
  return normaliseWidth(row?.personal_todo_col_width) ?? DEFAULT_COL_WIDTH;
}

// Read the board; seed the three default columns the FIRST time it's opened.
// Seeding is gated on users.personal_todo_initialized (not on emptiness) so a
// user who deletes every column keeps an empty board instead of having the
// defaults resurrected.
router.get("/", asyncHandler(async (req, res) => {
  const flag = (await query(
    "SELECT personal_todo_initialized FROM users WHERE id = @userId",
    { userId: req.user.id }
  )).recordset[0];
  const initialized = flag?.personal_todo_initialized === true || flag?.personal_todo_initialized === 1;

  if (!initialized) {
    let order = 0;
    for (const c of DEFAULT_COLUMNS) {
      await query(
        `INSERT INTO personal_todo_columns (user_id, title, color, sort_order)
         VALUES (@userId, @title, @color, @sortOrder)`,
        { userId: req.user.id, title: c.title, color: c.color, sortOrder: order++ }
      );
    }
    await query(
      "UPDATE users SET personal_todo_initialized = 1 WHERE id = @userId",
      { userId: req.user.id }
    );
  }
  res.json({
    columns: await loadBoard(req.user.id),
    defaultWidth: await loadDefaultWidth(req.user.id)
  });
}));

// Replace the whole board in one transaction. The client sends the columns (in
// order — that order IS the left-to-right layout) each with its cards (in
// order) and optional width; ids are reassigned on save.
router.put("/", asyncHandler(async (req, res) => {
  const schema = z.object({
    defaultWidth: z.number().optional().nullable(),
    columns: z.array(z.object({
      title: z.string().optional().nullable(),
      color: z.string().max(20).optional().nullable(),
      width: z.number().optional().nullable(),
      items: z.array(z.object({
        content: z.string().optional().nullable()
      })).optional().default([])
    })).max(50).optional().default([])
  });
  const input = schema.parse(req.body);
  const withLayout = await hasLayoutColumns();

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

    // Items reference columns, so clear items first.
    await run("DELETE FROM personal_todo_items WHERE user_id = @userId", { userId: req.user.id });
    await run("DELETE FROM personal_todo_columns WHERE user_id = @userId", { userId: req.user.id });
    // Any save marks the board initialized so GET won't re-seed defaults over
    // an intentionally empty board.
    await run("UPDATE users SET personal_todo_initialized = 1 WHERE id = @userId", { userId: req.user.id });
    if (withLayout && input.defaultWidth !== undefined) {
      await run(
        "UPDATE users SET personal_todo_col_width = @width WHERE id = @userId",
        { userId: req.user.id, width: normaliseWidth(input.defaultWidth) }
      );
    }

    let colOrder = 0;
    for (const col of input.columns) {
      const title = `${col.title ?? ""}`.slice(0, 120).trim() || "Untitled";
      const color = col.color ? `${col.color}`.slice(0, 20) : null;
      const width = normaliseWidth(col.width);
      const inserted = await run(
        withLayout
          ? `INSERT INTO personal_todo_columns (user_id, title, color, sort_order, width)
             OUTPUT INSERTED.id
             VALUES (@userId, @title, @color, @sortOrder, @width)`
          : `INSERT INTO personal_todo_columns (user_id, title, color, sort_order)
             OUTPUT INSERTED.id
             VALUES (@userId, @title, @color, @sortOrder)`,
        withLayout
          ? { userId: req.user.id, title, color, sortOrder: colOrder++, width }
          : { userId: req.user.id, title, color, sortOrder: colOrder++ }
      );
      const columnId = inserted.recordset[0].id;
      let itemOrder = 0;
      for (const item of (col.items ?? [])) {
        const content = `${item.content ?? ""}`.slice(0, 1000).trim();
        if (!content) continue; // drop blank cards
        await run(
          `INSERT INTO personal_todo_items (user_id, column_id, content, sort_order)
           VALUES (@userId, @columnId, @content, @sortOrder)`,
          { userId: req.user.id, columnId, content, sortOrder: itemOrder++ }
        );
      }
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  res.json({
    columns: await loadBoard(req.user.id),
    defaultWidth: await loadDefaultWidth(req.user.id)
  });
}));

module.exports = router;
