const { query } = require("../db/pool");
const { countOt } = require("./otHours");

// The month's data behind the two company forms, shared by the OT / off-site
// routes (export) and the form submissions (send for approval):
//   · OT — the section's Over Time Request form: the roster below and their OT.
//   · Off-site — each person's Clocking In-Out Confirmation form.

// Sections whose OT form exists (assets/templates/ot-template.xlsx is the
// Automation section's form), keyed by section code, with the department name
// on the people's profiles (users.section) that belongs on that form.
const OT_FORM_SECTIONS = { AUTOMATION: "Automation" };

function otUnitFor(sectionCode) {
  return OT_FORM_SECTIONS[`${sectionCode ?? ""}`.toUpperCase()] || null;
}

// Who is printed on the OT form: active members of the section whose profile
// department is the form's, ranked below Manager (M4) — a larger sort_order is
// a lower rank — and not trainees. People with no position are left off too.
const OT_ROSTER_SQL = `
  SELECT u.id, u.employee_no, u.full_name, u.display_name, u.section AS unit, u.phone
  FROM users u
  JOIN positions p ON p.id = u.position_id
  WHERE u.is_active = 1
    AND LOWER(LTRIM(RTRIM(u.section))) = LOWER(@unit)
    AND EXISTS (SELECT 1 FROM user_section_memberships m
                WHERE m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1)
    AND p.sort_order > ISNULL((SELECT MIN(sort_order) FROM positions WHERE abbreviation = 'M4'), 40)
    AND LOWER(LTRIM(RTRIM(p.name))) <> 'trainee'
    AND LOWER(LTRIM(RTRIM(ISNULL(p.abbreviation, '')))) <> 'trainee'`;

// The section's people who work there (the weekly plan's rows): the department
// an off-site send covers and the cc list of the form mails.
const SECTION_WORKERS_SQL = `
  SELECT u.id, u.employee_no, u.full_name, u.display_name, u.email, u.section AS unit
  FROM users u
  JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId
   AND m.is_active = 1 AND m.can_work = 1
  WHERE u.is_active = 1`;

const byEmployeeNo = (a, b) => a.employeeNo.localeCompare(b.employeeNo, undefined, { numeric: true });

function otEntryFromRow(row) {
  const otType = row.ot_type === "SPECIAL" ? "SPECIAL" : "NORMAL";
  const holiday = row.is_holiday === true || row.is_holiday === 1;
  return {
    date: row.ot_date,
    startTime: row.start_time,
    endTime: row.end_time,
    reason: row.reason,
    signMode: row.sign_mode,
    otType,
    holiday,
    minutes: countOt(row.start_time, row.end_time, { holiday, special: otType === "SPECIAL" }).minutes
  };
}

function offsiteEntryFromRow(row) {
  return {
    date: row.work_date,
    startTime: row.start_time,
    endTime: row.end_time,
    place: row.place || "",
    reason: row.reason || ""
  };
}

function monthRange(ym) {
  return { from: `${ym}-01`, to: `${ym}-31` };
}

// { people, entries } for the section's OT form in month ym ('YYYY-MM'), or
// null when the section has no OT form.
async function loadOtMonth(sectionId, sectionCode, ym) {
  const unit = otUnitFor(sectionCode);
  if (!unit) return null;
  const params = { sectionId, unit, ...monthRange(ym) };
  const people = (await query(OT_ROSTER_SQL, params)).recordset
    .map(r => ({
      employeeNo: `${r.employee_no ?? ""}`.trim(),
      fullName: `${r.full_name || r.display_name || ""}`.trim(),
      unit: `${r.unit ?? ""}`.trim(),
      phone: r.phone
    }))
    .sort(byEmployeeNo);
  const rows = (await query(
    `SELECT r.employee_no, o.ot_date, o.start_time, o.end_time, o.reason, o.sign_mode, o.ot_type, o.is_holiday
     FROM personal_ot o
     JOIN (${OT_ROSTER_SQL}) r ON r.id = o.user_id
     WHERE o.ot_date BETWEEN @from AND @to
     ORDER BY o.ot_date`,
    params
  )).recordset;
  return {
    people,
    entries: rows.map(r => ({ employeeNo: `${r.employee_no ?? ""}`.trim(), ...otEntryFromRow(r) }))
  };
}

// [{ person: { employeeNo, fullName, department }, entries }] — every section
// worker with off-site work in month ym, in employee-number order.
async function loadOffsiteMonth(sectionId, ym) {
  const rows = (await query(
    `SELECT w.employee_no, w.full_name, w.display_name, w.unit,
            o.work_date, o.start_time, o.end_time, o.place, o.reason
     FROM personal_offsite o
     JOIN (${SECTION_WORKERS_SQL}) w ON w.id = o.user_id
     WHERE o.work_date BETWEEN @from AND @to
     ORDER BY o.work_date`,
    { sectionId, ...monthRange(ym) }
  )).recordset;
  const people = new Map();
  for (const r of rows) {
    const employeeNo = `${r.employee_no ?? ""}`.trim();
    if (!people.has(employeeNo)) {
      people.set(employeeNo, {
        person: {
          employeeNo,
          fullName: `${r.full_name || r.display_name || ""}`.trim(),
          department: `${r.unit ?? ""}`.trim()
        },
        entries: []
      });
    }
    people.get(employeeNo).entries.push(offsiteEntryFromRow(r));
  }
  return [...people.values()].sort((a, b) => byEmployeeNo(a.person, b.person));
}

async function loadSectionWorkers(sectionId) {
  return (await query(SECTION_WORKERS_SQL, { sectionId })).recordset;
}

module.exports = {
  OT_FORM_SECTIONS,
  otUnitFor,
  otEntryFromRow,
  offsiteEntryFromRow,
  loadOtMonth,
  loadOffsiteMonth,
  loadSectionWorkers
};
