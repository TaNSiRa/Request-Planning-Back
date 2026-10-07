const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { env } = require("../config/env");

// Shared tools for filling the company's Excel forms in place (OT request,
// off-site work confirmation). A form is kept byte-identical as a template and
// only the cells that carry data are patched in the sheet XML, so every merge,
// border, font and picture of the original survives — see mboExport.js for the
// first form done this way.

// Where the e-signature images live: one file per person, named by employee
// number (e.g. 1650574.png). Override with E_SIGNATURE_DIR.
const E_SIGNATURE_DIR = process.env.E_SIGNATURE_DIR
  || path.join(env.attachmentRoot || "C:\\AutomationProject\\RAP", "Automation Request", "E-Signature");
const SIGNATURE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function ensureSignatureDir() {
  try {
    fs.mkdirSync(E_SIGNATURE_DIR, { recursive: true });
  } catch (err) {
    console.error(`[forms] could not create ${E_SIGNATURE_DIR}:`, err.message);
  }
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

// The person's signature image { buffer, ext, width, height }, or null.
// Matched on the file name without its extension, case-insensitively, so
// "1650574.PNG" works too.
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

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// An error whose message is meant for the user (see errorHandler.js).
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = true;
  return err;
}

// Template bytes read once per file; the zip is always opened from a copy so
// the file on disk can never be written back to (see mboExport.js).
const templateCache = new Map();
function openTemplate(file) {
  if (!templateCache.has(file)) templateCache.set(file, fs.readFileSync(file));
  return new AdmZip(Buffer.from(templateCache.get(file)));
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
  if (!cell) throw new Error(`Template cell ${ref} not found`);
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
// the right value even before Excel recalculates.
function setFormulaCache(xml, ref, value) {
  const cell = findCell(xml, ref);
  if (!cell) return xml;
  const body = xml.slice(cell.start, cell.end).replace(/<v>[^<]*<\/v>/, `<v>${value}</v>`);
  return xml.slice(0, cell.start) + body + xml.slice(cell.end);
}

function styleOf(xml, ref) {
  const cell = findCell(xml, ref);
  const m = cell && cell.openTag.match(/ s="(\d+)"/);
  return m ? Number(m[1]) : 0;
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

// Same as setCell, but the cell takes style [styleIndex] instead of its own.
function setCellStyled(xml, ref, value, styleIndex) {
  const cell = findCell(xml, ref);
  if (!cell) throw new Error(`Template cell ${ref} not found`);
  const restyled = `<c r="${ref}" s="${styleIndex}"/>`;
  return setCell(xml.slice(0, cell.start) + restyled + xml.slice(cell.end), ref, value);
}

// setCellStyled with a shrink-to-fit copy of the cell's own style.
function setCellShrunk(zip, xml, ref, value, cache) {
  return setCellStyled(xml, ref, value, shrinkToFitStyle(zip, styleOf(xml, ref), cache));
}

// Excel's day serial for a calendar date (1900 date system).
function excelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

// Picture size { cx, cy } in EMU that fits [width]×[height] px inside the
// maxW×maxH EMU box, keeping its shape.
function fitPicture(width, height, maxW, maxH) {
  const scale = Math.min(maxW / width, maxH / height);
  return { cx: Math.round(width * scale), cy: Math.round(height * scale) };
}

function pictureAnchor({ col, colOff, row0, rowOff, cx, cy, id, relId }) {
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${Math.max(0, Math.round(colOff))}</xdr:colOff>`
    + `<xdr:row>${row0}</xdr:row><xdr:rowOff>${Math.max(0, Math.round(rowOff))}</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${cx}" cy="${cy}"/>`
    + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="E-Signature ${id}"/>`
    + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/>`
    + `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
}

// Adds pictures to a sheet's drawing part. groups: [{ image, anchors }] — one
// media file per image ({ buffer, ext, width, height }), placed at each anchor
// ({ col, colOff, row0, rowOff, cx, cy }, EMU, zero-based col/row).
function addPictures(zip, { drawing: drawingPath, rels: relsPath }, groups) {
  groups = groups.filter(g => g.image && g.anchors.length);
  if (!groups.length) return;
  let types = zip.readAsText("[Content_Types].xml");
  // A drawing that holds only text boxes may have no rels part yet.
  let rels = zip.getEntry(relsPath)
    ? zip.readAsText(relsPath)
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let drawing = zip.readAsText(drawingPath);
  let id = Math.max(0, ...[...drawing.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(m => Number(m[1])));
  const xml = [];
  groups.forEach(({ image, anchors }, i) => {
    const media = `esign_${i + 1}${image.ext}`;
    zip.addFile(`xl/media/${media}`, image.buffer);
    const ext = image.ext.slice(1);
    if (!new RegExp(`<Default Extension="${ext}"`, "i").test(types)) {
      types = types.replace("<Default ",
        `<Default Extension="${ext}" ContentType="${SIGNATURE_TYPES[image.ext]}"/><Default `);
    }
    const relId = `rIdEsign${i + 1}`;
    rels = rels.replace("</Relationships>",
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media}"/></Relationships>`);
    for (const a of anchors) xml.push(pictureAnchor({ ...a, id: ++id, relId }));
  });
  zip.updateFile("[Content_Types].xml", Buffer.from(types, "utf8"));
  zip.addFile(relsPath, Buffer.from(rels, "utf8")); // adds or replaces
  drawing = drawing.replace("</xdr:wsDr>", `${xml.join("")}</xdr:wsDr>`);
  zip.updateFile(drawingPath, Buffer.from(drawing, "utf8"));
}

// Open at the top of the sheet with A1 selected, whatever view the template
// was last saved with.
function openAtTop(sheet) {
  return sheet
    .replace(/(<sheetView\b[^>]*?) topLeftCell="[A-Z]+\d+"/, "$1")
    .replace(/<selection\b[^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>');
}

// Workbook-level tidy-up every export does: drop calcChain (Excel rebuilds it),
// recalculate on open, set the print area, forget the template author's folder
// and stamp who exported it.
function finishWorkbook(zip, { printArea, exportedBy }) {
  if (zip.getEntry("xl/calcChain.xml")) {
    zip.deleteFile("xl/calcChain.xml");
    zip.updateFile("[Content_Types].xml", Buffer.from(zip.readAsText("[Content_Types].xml")
      .replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ""), "utf8"));
    zip.updateFile("xl/_rels/workbook.xml.rels", Buffer.from(zip.readAsText("xl/_rels/workbook.xml.rels")
      .replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, ""), "utf8"));
  }
  let workbook = zip.readAsText("xl/workbook.xml")
    .replace(/<calcPr(?![^>]*fullCalcOnLoad)/, '<calcPr fullCalcOnLoad="1"')
    .replace(/<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>/, "");
  if (printArea) {
    // A function, not a string: the area itself is full of "$" patterns.
    workbook = workbook.replace(/(<definedName name="_xlnm\.Print_Area"[^>]*>[^!<]*!)[^<]*/,
      (all, head) => `${head}${printArea}`);
  }
  zip.updateFile("xl/workbook.xml", Buffer.from(workbook, "utf8"));
  const core = zip.readAsText("docProps/core.xml")
    .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${xmlEscape(exportedBy || "")}</cp:lastModifiedBy>`);
  zip.updateFile("docProps/core.xml", Buffer.from(core, "utf8"));
}

module.exports = {
  E_SIGNATURE_DIR,
  ensureSignatureDir,
  findSignature,
  imageSize,
  xmlEscape,
  httpError,
  openTemplate,
  findCell,
  setCell,
  setFormulaCache,
  styleOf,
  shrinkToFitStyle,
  setCellStyled,
  setCellShrunk,
  excelSerial,
  fitPicture,
  addPictures,
  openAtTop,
  finishWorkbook
};
