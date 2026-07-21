const express = require("express");
const { z } = require("zod");
const { sql, getPool, query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection, requireSectionAdmin } = require("../../services/sectionService");
const { blockViewerWrites } = require("../../middleware/viewerGuard");
const { getUserDisplayOrder, sortUsersByDisplayOrder, getSectionSetting } = require("../../services/settingsService");
const { getHolidayDates } = require("../../db/holidayPool");
const { emitSystem } = require("../../services/realtimeService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);
router.use(blockViewerWrites("meeting"));

const DAYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
const weekStartSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "weekStart must be YYYY-MM-DD");

const ACTIVE_WORKERS_SQL =
  `SELECT u.id, u.display_name, u.full_name
   FROM users u
   JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1 AND m.can_work = 1
   WHERE u.is_active = 1
   ORDER BY u.display_name`;

// Section workers in the section's fixed display order (weekly-plan arrows);
// users not in the saved order follow alphabetically.
async function loadOrderedWorkers(sectionId) {
  const users = (await query(ACTIVE_WORKERS_SQL, { sectionId })).recordset;
  return sortUsersByDisplayOrder(users, await getUserDisplayOrder(sectionId));
}

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
  const users = await loadOrderedWorkers(req.section.id);

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

  // Defaults seed the *current* week only; past/future weeks stay blank until
  // saved. Seeding MERGES at the cell level rather than all-or-nothing: any cell
  // the user already filled is kept, and only the still-blank cells receive the
  // per-user default. This way pre-entering part of a week ahead of time no
  // longer forfeits the defaults — the blanks are filled once the week is current.
  if (weekStart === currentMonday()) {
    // Default car rows are free-form template rows, so they are only seeded when
    // the week has no saved car rows yet (merging them would risk duplicates).
    if (cars.length === 0) {
      const defCars = (await query(
        "SELECT label, plate FROM weekly_plan_default_cars WHERE section_id = @sectionId ORDER BY sort_order, id",
        { sectionId: req.section.id }
      )).recordset;
      for (const d of defCars) {
        cars.push({ id: null, label: d.label ?? "", plate: d.plate ?? "", cells: DAYS.map(() => "") });
      }
    }
    // Company holidays override defaults: nobody visits customers on a holiday,
    // so those days stay blank ("–") instead of the seeded value. Plain Sat/Sun
    // defaults are honoured — setting one there is an explicit choice.
    const holidayIdx = await holidayDayIndexes(weekStart);
    for (const [uid, defCells] of (await loadDefaultUserValues(req.section.id))) {
      const existing = userRowById.get(uid);
      const merged = DAYS.map((_, i) => {
        const cur = existing ? existing[i] : "";
        if (cur && cur.trim()) return cur; // keep what the user already entered
        return holidayIdx.has(i) ? "" : (defCells[i] ?? ""); // fill blanks with default
      });
      userRowById.set(uid, merged);
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

  emitSystem("weeklyplan.updated", { sectionId: req.section.id, weekStart: input.weekStart });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Realtime autosave (no Save button): one user's day cell, or one car row, is
// written the moment the editor commits it (Enter / focus leaves the field).
// Both are upserts so concurrent editors never clobber each other's rows the
// way the whole-week PUT above would.
// ---------------------------------------------------------------------------
router.put("/cell", asyncHandler(async (req, res) => {
  const schema = z.object({
    weekStart: weekStartSchema,
    userId: z.number().int().positive(),
    dayIndex: z.number().int().min(0).max(6),
    value: z.string().max(300).optional().default("")
  });
  const input = schema.parse(req.body);
  const col = DAYS[input.dayIndex]; // validated 0..6 — never raw user text
  const updated = await query(
    `UPDATE weekly_plan_rows SET ${col} = @value
     WHERE section_id = @sectionId AND week_start = @weekStart AND row_type = 'USER' AND user_id = @userId`,
    { sectionId: req.section.id, weekStart: input.weekStart, userId: input.userId, value: input.value }
  );
  if (!updated.rowsAffected[0]) {
    await query(
      `INSERT INTO weekly_plan_rows (section_id, week_start, row_type, user_id, sort_order, ${col})
       VALUES (@sectionId, @weekStart, 'USER', @userId, 0, @value)`,
      { sectionId: req.section.id, weekStart: input.weekStart, userId: input.userId, value: input.value }
    );
  }
  emitSystem("weeklyplan.updated", {
    sectionId: req.section.id,
    weekStart: input.weekStart,
    cell: { userId: input.userId, dayIndex: input.dayIndex }
  });
  res.json({ ok: true });
}));

// Upsert one car row (label/plate/cells). Created rows return their id so the
// client can address them from then on.
router.put("/car", asyncHandler(async (req, res) => {
  const schema = z.object({
    weekStart: weekStartSchema,
    carId: z.number().int().positive().optional().nullable(),
    label: z.string().optional().nullable(),
    plate: z.string().optional().nullable(),
    cells: z.array(z.string()).optional().nullable()
  });
  const input = schema.parse(req.body);
  const cells = normalizeCells(input.cells);
  const label = `${input.label ?? ""}`.slice(0, 200).trim();
  const plate = `${input.plate ?? ""}`.slice(0, 100).trim();
  const params = {
    sectionId: req.section.id,
    weekStart: input.weekStart,
    label: label || null,
    plate: plate || null,
    ...Object.fromEntries(DAYS.map((d, i) => [d, cells[i]]))
  };
  let carId = input.carId ?? null;
  if (carId != null) {
    const updated = await query(
      `UPDATE weekly_plan_rows SET label=@label, plate=@plate, ${DAYS.map(d => `${d}=@${d}`).join(", ")}
       WHERE id = @carId AND section_id = @sectionId AND week_start = @weekStart AND row_type = 'CAR'`,
      { ...params, carId }
    );
    if (!updated.rowsAffected[0]) return res.status(404).json({ message: "Car row not found" });
  } else {
    const inserted = await query(
      `INSERT INTO weekly_plan_rows
         (section_id, week_start, row_type, user_id, label, plate, sort_order, ${DAYS.join(", ")})
       OUTPUT INSERTED.id
       VALUES (@sectionId, @weekStart, 'CAR', NULL, @label, @plate,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM weekly_plan_rows
                WHERE section_id = @sectionId AND week_start = @weekStart),
               ${DAYS.map(d => `@${d}`).join(", ")})`,
      params
    );
    carId = inserted.recordset[0].id;
  }
  emitSystem("weeklyplan.updated", { sectionId: req.section.id, weekStart: input.weekStart });
  res.json({ ok: true, id: carId });
}));

router.delete("/car/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid car row id" });
  await query(
    "DELETE FROM weekly_plan_rows WHERE id = @id AND section_id = @sectionId AND row_type = 'CAR'",
    { id, sectionId: req.section.id }
  );
  emitSystem("weeklyplan.updated", { sectionId: req.section.id });
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
  emitSystem("weeklyplan.updated", { sectionId: req.section.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Per-section, per-user default cell values (edited in Settings as a
// users × day grid). Seed a fresh current week.
// ---------------------------------------------------------------------------
// Day indexes (0=Mon … 6=Sun) of the week that are company holidays. Empty when
// the external holiday DB isn't configured (getHolidayDates never throws).
async function holidayDayIndexes(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const ymd = d =>
    `${d.getUTCFullYear()}-${`${d.getUTCMonth() + 1}`.padStart(2, "0")}-${`${d.getUTCDate()}`.padStart(2, "0")}`;
  const { dates } = await getHolidayDates(weekStart, ymd(end));
  const indexes = new Set();
  for (const date of dates) {
    const idx = Math.round((new Date(`${date}T00:00:00Z`) - start) / 86400000);
    if (idx >= 0 && idx <= 6) indexes.add(idx);
  }
  return indexes;
}

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
  const users = await loadOrderedWorkers(req.section.id);
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
  emitSystem("weeklyplan.updated", { sectionId: req.section.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Leave types — the words offered by the small button on a weekly-plan day cell
// ("what kind of leave"). Stored per section as the 'weeklyPlan.leaveTypes' app
// setting (a JSON array of words) so no extra table/DB patch is needed; the
// whole list is edited in Settings by a system/section admin. A section that
// never edited it gets the company defaults below; saving an empty list is an
// explicit "no leave types" and is honoured.
// ---------------------------------------------------------------------------
const LEAVE_TYPES_KEY = "weeklyPlan.leaveTypes";
const DEFAULT_LEAVE_TYPES = [
  "Sick leave",
  "Personal leave",
  "Annual leave",
  "Maternity leave",
  "Bereavement leave",
  "Ordination leave"
];

async function loadLeaveTypes(sectionId) {
  const raw = await getSectionSetting(LEAVE_TYPES_KEY, sectionId);
  if (raw == null) return DEFAULT_LEAVE_TYPES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_LEAVE_TYPES;
    return parsed.map(v => `${v}`.trim()).filter(Boolean);
  } catch {
    return DEFAULT_LEAVE_TYPES;
  }
}

// Read by every section member — the grid needs the list to build its picker.
router.get("/leave-types", asyncHandler(async (req, res) => {
  res.json({ leaveTypes: await loadLeaveTypes(req.section.id) });
}));

router.put("/leave-types", requireSectionAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    leaveTypes: z.array(z.string().max(100)).max(100).optional().default([])
  });
  const input = schema.parse(req.body);
  // Trim, drop blanks, and de-duplicate case-insensitively so the picker never
  // shows the same word twice.
  const seen = new Set();
  const list = [];
  for (const raw of input.leaveTypes) {
    const word = `${raw}`.trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    list.push(word);
  }
  await query(
    `MERGE app_settings AS target
     USING (SELECT @key AS setting_key, @sectionId AS section_id) AS source
     ON target.setting_key = source.setting_key AND COALESCE(target.section_id, 0) = COALESCE(source.section_id, 0)
     WHEN MATCHED THEN UPDATE SET setting_value=@value, updated_at=SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, value_type, is_public, description)
       VALUES (@sectionId, @key, @value, 'json', 1, 'Weekly plan leave types (day-cell picker)');`,
    { sectionId: req.section.id, key: LEAVE_TYPES_KEY, value: JSON.stringify(list) }
  );
  emitSystem("weeklyplan.updated", { sectionId: req.section.id });
  res.json({ ok: true, leaveTypes: list });
}));

// Company holidays (from the external SAR DB) within the given week, so the
// grid can grey those days. Never fails — returns configured:false if unset.
router.get("/holidays", asyncHandler(async (req, res) => {
  const from = weekStartSchema.parse(req.query.from);
  const to = weekStartSchema.parse(req.query.to);
  res.json(await getHolidayDates(from, to));
}));

module.exports = router;
