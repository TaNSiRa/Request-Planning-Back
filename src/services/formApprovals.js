const { query } = require("../db/pool");

// Who has signed a month's OT / off-site form so far, so that a plain export
// of that month (Personal calendar) carries the same approver signatures as
// the files the approvers see.

// Today in Thailand as DD/MM/YYYY — the dates written on the forms.
function thaiToday() {
  return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok" });
}

// steps (form_submission_steps rows joined with the approver's employee_no) →
// { CHIEF | MANAGER | DEPT_MGR: { employeeNo, decidedOn: 'DD/MM/YYYY' } } for
// each approved step.
function approvalsOf(steps) {
  const out = {};
  for (const st of steps) {
    if (st.status !== "APPROVED") continue;
    out[st.role] = {
      employeeNo: st.approver_employee_no,
      decidedOn: st.decided_at ? new Date(st.decided_at).toLocaleDateString("en-GB", { timeZone: "UTC" }) : thaiToday()
    };
  }
  return out;
}

// The month's latest submission of [kind] that wasn't rejected — in
// [sectionId] for OT, or the one carrying [employeeNo]'s off-site form — as
// { approvals, sentOn } (sentOn: the date the sender e-signed it with).
// Nothing sent yet, or the forms tables not installed: { approvals: {} }.
async function monthApprovals({ kind, ym, sectionId = null, employeeNo = null }) {
  let subs;
  try {
    subs = (await query(
      `SELECT id, snapshot_json FROM form_submissions
       WHERE kind = @kind AND form_month = @ym AND status <> 'REJECTED'
         ${sectionId != null ? "AND section_id = @sectionId" : ""}
       ORDER BY submitted_at DESC, id DESC`,
      { kind, ym, sectionId }
    )).recordset;
  } catch (err) {
    if (err?.number === 208) return { approvals: {} };
    throw err;
  }
  for (const sub of subs) {
    let snapshot = {};
    try {
      snapshot = JSON.parse(sub.snapshot_json) || {};
    } catch {
      continue;
    }
    if (employeeNo != null && !(snapshot.offsite || []).some(f => `${f.person?.employeeNo ?? ""}` === `${employeeNo}`)) continue;
    const steps = (await query(
      `SELECT st.role, st.status, st.decided_at, u.employee_no AS approver_employee_no
       FROM form_submission_steps st LEFT JOIN users u ON u.id = st.approver_user_id
       WHERE st.submission_id = @id ORDER BY st.step_no`,
      { id: sub.id }
    )).recordset;
    return { approvals: approvalsOf(steps), sentOn: snapshot.sentOn || null };
  }
  return { approvals: {} };
}

module.exports = { approvalsOf, monthApprovals, thaiToday };
