// Personal OT log (/api/ot) and the Over Time Request export it feeds.
// The log is per-user and NOT section-scoped: one entry per day, upserted.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

// A throwaway signature folder so the export test never reads the real one.
// Set before anything loads otExport.js (the app does, via the OT router).
const SIGN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rap-esign-"));
process.env.E_SIGNATURE_DIR = SIGN_DIR;
const { createApp, closePool, fixtureContext } = require("./helpers/setup");
const { buildOtWorkbook } = require("../src/services/otExport");

const ctx = fixtureContext("OTLOG");

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

describe("personal OT log", () => {
  it("adds, replaces and deletes one day's OT with the duration worked out", async () => {
    const s = await ctx.login(app, "requester");
    const put = await s.put("/api/ot/2026-10-05").send({ startTime: "17:30", endTime: "20:15", reason: "PLC fix" });
    assert.equal(put.status, 200);
    assert.equal(put.body.entry.minutes, 165);
    assert.equal(put.body.entry.signMode, "SELF"); // default: sign by hand

    // Same day again replaces rather than duplicating.
    await s.put("/api/ot/2026-10-05").send({ startTime: "18:00", endTime: "19:00", reason: "Retest", signMode: "ESIGN" });
    const list = await s.get("/api/ot?from=2026-10-01&to=2026-10-31");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries.length, 1);
    assert.deepEqual(
      { ...list.body.entries[0] },
      {
        date: "2026-10-05", startTime: "18:00", endTime: "19:00", reason: "Retest", signMode: "ESIGN",
        otType: "NORMAL", holiday: false, minutes: 60
      }
    );

    const del = await s.del("/api/ot/2026-10-05");
    assert.equal(del.status, 200);
    const after = await s.get("/api/ot?from=2026-10-01&to=2026-10-31");
    assert.equal(after.body.entries.length, 0);
  });

  it("runs past midnight when the end is before the start", async () => {
    const s = await ctx.login(app, "member");
    const res = await s.put("/api/ot/2026-10-06").send({ startTime: "22:00", endTime: "01:30", reason: "Night shutdown" });
    assert.equal(res.body.entry.minutes, 210);
  });

  it("takes breaks off a normal OT, not a special one, and counts holidays in half hours", async () => {
    const s = await ctx.login(app, "coapprover");
    // Sat 10 Oct 2026 — known as a holiday from the weekday alone.
    const sat = await s.put("/api/ot/2026-10-10").send({ startTime: "08:31", endTime: "13:00", reason: "Install" });
    assert.equal(sat.body.entry.holiday, true);
    assert.equal(sat.body.entry.minutes, 180); // 09:00-13:00 less 10:00-10:10 and 12:00-12:50
    const special = await s.put("/api/ot/2026-10-10")
      .send({ startTime: "08:31", endTime: "13:00", reason: "Install", otType: "SPECIAL" });
    assert.equal(special.body.entry.minutes, 240); // 09:00-13:00, no break off
    // A weekday the calendar marked as a company holiday.
    const hol = await s.put("/api/ot/2026-10-13").send({ startTime: "08:30", endTime: "11:00", reason: "x", holiday: true });
    assert.equal(hol.body.entry.minutes, 140);
  });

  it("rejects bad input", async () => {
    const s = await ctx.login(app, "requester");
    assert.equal((await s.put("/api/ot/2026-02-30").send({ startTime: "17:00", endTime: "18:00", reason: "x" })).status, 400);
    assert.equal((await s.put("/api/ot/2026-10-07").send({ startTime: "17:00", endTime: "17:00", reason: "x" })).status, 400);
    assert.equal((await s.put("/api/ot/2026-10-07").send({ startTime: "25:00", endTime: "18:00", reason: "x" })).status, 400);
    assert.equal((await s.put("/api/ot/2026-10-07").send({ startTime: "17:00", endTime: "18:00", reason: "  " })).status, 400);
    assert.equal((await s.get("/api/ot?from=2026-10&to=2026-10-31")).status, 400);
  });

  it("keeps each person's OT to themselves", async () => {
    const a = await ctx.login(app, "approver1");
    const b = await ctx.login(app, "approver2");
    await a.put("/api/ot/2026-11-02").send({ startTime: "17:30", endTime: "19:30", reason: "Mine" });
    const theirs = await b.get("/api/ot?from=2026-11-01&to=2026-11-30");
    assert.equal(theirs.body.entries.length, 0);
  });
});

describe("OT form export", () => {
  const sheetOf = buffer => new AdmZip(buffer).readAsText("xl/worksheets/sheet1.xml");
  const textAt = (xml, ref) => (xml.match(new RegExp(`<c r="${ref}"[^>]*>(?:<is><t[^>]*>([^<]*)</t></is>)?`)) || [])[1];
  const numAt = (xml, ref) => (xml.match(new RegExp(`<c r="${ref}"[^>]*><v>([^<]*)</v>`)) || [])[1];
  // Day forms are 14 rows from row 16; the six employee rows are form start + 8 … 13.
  const rowOf = (block, person) => 16 + 14 * block + 8 + person;

  it("is only offered to sections that have a form", async () => {
    const s = await ctx.login(app, "requester");
    assert.equal((await s.get("/api/ot/export.xlsx?month=2026-10")).status, 403);
    assert.equal((await s.get("/api/ot/export-people?month=2026-10")).status, 403);
  });

  // The form's roster, in print order (the route sorts by employee number).
  const ROSTER = [
    { employeeNo: "151447", fullName: "Trimate Ritthep", unit: "Automation", phone: "085-4882733" },
    { employeeNo: "1600159", fullName: "Harichai Suksathan", unit: "Automation", phone: "0948714197" },
    { employeeNo: "1650574", fullName: "Sirawit Kaewchoo", unit: "Automation", phone: "0909465991" },
    { employeeNo: "1660619", fullName: "Teera Thanukaeo", unit: "Automation", phone: "" }
  ];
  const ot = (employeeNo, date, startTime, endTime, reason, signMode = "SELF") =>
    ({ employeeNo, date, startTime, endTime, reason, signMode });

  it("prints only the days with OT, each listing the whole roster with that day's OT filled in", () => {
    const { buffer, days, missingSignatures } = buildOtWorkbook({
      year: 2026, month: 2, exportedBy: "Test", people: ROSTER,
      entries: [
        ot("1650574", "2026-02-03", "17:40", "20:00", "แก้ไขโปรแกรม"),
        ot("151447", "2026-02-03", "17:40", "19:00", "Install"),
        ot("1660619", "2026-02-21", "08:30", "17:10", "Sat work"),
        ot("999", "2026-02-10", "08:30", "17:10", "Not on the roster")
      ]
    });
    assert.deepEqual(days, [3, 21]); // 10 Feb belongs to nobody on the roster
    assert.deepEqual(missingSignatures, []);
    const xml = sheetOf(buffer);
    // Form 0 = 3 Feb: all four people listed, in roster order.
    assert.equal(numAt(xml, `A${rowOf(0, 0)}`), "1");
    assert.equal(numAt(xml, `C${rowOf(0, 0)}`), "151447");
    assert.equal(textAt(xml, `D${rowOf(0, 0)}`), "Trimate Ritthep");
    assert.equal(textAt(xml, `F${rowOf(0, 0)}`), "Automation");
    assert.equal(textAt(xml, `H${rowOf(0, 0)}`), "19:00");
    assert.equal(textAt(xml, `N${rowOf(0, 0)}`), "085-4882733");
    // Harichai is listed with no OT that day.
    assert.equal(numAt(xml, `A${rowOf(0, 1)}`), "2");
    assert.equal(textAt(xml, `D${rowOf(0, 1)}`), "Harichai Suksathan");
    assert.equal(textAt(xml, `G${rowOf(0, 1)}`), undefined);
    assert.equal(textAt(xml, `G${rowOf(0, 2)}`), "17:40");
    assert.equal(textAt(xml, `I${rowOf(0, 2)}`), "แก้ไขโปรแกรม");
    assert.equal(textAt(xml, `D${rowOf(0, 3)}`), "Teera Thanukaeo");
    // Rows past the roster stay blank; Chief / Manager / bus route are never filled.
    assert.equal(textAt(xml, `D${rowOf(0, 4)}`), undefined);
    assert.equal(textAt(xml, `M${rowOf(0, 0)}`), undefined);
    // Form 1 = 21 Feb: the same roster, with Teera's OT.
    assert.equal(textAt(xml, `D${rowOf(1, 0)}`), "Trimate Ritthep");
    assert.equal(textAt(xml, `G${rowOf(1, 0)}`), undefined);
    assert.equal(textAt(xml, `I${rowOf(1, 3)}`), "Sat work");
    // Two forms only — nothing after row 16 + 2·14 − 1.
    assert.ok(xml.includes(`<row r="43"`));
    assert.ok(!xml.includes(`<row r="44"`));
    assert.match(new AdmZip(buffer).readAsText("xl/workbook.xml"), /\$A\$16:\$N\$43/);
    const dates = new AdmZip(buffer).readAsText("xl/worksheets/sheet2.xml");
    assert.match(dates, /<c r="B2"[^>]*><v>46056<\/v>/); // 2026-02-03
    assert.match(dates, /<c r="B3"[^>]*><v>46074<\/v>/); // 2026-02-21
  });

  it("continues a roster longer than six on a second form for the same date", () => {
    const people = Array.from({ length: 8 }, (_, i) =>
      ({ employeeNo: `${100 + i}`, fullName: `P${i}`, unit: "Automation", phone: "" }));
    const { buffer, days } = buildOtWorkbook({
      year: 2026, month: 10, exportedBy: "T", people,
      entries: [ot("107", "2026-10-09", "17:40", "19:00", "x")]
    });
    assert.deepEqual(days, [9]);
    const xml = sheetOf(buffer);
    assert.equal(numAt(xml, `C${rowOf(1, 1)}`), "107");
    assert.equal(numAt(xml, `A${rowOf(1, 1)}`), "8"); // numbering carries on
    assert.equal(textAt(xml, `I${rowOf(1, 1)}`), "x");
    const dates = new AdmZip(buffer).readAsText("xl/worksheets/sheet2.xml");
    assert.match(dates, /<c r="B3"[^>]*><v>46304<\/v>/); // 2026-10-09 again
  });

  it("places each person's e-signature image, and reports the ones missing", () => {
    const entries = [
      ot("1660619", "2026-10-01", "17:40", "19:00", "x", "ESIGN"),
      ot("1600159", "2026-10-01", "17:40", "19:00", "y", "ESIGN")
    ];
    // Smallest valid PNG header is enough: only the IHDR size is read.
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(300, 16);
    png.writeUInt32BE(100, 20);
    fs.writeFileSync(path.join(SIGN_DIR, "1660619.png"), png);
    const { buffer, missingSignatures } = buildOtWorkbook({ year: 2026, month: 10, exportedBy: "T", people: ROSTER, entries });
    assert.deepEqual(missingSignatures, ["1600159"]);
    const zip = new AdmZip(buffer);
    assert.equal((zip.readAsText("xl/drawings/drawing1.xml").match(/name="E-Signature \d+"/g) || []).length, 1);
    assert.ok(zip.getEntries().some(e => e.entryName === "xl/media/esign_1.png"));
  });

  it("refuses a month with no OT on the form", () => {
    assert.throws(
      () => buildOtWorkbook({
        year: 2026, month: 10, exportedBy: "T", people: ROSTER,
        entries: [ot("999", "2026-10-01", "17:40", "19:00", "not on the roster")]
      }),
      err => err.status === 422
    );
  });
});
