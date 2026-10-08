const path = require("path");
const {
  httpError, openTemplate, setCell, setCellShrunk, fitPicture, addPictures, openAtTop, finishWorkbook
} = require("./xlsxKit");

// Builds one person's monthly "Clocking In-Out Confirmation" form
// (แบบฟอร์มยืนยันการมาทำงาน — กรณีลืมบันทึกเวลา หรือ ทำงานนอกสถานที่) with their
// off-site work days filled in, from the company form kept byte-identical as a
// template (see xlsxKit.js).
//
// Template layout (sheet "Form"):
//   · C5 Employee Code, F5 Name, L5 Department.
//   · rows 10–24: fifteen numbered lines — B:C date, D:E forgot-to-clock
//     (left blank), F:G place, H start, I end, J:K / L:M company in/out (left
//     blank), N remarks. Row 24 carries the table's thick bottom edge.
//   · below: HR note, the grade table and the signature boxes (pictures), the
//     notes; print area A1:N44.
const TEMPLATE = path.join(__dirname, "..", "..", "assets", "templates", "offsite-template.xlsx");
const SHEET = "xl/worksheets/sheet1.xml";
const DRAWING = { drawing: "xl/drawings/drawing1.xml", rels: "xl/drawings/_rels/drawing1.xml.rels" };
const FIRST_LINE = 10;
const LINES = 15;
const LAST_LINE = FIRST_LINE + LINES - 1; // 24
const LINE_MERGES = [["B", "C"], ["D", "E"], ["F", "G"], ["J", "K"], ["L", "M"]];
const PRINT_LAST_ROW = 44;

// The approval-box picture ("พนักงาน / Employee", Department Mgr., …) sits
// from column F + 457200 EMU, row 26 + 187743 EMU (6027420 × 1269679 EMU).
// Its boxes, measured off the picture as Excel draws it: Employee 0–1513000
// EMU across, then Department Mgr. 1513000–3015000; the signing space is the
// top ~45 %.
const SIGN_BOX = { col: 5, colOff: 457200, row0: 25, rowOff: 187743, h: 560000 };
const SIGN_BOXES = [{ x: 0, w: 1513000 }, { x: 1513000, w: 1502000 }];
const SIGN_PAD = 60000;
// The boxes' "…/…/…" date line: between the row line under the box name
// (≈ 910000 EMU down) and the picture's bottom edge (≈ 1263000). The white date
// box sits inside those lines, covering the dots but not the borders.
const SIGN_DATE = { top: 925000, h: 322000, inset: 25000 };

// Today in Thailand as DD/MM/YYYY, the way the form's date line reads.
function thaiToday() {
  return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok" });
}

// A borderless white text box with [text] centred in it — laid over the
// picture's dotted date line so the date reads cleanly.
function dateBoxAnchor({ col, colOff, row0, rowOff, cx, cy, id, text }) {
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${Math.round(colOff)}</xdr:colOff>`
    + `<xdr:row>${row0}</xdr:row><xdr:rowOff>${Math.round(rowOff)}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/>`
    + `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="E-Sign Date ${id}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></xdr:spPr>`
    + `<xdr:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/>`
    + `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>`
    + `<a:latin typeface="Calibri"/></a:rPr><a:t>${text}</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 'YYYY-MM-DD' -> 'DD-MMM-YY', e.g. 14-Oct-26.
function formDate(ymd) {
  const [y, m, d] = String(ymd).split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

// Width of columns A–N in EMU, as Excel lays the template out (measured in
// Excel, in points). Computing them from <cols> drifted by several points by
// column F, enough to push the signature boxes' date over the frame lines.
const COLUMN_POINTS = [41.4, 36.6, 36.6, 47.4, 51, 74.4, 74.4, 52.8, 52.8, 28.8, 28.8, 28.8, 28.8, 141.6];
function columnWidths() {
  return COLUMN_POINTS.map(pt => Math.round(pt * 12700));
}

function rowHeights(sheet) {
  const heights = [];
  for (const m of sheet.matchAll(/<row r="(\d+)"[^>]*? ht="([\d.]+)"/g)) {
    heights[Number(m[1]) - 1] = Math.round(Number(m[2]) * 12700);
  }
  return heights;
}

// Moves an offset that runs past its cell on into the following cells.
function normalise(index, offset, sizes, fallback) {
  while (offset > (sizes[index] ?? fallback)) {
    offset -= sizes[index] ?? fallback;
    index += 1;
  }
  return { index, offset };
}

// Make room for [count] more lines: copies of the last-but-one line go in
// before the last one (which keeps the thick bottom edge), and everything
// below — rows, merges, page break, pictures, print area — moves down.
function addLines(zip, sheet, count) {
  if (count <= 0) return sheet;
  const shiftRef = ref => ref.replace(/([A-Z]+)(\d+)/g, (all, col, row) =>
    `${col}${Number(row) >= LAST_LINE ? Number(row) + count : row}`);
  let xml = sheet.replace(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (row, r) => {
    if (Number(r) < LAST_LINE) return row;
    return row
      .replace(/^<row r="\d+"/, `<row r="${Number(r) + count}"`)
      .replace(/<c r="([A-Z]+)\d+"/g, (all, col) => `<c r="${col}${Number(r) + count}"`);
  });
  const model = sheet.match(new RegExp(`<row r="${LAST_LINE - 1}"[^>]*>[\\s\\S]*?<\\/row>`))[0];
  const added = [];
  for (let i = 0; i < count; i++) {
    const r = LAST_LINE + i;
    added.push(model
      .replace(/^<row r="\d+"/, `<row r="${r}"`)
      .replace(/<c r="([A-Z]+)\d+"/g, (all, col) => `<c r="${col}${r}"`));
  }
  xml = xml.replace(`<row r="${LAST_LINE + count}"`, `${added.join("")}<row r="${LAST_LINE + count}"`);

  xml = xml.replace(/<dimension ref="([^"]+)"\/>/, (all, ref) => `<dimension ref="${shiftRef(ref)}"/>`);
  xml = xml.replace(/<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/, (all, inner) => {
    const refs = [...inner.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map(m => shiftRef(m[1]));
    for (let i = 0; i < count; i++) {
      for (const [from, to] of LINE_MERGES) refs.push(`${from}${LAST_LINE + i}:${to}${LAST_LINE + i}`);
    }
    return `<mergeCells count="${refs.length}">${refs.map(r => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`;
  });
  xml = xml.replace(/<brk id="(\d+)"/g, (all, id) => `<brk id="${Number(id) >= LAST_LINE ? Number(id) + count : id}"`);

  const drawing = zip.readAsText(DRAWING.drawing).replace(/<xdr:row>(\d+)<\/xdr:row>/g,
    (all, row) => `<xdr:row>${Number(row) >= LAST_LINE - 1 ? Number(row) + count : row}</xdr:row>`); // zero-based
  zip.updateFile(DRAWING.drawing, Buffer.from(drawing, "utf8"));
  return xml;
}

// person: { employeeNo, fullName, department }.
// entries: their off-site days that month, [{ date:'YYYY-MM-DD', startTime,
// endTime, place, reason }] (any order). signature: image from findSignature
// to put in the Employee box, or null to leave it for signing by hand. With a
// signature the box's date line gets signedOn (DD/MM/YYYY; today in Thailand
// when not given). deptMgr: { image, signedOn } — the approving Department
// Mgr.'s signature and date for their box, or null while not yet approved.
function buildOffsiteWorkbook({ person, entries, signature, exportedBy, signedOn, deptMgr = null }) {
  if (!entries.length) throw httpError(422, "There is no off-site work to export for this month");
  const rows = [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const extra = Math.max(0, rows.length - LINES);
  const zip = openTemplate(TEMPLATE);
  let sheet = addLines(zip, zip.readAsText(SHEET), extra);

  const shrink = new Map();
  const code = `${person.employeeNo ?? ""}`.trim();
  sheet = setCell(sheet, "C5", /^\d+$/.test(code) ? Number(code) : code || null);
  sheet = setCellShrunk(zip, sheet, "F5", person.fullName || null, shrink);
  sheet = setCellShrunk(zip, sheet, "L5", person.department || null, shrink);
  rows.forEach((e, i) => {
    const r = FIRST_LINE + i;
    sheet = setCell(sheet, `A${r}`, i + 1);
    sheet = setCell(sheet, `B${r}`, formDate(e.date));
    sheet = setCellShrunk(zip, sheet, `F${r}`, e.place || null, shrink);
    sheet = setCell(sheet, `H${r}`, e.startTime);
    sheet = setCell(sheet, `I${r}`, e.endTime);
    sheet = setCellShrunk(zip, sheet, `N${r}`, e.reason || null, shrink);
  });

  // Signed boxes of the approval picture: the Employee box (0) with the
  // person's e-signature, the Department Mgr. box (1) once approved. Each is
  // dated on its own "…/…/…" line; the other approvers date theirs by hand.
  const signed = [
    signature && { box: 0, image: signature, date: signedOn || thaiToday() },
    deptMgr?.image && { box: 1, image: deptMgr.image, date: deptMgr.signedOn || thaiToday() }
  ].filter(Boolean);
  if (signed.length) {
    const cols = columnWidths();
    const heights = rowHeights(sheet);
    const place = (offset, rowOff) => {
      const x = normalise(SIGN_BOX.col, SIGN_BOX.colOff + offset, cols, 64 * 9525);
      const y = normalise(SIGN_BOX.row0 + extra, SIGN_BOX.rowOff + rowOff, heights, 14.4 * 12700);
      return { col: x.index, colOff: x.offset, row0: y.index, rowOff: y.offset };
    };
    addPictures(zip, DRAWING, signed.map(({ box, image }) => {
      const { x, w } = SIGN_BOXES[box];
      const { cx, cy } = fitPicture(image.width, image.height, w - 2 * SIGN_PAD, SIGN_BOX.h - 2 * SIGN_PAD);
      return { image, anchors: [{ ...place(x + (w - cx) / 2, (SIGN_BOX.h - cy) / 2), cx, cy }] };
    }));
    let drawing = zip.readAsText(DRAWING.drawing);
    let id = Math.max(0, ...[...drawing.matchAll(/<xdr:cNvPr id="(d+)"/g)].map(m => Number(m[1])));
    const dates = signed.map(({ box, date }) => dateBoxAnchor({
      ...place(SIGN_BOXES[box].x + SIGN_DATE.inset, SIGN_DATE.top),
      cx: Math.round(SIGN_BOXES[box].w - 2 * SIGN_DATE.inset), cy: SIGN_DATE.h, id: ++id, text: date
    }));
    drawing = drawing.replace("</xdr:wsDr>", `${dates.join("")}</xdr:wsDr>`);
    zip.updateFile(DRAWING.drawing, Buffer.from(drawing, "utf8"));
  }

  // The dates are text ("14-Oct-26", as the form wants them); stop Excel
  // flagging every one as a two-digit-year date in text.
  if (!sheet.includes("<ignoredErrors>")) {
    sheet = sheet.replace("<drawing ", `<ignoredErrors><ignoredError sqref="B${FIRST_LINE}:C${LAST_LINE + extra}" twoDigitTextYear="1"/></ignoredErrors><drawing `);
  }
  zip.updateFile(SHEET, Buffer.from(openAtTop(sheet), "utf8"));
  finishWorkbook(zip, { printArea: `$A$1:$N$${PRINT_LAST_ROW + extra}`, exportedBy });
  return zip.toBuffer();
}

module.exports = { buildOffsiteWorkbook, formDate };
