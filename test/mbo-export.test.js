// The MBO workbook is produced by patching XML *inside* the pristine template
// zip (see src/services/mboExport.js), so the thing that breaks is never the
// numbers — it is the container. A zip library upgrade that writes a subtly
// different archive still returns a Buffer and still passes every route test,
// and the damage only shows up when a user opens the file in Excel and is told
// it is corrupt.
//
// So this locks the bytes. buildMboWorkbook is deterministic: the same inputs
// give the same archive down to the sha256, because entry timestamps come from
// the template rather than the clock.
//
// The zip is then re-read by the small central-directory parser below instead
// of by adm-zip, on purpose: adm-zip reading back its own broken output would
// happily agree with itself. Nothing here touches the database.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const zlib = require("zlib");

const { buildMboWorkbook } = require("../src/services/mboExport");

// Fixed appraisee + goals. Thai text is deliberate — the identity cells are
// written as inline UTF-8 strings, which is exactly where an encoding
// regression would surface.
const APPRAISEE = {
  fullName: "สมชาย ทดสอบระบบ",
  employeeNo: "12345",
  branch: "Rayong",
  department: "MKT",
  section: "AUTO",
  requests: [
    {
      title: "ลดของเสียในไลน์ผลิต A",
      planned_start: "2026-01-15",
      planned_end: "2026-06-30",
      todos: ["สำรวจสาเหตุ", "ปรับพารามิเตอร์", "สรุปผล"],
    },
    {
      title: "Upgrade coating line sensors",
      planned_start: "2026-02-01",
      planned_end: "2026-05-31",
      todos: ["Spec review", "Install"],
    },
    // A goal with no todos and no dates: the empty Action Plan / Start-End path.
    { title: "งานที่ไม่มี todo", planned_start: null, planned_end: null, todos: [] },
  ],
};

// Re-lock with:
//   node -e "const c=require('crypto');const{buildMboWorkbook}=require('./src/services/mboExport');..."
// and paste the new digest here — but only once the file has been opened in
// Excel and confirmed intact. A changed digest is a question, not a defect: a
// new zlib in Node, a bumped zip library, or an edited template will all move
// it legitimately. What it must never do is change silently.
const HALF1_SHA256 = "179de6a1ba2822900fa7200aabe6147e7d3b8cb48c6083e649d199e4883b0819";
const TEMPLATE_ENTRY_COUNT = 41;

// --- minimal zip reader (central directory only) -------------------------
// Enough of the format to prove the archive is navigable the way Excel will
// navigate it: find the End Of Central Directory record, walk the entries it
// points at, and inflate one by seeking to its local header.
function readZip(buf) {
  // EOCD: signature 0x06054b50, then 18 bytes; scan back over the comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "no End Of Central Directory record - not a zip");

  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < total; i += 1) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, `central directory entry ${i} is malformed`);
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    entries.set(name, { method, compressedSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  // Local header is 30 bytes + its own name/extra lengths, which may differ
  // from the central directory's.
  assert.equal(buf.readUInt32LE(entry.localOffset), 0x04034b50, "local file header is malformed");
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compressedSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

describe("MBO export: the workbook stays a workbook", () => {
  it("produces the exact same archive for the same appraisee", () => {
    const buf = buildMboWorkbook({ ...APPRAISEE, half: 1 });
    const digest = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(
      digest,
      HALF1_SHA256,
      "the exported workbook changed byte-for-byte. If a zip library, Node's zlib "
        + "or assets/templates/mbo-template.xlsx was touched, open the export in Excel, "
        + "confirm it is intact, then re-lock HALF1_SHA256.",
    );
  });

  it("is a zip Excel can walk, with every part still present", () => {
    const buf = buildMboWorkbook({ ...APPRAISEE, half: 1 });
    const entries = readZip(buf);

    assert.equal(entries.size, TEMPLATE_ENTRY_COUNT, "the template lost or gained a zip entry");
    for (const required of [
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml", // New_6 Factors Form
      "xl/worksheets/sheet3.xml", // New_MBO Form
      "docProps/core.xml",
    ]) {
      assert.ok(entries.has(required), `missing zip entry: ${required}`);
    }
  });

  it("writes the appraisee into both visible sheets, readable as UTF-8", () => {
    const buf = buildMboWorkbook({ ...APPRAISEE, half: 1 });
    const entries = readZip(buf);

    const mbo = readEntry(buf, entries.get("xl/worksheets/sheet3.xml")).toString("utf8");
    const factors = readEntry(buf, entries.get("xl/worksheets/sheet1.xml")).toString("utf8");

    assert.ok(mbo.includes(APPRAISEE.fullName), "appraisee name missing from the MBO sheet");
    assert.ok(factors.includes(APPRAISEE.fullName), "appraisee name missing from the 6 Factors sheet");
    assert.ok(mbo.includes(APPRAISEE.requests[0].title), "first KPI goal missing from the MBO sheet");
    assert.ok(mbo.includes("MKT/AUTO"), "division label missing from the MBO sheet");
  });

  it("puts the two halves in different columns", () => {
    // half 1 fills the Mid-Year block, half 2 the Year-End block 20 columns
    // over. Same inputs, so anything that ignored `half` would produce
    // identical archives.
    const first = buildMboWorkbook({ ...APPRAISEE, half: 1 });
    const second = buildMboWorkbook({ ...APPRAISEE, half: 2 });
    assert.notEqual(
      crypto.createHash("sha256").update(first).digest("hex"),
      crypto.createHash("sha256").update(second).digest("hex"),
      "half 1 and half 2 exported the same bytes - the half selection was dropped",
    );
  });
});
