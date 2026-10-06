const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { env } = require("../config/env");

// Builds the monthly "Over Time Request" workbook (แบบฟอร์มการขออนุมัติการทำงาน
// ล่วงเวลา) from the section's real form, kept byte-identical as a template —
// the same approach as mboExport.js: only the cells that carry data are patched
// in the sheet XML, so every merge, border, font and text box survives.
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
const DRAWING = "xl/drawings/drawing1.xml";
const DRAWING_RELS = "xl/drawings/_rels/drawing1.xml.rels";
const FIRST_BLOCK_ROW = 16;
const BLOCK_ROWS = 14;
const TEMPLATE_DAYS = 31;
const EMPLOYEE_ROW_OFFSETS = [8, 9, 10, 11, 12, 13];
const DATE_ROW_OFFSET = 2;

// Employee (signature) cell box, in EMU: column J is 19.14 chars wide (≈134 px
// at the workbook's 7 px digit) and an employee row is 19.9 pt tall.
const SIGN_COL = 9; // J, zero-based
const SIGN_CELL_W = 134 * 9525;
const SIGN_CELL_H = Math.round(19.9 * 12700);
const SIGN_PAD_X = 60000;
const SIGN_MAX_H = 240000; // may overhang the row a hair, like the template's own signatures

// Where the e-signature images live: one file per person, named by employee
// number (e.g. 1650574.png). Override with E_SIGNATURE_DIR.
const E_SIGNATURE_DIR = process.env.E_SIGNATURE_DIR
  || path.join(env.attachmentRoot || "C:\\AutomationProject\\RAP", "Automation Request", "E-Signature");
const SIGNATURE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function ensureSignatureDir() {
  try {
    fs.mkdirSync(E_SIGNATURE_DIR, { recursive: true });
  } catch (err) {
    console.error(`[ot] could not create ${E_SIGNATURE_DIR}:`, err.message);
  }
}

// The person's signature file, or null. Matched on the file name without its
// extension, case-insensitively, so "1650574.PNG" works too.
function findSignature(employeeNo) {
  const code = `${employeeNo ?? ""}`.trim().toLowerCase();
  if (!code) return null;
  let names;
  try {
    names = fs.readdirSync(E_SIGNATURE_DIR);
  } catch {
    return null;
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!SIGNATURE_TYPES[ext]) continue;
    if (path.basename(name, path.extname(name)).trim().toLowerCase() !== code) continue;
    const buffer = fs.readFileSync(path.join(E_SIGNATURE_DIR, name));
    const size = imageSize(buffer);
    if (!size) continue;
    return { buffer, ext: ext === ".jpeg" ? ".jpg" : ext, ...size };
  }
  return null;
}

// Pixel size from a PNG or JPEG header; null for anything else.
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Locate one cell element: { start, end, openTag } or null.
function findCell(xml, ref) {
  const start = xml.indexOf(`<c r="${ref}"`);
  if (start === -1) return null;
  const tagEnd = xml.indexOf(">", start);
  const selfClosing = xml[tagEnd - 1] === "/";
  const end = selfClosing ? tagEnd + 1 : xml.indexOf("</c>", tagEnd) + 4;
  return { start, end, openTag: xml.slice(start, tagEnd + 1) };
}

// Replace one cell's content keeping its style index. value: null → blank,
// number → numeric, string → inline string.
function setCell(xml, ref, value) {
  const cell = findCell(xml, ref);
  if (!cell) throw new Error(`OT template cell ${ref} not found`);
  const styleMatch = cell.openTag.match(/ s="\d+"/);
  const sAttr = styleMatch ? styleMatch[0] : "";
  let out;
  if (value === null || value === undefined || value === "") {
    out = `<c r="${ref}"${sAttr}/>`;
  } else if (typeof value === "number") {
    out = `<c r="${ref}"${sAttr}><v>${value}</v></c>`;
  } else {
    out = `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }
  return xml.slice(0, cell.start) + out + xml.slice(cell.end);
}

// A formula cell's cached result (the <v> next to its <f>), so the sheet shows
// the right date even before Excel recalculates.
function setFormulaCache(xml, ref, value) {
  const cell = findCell(xml, ref);
  if (!cell) return xml;
  const body = xml.slice(cell.start, cell.end).replace(/<v>[^<]*<\/v>/, `<v>${value}</v>`);
  return xml.slice(0, cell.start) + body + xml.slice(cell.end);
}

// A copy of cell style [index] that shrinks its text to fit the cell, so a long
// reason (or name) stays readable inside its column instead of spilling out.
// Returns the new style's index; one copy per source style.
function shrinkToFitStyle(zip, index, cache) {
  if (cache.has(index)) return cache.get(index);
  let styles = zip.readAsText("xl/styles.xml");
  const block = styles.match(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/);
  const xfs = block[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const source = xfs[index];
  if (!source) return index;
  let xf;
  if (/<alignment\b/.test(source)) {
    xf = source.replace(/ shrinkToFit="\d"/, "").replace("<alignment", '<alignment shrinkToFit="1"');
  } else {
    const open = source.replace(/\s*\/?>[\s\S]*$/, "").replace(/ applyAlignment="\d"/, "");
    xf = `${open} applyAlignment="1"><alignment shrinkToFit="1"/></xf>`;
  }
  const next = xfs.length;
  styles = styles.replace(block[0], `<cellXfs count="${next + 1}">${block[1]}${xf}</cellXfs>`);
  zip.updateFile("xl/styles.xml", Buffer.from(styles, "utf8"));
  cache.set(index, next);
  return next;
}

function styleOf(xml, ref) {
  const cell = findCell(xml, ref);
  const m = cell && cell.openTag.match(/ s="(\d+)"/);
  return m ? Number(m[1]) : 0;
}

// Same as setCell, but the cell takes style [styleIndex] instead of its own.
function setCellStyled(xml, ref, value, styleIndex) {
  const cell = findCell(xml, ref);
  if (!cell) throw new Error(`OT template cell ${ref} not found`);
  const restyled = `<c r="${ref}" s="${styleIndex}"/>`;
  return setCell(xml.slice(0, cell.start) + restyled + xml.slice(cell.end), ref, value);
}

// Excel's day serial for a calendar date (1900 date system).
function excelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

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

  const drawing = zip.readAsText(DRAWING).replace(
    /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g,
    anchor => {
      const row = anchor.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      return row && Number(row[1]) >= lastRow ? "" : anchor; // zero-based row
    });
  zip.updateFile(DRAWING, Buffer.from(drawing, "utf8"));
  return xml;
}

// One picture anchored in an Employee cell, scaled to fit and centred.
function signatureAnchor({ row0, id, relId, width, height }) {
  const scale = Math.min((SIGN_CELL_W - 2 * SIGN_PAD_X) / width, SIGN_MAX_H / height);
  const cx = Math.round(width * scale);
  const cy = Math.round(height * scale);
  const colOff = Math.max(0, Math.round((SIGN_CELL_W - cx) / 2));
  const rowOff = Math.max(0, Math.round((SIGN_CELL_H - cy) / 2));
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${SIGN_COL}</xdr:col><xdr:colOff>${colOff}</xdr:colOff>`
    + `<xdr:row>${row0}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/>`
    + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="E-Signature ${id}"/>`
    + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/>`
    + `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
}

// groups: [{ signature, rows }] — one picture file per person, anchored in
// each of their Employee cells.
function addSignatures(zip, groups) {
  groups = groups.filter(g => g.rows.length);
  if (!groups.length) return;
  let types = zip.readAsText("[Content_Types].xml");
  // The template's drawing holds only text boxes, so it may have no rels part yet.
  let rels = zip.getEntry(DRAWING_RELS)
    ? zip.readAsText(DRAWING_RELS)
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let drawing = zip.readAsText(DRAWING);
  let id = Math.max(0, ...[...drawing.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(m => Number(m[1])));
  const anchors = [];
  groups.forEach(({ signature, rows }, i) => {
    const media = `esign_${i + 1}${signature.ext}`;
    zip.addFile(`xl/media/${media}`, signature.buffer);
    const ext = signature.ext.slice(1);
    if (!new RegExp(`<Default Extension="${ext}"`, "i").test(types)) {
      types = types.replace("<Default ",
        `<Default Extension="${ext}" ContentType="${SIGNATURE_TYPES[signature.ext]}"/><Default `);
    }
    const relId = `rIdOtEsign${i + 1}`;
    rels = rels.replace("</Relationships>",
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media}"/></Relationships>`);
    for (const row of rows) {
      anchors.push(signatureAnchor({
        row0: row - 1, id: ++id, relId, width: signature.width, height: signature.height
      }));
    }
  });
  zip.updateFile("[Content_Types].xml", Buffer.from(types, "utf8"));
  zip.addFile(DRAWING_RELS, Buffer.from(rels, "utf8")); // adds or replaces
  drawing = drawing.replace("</xdr:wsDr>", `${anchors.join("")}</xdr:wsDr>`);
  zip.updateFile(DRAWING, Buffer.from(drawing, "utf8"));
}

// Template bytes read once; the zip is always opened from a copy so the file
// on disk can never be written back to (see mboExport.js).
let templateBytes;
function templateZip() {
  if (!templateBytes) templateBytes = fs.readFileSync(TEMPLATE);
  return new AdmZip(Buffer.from(templateBytes));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
// blank) for whoever had OT that day. Chief/Asst.Mgr., Manager and bus route
// stay blank.
// Returns { buffer, days, missingSignatures }: missingSignatures = employee
// numbers that asked for an e-signature with no image on file (left blank).
function buildOtWorkbook({ year, month, exportedBy, people, entries }) {
  const blocks = planBlocks(people, entries);
  if (!blocks.length) throw httpError(422, "There is no OT to export for this month");
  if (blocks.length > TEMPLATE_DAYS) {
    throw httpError(422, `Too many OT forms for one file (${blocks.length}, max ${TEMPLATE_DAYS})`);
  }
  const otOf = new Map(entries.map(e => [`${e.employeeNo}|${Number(String(e.date).slice(8, 10))}`, e]));
  const zip = templateZip();
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
  const shrink = (ref) => shrinkToFitStyle(zip, styleOf(sheet, ref), shrinkStyles);
  const signatures = new Map(); // code -> { signature, rows } (null signature = none on file)
  blocks.forEach((block, b) => {
    block.people.forEach((person, p) => {
      const row = FIRST_BLOCK_ROW + BLOCK_ROWS * b + EMPLOYEE_ROW_OFFSETS[p];
      const code = `${person.employeeNo ?? ""}`.trim();
      sheet = setCell(sheet, `A${row}`, block.first + p + 1);
      sheet = setCell(sheet, `C${row}`, /^\d+$/.test(code) ? Number(code) : code || null);
      sheet = setCellStyled(sheet, `D${row}`, person.fullName || null, shrink(`D${row}`));
      sheet = setCellStyled(sheet, `F${row}`, person.unit || null, shrink(`F${row}`));
      sheet = setCell(sheet, `N${row}`, `${person.phone ?? ""}`.trim() || null);
      const e = otOf.get(`${code}|${block.day}`);
      if (!e) return;
      sheet = setCell(sheet, `G${row}`, e.startTime);
      sheet = setCell(sheet, `H${row}`, e.endTime);
      sheet = setCellStyled(sheet, `I${row}`, e.reason, shrink(`I${row}`));
      if (e.signMode === "ESIGN" && code) {
        if (!signatures.has(code)) signatures.set(code, { signature: findSignature(code), rows: [] });
        signatures.get(code).rows.push(row);
      }
    });
  });

  if (blocks.length < TEMPLATE_DAYS) sheet = trimBlocks(zip, sheet, lastRow);
  // Open at the top of the sheet with A1 selected, whatever view the template
  // was last saved with (scrolled down to the last form, a cell picked there).
  sheet = sheet
    .replace(/(<sheetView\b[^>]*?) topLeftCell="[A-Z]+\d+"/, "$1")
    .replace(/<selection\b[^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>');
  zip.updateFile(FORM_SHEET, Buffer.from(sheet, "utf8"));
  addSignatures(zip, [...signatures.values()].filter(g => g.signature));

  // calcChain lists the formula cells of the removed blocks; Excel rebuilds it
  // on its own, so drop it rather than patch it.
  zip.deleteFile("xl/calcChain.xml");
  zip.updateFile("[Content_Types].xml", Buffer.from(zip.readAsText("[Content_Types].xml")
    .replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ""), "utf8"));
  zip.updateFile("xl/_rels/workbook.xml.rels", Buffer.from(zip.readAsText("xl/_rels/workbook.xml.rels")
    .replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, ""), "utf8"));

  const workbook = zip.readAsText("xl/workbook.xml")
    .replace(/\$A\$16:\$N\$\d+/, `$A$16:$N$${lastRow}`)
    .replace("<calcPr", '<calcPr fullCalcOnLoad="1"')
    .replace(/<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>/, "");
  zip.updateFile("xl/workbook.xml", Buffer.from(workbook, "utf8"));

  const core = zip.readAsText("docProps/core.xml")
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${xmlEscape(exportedBy || "")}</cp:lastModifiedBy>`);
  zip.updateFile("docProps/core.xml", Buffer.from(core, "utf8"));

  return {
    buffer: zip.toBuffer(),
    days: [...new Set(blocks.map(b => b.day))],
    missingSignatures: [...signatures].filter(([, g]) => !g.signature).map(([code]) => code)
  };
}

module.exports = { buildOtWorkbook, findSignature, ensureSignatureDir, E_SIGNATURE_DIR };
