const AdmZip = require("adm-zip");
const { buildOtWorkbook } = require("./otExport");
const { buildOffsiteWorkbook } = require("./offsiteExport");
const { findSignature } = require("./xlsxKit");

// The Excel files of one form submission, rebuilt from the snapshot it was sent
// with plus whichever approvals it has so far — what the approvers download,
// what the mails carry, and (once approved) the signed result.
//
// snapshot (form_submissions.snapshot_json):
//   { month: 'YYYY-MM', sentOn: 'DD/MM/YYYY', esign: [employeeNo…], sentBy: name,
//     ot: { people, entries } }                     — kind 'OT'
//     offsite: [{ person, entries }]                 — kind 'OFFSITE'
// approvals: { CHIEF, MANAGER, DEPT_MGR } → { employeeNo, decidedOn: 'DD/MM/YYYY' }
//   for each approved step (missing = not approved yet).

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function monthLabel(ym) {
  const [y, m] = `${ym}`.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const safeName = s => `${s ?? ""}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

// [{ filename, content }]
function buildSubmissionFiles(kind, snapshot, approvals = {}) {
  const [year, month] = `${snapshot.month}`.split("-").map(Number);
  const esign = new Set(snapshot.esign || []);
  const label = monthLabel(snapshot.month);
  const signatureOf = step => (approvals[step] ? findSignature(approvals[step].employeeNo) : null);

  if (kind === "OT") {
    const { buffer } = buildOtWorkbook({
      year,
      month,
      exportedBy: snapshot.sentBy,
      people: snapshot.ot.people,
      entries: snapshot.ot.entries.map(e => ({ ...e, signMode: esign.has(e.employeeNo) ? "ESIGN" : "SELF" })),
      approvals: { chief: signatureOf("CHIEF"), manager: signatureOf("MANAGER") }
    });
    return [{ filename: `OT ${label}.xlsx`, content: buffer }];
  }

  const deptMgrImage = signatureOf("DEPT_MGR");
  return snapshot.offsite.map(({ person, entries }) => ({
    filename: `${safeName(`Off-site ${label} ${person.employeeNo} ${person.fullName}`)}.xlsx`,
    content: buildOffsiteWorkbook({
      person,
      entries,
      signature: esign.has(person.employeeNo) ? findSignature(person.employeeNo) : null,
      signedOn: snapshot.sentOn,
      exportedBy: snapshot.sentBy,
      deptMgr: deptMgrImage ? { image: deptMgrImage, signedOn: approvals.DEPT_MGR.decidedOn } : null
    })
  }));
}

// One download: the single workbook as it is, several zipped together.
function bundleFiles(files, zipName) {
  if (files.length === 1) return { filename: files[0].filename, content: files[0].content, zip: false };
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.filename, f.content);
  return { filename: `${safeName(zipName)}.zip`, content: zip.toBuffer(), zip: true };
}

module.exports = { buildSubmissionFiles, bundleFiles, monthLabel };
