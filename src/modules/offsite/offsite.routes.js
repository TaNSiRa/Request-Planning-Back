const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { buildOffsiteWorkbook } = require("../../services/offsiteExport");
const { findSignature, ensureSignatureDir } = require("../../services/xlsxKit");
const { xlsxToPdf } = require("../../services/pdfConvert");

// Personal off-site work log ("ทำงานนอกสถานที่") behind the Personal calendar
// page, and the person's own monthly Clocking In-Out Confirmation form. Like
// the OT log it belongs to the person: every route works on the caller's own
// rows only, and never resolves a section.
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
const COLUMNS = "work_date, start_time, end_time, place, reason";

function toEntry(row) {
  return {
    date: row.work_date,
    startTime: row.start_time,
    endTime: row.end_time,
    place: row.place || "",
    reason: row.reason || ""
  };
}

// Until patch_personal_offsite.sql is applied the table is missing (SQL error
// 208); say so plainly instead of a generic 500.
async function offsiteQuery(text, params) {
  try {
    return await query(text, params);
  } catch (err) {
    if (err?.number === 208) {
      const e = new Error("Off-site work is not set up on this server yet (database patch_personal_offsite.sql)");
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

async function loadMe(userId) {
  return (await query(
    `SELECT employee_no, full_name, display_name, section FROM users WHERE id=@userId`,
    { userId }
  )).recordset[0] || {};
}

// GET /api/offsite?from=YYYY-MM-DD&to=YYYY-MM-DD — the caller's off-site days
// in a date range, plus whether an e-signature image is on file for them.
router.get("/", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ message: "from/to must be YYYY-MM-DD" });
  const rows = (await offsiteQuery(
    `SELECT ${COLUMNS} FROM personal_offsite
     WHERE user_id=@userId AND work_date BETWEEN @from AND @to ORDER BY work_date`,
    { userId: req.user.id, from, to }
  )).recordset;
  const me = await loadMe(req.user.id);
  res.json({ entries: rows.map(toEntry), esignAvailable: !!findSignature(me.employee_no) });
}));

// PUT /api/offsite/:date — add or replace the caller's off-site work for one day.
router.put("/:date", asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
  const input = z.object({
    startTime: hm,
    endTime: hm,
    place: z.string().trim().max(300).optional().default(""),
    reason: z.string().trim().min(1, "Remarks are required").max(200)
  }).parse(req.body);
  if (input.startTime === input.endTime) {
    return res.status(400).json({ message: "Start and end time can't be the same" });
  }
  const params = {
    userId: req.user.id, date, startTime: input.startTime, endTime: input.endTime,
    place: input.place || null, reason: input.reason
  };
  const updated = await offsiteQuery(
    `UPDATE personal_offsite
     SET start_time=@startTime, end_time=@endTime, place=@place, reason=@reason,
         updated_at=DATEADD(HOUR, 7, SYSUTCDATETIME())
     WHERE user_id=@userId AND work_date=@date`,
    params
  );
  if (!updated.rowsAffected[0]) {
    await offsiteQuery(
      `INSERT INTO personal_offsite (user_id, work_date, start_time, end_time, place, reason)
       VALUES (@userId, @date, @startTime, @endTime, @place, @reason)`,
      params
    );
  }
  res.json({
    entry: toEntry({
      work_date: date, start_time: input.startTime, end_time: input.endTime,
      place: input.place, reason: input.reason
    })
  });
}));

router.delete("/:date", asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!isYmd(date)) return res.status(400).json({ message: "Date must be YYYY-MM-DD" });
  await offsiteQuery(`DELETE FROM personal_offsite WHERE user_id=@userId AND work_date=@date`,
    { userId: req.user.id, date });
  res.json({ ok: true });
}));

// GET /api/offsite/export?month=YYYY-MM&sign=SELF|ESIGN&format=xlsx|pdf — the
// caller's Clocking In-Out Confirmation form for the month: one line per
// off-site day, signed with their e-signature or left for signing by hand.
router.get("/export", asyncHandler(async (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(`${req.query.month ?? ""}`);
  const month = m ? Number(m[2]) : NaN;
  if (!m || month < 1 || month > 12) return res.status(400).json({ message: "month must be YYYY-MM" });
  const pdf = req.query.format === "pdf";
  const ym = `${m[1]}-${m[2]}`;
  const rows = (await offsiteQuery(
    `SELECT ${COLUMNS} FROM personal_offsite
     WHERE user_id=@userId AND work_date BETWEEN @from AND @to ORDER BY work_date`,
    { userId: req.user.id, from: `${ym}-01`, to: `${ym}-31` }
  )).recordset;
  const me = await loadMe(req.user.id);
  const fullName = `${me.full_name || me.display_name || ""}`.trim();
  const employeeNo = `${me.employee_no ?? ""}`.trim();
  const xlsx = buildOffsiteWorkbook({
    person: { employeeNo, fullName, department: `${me.section ?? ""}`.trim() },
    entries: rows.map(toEntry),
    signature: req.query.sign === "ESIGN" ? findSignature(employeeNo) : null,
    exportedBy: fullName
  });
  // e.g. "Off-site October 2026 1650574 Sirawit Kaewchoo.pdf"
  const name = ["Off-site", MONTH_NAMES[month - 1], m[1], employeeNo, fullName]
    .filter(v => `${v}`.trim() !== "").join(" ");
  if (pdf) {
    const buffer = await xlsxToPdf(xlsx);
    res.header("Content-Type", "application/pdf");
    return res.attachment(`${name}.pdf`).send(buffer);
  }
  res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment(`${name}.xlsx`).send(xlsx);
}));

module.exports = router;
