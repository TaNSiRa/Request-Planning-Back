const path = require("path");
const {
  httpError, openTemplate, setCell, setCellShrunk, fitPicture, pictureXml, addImageParts, maxShapeId,
  openAtTop, finishWorkbook
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

// The approval-box picture ("พนักงาน / Employee", Department Mgr., …;
// xl/media/image2.png, 3166 × 666 px) and its boxes in the picture's own
// pixels, measured off the image: the Employee box spans x 4–790, Department
// Mgr. 793–1580 (lines 4 px wide); the signing space is y 3–319; the
// "…/…/…" date line sits at y 580–648, inside the bottom row (477–659).
const APPROVAL_PICTURE = 'name="Picture 2"';
const PICTURE_PX = { w: 3166, h: 666 };
const SIGN_BOXES = [{ x0: 4, x1: 790 }, { x0: 793, x1: 1580 }];
const SIGN_SPACE = { y0: 3, y1: 319, pad: 30 };
// The white date box: over the dots and slashes, clear of the lines around.
const DATE_BOX = { y0: 556, y1: 655, inset: 12 };

// Today in Thailand as DD/MM/YYYY, the way the form's date line reads.
function thaiToday() {
  return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok" });
}

// A borderless white text box with [text] centred in it — laid over the
// picture's dotted date line so the date reads cleanly.
function dateBoxXml({ x, y, cx, cy, id, text }) {
  return `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="E-Sign Date ${id}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>`
    + `<xdr:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></xdr:spPr>`
    + `<xdr:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/>`
    + `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="1100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>`
    + `<a:latin typeface="Calibri"/></a:rPr><a:t>${text}</a:t></a:r></a:p></xdr:txBody></xdr:sp>`;
}

// Signs boxes of the approval picture — signed: [{ box (index into
// SIGN_BOXES), image, date }]. The signatures and their dates go into the
// picture's own anchor, grouped with it and laid out in its coordinates, so
// they stretch and move with the picture however Excel sizes the columns
// (that changes with the screen's DPI) and never drift off their boxes.
function signApprovalBox(zip, signed) {
  let drawing = zip.readAsText(DRAWING.drawing);
  const anchor = [...drawing.matchAll(/<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g)]
    .map(m => m[0]).find(a => a.includes(APPROVAL_PICTURE));
  const pic = anchor && anchor.match(/<xdr:pic>[\s\S]*<\/xdr:pic>/);
  const xfrm = pic && pic[0].match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!xfrm) throw new Error("Off-site template: approval picture not found");
  const [ox, oy, cx, cy] = xfrm.slice(1).map(Number);
  const sx = cx / PICTURE_PX.w;
  const sy = cy / PICTURE_PX.h;

  const relIds = addImageParts(zip, DRAWING.rels, signed.map(s => s.image));
  let id = maxShapeId(drawing);
  const shapes = [];
  signed.forEach(({ box, image }, i) => {
    const { x0, x1 } = SIGN_BOXES[box];
    const { pad, y0, y1 } = SIGN_SPACE;
    const size = fitPicture(image.width, image.height, (x1 - x0 - 2 * pad) * sx, (y1 - y0 - 2 * pad) * sy);
    shapes.push(pictureXml({
      id: ++id, relId: relIds[i], ...size,
      x: ox + ((x0 + x1) / 2) * sx - size.cx / 2,
      y: oy + ((y0 + y1) / 2) * sy - size.cy / 2
    }));
  });
  for (const { box, date } of signed) {
    const { x0, x1 } = SIGN_BOXES[box];
    shapes.push(dateBoxXml({
      id: ++id, text: date,
      x: ox + (x0 + DATE_BOX.inset) * sx, y: oy + DATE_BOX.y0 * sy,
      cx: (x1 - x0 - 2 * DATE_BOX.inset) * sx, cy: (DATE_BOX.y1 - DATE_BOX.y0) * sy
    }));
  }
  const group = `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="${++id}" name="Approval Boxes ${id}"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>`
    + `<xdr:grpSpPr><a:xfrm><a:off x="${ox}" y="${oy}"/><a:ext cx="${cx}" cy="${cy}"/>`
    + `<a:chOff x="${ox}" y="${oy}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></xdr:grpSpPr>`
    + `${pic[0]}${shapes.join("")}</xdr:grpSp>`;
  drawing = drawing.replace(anchor, () => anchor.replace(pic[0], () => group));
  zip.updateFile(DRAWING.drawing, Buffer.from(drawing, "utf8"));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 'YYYY-MM-DD' -> 'DD-MMM-YY', e.g. 14-Oct-26.
function formDate(ymd) {
  const [y, m, d] = String(ymd).split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
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
  if (signed.length) signApprovalBox(zip, signed);

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
