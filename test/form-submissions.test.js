// Monthly OT / off-site form submissions (/api/form-submissions): who may send,
// the approval chain (Chief → Manager for OT, Department Mgr. for off-site, any
// candidate of a step may act), one person approving both OT steps at once,
// reject with a reason, the mails it queues and the signed forms it produces.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const SIGN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rap-esign-"));
process.env.E_SIGNATURE_DIR = SIGN_DIR;
const { createApp, closePool, fixtureContext, query } = require("./helpers/setup");
const { OT_FORM_SECTIONS } = require("../src/services/monthForms");

const ctx = fixtureContext("FORMS");

let app;
let fixture;
let sectionCode;
const code = name => `FRM${["requester", "approver1", "approver2", "member", "coapprover"].indexOf(name) + 1}`;

// A minimal PNG header — the forms only read its size.
function writeSignature(employeeNo) {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(100, 20);
  fs.writeFileSync(path.join(SIGN_DIR, `${employeeNo}.png`), png);
}

async function outbox(type) {
  return (await query(
    `SELECT to_email, mail_type FROM email_outbox WHERE section_id=@sid AND mail_type=@type ORDER BY id`,
    { sid: fixture.sectionId, type }
  )).recordset;
}

before(async () => {
  app = createApp();
  fixture = await ctx.createFixture();
  sectionCode = (await query("SELECT code FROM request_sections WHERE id=@id", { id: fixture.sectionId })).recordset[0].code;
  // Give the test section an OT form (its users' department is the section code).
  OT_FORM_SECTIONS[sectionCode] = sectionCode;
  const position = (await query(
    "SELECT TOP 1 id FROM positions WHERE sort_order > 40 AND LOWER(name) <> 'trainee' ORDER BY sort_order"
  )).recordset[0];
  for (const [name, id] of Object.entries(fixture.users)) {
    await query("UPDATE users SET employee_no=@no, position_id=@pos, full_name=@full WHERE id=@id",
      { no: code(name), pos: position.id, full: `Test ${name}`, id });
    writeSignature(code(name));
  }
  const { approver1, approver2, coapprover, member } = fixture.users;
  await query(
    `INSERT INTO app_settings (section_id, setting_key, setting_value, value_type, is_public, description)
     VALUES (@sid, 'forms.approvers', @value, 'json', 0, 'test')`,
    {
      sid: fixture.sectionId,
      value: JSON.stringify({
        otChief: [approver1, coapprover], otManager: [approver2, coapprover],
        offsiteDeptMgr: [approver1], custodians: [member],
        sendEnabled: true
      })
    }
  );
});

after(async () => {
  delete OT_FORM_SECTIONS[sectionCode];
  await ctx.cleanupFixture();
  await closePool();
  fs.rmSync(SIGN_DIR, { recursive: true, force: true });
});

describe("form submissions", () => {
  let otId;
  let offsiteId;

  it("only lets admins, section admins and document custodians send", async () => {
    const requester = await ctx.login(app, "requester");
    const settings = await requester.get("/api/form-submissions/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.body.canSubmit, false);
    assert.equal(settings.body.hasOtForm, true);
    assert.equal((await requester.get("/api/form-submissions/preview?month=2026-11")).status, 403);
    assert.equal((await requester.post("/api/form-submissions/submit").send({ month: "2026-11", kinds: ["OT"] })).status, 403);
    // Only a section admin edits the approvers.
    assert.equal((await requester.put("/api/form-submissions/settings").send({ otChief: [] })).status, 403);
    const member = await ctx.login(app, "member");
    assert.equal((await member.get("/api/form-submissions/settings")).body.canSubmit, true);
  });

  it("hides the Send button and refuses sending while the section has it turned off", async () => {
    const setSend = on => query(
      `UPDATE app_settings SET setting_value = JSON_MODIFY(setting_value, '$.sendEnabled', CAST(@on AS bit))
       WHERE section_id = @sid AND setting_key = 'forms.approvers'`,
      { sid: fixture.sectionId, on: on ? 1 : 0 }
    );
    const member = await ctx.login(app, "member");
    // Never set: off, like every section until its admin turns it on.
    await query(
      `UPDATE app_settings SET setting_value = JSON_MODIFY(setting_value, '$.sendEnabled', NULL)
       WHERE section_id = @sid AND setting_key = 'forms.approvers'`,
      { sid: fixture.sectionId }
    );
    const unset = await member.get("/api/form-submissions/settings");
    assert.equal(unset.body.sendEnabled, false);
    assert.equal(unset.body.canSubmit, false);
    await setSend(false);
    try {
      const settings = await member.get("/api/form-submissions/settings");
      assert.equal(settings.body.sendEnabled, false);
      assert.equal(settings.body.canSubmit, false);
      const preview = await member.get("/api/form-submissions/preview?month=2026-11");
      assert.equal(preview.status, 403);
      assert.match(preview.body.message, /turned off/);
      assert.equal((await member.post("/api/form-submissions/submit").send({ month: "2026-11", kinds: ["OT"] })).status, 403);
      // The approvers stay set while it is off.
      assert.equal(settings.body.custodians.length, 1);
    } finally {
      await setSend(true);
    }
    const back = await member.get("/api/form-submissions/settings");
    assert.equal(back.body.sendEnabled, true);
    assert.equal(back.body.canSubmit, true);
  });

  it("flags the section for its form approvers, so they reach the inbox", async () => {
    const flag = async name => {
      const s = await ctx.login(app, name);
      const res = await s.get("/api/auth/sections");
      return res.body.data.find(x => x.id === fixture.sectionId)?.isFormApprover;
    };
    assert.equal(await flag("approver1"), true); // Chief + Department Mgr.
    assert.equal(await flag("approver2"), true); // Manager
    assert.equal(await flag("member"), false); // only a document custodian
  });

  it("previews the month and sends both forms, mailing the first approvers", async () => {
    const requester = await ctx.login(app, "requester");
    const approver2 = await ctx.login(app, "approver2");
    await requester.put("/api/ot/2026-11-03").send({ startTime: "17:40", endTime: "20:40", reason: "PLC" });
    await requester.put("/api/offsite/2026-11-04").send({ startTime: "08:30", endTime: "17:10", place: "Site", reason: "Install" });
    await approver2.put("/api/offsite/2026-11-05").send({ startTime: "08:30", endTime: "17:10", place: "Site", reason: "Visit" });

    const member = await ctx.login(app, "member");
    const preview = await member.get("/api/form-submissions/preview?month=2026-11");
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.approversReady, { OT: true, OFFSITE: true });
    const people = Object.fromEntries(preview.body.people.map(p => [p.employeeNo, p]));
    assert.equal(people[code("requester")].otDays, 1);
    assert.equal(people[code("requester")].offsiteDays, 1);
    assert.equal(people[code("approver2")].offsiteDays, 1);

    const sent = await member.post("/api/form-submissions/submit")
      .send({ month: "2026-11", kinds: ["OT", "OFFSITE"], esign: [code("requester")] });
    assert.equal(sent.status, 201);
    otId = sent.body.submissions.find(s => s.kind === "OT").id;
    offsiteId = sent.body.submissions.find(s => s.kind === "OFFSITE").id;

    // Sending the same kind again while it waits is refused.
    const again = await member.post("/api/form-submissions/submit").send({ month: "2026-11", kinds: ["OT"] });
    assert.equal(again.status, 409);

    const mails = await outbox("FORM_APPROVE");
    assert.equal(mails.length, 2);
    // OT goes to both Chief/Asst.Mgr. candidates, cc the rest of the section.
    assert.match(mails[0].to_email, /approver1@/);
    assert.match(mails[0].to_email, /coapprover@/);
    assert.match(mails[0].to_email, /cc: .*requester@/);
    // The Manager is not asked until the Chief has approved (only cc'd, as
    // everyone in the section is).
    assert.doesNotMatch(mails[0].to_email.split(" | ")[0], /approver2@/);
  });

  it("shows each step only to its approvers and keeps the order", async () => {
    const approver1 = await ctx.login(app, "approver1");
    const approver2 = await ctx.login(app, "approver2");
    const mine = (await approver1.get("/api/form-submissions/pending")).body.data;
    assert.deepEqual(mine.map(i => `${i.kind}:${i.role}`).sort(), ["OFFSITE:DEPT_MGR", "OT:CHIEF"]);
    assert.ok(mine.every(i => i.canAct));
    assert.equal((await approver2.get("/api/form-submissions/pending")).body.data.length, 0);
    // Manager can't jump the queue.
    const chiefStep = mine.find(i => i.kind === "OT").stepId;
    assert.equal((await approver2.post(`/api/form-submissions/steps/${chiefStep}/approve`)).status, 403);
  });

  it("signs the OT form step by step and mails the signed result", async () => {
    const approver1 = await ctx.login(app, "approver1");
    const approver2 = await ctx.login(app, "approver2");
    const chiefStep = (await approver1.get("/api/form-submissions/pending")).body.data.find(i => i.kind === "OT").stepId;
    assert.equal((await approver1.post(`/api/form-submissions/steps/${chiefStep}/approve`)).status, 200);
    // Deciding twice is refused.
    assert.equal((await approver1.post(`/api/form-submissions/steps/${chiefStep}/approve`)).status, 409);

    const managerItem = (await approver2.get("/api/form-submissions/pending")).body.data.find(i => i.kind === "OT");
    assert.equal(managerItem.role, "MANAGER");
    const done = await approver2.post(`/api/form-submissions/steps/${managerItem.stepId}/approve`);
    assert.equal(done.body.status, "APPROVED");
    assert.equal((await outbox("FORM_APPROVED")).length, 1);

    // The signed form: requester's e-signature (J) and both approvers (K, L)
    // on the one OT row.
    const res = await approver2.get(`/api/form-submissions/${otId}/download`).buffer(true)
      .parse((r, cb) => { const c = []; r.on("data", d => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(res.status, 200);
    const drawing = new AdmZip(res.body).readAsText("xl/drawings/drawing1.xml");
    const cols = [...drawing.matchAll(/name="E-Signature \d+"/g)].length;
    assert.equal(cols, 3);
    for (const col of [9, 10, 11]) assert.match(drawing, new RegExp(`<xdr:from><xdr:col>${col}</xdr:col>`));
  });

  it("rejects off-site work with a reason, then lets it be sent again", async () => {
    const approver1 = await ctx.login(app, "approver1");
    const step = (await approver1.get("/api/form-submissions/pending")).body.data.find(i => i.kind === "OFFSITE").stepId;
    assert.equal((await approver1.post(`/api/form-submissions/steps/${step}/reject`).send({ comment: " " })).status, 400);
    const res = await approver1.post(`/api/form-submissions/steps/${step}/reject`).send({ comment: "Wrong place" });
    assert.equal(res.body.status, "REJECTED");
    assert.equal((await outbox("FORM_REJECTED")).length, 1);

    const member = await ctx.login(app, "member");
    const subs = (await member.get("/api/form-submissions?month=2026-11")).body.submissions;
    assert.equal(subs.find(s => s.id === offsiteId).rejectReason, "Wrong place");
    const again = await member.post("/api/form-submissions/submit").send({ month: "2026-11", kinds: ["OFFSITE"] });
    assert.equal(again.status, 201);
  });

  it("signs off-site forms in the Department Mgr. box, one file per person", async () => {
    const approver1 = await ctx.login(app, "approver1");
    const item = (await approver1.get("/api/form-submissions/pending")).body.data.find(i => i.kind === "OFFSITE");
    assert.equal(item.people, 2);
    await approver1.post(`/api/form-submissions/steps/${item.stepId}/approve`);
    const res = await approver1.get(`/api/form-submissions/${item.submissionId}/download`).buffer(true)
      .parse((r, cb) => { const c = []; r.on("data", d => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(res.headers["content-type"], "application/zip");
    // The same forms for the inbox's in-app preview, as data URLs.
    const preview = await approver1.get(`/api/form-submissions/${item.submissionId}/files`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.files.length, 2);
    assert.match(preview.body.files[0].fileName, /^Off-site November 2026 /);
    assert.ok(preview.body.files[0].dataUrl.startsWith("data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDB"));
    const files = new AdmZip(res.body).getEntries();
    assert.equal(files.length, 2);
    const form = new AdmZip(files[0].getData()).readAsText("xl/drawings/drawing1.xml");
    // Department Mgr. signature + its date (no employee e-sign was chosen this time).
    assert.equal([...form.matchAll(/name="E-Signature \d+"/g)].length, 1);
    assert.equal([...form.matchAll(/name="E-Sign Date \d+"/g)].length, 1);
  });

  it("puts the month's approver signatures into a plain export too", async () => {
    const requester = await ctx.login(app, "requester");
    const drawingOf = async url => {
      const res = await requester.get(url).buffer(true)
        .parse((r, cb) => { const c = []; r.on("data", d => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
      assert.equal(res.status, 200);
      const zip = new AdmZip(res.body);
      return zip.getEntry("xl/drawings/drawing1.xml") ? zip.readAsText("xl/drawings/drawing1.xml") : "";
    };
    const count = (xml, name) => [...xml.matchAll(new RegExp(`name="${name} \\d+"`, "g"))].length;

    // November's OT form is approved: Chief/Asst.Mgr. and Manager sign (K, L),
    // the employee signs by hand this time.
    const ot = await drawingOf("/api/ot/export.xlsx?month=2026-11&esign=");
    assert.equal(count(ot, "E-Signature"), 2);
    for (const col of [10, 11]) assert.match(ot, new RegExp(`<xdr:from><xdr:col>${col}</xdr:col>`));

    // November's off-site form (sent again, then approved): the Department
    // Mgr.'s signature and date, beside the employee's own.
    const offsite = await drawingOf("/api/offsite/export?month=2026-11&sign=ESIGN");
    assert.equal(count(offsite, "E-Signature"), 2);
    assert.equal(count(offsite, "E-Sign Date"), 2);

    // Another month carries no one's approval.
    await requester.put("/api/offsite/2026-10-06").send({ startTime: "08:30", endTime: "17:10", place: "Site", reason: "Install" });
    const october = await drawingOf("/api/offsite/export?month=2026-10&sign=ESIGN");
    assert.equal(count(october, "E-Signature"), 1);
  });

  it("lets someone who is both OT approvers sign once for both", async () => {
    const requester = await ctx.login(app, "requester");
    await requester.put("/api/ot/2026-12-01").send({ startTime: "17:40", endTime: "20:40", reason: "PLC" });
    const member = await ctx.login(app, "member");
    assert.equal((await member.post("/api/form-submissions/submit").send({ month: "2026-12", kinds: ["OT"] })).status, 201);
    const co = await ctx.login(app, "coapprover");
    const item = (await co.get("/api/form-submissions/pending")).body.data.find(i => i.month === "2026-12");
    const res = await co.post(`/api/form-submissions/steps/${item.stepId}/approve`);
    assert.equal(res.body.status, "APPROVED");
    const steps = (await query(
      `SELECT role, status, approver_user_id FROM form_submission_steps
       WHERE submission_id=@id ORDER BY step_no`, { id: item.submissionId }
    )).recordset;
    assert.deepEqual(steps.map(s => [s.role, s.status, s.approver_user_id]), [
      ["CHIEF", "APPROVED", fixture.users.coapprover],
      ["MANAGER", "APPROVED", fixture.users.coapprover]
    ]);
  });

  it("refuses to send without approvers set or without data", async () => {
    const member = await ctx.login(app, "member");
    assert.equal((await member.post("/api/form-submissions/submit").send({ month: "2027-01", kinds: ["OFFSITE"] })).status, 422);
    await query("UPDATE app_settings SET setting_value=@v WHERE section_id=@sid AND setting_key='forms.approvers'", {
      sid: fixture.sectionId,
      v: JSON.stringify({ otChief: [], otManager: [], offsiteDeptMgr: [], custodians: [fixture.users.member], sendEnabled: true })
    });
    const requester = await ctx.login(app, "requester");
    await requester.put("/api/offsite/2027-01-05").send({ startTime: "08:30", endTime: "17:10", reason: "x" });
    const res = await member.post("/api/form-submissions/submit").send({ month: "2027-01", kinds: ["OFFSITE"] });
    assert.equal(res.status, 422);
    assert.match(res.body.message, /Department Mgr\./);
  });
});
