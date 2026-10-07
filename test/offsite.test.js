// Personal off-site work log (/api/offsite) and the Clocking In-Out
// Confirmation form it exports. Per user, one entry per day, upserted.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

// A throwaway signature folder so the export never reads the real one. Set
// before anything loads xlsxKit.js (the app does, via the routers).
const SIGN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rap-esign-"));
process.env.E_SIGNATURE_DIR = SIGN_DIR;
const { createApp, closePool, fixtureContext } = require("./helpers/setup");
const { buildOffsiteWorkbook, formDate } = require("../src/services/offsiteExport");

const ctx = fixtureContext("OFFSITE");

let app;

before(async () => {
  app = createApp();
  await ctx.createFixture();
});

after(async () => {
  await ctx.cleanupFixture();
  await closePool();
  fs.rmSync(SIGN_DIR, { recursive: true, force: true });
});

describe("personal off-site log", () => {
  it("adds, replaces and deletes one day's off-site work", async () => {
    const s = await ctx.login(app, "requester");
    const put = await s.put("/api/offsite/2026-10-05")
      .send({ startTime: "08:30", endTime: "17:10", place: "TMT Gateway", reason: "Install" });
    assert.equal(put.status, 200);
    await s.put("/api/offsite/2026-10-05").send({ startTime: "09:00", endTime: "16:00", place: "ESIE", reason: "Visit" });
    const list = await s.get("/api/offsite?from=2026-10-01&to=2026-10-31");
    assert.equal(list.status, 200);
    assert.deepEqual({ ...list.body.entries[0] },
      { date: "2026-10-05", startTime: "09:00", endTime: "16:00", place: "ESIE", reason: "Visit" });
    assert.equal((await s.del("/api/offsite/2026-10-05")).status, 200);
    assert.equal((await s.get("/api/offsite?from=2026-10-01&to=2026-10-31")).body.entries.length, 0);
  });

  it("rejects bad input (remarks are required) and keeps each person's days to themselves", async () => {
    const a = await ctx.login(app, "approver1");
    const b = await ctx.login(app, "approver2");
    assert.equal((await a.put("/api/offsite/2026-02-30").send({ startTime: "08:30", endTime: "17:10" })).status, 400);
    assert.equal((await a.put("/api/offsite/2026-10-07").send({ startTime: "08:30", endTime: "08:30", reason: "x" })).status, 400);
    assert.equal((await a.put("/api/offsite/2026-10-07").send({ startTime: "08:30", endTime: "17:10", reason: "  " })).status, 400);
    await a.put("/api/offsite/2026-11-02").send({ startTime: "08:30", endTime: "17:10", place: "Mine", reason: "x" });
    assert.equal((await b.get("/api/offsite?from=2026-11-01&to=2026-11-30")).body.entries.length, 0);
  });

  it("exports the caller's month as the form, and refuses an empty month", async () => {
    const s = await ctx.login(app, "member");
    assert.equal((await s.get("/api/offsite/export?month=2026-12")).status, 422);
    await s.put("/api/offsite/2026-12-03").send({ startTime: "08:30", endTime: "17:10", place: "Site A", reason: "Install" });
    const res = await s.get("/api/offsite/export?month=2026-12").buffer(true)
      .parse((r, cb) => { const chunks = []; r.on("data", c => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    assert.equal(res.status, 200);
    const sheet = new AdmZip(res.body).readAsText("xl/worksheets/sheet1.xml");
    assert.match(sheet, /<c r="B10"[^>]*><is><t[^>]*>03-Dec-26<\/t>/);
    assert.match(sheet, /<c r="F10"[^>]*><is><t[^>]*>Site A<\/t>/);
  });
});

describe("off-site form", () => {
  const sheetOf = buffer => new AdmZip(buffer).readAsText("xl/worksheets/sheet1.xml");
  const textAt = (xml, ref) => (xml.match(new RegExp(`<c r="${ref}"[^>]*>(?:<is><t[^>]*>([^<]*)</t></is>)?`)) || [])[1];
  const numAt = (xml, ref) => (xml.match(new RegExp(`<c r="${ref}"[^>]*><v>([^<]*)</v>`)) || [])[1];
  const person = { employeeNo: "1650574", fullName: "Sirawit Kaewchoo", department: "Automation" };
  const day = (d, place = "TMT", reason = "") =>
    ({ date: `2026-10-${String(d).padStart(2, "0")}`, startTime: "08:30", endTime: "17:10", place, reason });

  it("writes dates as DD-MMM-YY", () => {
    assert.equal(formDate("2026-10-14"), "14-Oct-26");
    assert.equal(formDate("2027-01-02"), "02-Jan-27");
  });

  it("fills the header and one line per day, in date order", () => {
    const xml = sheetOf(buildOffsiteWorkbook({
      person, entries: [day(9, "B site", "late"), day(2, "A site")], signature: null, exportedBy: "T"
    }));
    assert.equal(numAt(xml, "C5"), "1650574");
    assert.equal(textAt(xml, "F5"), "Sirawit Kaewchoo");
    assert.equal(textAt(xml, "L5"), "Automation");
    assert.equal(textAt(xml, "B10"), "02-Oct-26");
    assert.equal(textAt(xml, "F10"), "A site");
    assert.equal(textAt(xml, "H10"), "08:30");
    assert.equal(textAt(xml, "I10"), "17:10");
    assert.equal(textAt(xml, "B11"), "09-Oct-26");
    assert.equal(textAt(xml, "N11"), "late");
    assert.equal(textAt(xml, "B12"), undefined); // the rest stay blank
  });

  it("adds lines past the fifteenth and moves the rest of the form down", () => {
    const buffer = buildOffsiteWorkbook({
      person, entries: Array.from({ length: 18 }, (_, i) => day(i + 1)), signature: null, exportedBy: "T"
    });
    const xml = sheetOf(buffer);
    assert.equal(numAt(xml, "A27"), "18");
    assert.equal(textAt(xml, "B27"), "18-Oct-26");
    assert.ok(xml.includes('<mergeCell ref="B26:C26"/>'));
    assert.ok(xml.includes('<mergeCell ref="A28:N28"/>')); // the HR note, was A25:N25
    assert.match(new AdmZip(buffer).readAsText("xl/workbook.xml"), /Form!\$A\$1:\$N\$47/);
    // The signature-box pictures moved down by three rows too (zero-based 25 -> 28).
    assert.match(new AdmZip(buffer).readAsText("xl/drawings/drawing1.xml"), /<xdr:row>28<\/xdr:row>/);
  });

  it("puts the e-signature in the Employee box when asked, dated the day of export", () => {
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(100, 20);
    const buffer = buildOffsiteWorkbook({
      person, entries: [day(1)], signature: { buffer: png, ext: ".png", width: 300, height: 100 },
      exportedBy: "T", signedOn: "07/10/2026"
    });
    const zip = new AdmZip(buffer);
    const drawing = zip.readAsText("xl/drawings/drawing1.xml");
    assert.match(drawing, /name="E-Signature \d+"/);
    assert.ok(zip.getEntry("xl/media/esign_1.png"));
    // One date only — the Employee box's; the approvers date theirs by hand.
    assert.equal((drawing.match(/name="E-Sign Date \d+"/g) || []).length, 1);
    assert.match(drawing, /<a:t>07\/10\/2026<\/a:t>/);
  });

  it("leaves the date line alone when signing by hand", () => {
    const drawing = new AdmZip(buildOffsiteWorkbook({ person, entries: [day(1)], signature: null, exportedBy: "T" }))
      .readAsText("xl/drawings/drawing1.xml");
    assert.doesNotMatch(drawing, /E-Sign Date/);
  });
});
