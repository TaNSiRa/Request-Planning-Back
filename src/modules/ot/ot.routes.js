const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { buildOtWorkbook } = require("../../services/otExport");
const { findSignature, ensureSignatureDir } = require("../../services/xlsxKit");
const { resolveSection } = require("../../services/sectionService");
const { otUnitFor, otEntryFromRow, loadOtMonth } = require("../../services/monthForms");

// Personal OT log behind the Personal calendar page. Like the personal to-do
// board it belongs to the person, not a section: every route works on the
// caller's own rows only — except the export, which is the section's monthly
// form and therefore resolves the section and gathers its members' OT.
const router = express.Router();
router.use(requireAuth);
ensureSignatureDir();

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function isYmd(value) {
  const s = `${value ?? ""}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm");

const OT_COLUMNS = "ot_date, start_time, end_time, reason, sign_mode, ot_type, is_holiday";

const toEntry = otEntryFromRow;

// Until patch_personal_ot.sql is applied the table (SQL error 208) or its later
// columns (207) are missing; say so plainly instead of a generic 500.
async function otQuery(text, params) {
  return otQueryWrap(() => query(text, params));
}

async function otQueryWrap(run) {
  try {
    return await run();
  } catch (err) {
    if (err?.number === 208 || err?.number === 207) {
      const e = new Error("OT is not set up on this server yet (database patch_personal_ot.sql)");
      e.status = 503;
      e.publicMessage = true;
      throw e;
    }
    throw err;
  }
}

async function loadMe(userId) {
  return (await query(
    `SELECT employee_no, full_name, display_name FROM users WHERE id=@userId`,
    { userId }
  )).recordset[0] || {};
}

// GET /api/ot?from=YYYY-MM-DD&to=YYYY-MM-DD — the caller's OT in a date range,
// plus whether an e-signature image is on file for them.
router.get("/", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ message: "from/to must be YYYY-MM-DD" });
  const rows = (await otQuery(
    `SELECT ${OT_COLUMNS} FROM personal_ot
     WHERE user_id=@userId AND ot_date BETWEEN @from AND @to ORDER BY ot_date`,
    { userId: req.user.id, from, to }
  )).recordset;
  const me = await loadMe(req.user.id);
  const employeeNo = `${me.employee_no ?? ""}`.trim();
  res.json({
    entries: rows.map(toEntry),
    employeeNo,
    esignAvailable: !!findSignature(employeeNo)
  });
}));

// PUT /api/ot/:date — add or replace the caller's OT for one day.
router.put("/:date", asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
  const input = z.object({
    startTime: hm,
    endTime: hm,
    reason: z.string().trim().min(1, "Reason is required").max(200),
    signMode: z.enum(["SELF", "ESIGN"]).optional().default("SELF"),
    otType: z.enum(["NORMAL", "SPECIAL"]).optional().default("NORMAL"),
    // Sat / Sun / company holiday, as the calendar saw the day. Without it only
    // a weekend is known to be one.
    holiday: z.boolean().optional()
  }).parse(req.body);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const holiday = input.holiday ?? (weekday === 0 || weekday === 6);
  if (input.startTime === input.endTime) {
    return res.status(400).json({ message: "Start and end time can't be the same" });
  }
  const params = { userId: req.user.id, date, ...input, holiday };
  const updated = await otQuery(
    `UPDATE personal_ot
     SET start_time=@startTime, end_time=@endTime, reason=@reason, sign_mode=@signMode,
         ot_type=@otType, is_holiday=@holiday,
         updated_at=DATEADD(HOUR, 7, SYSUTCDATETIME())
     WHERE user_id=@userId AND ot_date=@date`,
    params
  );
  if (!updated.rowsAffected[0]) {
    await otQuery(
      `INSERT INTO personal_ot (user_id, ot_date, start_time, end_time, reason, sign_mode, ot_type, is_holiday)
       VALUES (@userId, @date, @startTime, @endTime, @reason, @signMode, @otType, @holiday)`,
      params
    );
  }
  res.json({
    entry: toEntry({
      ot_date: date, start_time: input.startTime, end_time: input.endTime,
      reason: input.reason, sign_mode: input.signMode, ot_type: input.otType, is_holiday: holiday
    })
  });
}));

router.delete("/:date", asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
  await otQuery(`DELETE FROM personal_ot WHERE user_id=@userId AND ot_date=@date`,
    { userId: req.user.id, date });
  res.json({ ok: true });
}));

// The section's OT form data for ?month=YYYY-MM, after checking the section
// has a form. Sends the error response itself and returns null when it can't
// go on.
async function loadDepartmentOt(req, res) {
  if (!otUnitFor(req.section.code)) {
    res.status(403).json({ message: "There is no OT form for this section yet" });
    return null;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(`${req.query.month ?? ""}`);
  const month = m ? Number(m[2]) : NaN;
  if (!m || month < 1 || month > 12) {
    res.status(400).json({ message: "month must be YYYY-MM" });
    return null;
  }
  const data = await otQueryWrap(() => loadOtMonth(req.section.id, req.section.code, `${m[1]}-${m[2]}`));
  return { year: Number(m[1]), month, ...data };
}

// GET /api/ot/export-people?month=YYYY-MM — who on the form has OT this month,
// for picking each person's signature before exporting. signMode is what the
// person chose on their own entries (E-Sign if any of them asked for it).
router.get("/export-people", resolveSection, asyncHandler(async (req, res) => {
  const data = await loadDepartmentOt(req, res);
  if (!data) return;
  const out = [];
  for (const person of data.people) {
    const mine = data.entries.filter(e => e.employeeNo === person.employeeNo);
    if (!mine.length) continue;
    out.push({
      employeeNo: person.employeeNo,
      fullName: person.fullName,
      days: mine.length,
      minutes: mine.reduce((sum, e) => sum + e.minutes, 0),
      signMode: mine.some(e => e.signMode === "ESIGN") ? "ESIGN" : "SELF",
      esignAvailable: !!findSignature(person.employeeNo)
    });
  }
  res.json({ people: out });
}));

// GET /api/ot/export.xlsx?month=YYYY-MM[&esign=code,code] (x-section-code:
// AUTOMATION) — the month's Over Time Request form: one form per day on which
// anyone on the roster has OT, each listing the whole roster with that day's
// OT filled in. esign, when given, is the exporter's per-person choice: the
// listed employee numbers get their e-signature, everyone else signs by hand.
router.get(["/export", "/export.xlsx"], resolveSection, asyncHandler(async (req, res) => {
  const data = await loadDepartmentOt(req, res);
  if (!data) return;
  let { entries } = data;
  if (req.query.esign !== undefined) {
    const esign = new Set(`${req.query.esign}`.split(",").map(s => s.trim()).filter(Boolean));
    entries = entries.map(e => ({ ...e, signMode: esign.has(e.employeeNo) ? "ESIGN" : "SELF" }));
  }
  const me = await loadMe(req.user.id);
  const { buffer } = buildOtWorkbook({
    year: data.year,
    month: data.month,
    exportedBy: `${me.full_name || me.display_name || ""}`.trim(),
    people: data.people,
    entries
  });
  // e.g. "OT October 2026.xlsx"
  const name = `OT ${MONTH_NAMES[data.month - 1]} ${data.year}`;
  res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment(`${name}.xlsx`).send(buffer);
}));

module.exports = router;
