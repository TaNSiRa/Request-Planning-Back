const path = require("path");
const {
  findSignature, httpError, openTemplate, setCell, setFormulaCache, setCellShrunk,
  excelSerial, fitPicture, addPictures, openAtTop, finishWorkbook
} = require("./xlsxKit");

// Builds the monthly "Over Time Request" workbook (แบบฟอร์มการขออนุมัติการทำงาน
// ล่วงเวลา) from the section's real form, kept byte-identical as a template
// (see xlsxKit.js).
//
// Template layout (Sheet1):
//   · rows 1–15: an unprinted master copy of one day — left untouched.
//   · rows 16–449 (the print area): 31 identical, blank day forms of 14 rows.
//     Form i starts at row 16 + 14·i; its date cell L(start+2) is the formula
//     =Sheet3!B(i+2), and its six employee rows are start+8 … start+13 (only
//     the M/D column is pre-filled).
// Sheet3 (xl/worksheets/sheet2.xml) holds the 31 date serials in B2:B32.
const TEMPLATE = path.join(__dirname, "..", "..", "assets", "templates", "ot-template.xlsx");
const FORM_SHEET = "xl/worksheets/sheet1.xml";
const DATES_SHEET = "xl/worksheets/sheet2.xml";
const DRAWING = { drawing: "xl/drawings/drawing1.xml", rels: "xl/drawings/_rels/drawing1.xml.rels" };
const FIRST_BLOCK_ROW = 16;
const BLOCK_ROWS = 14;
const TEMPLATE_DAYS = 31;
const EMPLOYEE_ROW_OFFSETS = [8, 9, 10, 11, 12, 13];
const DATE_ROW_OFFSET = 2;

// Signature cell boxes, in EMU: column widths at the workbook's 7 px digit —
// J (Employee) 19.14 chars ≈ 134 px, K (Chief/Asst.Mgr.) 16.43 ≈ 115 px,
// L (Manager) 14.14 ≈ 99 px — and an employee row 19.9 pt tall.
const SIGN_COLS = {
  employee: { col: 9, w: 134 * 9525 },
  chief: { col: 10, w: 115 * 9525 },
  manager: { col: 11, w: 99 * 9525 }
};
const SIGN_CELL_H = Math.round(19.9 * 12700);
const SIGN_PAD_X = 60000;
const SIGN_MAX_H = 240000; // may overhang the row a hair, like the template's own signatures

// Drop the day blocks past the last one used: their rows, merges, page
// breaks and text boxes, and pull the print area in to match.
function trimBlocks(zip, sheet, lastRow) {
  let xml = sheet.replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g,
    (row, r) => (Number(r) > lastRow ? "" : row));
  xml = xml.replace(/<dimension ref="A1:N\d+"\/>/, `<dimension ref="A1:N${lastRow}"/>`);
  xml = xml.replace(/<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/, (all, inner) => {
    const kept = [...inner.matchAll(/<mergeCell ref="[A-Z]+(\d+):[A-Z]+\d+"\/>/g)]
      .filter(m => Number(m[1]) <= lastRow).map(m => m[0]);
    return `<mergeCells count="${kept.length}">${kept.join("")}</mergeCells>`;
  });
  xml = xml.replace(/<rowBreaks[^>]*>([\s\S]*?)<\/rowBreaks>/, (all, inner) => {
    const kept = [...inner.matchAll(/<brk id="(\d+)"[^>]*\/>/g)]
      .filter(m => Number(m[1]) < lastRow).map(m => m[0]);
    return kept.length
      ? `<rowBreaks count="${kept.length}" manualBreakCount="${kept.length}">${kept.join("")}</rowBreaks>`
      : "";
  });

  const drawing = zip.readAsText(DRAWING.drawing).replace(
    /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g,
    anchor => {
      const row = anchor.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      return row && Number(row[1]) >= lastRow ? "" : anchor; // zero-based row
    });
  zip.updateFile(DRAWING.drawing, Buffer.from(drawing, "utf8"));
  return xml;
}

// A signature centred in [box] (one of SIGN_COLS) on [row].
function signatureAnchor(image, row, box = SIGN_COLS.employee) {
  const { cx, cy } = fitPicture(image.width, image.height, box.w - 2 * SIGN_PAD_X, SIGN_MAX_H);
  return {
    col: box.col, colOff: (box.w - cx) / 2,
    row0: row - 1, rowOff: (SIGN_CELL_H - cy) / 2,
    cx, cy
  };
}

// Day forms: one per day on which anyone on the roster has OT, each listing the
// whole roster (in the order given) with that day's OT filled in where there
// is some. A roster longer than a form's rows continues on another form with
// the same date, numbering on from the first.
function planBlocks(people, entries) {
  const codes = new Set(people.map(p => p.employeeNo));
  const days = [...new Set(entries.filter(e => codes.has(e.employeeNo))
    .map(e => Number(String(e.date).slice(8, 10))))].sort((a, b) => a - b);
  const per = EMPLOYEE_ROW_OFFSETS.length;
  const blocks = [];
  for (const day of days) {
    for (let i = 0; i < people.length; i += per) {
      blocks.push({ day, first: i, people: people.slice(i, i + per) });
    }
  }
  return blocks;
}

// year/month: the month to print.
// people: the form's roster, in print order — [{ employeeNo, fullName, unit, phone }].
// entries: their OT that month — [{ employeeNo, date:'YYYY-MM-DD', startTime,
// endTime, reason, signMode:'SELF'|'ESIGN' }]; anyone not on the roster is ignored.
// Every printed day form lists the whole roster: No., Code, Name, Section
// (unit) and phone, plus In, Out, Reason and the Employee signature (image or
// blank) for whoever had OT that day. Bus route stays blank; Chief/Asst.Mgr.
// and Manager are blank too unless approvals carries their signature images
// ({ chief, manager }), which then go on every row that has OT.
// Returns { buffer, days, missingSignatures }: missingSignatures = employee
// numbers that asked for an e-signature with no image on file (left blank).
function buildOtWorkbook({ year, month, exportedBy, people, entries, approvals = {} }) {
  const blocks = planBlocks(people, entries);
  if (!blocks.length) throw httpError(422, "There is no OT to export for this month");
  if (blocks.length > TEMPLATE_DAYS) {
    throw httpError(422, `Too many OT forms for one file (${blocks.length}, max ${TEMPLATE_DAYS})`);
  }
  const otOf = new Map(entries.map(e => [`${e.employeeNo}|${Number(String(e.date).slice(8, 10))}`, e]));
  const zip = openTemplate(TEMPLATE);
  let sheet = zip.readAsText(FORM_SHEET);
  const lastRow = FIRST_BLOCK_ROW + BLOCK_ROWS * blocks.length - 1;

  // Dates: Sheet3 feeds every block's date cell, so block i shows its day. The
  // cached copies are updated too so the file reads right before any
  // recalculation.
  let dates = zip.readAsText(DATES_SHEET);
  for (let i = 0; i < TEMPLATE_DAYS; i++) {
    const serial = i < blocks.length ? excelSerial(year, month, blocks[i].day) : null;
    dates = setCell(dates, `B${i + 2}`, serial);
    if (serial !== null) {
      sheet = setFormulaCache(sheet, `L${FIRST_BLOCK_ROW + BLOCK_ROWS * i + DATE_ROW_OFFSET}`, serial);
    }
  }
  zip.updateFile(DATES_SHEET, Buffer.from(dates, "utf8"));

  const shrinkStyles = new Map();
  const signatures = new Map(); // code -> { image, rows } (null image = none on file)
  const otRows = [];
  blocks.forEach((block, b) => {
    block.people.forEach((person, p) => {
      const row = FIRST_BLOCK_ROW + BLOCK_ROWS * b + EMPLOYEE_ROW_OFFSETS[p];
      const code = `${person.employeeNo ?? ""}`.trim();
      sheet = setCell(sheet, `A${row}`, block.first + p + 1);
      sheet = setCell(sheet, `C${row}`, /^\d+$/.test(code) ? Number(code) : code || null);
      sheet = setCellShrunk(zip, sheet, `D${row}`, person.fullName || null, shrinkStyles);
      sheet = setCellShrunk(zip, sheet, `F${row}`, person.unit || null, shrinkStyles);
      sheet = setCell(sheet, `N${row}`, `${person.phone ?? ""}`.trim() || null);
      const e = otOf.get(`${code}|${block.day}`);
      if (!e) return;
      sheet = setCell(sheet, `G${row}`, e.startTime);
      sheet = setCell(sheet, `H${row}`, e.endTime);
      sheet = setCellShrunk(zip, sheet, `I${row}`, e.reason, shrinkStyles);
      otRows.push(row);
      if (e.signMode === "ESIGN" && code) {
        if (!signatures.has(code)) signatures.set(code, { image: findSignature(code), rows: [] });
        signatures.get(code).rows.push(row);
      }
    });
  });

  if (blocks.length < TEMPLATE_DAYS) sheet = trimBlocks(zip, sheet, lastRow);
  zip.updateFile(FORM_SHEET, Buffer.from(openAtTop(sheet), "utf8"));
  const approverGroups = [["chief", approvals.chief], ["manager", approvals.manager]]
    .filter(([, image]) => image)
    .map(([role, image]) => ({ image, anchors: otRows.map(row => signatureAnchor(image, row, SIGN_COLS[role])) }));
  addPictures(zip, DRAWING, [
    ...[...signatures.values()]
      .filter(g => g.image)
      .map(g => ({ image: g.image, anchors: g.rows.map(row => signatureAnchor(g.image, row)) })),
    ...approverGroups
  ]);
  finishWorkbook(zip, { printArea: `$A$16:$N$${lastRow}`, exportedBy });

  return {
    buffer: zip.toBuffer(),
    days: [...new Set(blocks.map(b => b.day))],
    missingSignatures: [...signatures].filter(([, g]) => !g.image).map(([code]) => code)
  };
}

module.exports = { buildOtWorkbook };
