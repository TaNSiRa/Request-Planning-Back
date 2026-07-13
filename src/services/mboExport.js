const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// Builds the Thai Parkerizing "Performance Appraisal (MBO)" workbook from the
// real company form kept as a byte-identical, already-blank template. Only the
// cells that carry the appraisee's data are patched directly in the sheet XML,
// so every merge, border, font, hidden helper sheet and formula of the original
// file survives untouched.
const TEMPLATE = path.join(__dirname, "..", "..", "assets", "templates", "mbo-template.xlsx");
// Sheet entries inside the xlsx zip (workbook.xml: rId1=New_6 Factors Form,
// rId3=New_MBO Form). Only these two are filled in; the "How to fill" guide
// sheets keep their generic sample text.
const MBO_SHEET = "xl/worksheets/sheet3.xml";
const FACTORS_SHEET = "xl/worksheets/sheet1.xml";
// "Self-Assessment (appraisee name)" column headers on each of the two sheets.
const MBO_SELF_CELLS = ["Q29", "AK29", "Q80", "AK80"];
const FACTORS_SELF_CELLS = ["K24", "AC24"];
// Part 1 has 7 goal slots; each slot is a block of 6 merged rows whose anchor
// rows are these.
const PART1_ROWS = [32, 38, 44, 50, 56, 62, 68];
const PART1_TOTAL_WEIGHT = 0.6; // form rule: Part 1 weights must sum to 60%
// Each goal row carries two side-by-side assessment blocks: the "1st-Half
// Assessment for Mid-Year Bonus" starting at column F and the "2nd-Half
// Assessment for Year-End Bonus" starting at column Z (+20 columns). The Goal
// title stays in the shared column B; only these per-half fields move.
const HALF_COLUMNS = {
  1: { actionPlan: "F", startEnd: "I", weight: "P", selfAssess: "Q" },
  2: { actionPlan: "Z", startEnd: "AC", weight: "AJ", selfAssess: "AK" },
};

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Replace one cell's content in a worksheet XML string while keeping its
// style index (s="…"), so the template formatting stays intact. value:
// null → blank cell, number → numeric cell, string → inline string.
function setCell(xml, ref, value) {
  const open = `<c r="${ref}"`;
  const start = xml.indexOf(open);
  if (start === -1) throw new Error(`MBO template cell ${ref} not found`);
  const tagEnd = xml.indexOf(">", start);
  const selfClosing = xml[tagEnd - 1] === "/";
  const end = selfClosing ? tagEnd + 1 : xml.indexOf("</c>", tagEnd) + 4;
  const openTag = xml.slice(start, tagEnd + 1);
  const styleMatch = openTag.match(/ s="\d+"/);
  const sAttr = styleMatch ? styleMatch[0] : "";
  let cell;
  if (value === null || value === undefined || value === "") {
    cell = `<c r="${ref}"${sAttr}/>`;
  } else if (typeof value === "number") {
    cell = `<c r="${ref}"${sAttr}><v>${value}</v></c>`;
  } else {
    cell = `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }
  return xml.slice(0, start) + cell + xml.slice(end);
}

function monthLabel(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}

// "Aug 25-Feb 26" — start/end months of the approver-selected period.
function periodLabel(start, end) {
  const from = monthLabel(start);
  const to = monthLabel(end);
  if (from && to) return `${from}-${to}`;
  return from || to || null;
}

// "MKT/AUTO" — the user's org department over their org section.
function divisionLabel(department, section) {
  return [department, section].filter(Boolean).join("/") || null;
}

// Read once and always open the zip from that Buffer: an AdmZip opened by path
// can flush its edited entries back to the source file, which would slowly
// erode the pristine template across exports.
let templateBytes;
function templateZip() {
  if (!templateBytes) templateBytes = fs.readFileSync(TEMPLATE);
  return new AdmZip(Buffer.from(templateBytes));
}

// Name / Code / Location / Division and the "Self-Assessment (…)" headers,
// laid out identically on both visible sheets apart from the cell refs.
function fillIdentity(xml, { fullName, employeeCell, branch, division, nameCell, selfCells, locationCell }) {
  let out = setCell(xml, nameCell, fullName || null);
  out = setCell(out, "J4", employeeCell);
  out = setCell(out, locationCell, branch || null);
  out = setCell(out, "L7", division);
  for (const ref of selfCells) {
    out = setCell(out, ref, `Self-Assessment\n(${fullName || ""})`);
  }
  return out;
}

// requests: [{ title, planned_start, planned_end, todos: [title, …] }, …]
// (KPI-flagged, already ordered; at most PART1_ROWS.length entries are used).
// half: 1 → fill the Mid-Year (1st-half) assessment columns, 2 → the Year-End
// (2nd-half) columns.
function buildMboWorkbook({ fullName, employeeNo, branch, department, section, requests, half }) {
  const zip = templateZip();
  const goals = requests.slice(0, PART1_ROWS.length);
  const division = divisionLabel(department, section);
  const cols = HALF_COLUMNS[half] || HALF_COLUMNS[1];

  // Equal weight per KPI goal summing to exactly 60% (last slot absorbs the
  // rounding remainder). Computed in 0.01% units to dodge float noise.
  const n = goals.length;
  const totalUnits = PART1_TOTAL_WEIGHT * 10000;
  const baseUnits = n ? Math.floor(totalUnits / n) : 0;
  const baseWeight = baseUnits / 10000;
  const lastWeight = n ? (totalUnits - baseUnits * (n - 1)) / 10000 : 0;

  const employeeCell = employeeNo == null || employeeNo === ""
    ? null
    : (/^\d+$/.test(String(employeeNo)) ? Number(employeeNo) : String(employeeNo));
  const identity = { fullName, employeeCell, branch, division };

  // Not filled in: position, grade, dates, appraiser names and the appraisal
  // period — the template leaves them blank for the appraisee to complete. The
  // grade cells are formulas driven by hidden cell AT1 and stay as-is so the
  // grade lookups keep working.
  let mbo = fillIdentity(zip.readAsText(MBO_SHEET), {
    ...identity, nameCell: "B4", locationCell: "C7", selfCells: MBO_SELF_CELLS
  });

  goals.forEach((req, i) => {
    const row = PART1_ROWS[i];
    const actionPlan = req.todos.length
      ? req.todos.map((t, idx) => `${idx + 1}.${t}`).join("\n")
      : null;
    mbo = setCell(mbo, `B${row}`, req.title); // Goal (shared column)
    mbo = setCell(mbo, `${cols.actionPlan}${row}`, actionPlan); // Action Plan
    mbo = setCell(mbo, `${cols.startEnd}${row}`, periodLabel(req.planned_start, req.planned_end)); // Start-End
    mbo = setCell(mbo, `${cols.weight}${row}`, i === n - 1 ? lastWeight : baseWeight); // Weight
    mbo = setCell(mbo, `${cols.selfAssess}${row}`, 5); // Self-Assessment score
  });
  zip.updateFile(MBO_SHEET, Buffer.from(mbo, "utf8"));

  // The 6 Factors sheet shares the workbook and repeats the same identity block.
  const factors = fillIdentity(zip.readAsText(FACTORS_SHEET), {
    ...identity, nameCell: "B4", locationCell: "B7", selfCells: FACTORS_SELF_CELLS
  });
  zip.updateFile(FACTORS_SHEET, Buffer.from(factors, "utf8"));

  // Sub/grand-total formulas depend on the cells we changed; force Excel to
  // recalculate on open instead of showing the template's cached values. The
  // absPath block records the template author's local folder — drop it.
  const workbook = zip.readAsText("xl/workbook.xml")
    .replace("<calcPr", '<calcPr fullCalcOnLoad="1"')
    .replace(/<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>/, "");
  zip.updateFile("xl/workbook.xml", Buffer.from(workbook, "utf8"));

  const core = zip.readAsText("docProps/core.xml")
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${xmlEscape(fullName)}</cp:lastModifiedBy>`);
  zip.updateFile("docProps/core.xml", Buffer.from(core, "utf8"));

  return zip.toBuffer();
}

module.exports = { buildMboWorkbook };
