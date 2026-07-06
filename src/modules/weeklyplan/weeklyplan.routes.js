const express = require("express");
const { z } = require("zod");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection, requireAdmin } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

const DAYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
const weekStartSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "weekStart must be YYYY-MM-DD");

// Coerce any cells payload to exactly 7 trimmed strings (Mon..Sun).
function normalizeCells(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return DAYS.map((_, i) => `${arr[i] ?? ""}`.slice(0, 300));
}

function rowCells(row) {
  return DAYS.map(d => row[d] ?? "");
}

// Read the week's plan: one row per active section worker (merged with any
// saved values) plus the saved free-form car rows.
router.get("/", asyncHandler(async (req, res) => {
  const weekStart = weekStartSchema.parse(req.query.weekStart);
  const users = (await query(
    `SELECT u.id, u.display_name, u.full_name
     FROM users u
     JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1 AND m.can_work = 1
     WHERE u.is_active = 1
     ORDER BY u.display_name`,
    { sectionId: req.section.id }
  )).recordset;

  const saved = (await query(
    `SELECT * FROM weekly_plan_rows WHERE section_id = @sectionId AND week_start = @weekStart
     ORDER BY sort_order, id`,
    { sectionId: req.section.id, weekStart }
  )).recordset;

  const userRowById = new Map();
  const cars = [];
  for (const row of saved) {
    if (row.row_type === "CAR") {
      cars.push({ id: row.id, label: row.label ?? "", plate: row.plate ?? "", cells: rowCells(row) });
    } else if (row.user_id != null) {
      userRowById.set(row.user_id, rowCells(row));
    }
  }

  // A week that hasn't been saved with any car rows yet starts from the
  // section's configured default cars (labels/plates), with empty cells.
  if (cars.length === 0) {
    const defaults = (await query(
      "SELECT label, plate FROM weekly_plan_default_cars WHERE section_id = @sectionId ORDER BY sort_order, id",
      { sectionId: req.section.id }
    )).recordset;
    for (const d of defaults) {
      cars.push({ id: null, label: d.label ?? "", plate: d.plate ?? "", cells: DAYS.map(() => "") });
    }
  }

  res.json({
    weekStart,
    users: users.map(u => ({
      userId: u.id,
      displayName: u.display_name,
      fullName: u.full_name,
      cells: userRowById.get(u.id) ?? DAYS.map(() => "")
    })),
    cars
  });
}));

// Replace the whole week's plan for this section in one transaction.
router.put("/", asyncHandler(async (req, res) => {
  const schema = z.object({
    weekStart: weekStartSchema,
    users: z.array(z.object({
      userId: z.number().int(),
      cells: z.array(z.string()).optional().nullable()
    })).optional().default([]),
    cars: z.array(z.object({
      label: z.string().optional().nullable(),
      plate: z.string().optional().nullable(),
      cells: z.array(z.string()).optional().nullable()
    })).optional().default([])
  });
  const input = schema.parse(req.body);

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

    await run("DELETE FROM weekly_plan_rows WHERE section_id = @sectionId AND week_start = @weekStart", {
      sectionId: req.section.id,
      weekStart: input.weekStart
    });

    const insert = (params) => run(
      `INSERT INTO weekly_plan_rows
         (section_id, week_start, row_type, user_id, label, plate, sort_order, d0, d1, d2, d3, d4, d5, d6)
       VALUES (@sectionId, @weekStart, @rowType, @userId, @label, @plate, @sortOrder, @d0, @d1, @d2, @d3, @d4, @d5, @d6)`,
      params
    );

    let order = 0;
    for (const u of input.users) {
      const cells = normalizeCells(u.cells);
      // Skip empty engineer rows so the table isn't cluttered with blanks.
      if (cells.every(c => !c.trim())) continue;
      await insert({
        sectionId: req.section.id, weekStart: input.weekStart, rowType: "USER",
        userId: u.userId, label: null, plate: null, sortOrder: order++,
        ...Object.fromEntries(DAYS.map((d, i) => [d, cells[i]]))
      });
    }
    for (const car of input.cars) {
      const cells = normalizeCells(car.cells);
      const label = `${car.label ?? ""}`.slice(0, 200).trim();
      const plate = `${car.plate ?? ""}`.slice(0, 100).trim();
      // Keep a car row if it has a name/plate or any value.
      if (!label && !plate && cells.every(c => !c.trim())) continue;
      await insert({
        sectionId: req.section.id, weekStart: input.weekStart, rowType: "CAR",
        userId: null, label: label || null, plate: plate || null, sortOrder: order++,
        ...Object.fromEntries(DAYS.map((d, i) => [d, cells[i]]))
      });
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Per-section default car rows (edited in Settings). Used to seed a new week.
// ---------------------------------------------------------------------------
router.get("/default-cars", asyncHandler(async (req, res) => {
  const rows = (await query(
    "SELECT id, label, plate FROM weekly_plan_default_cars WHERE section_id = @sectionId ORDER BY sort_order, id",
    { sectionId: req.section.id }
  )).recordset;
  res.json({ cars: rows.map(r => ({ label: r.label ?? "", plate: r.plate ?? "" })) });
}));

router.put("/default-cars", requireAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    cars: z.array(z.object({
      label: z.string().optional().nullable(),
      plate: z.string().optional().nullable()
    })).optional().default([])
  });
  const input = schema.parse(req.body);

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
    await run("DELETE FROM weekly_plan_default_cars WHERE section_id = @sectionId", { sectionId: req.section.id });
    let order = 0;
    for (const car of input.cars) {
      const label = `${car.label ?? ""}`.slice(0, 200).trim();
      const plate = `${car.plate ?? ""}`.slice(0, 100).trim();
      if (!label && !plate) continue; // drop fully-empty rows
      await run(
        `INSERT INTO weekly_plan_default_cars (section_id, label, plate, sort_order)
         VALUES (@sectionId, @label, @plate, @sortOrder)`,
        { sectionId: req.section.id, label: label || null, plate: plate || null, sortOrder: order++ }
      );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  res.json({ ok: true });
}));

module.exports = router;
