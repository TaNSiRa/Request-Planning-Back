const { query } = require("../db/pool");

// Co-approver support (multiple approvers per approval step, any one may act).
// The three companion tables come from database/patch_multi_approvers.sql —
// until the patch is applied every helper degrades gracefully to the legacy
// single-approver behaviour (primary approver column only).

let _hasTables = null;
let _lastProbeAt = 0;

async function hasCoApproverTables() {
  // "true" is permanent for the process lifetime; "false" re-probes at most
  // every 30s, so applying database/patch_multi_approvers.sql is picked up
  // WITHOUT a backend restart (probe order no longer matters).
  if (_hasTables === true) return true;
  if (_hasTables === false && Date.now() - _lastProbeAt < 30000) return false;
  _lastProbeAt = Date.now();
  try {
    await query("SELECT TOP 0 1 FROM approval_route_step_approvers");
    await query("SELECT TOP 0 1 FROM approval_step_approvers");
    await query("SELECT TOP 0 1 FROM schedule_extension_step_approvers");
    _hasTables = true;
  } catch (err) {
    _hasTables = false;
  }
  return _hasTables;
}

// SQL fragment: does @userId sit on approval step alias `a` (primary OR co)?
// Falls back to the primary-only check when the tables aren't installed.
async function approvalStepUserCondition(alias = "a", userParam = "@userId") {
  if (await hasCoApproverTables()) {
    return `(${alias}.approver_user_id=${userParam} OR EXISTS (
      SELECT 1 FROM approval_step_approvers casp
      WHERE casp.step_id=${alias}.id AND casp.user_id=${userParam}))`;
  }
  return `${alias}.approver_user_id=${userParam}`;
}

async function extensionStepUserCondition(alias = "a", userParam = "@userId") {
  if (await hasCoApproverTables()) {
    return `(${alias}.approver_user_id=${userParam} OR EXISTS (
      SELECT 1 FROM schedule_extension_step_approvers cesp
      WHERE cesp.step_id=${alias}.id AND cesp.user_id=${userParam}))`;
  }
  return `${alias}.approver_user_id=${userParam}`;
}

// SQL fragment: is @userId a candidate on route step alias `ars`?
async function routeStepUserCondition(alias = "ars", userParam = "@userId") {
  if (await hasCoApproverTables()) {
    return `(${alias}.default_approver_user_id=${userParam} OR EXISTS (
      SELECT 1 FROM approval_route_step_approvers crsp
      WHERE crsp.step_id=${alias}.id AND crsp.user_id=${userParam}))`;
  }
  return `${alias}.default_approver_user_id=${userParam}`;
}

// Candidate user ids per route step: Map(step_id -> [user_id, ...]) with the
// primary approver first. Steps without co-approver rows fall back to primary.
async function routeStepApproverIds(routeId) {
  const steps = (await query(
    "SELECT id, default_approver_user_id FROM approval_route_steps WHERE route_id=@routeId",
    { routeId }
  )).recordset;
  const map = new Map(steps.map(s => [s.id, s.default_approver_user_id ? [s.default_approver_user_id] : []]));
  if (await hasCoApproverTables()) {
    const rows = (await query(
      `SELECT a.step_id, a.user_id
       FROM approval_route_step_approvers a
       JOIN approval_route_steps s ON s.id = a.step_id
       WHERE s.route_id=@routeId
       ORDER BY a.id`,
      { routeId }
    )).recordset;
    for (const row of rows) {
      const list = map.get(row.step_id);
      if (list && !list.includes(row.user_id)) list.push(row.user_id);
    }
  }
  return map;
}

async function saveRouteStepApprovers(stepId, userIds) {
  if (!(await hasCoApproverTables())) return;
  for (const userId of userIds) {
    await query(
      `IF NOT EXISTS (SELECT 1 FROM approval_route_step_approvers WHERE step_id=@stepId AND user_id=@userId)
       INSERT INTO approval_route_step_approvers (step_id, user_id) VALUES (@stepId, @userId)`,
      { stepId, userId }
    );
  }
}

// Snapshot the candidate list onto a request's approval step.
async function saveStepApprovers(stepId, userIds) {
  if (!(await hasCoApproverTables())) return;
  for (const userId of userIds) {
    await query(
      `IF NOT EXISTS (SELECT 1 FROM approval_step_approvers WHERE step_id=@stepId AND user_id=@userId)
       INSERT INTO approval_step_approvers (step_id, user_id) VALUES (@stepId, @userId)`,
      { stepId, userId }
    );
  }
}

async function saveExtensionStepApprovers(stepId, userIds) {
  if (!(await hasCoApproverTables())) return;
  for (const userId of userIds) {
    await query(
      `IF NOT EXISTS (SELECT 1 FROM schedule_extension_step_approvers WHERE step_id=@stepId AND user_id=@userId)
       INSERT INTO schedule_extension_step_approvers (step_id, user_id) VALUES (@stepId, @userId)`,
      { stepId, userId }
    );
  }
}

// Everyone who may act on one request approval step (primary + co-approvers),
// deduplicated, primary first — for notifications/emails.
async function stepCandidates(stepId) {
  const rows = (await query(
    `SELECT u.id, u.email, u.display_name
     FROM approval_steps a JOIN users u ON u.id = a.approver_user_id
     WHERE a.id=@stepId`,
    { stepId }
  )).recordset;
  if (await hasCoApproverTables()) {
    const extra = (await query(
      `SELECT u.id, u.email, u.display_name
       FROM approval_step_approvers x JOIN users u ON u.id = x.user_id
       WHERE x.step_id=@stepId
       ORDER BY x.id`,
      { stepId }
    )).recordset;
    for (const row of extra) {
      if (!rows.some(r => r.id === row.id)) rows.push(row);
    }
  }
  return rows;
}

async function extensionStepCandidates(stepId) {
  const rows = (await query(
    `SELECT u.id, u.email, u.display_name
     FROM schedule_extension_approval_steps a JOIN users u ON u.id = a.approver_user_id
     WHERE a.id=@stepId`,
    { stepId }
  )).recordset;
  if (await hasCoApproverTables()) {
    const extra = (await query(
      `SELECT u.id, u.email, u.display_name
       FROM schedule_extension_step_approvers x JOIN users u ON u.id = x.user_id
       WHERE x.step_id=@stepId
       ORDER BY x.id`,
      { stepId }
    )).recordset;
    for (const row of extra) {
      if (!rows.some(r => r.id === row.id)) rows.push(row);
    }
  }
  return rows;
}

// Candidate names/ids per approval step of one request:
// Map(step_id -> [{ id, name }]) (primary first). Empty map pre-patch.
async function requestStepCandidateMap(requestId) {
  const map = new Map();
  if (!(await hasCoApproverTables())) return map;
  const rows = (await query(
    `SELECT x.step_id, u.id, u.display_name
     FROM approval_step_approvers x
     JOIN approval_steps a ON a.id = x.step_id
     JOIN users u ON u.id = x.user_id
     WHERE a.request_id=@requestId
     ORDER BY x.id`,
    { requestId }
  )).recordset;
  for (const row of rows) {
    if (!map.has(row.step_id)) map.set(row.step_id, []);
    map.get(row.step_id).push({ id: row.id, name: row.display_name });
  }
  return map;
}

module.exports = {
  hasCoApproverTables,
  approvalStepUserCondition,
  extensionStepUserCondition,
  routeStepUserCondition,
  routeStepApproverIds,
  saveRouteStepApprovers,
  saveStepApprovers,
  saveExtensionStepApprovers,
  stepCandidates,
  extensionStepCandidates,
  requestStepCandidateMap
};
