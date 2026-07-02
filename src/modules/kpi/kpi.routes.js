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
  // "kpi" = only requests flagged is_kpi; "all" (default) = every request,
  // including KPI-flagged ones.
  const kpiOnly = req.query.kpiFilter === "kpi" ? 1 : 0;
  const chartYear = Number(req.query.chartYear) || new Date().getUTCFullYear();
  const byStatus = await query(
    `SELECT status, COUNT(*) AS total FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)
     GROUP BY status ORDER BY status`,
    { mine, kpiOnly, userId: req.user.id, sectionId: req.section.id, from: from || null, to: to || null }
  );
  const byType = await query(
    `SELECT request_type, COUNT(*) AS total FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND status = 'COMPLETED'
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)
     GROUP BY request_type ORDER BY total DESC`,
    { mine, kpiOnly, userId: req.user.id, sectionId: req.section.id, from: from || null, to: to || null }
  );
  // Lead time = from the approver-set start date to when the incharge submitted
  // work complete (work_completed_at), counted only for completed requests.
  const leadTime = await query(
    `SELECT AVG(CAST(DATEDIFF(HOUR, planned_start, work_completed_at) AS FLOAT)) AS avg_hours
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND status = 'COMPLETED'
       AND planned_start IS NOT NULL
       AND work_completed_at IS NOT NULL
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)`,
    { mine, kpiOnly, userId: req.user.id, sectionId: req.section.id, from: from || null, to: to || null }
  );
  // Monthly chart compares, per month, the Target (completed requests whose
  // approver-set period end falls in that month) against the Actual (requests
  // actually completed that month). Completed requests only. The chart follows
  // the department/mine scope but ignores the date range filter.
  // Target = every committed request (has a period end) that's still alive —
  // i.e. NOT on hold / rejected / cancelled — bucketed by its period-end month.
  const monthlyTarget = await query(
    `SELECT MONTH(planned_end) AS month, COUNT(*) AS total
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status NOT IN ('ON_HOLD','REJECTED','CANCELLED') AND planned_end IS NOT NULL
       AND YEAR(planned_end) = @chartYear
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
     GROUP BY MONTH(planned_end) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, sectionId: req.section.id }
  );
  const monthlyActual = await query(
    `SELECT MONTH(work_completed_at) AS month, COUNT(*) AS total
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status = 'COMPLETED' AND work_completed_at IS NOT NULL
       AND YEAR(work_completed_at) = @chartYear
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
     GROUP BY MONTH(work_completed_at) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, sectionId: req.section.id }
  );
  // Completed earlier than the target month — shown faded at the target month.
  const monthlyEarly = await query(
    `SELECT MONTH(planned_end) AS month, COUNT(*) AS total
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status = 'COMPLETED' AND planned_end IS NOT NULL AND work_completed_at IS NOT NULL
       AND work_completed_at < DATEFROMPARTS(YEAR(planned_end), MONTH(planned_end), 1)
       AND YEAR(planned_end) = @chartYear
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
     GROUP BY MONTH(planned_end) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, sectionId: req.section.id }
  );
  // Distinct years that have completed KPI data, for the chart's year selector.
  const years = await query(
    `SELECT DISTINCT yr FROM (
       SELECT YEAR(planned_end) AS yr FROM requests
         WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status NOT IN ('ON_HOLD','REJECTED','CANCELLED') AND planned_end IS NOT NULL AND section_id=@sectionId
           AND (@mine=0 OR incharge_user_id=@userId)
       UNION
       SELECT YEAR(work_completed_at) FROM requests
         WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status='COMPLETED' AND work_completed_at IS NOT NULL AND section_id=@sectionId
           AND (@mine=0 OR incharge_user_id=@userId)
     ) t WHERE yr IS NOT NULL ORDER BY yr DESC`,
    { mine, kpiOnly, userId: req.user.id, sectionId: req.section.id }
  );
  // Overdue = work submitted late: the incharge pressed "submit work complete"
  // (work_completed_at) after the approver-set period end.
  const overdue = await query(
    `SELECT COUNT(*) AS total FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND work_completed_at IS NOT NULL
       AND planned_end IS NOT NULL
       AND CAST(work_completed_at AS DATE) > CAST(planned_end AS DATE)
       AND section_id=@sectionId
       AND (@mine=0 OR incharge_user_id=@userId)
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)`,
    { mine, kpiOnly, userId: req.user.id, sectionId: req.section.id, from: from || null, to: to || null }
  );
  res.json({
    byStatus: byStatus.recordset,
    byType: byType.recordset,
    leadTime: leadTime.recordset[0],
    monthlyTarget: monthlyTarget.recordset,
    monthlyActual: monthlyActual.recordset,
    monthlyEarly: monthlyEarly.recordset,
    chartYear,
    chartYears: years.recordset.map(r => r.yr),
    overdue: overdue.recordset[0].total
  });
}));

// Workload breakdown by support type (PLC, HMI, ...). Used by the Sup-type
// Summary page to gauge load and inform hiring decisions.
router.get("/sup-type-summary", asyncHandler(async (req, res) => {
  const { scope = "all" } = req.query;
  const mine = scope === "mine" ? 1 : 0;
  const rows = await query(
    `SELECT st.sup_type,
            COUNT(*) AS total,
            SUM(CASE WHEN r.status IN ('IN_PROGRESS','ON_HOLD') THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN r.status = 'WAITING_CLOSE' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN r.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN r.work_completed_at IS NOT NULL AND r.planned_end IS NOT NULL
                      AND CAST(r.work_completed_at AS DATE) > CAST(r.planned_end AS DATE) THEN 1 ELSE 0 END) AS overdue,
            AVG(CASE WHEN r.status='COMPLETED' AND r.planned_start IS NOT NULL AND r.work_completed_at IS NOT NULL
                     THEN CAST(DATEDIFF(HOUR, r.planned_start, r.work_completed_at) AS FLOAT) END) AS avg_hours
     FROM request_support_types st
     JOIN requests r ON r.id = st.request_id
     WHERE r.section_id=@sectionId
       AND (@mine=0 OR r.incharge_user_id=@userId)
     GROUP BY st.sup_type
     ORDER BY total DESC, st.sup_type`,
    { mine, userId: req.user.id, sectionId: req.section.id }
  );
  res.json({ supTypes: rows.recordset });
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
