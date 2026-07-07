const express = require("express");
const { z } = require("zod");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection, requireSectionAdmin } = require("../../services/sectionService");
const { getHolidayDates } = require("../../db/holidayPool");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

const DAYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
const weekStartSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "weekStart must be YYYY-MM-DD");

const ACTIVE_WORKERS_SQL =
  `SELECT u.id, u.display_name, u.full_name
   FROM users u
   JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1 AND m.can_work = 1
   WHERE u.is_active = 1
   ORDER BY u.display_name`;

// YYYY-MM-DD of the Monday of the server's current week (Mon=start).
function currentMonday() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

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
  const users = (await query(ACTIVE_WORKERS_SQL, { sectionId: req.section.id })).recordset;

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

  // Defaults (cars + per-user values) only seed the *current* week while it is
  // still empty (never saved). Past/future weeks stay blank until saved.
  if (weekStart === currentMonday() && saved.length === 0) {
    const defCars = (await query(
      "SELECT label, plate FROM weekly_plan_default_cars WHERE section_id = @sectionId ORDER BY sort_order, id",
      { sectionId: req.section.id }
    )).recordset;
    for (const d of defCars) {
      cars.push({ id: null, label: d.label ?? "", plate: d.plate ?? "", cells: DAYS.map(() => "") });
    }
    for (const [uid, cells] of (await loadDefaultUserValues(req.section.id))) {
      userRowById.set(uid, cells);
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

router.put("/default-cars", requireSectionAdmin, asyncHandler(async (req, res) => {
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

// ---------------------------------------------------------------------------
// Per-section, per-user default cell values (edited in Settings as a
// users × day grid). Seed a fresh current week.
// ---------------------------------------------------------------------------
async function loadDefaultUserValues(sectionId) {
  const rows = (await query(
    "SELECT user_id, day_index, value FROM weekly_plan_default_user_values WHERE section_id = @sectionId",
    { sectionId }
  )).recordset;
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, DAYS.map(() => ""));
    if (r.day_index >= 0 && r.day_index < 7) byUser.get(r.user_id)[r.day_index] = r.value ?? "";
  }
  return byUser;
}

router.get("/default-user-values", asyncHandler(async (req, res) => {
  const users = (await query(ACTIVE_WORKERS_SQL, { sectionId: req.section.id })).recordset;
  const byUser = await loadDefaultUserValues(req.section.id);
  res.json({
    users: users.map(u => ({
      userId: u.id,
      displayName: u.display_name,
      fullName: u.full_name,
      cells: byUser.get(u.id) ?? DAYS.map(() => "")
    }))
  });
}));

router.put("/default-user-values", requireSectionAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    users: z.array(z.object({
      userId: z.number().int(),
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
    await run("DELETE FROM weekly_plan_default_user_values WHERE section_id = @sectionId", { sectionId: req.section.id });
    for (const u of input.users) {
      const cells = normalizeCells(u.cells);
      for (let i = 0; i < 7; i++) {
        if (!cells[i].trim()) continue; // only store non-empty defaults
        await run(
          `INSERT INTO weekly_plan_default_user_values (section_id, user_id, day_index, value)
           VALUES (@sectionId, @userId, @dayIndex, @value)`,
          { sectionId: req.section.id, userId: u.userId, dayIndex: i, value: cells[i] }
        );
      }
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  res.json({ ok: true });
}));

// Company holidays (from the external SAR DB) within the given week, so the
// grid can grey those days. Never fails — returns configured:false if unset.
router.get("/holidays", asyncHandler(async (req, res) => {
  const from = weekStartSchema.parse(req.query.from);
  const to = weekStartSchema.parse(req.query.to);
  res.json(await getHolidayDates(from, to));
}));

module.exports = router;
