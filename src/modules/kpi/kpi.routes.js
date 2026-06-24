const express = require("express");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/summary", asyncHandler(async (req, res) => {
  const { scope = "all", from, to } = req.query;
  const mine = scope === "mine" ? 1 : 0;
  const byStatus = await query(
    `SELECT status, COUNT(*) AS total FROM requests
     WHERE is_kpi = 1
       AND section_id=@sectionId
       AND (@mine=0 OR requester_user_id=@userId OR incharge_user_id=@userId OR support_user_id=@userId)
       AND (@from IS NULL OR created_at >= @from)
       AND (@to IS NULL OR created_at <= @to)
     GROUP BY status ORDER BY status`,
    { mine, userId: req.user.id, sectionId: req.section.id, from: from || null, to: to || null }
  );
  const byType = await query(
    `SELECT request_type, COUNT(*) AS total FROM requests
     WHERE is_kpi = 1
       AND section_id=@sectionId
       AND (@mine=0 OR requester_user_id=@userId OR incharge_user_id=@userId OR support_user_id=@userId)
     GROUP BY request_type ORDER BY total DESC`,
    { mine, userId: req.user.id, sectionId: req.section.id }
  );
  const leadTime = await query(
    `SELECT AVG(CAST(DATEDIFF(HOUR, created_at, COALESCE(closed_at, SYSUTCDATETIME())) AS FLOAT)) AS avg_hours
     FROM requests
     WHERE is_kpi = 1
       AND section_id=@sectionId
       AND status IN ('COMPLETED','IN_PROGRESS','WAITING_CLOSE')`,
    { sectionId: req.section.id }
  );
  res.json({ byStatus: byStatus.recordset, byType: byType.recordset, leadTime: leadTime.recordset[0] });
}));

router.get("/export.csv", asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT request_no, title, request_type, priority, status, due_date, planned_start, planned_end, created_at, closed_at
     FROM requests WHERE is_kpi = 1 AND section_id=@sectionId ORDER BY created_at DESC`,
    { sectionId: req.section.id }
  )).recordset;
  const header = Object.keys(rows[0] || { request_no: "", title: "", status: "" });
  const csv = [header.join(","), ...rows.map(row => header.map(key => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
  res.header("Content-Type", "text/csv");
  res.attachment("automation-kpi.csv").send(csv);
}));

module.exports = router;
