const express = require("express");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection, isAdmin } = require("../../services/sectionService");
const { buildMboWorkbook } = require("../../services/mboExport");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

function analyticsScope(req) {
  // A real member works in this section (can_work); a cross-section approver
  // (can_work=0) is scoped to their own org section. Mirrors the frontend
  // belongsToSection so KPI / sup-type views match what pages show.
  const belongsToSection = isAdmin(req.user) || req.sectionAccess.canWork === true;
  return {
    requesterOrgSection: belongsToSection ? null : (req.user.section || "__NO_ORG_SECTION__"),
    sectionMember: belongsToSection ? 1 : 0
  };
}

router.get("/summary", asyncHandler(async (req, res) => {
  const { scope = "all", from, to } = req.query;
  const mine = scope === "mine" ? 1 : 0;
  // Members of this section (workers / approvers / admin) see the whole section
  // in the "all" scope; an outside cross-section requester sees only requests
  // raised by their own org section. "mine" scope stays incharge-only.
  const { requesterOrgSection } = analyticsScope(req);
  // "kpi" = only requests flagged is_kpi; "all" (default) = every request,
  // including KPI-flagged ones.
  const kpiOnly = req.query.kpiFilter === "kpi" ? 1 : 0;
  const chartYear = Number(req.query.chartYear) || new Date().getUTCFullYear();
  const byStatus = await query(
    `SELECT status, COUNT(*) AS total FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND section_id=@sectionId
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)
     GROUP BY status ORDER BY status`,
    { mine, kpiOnly, userId: req.user.id, requesterOrgSection, sectionId: req.section.id, from: from || null, to: to || null }
  );
  const byType = await query(
    `SELECT request_type, COUNT(*) AS total FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1)
       AND status = 'COMPLETED'
       AND section_id=@sectionId
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)
     GROUP BY request_type ORDER BY total DESC`,
    { mine, kpiOnly, userId: req.user.id, requesterOrgSection, sectionId: req.section.id, from: from || null, to: to || null }
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
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)`,
    { mine, kpiOnly, userId: req.user.id, requesterOrgSection, sectionId: req.section.id, from: from || null, to: to || null }
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
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
     GROUP BY MONTH(planned_end) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
  );
  const monthlyActual = await query(
    `SELECT MONTH(work_completed_at) AS month, COUNT(*) AS total
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status = 'COMPLETED' AND work_completed_at IS NOT NULL
       AND YEAR(work_completed_at) = @chartYear
       AND section_id=@sectionId
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
     GROUP BY MONTH(work_completed_at) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
  );
  // Completed earlier than the target month — shown faded at the target month.
  const monthlyEarly = await query(
    `SELECT MONTH(planned_end) AS month, COUNT(*) AS total
     FROM requests
     WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status = 'COMPLETED' AND planned_end IS NOT NULL AND work_completed_at IS NOT NULL
       AND work_completed_at < DATEFROMPARTS(YEAR(planned_end), MONTH(planned_end), 1)
       AND YEAR(planned_end) = @chartYear
       AND section_id=@sectionId
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
     GROUP BY MONTH(planned_end) ORDER BY month`,
    { mine, kpiOnly, chartYear, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
  );
  // Distinct years that have completed KPI data, for the chart's year selector.
  const years = await query(
    `SELECT DISTINCT yr FROM (
       SELECT YEAR(planned_end) AS yr FROM requests
         WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status NOT IN ('ON_HOLD','REJECTED','CANCELLED') AND planned_end IS NOT NULL AND section_id=@sectionId
           AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       UNION
       SELECT YEAR(work_completed_at) FROM requests
         WHERE (@kpiOnly = 0 OR is_kpi = 1) AND status='COMPLETED' AND work_completed_at IS NOT NULL AND section_id=@sectionId
           AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
     ) t WHERE yr IS NOT NULL ORDER BY yr DESC`,
    { mine, kpiOnly, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
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
       AND ((@mine=1 AND incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       AND (@from IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start <= @to)`,
    { mine, kpiOnly, userId: req.user.id, requesterOrgSection, sectionId: req.section.id, from: from || null, to: to || null }
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
  const { requesterOrgSection } = analyticsScope(req);
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
       AND ((@mine=1 AND r.incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR r.requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
     GROUP BY st.sup_type
     ORDER BY total DESC, st.sup_type`,
    { mine, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
  );
  res.json({ supTypes: rows.recordset });
}));

// Skill-matrix workload + capacity per (item, level): how many requests need
// that skill at that level vs. how many section workers hold it. Powers the
// Sup-type Summary matrix box. Returns empty lists if the skill-matrix tables
// aren't installed. Level-tagged requests only (matrix-mode assignments).
router.get("/skill-matrix-workload", asyncHandler(async (req, res) => {
  const { scope = "all" } = req.query;
  const mine = scope === "mine" ? 1 : 0;
  const { requesterOrgSection } = analyticsScope(req);
  try {
    const workload = (await query(
      `SELECT st.item_id AS itemId, st.level_id AS levelId, COUNT(*) AS total
       FROM request_support_types st
       JOIN requests r ON r.id = st.request_id
       WHERE st.item_id IS NOT NULL AND st.level_id IS NOT NULL
         AND r.section_id=@sectionId
         AND ((@mine=1 AND r.incharge_user_id=@userId) OR (@mine=0 AND (@requesterOrgSection IS NULL OR r.requester_user_id IN (SELECT id FROM users WHERE section=@requesterOrgSection))))
       GROUP BY st.item_id, st.level_id`,
      { mine, userId: req.user.id, requesterOrgSection, sectionId: req.section.id }
    )).recordset;
    const capacity = (await query(
      `SELECT usl.item_id AS itemId, usl.level_id AS levelId, COUNT(DISTINCT usl.user_id) AS total
       FROM user_skill_levels usl
       JOIN user_section_memberships m ON m.user_id = usl.user_id
         AND m.section_id=@sectionId AND m.is_active=1 AND m.can_work=1
       GROUP BY usl.item_id, usl.level_id`,
      { sectionId: req.section.id }
    )).recordset;
    res.json({ workload, capacity });
  } catch (err) {
    const msg = `${err.message}`;
    if (msg.includes("Invalid object name") || msg.includes("Invalid column name")) {
      return res.json({ workload: [], capacity: [] });
    }
    throw err;
  }
}));

router.get("/export.csv", asyncHandler(async (req, res) => {
  const { requesterOrgSection, sectionMember } = analyticsScope(req);
  const rows = (await query(
    `SELECT r.request_no, r.title, r.request_type, r.priority, r.status, r.due_date, r.planned_start, r.planned_end, r.created_at, r.closed_at
     FROM requests r
     JOIN users requester ON requester.id = r.requester_user_id
     WHERE r.is_kpi = 1
       AND r.section_id=@sectionId
       AND (@sectionMember=1 OR requester.section=@requesterOrgSection)
     ORDER BY r.created_at DESC`,
    { sectionId: req.section.id, requesterOrgSection, sectionMember }
  )).recordset;
  const header = Object.keys(rows[0] || { request_no: "", title: "", status: "" });
  const csv = [header.join(","), ...rows.map(row => header.map(key => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
  res.header("Content-Type", "text/csv");
  res.attachment("automation-kpi.csv").send(csv);
}));

// Personal MBO appraisal form (company Excel template) filled with the
// caller's KPI-flagged requests: goal = request title, action plan = todos,
// start-end = the approver-set period, equal weights summing to 60%, and a
// provisional self-assessment score of 5. Optional from/to narrows requests
// by period overlap (same rule as /summary).
router.get("/export-mbo.xlsx", asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const me = (await query(
    `SELECT full_name, display_name, employee_no, branch, department, section FROM users WHERE id=@userId`,
    { userId: req.user.id }
  )).recordset[0] || {};
  const requests = (await query(
    `SELECT TOP 7 id, title, planned_start, planned_end
     FROM requests
     WHERE is_kpi = 1
       AND section_id=@sectionId
       AND incharge_user_id=@userId
       AND status NOT IN ('DRAFT','REJECTED','CANCELLED')
       AND (@from IS NULL OR planned_end IS NULL OR planned_end >= @from)
       AND (@to IS NULL OR planned_start IS NULL OR planned_start <= @to)
     ORDER BY planned_start, created_at`,
    { sectionId: req.section.id, userId: req.user.id, from: from || null, to: to || null }
  )).recordset;
  for (const r of requests) {
    r.todos = (await query(
      `SELECT title FROM request_todos WHERE request_id=@requestId ORDER BY sort_order, id`,
      { requestId: r.id }
    )).recordset.map(t => t.title);
  }
  const buffer = buildMboWorkbook({
    fullName: me.full_name || me.display_name || "",
    employeeNo: me.employee_no,
    branch: me.branch,
    department: me.department,
    section: me.section,
    requests
  });
  res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment("mbo-form.xlsx").send(buffer);
}));

module.exports = router;
