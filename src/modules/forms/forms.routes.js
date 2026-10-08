const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { notify } = require("../../services/notificationService");
const { sendMail } = require("../../services/mailService");
const { buildFormSubmissionEmail } = require("../../services/emailTemplates");
const { emitSystem } = require("../../services/realtimeService");
const { isAdmin, resolveSection, requireSectionAdmin } = require("../../services/sectionService");
const { blockViewerWrites } = require("../../middleware/viewerGuard");
const { getSectionSetting } = require("../../services/settingsService");
const { findSignature } = require("../../services/xlsxKit");
const { otUnitFor, loadOtMonth, loadOffsiteMonth, loadSectionWorkers } = require("../../services/monthForms");
const { buildSubmissionFiles, bundleFiles, monthLabel } = require("../../services/formSubmissionFiles");
const { approvalsOf, thaiToday } = require("../../services/formApprovals");

// Monthly OT / off-site form submissions (/api/form-submissions).
//
// A section's admin, section admin or document custodian sends the month's
// forms from the Personal calendar: the OT form (whole section, where the
// section has one) and/or everyone's off-site forms. Each kind becomes one
// submission with its approval chain, snapshotted as sent:
//   OT       — CHIEF (Chief/Asst.Mgr.) then MANAGER
//   OFFSITE  — DEPT_MGR (Department Mgr.)
// Each step may have several candidates (section settings); any one approves.
// The approver's e-signature then goes into the forms: Chief/Asst.Mgr. and
// Manager columns of the OT form, the Department Mgr. box (dated) of each
// off-site form. Someone who is a candidate of both OT steps approves once for
// both. Mails carry the Excel files: to the approvers at each step (cc the rest
// of the section on the first), and the signed result back to the sender (cc
// the section) — or the reason, when rejected.
const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);
router.use(blockViewerWrites("approvals"));

const SETTING_KEY = "forms.approvers";
const KINDS = ["OT", "OFFSITE"];
const KIND_LABEL = { OT: "OT", OFFSITE: "ทำงานนอกสถานที่ (Off-site)" };
const ROLE_LABEL = { CHIEF: "Chief/Asst.Mgr.", MANAGER: "Manager", DEPT_MGR: "Department Mgr." };
const CHAINS = { OT: ["CHIEF", "MANAGER"], OFFSITE: ["DEPT_MGR"] };
const ROLE_SETTING = { CHIEF: "otChief", MANAGER: "otManager", DEPT_MGR: "offsiteDeptMgr" };
const EMPTY_SETTINGS = { otChief: [], otManager: [], offsiteDeptMgr: [], custodians: [] };

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Until patch_form_submissions.sql is applied the tables are missing (SQL 208).
async function formsQuery(text, params) {
  try {
    return await query(text, params);
  } catch (err) {
    if (err?.number === 208) {
      const e = new Error("Form submissions are not set up on this server yet (database patch_form_submissions.sql)");
      e.status = 503;
      e.publicMessage = true;
      throw e;
    }
    throw err;
  }
}

async function loadSettings(sectionId) {
  let parsed = {};
  try {
    parsed = JSON.parse((await getSectionSetting(SETTING_KEY, sectionId)) || "{}") || {};
  } catch {
    parsed = {};
  }
  const ids = list => [...new Set((Array.isArray(list) ? list : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  return Object.fromEntries(Object.keys(EMPTY_SETTINGS).map(k => [k, ids(parsed[k])]));
}

function canSubmit(req, settings) {
  return isAdmin(req.user) || req.sectionAccess?.isSectionAdmin === true || settings.custodians.includes(req.user.id);
}

async function usersByIds(ids) {
  if (!ids.length) return [];
  const params = Object.fromEntries(ids.map((id, i) => [`u${i}`, id]));
  return (await query(
    `SELECT id, employee_no, display_name, full_name, email FROM users
     WHERE is_active = 1 AND id IN (${ids.map((_, i) => `@u${i}`).join(",")})`,
    params
  )).recordset;
}

const nameOf = u => `${u?.full_name || u?.display_name || ""}`.trim();

// ── Settings ────────────────────────────────────────────────────────────────

// GET /api/form-submissions/settings — the section's approvers and document
// custodians (with names), and what the caller may do here.
router.get("/settings", asyncHandler(async (req, res) => {
  const settings = await loadSettings(req.section.id);
  const all = await usersByIds([...new Set(Object.values(settings).flat())]);
  const named = list => list.map(id => all.find(u => u.id === id)).filter(Boolean)
    .map(u => ({ userId: u.id, name: nameOf(u), employeeNo: u.employee_no }));
  res.json({
    ...settings,
    people: Object.fromEntries(Object.keys(EMPTY_SETTINGS).map(k => [k, named(settings[k])])),
    canSubmit: canSubmit(req, settings),
    hasOtForm: !!otUnitFor(req.section.code)
  });
}));

router.put("/settings", requireSectionAdmin, audit("EDIT", "FORM_APPROVERS", req => req.section?.id),
  asyncHandler(async (req, res) => {
    const ids = z.array(z.number().int().positive()).max(50).optional().default([]);
    const input = z.object({ otChief: ids, otManager: ids, offsiteDeptMgr: ids, custodians: ids }).parse(req.body);
    const value = JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, [...new Set(v)]])));
    await query(
      `MERGE app_settings AS target USING (SELECT @key AS setting_key, @sectionId AS section_id) AS source
       ON target.setting_key = source.setting_key AND COALESCE(target.section_id, 0) = COALESCE(source.section_id, 0)
       WHEN MATCHED THEN UPDATE SET setting_value = @value, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, value_type, is_public, description)
         VALUES (@sectionId, @key, @value, 'json', 0, 'OT / off-site form approvers and document custodians');`,
      { key: SETTING_KEY, sectionId: req.section.id, value }
    );
    emitSystem("settings.updated", { sectionId: req.section.id, key: SETTING_KEY });
    res.json({ ok: true, ...(await loadSettings(req.section.id)) });
  }));

// ── Sending ─────────────────────────────────────────────────────────────────

async function loadMonthData(req, ym) {
  const [ot, offsite] = await Promise.all([
    loadOtMonth(req.section.id, req.section.code, ym),
    loadOffsiteMonth(req.section.id, ym)
  ]);
  // Only roster people's OT goes on the form.
  if (ot) {
    const codes = new Set(ot.people.map(p => p.employeeNo));
    ot.entries = ot.entries.filter(e => codes.has(e.employeeNo));
  }
  return { ot, offsite };
}

async function submissionsOf(sectionId, ym) {
  const subs = (await formsQuery(
    `SELECT s.id, s.kind, s.status, s.submitted_at, s.decided_at, s.reject_reason,
            u.full_name AS sender_name, u.display_name AS sender_display
     FROM form_submissions s JOIN users u ON u.id = s.submitted_by
     WHERE s.section_id = @sectionId AND s.form_month = @ym
     ORDER BY s.submitted_at DESC`,
    { sectionId, ym }
  )).recordset;
  return subs.map(s => ({
    id: s.id,
    kind: s.kind,
    status: s.status,
    submittedAt: s.submitted_at,
    decidedAt: s.decided_at,
    rejectReason: s.reject_reason,
    sentBy: `${s.sender_name || s.sender_display || ""}`.trim()
  }));
}

// GET /api/form-submissions/preview?month=YYYY-MM — what a send would carry:
// everyone with OT / off-site that month (for the e-signature choices), whether
// each kind has its approvers set, and the month's earlier submissions.
router.get("/preview", asyncHandler(async (req, res) => {
  const ym = monthSchema.parse(req.query.month);
  const settings = await loadSettings(req.section.id);
  if (!canSubmit(req, settings)) throw httpError(403, "Only admins, section admins and document custodians can send the forms");
  const { ot, offsite } = await loadMonthData(req, ym);
  const people = new Map();
  const touch = (employeeNo, fullName) => {
    if (!people.has(employeeNo)) {
      people.set(employeeNo, { employeeNo, fullName, otDays: 0, offsiteDays: 0, esignAvailable: !!findSignature(employeeNo) });
    }
    return people.get(employeeNo);
  };
  if (ot) {
    for (const e of ot.entries) {
      touch(e.employeeNo, ot.people.find(p => p.employeeNo === e.employeeNo)?.fullName || "").otDays++;
    }
  }
  for (const { person, entries } of offsite) touch(person.employeeNo, person.fullName).offsiteDays += entries.length;
  res.json({
    hasOtForm: !!ot,
    people: [...people.values()].sort((a, b) => a.employeeNo.localeCompare(b.employeeNo, undefined, { numeric: true })),
    approversReady: {
      OT: settings.otChief.length > 0 && settings.otManager.length > 0,
      OFFSITE: settings.offsiteDeptMgr.length > 0
    },
    submissions: await submissionsOf(req.section.id, ym)
  });
}));

router.get("/", asyncHandler(async (req, res) => {
  res.json({ submissions: await submissionsOf(req.section.id, monthSchema.parse(req.query.month)) });
}));

// Who gets the mails: [{ id, email, name }] of the section's workers.
async function sectionMailList(sectionId) {
  return (await loadSectionWorkers(sectionId))
    .filter(u => u.email)
    .map(u => ({ id: u.id, email: u.email, name: nameOf(u) }));
}

async function stepCandidates(stepId) {
  return (await query(
    `SELECT u.id, u.email, u.full_name, u.display_name, u.employee_no
     FROM form_submission_step_candidates c JOIN users u ON u.id = c.user_id
     WHERE c.step_id = @stepId AND u.is_active = 1`,
    { stepId }
  )).recordset;
}

async function loadSubmission(id) {
  const sub = (await formsQuery(
    `SELECT s.*, u.full_name AS sender_name, u.display_name AS sender_display, u.email AS sender_email,
            r.name AS section_name, r.code AS section_code
     FROM form_submissions s
     JOIN users u ON u.id = s.submitted_by
     JOIN request_sections r ON r.id = s.section_id
     WHERE s.id = @id`,
    { id }
  )).recordset[0];
  if (!sub) return null;
  const steps = (await query(
    `SELECT st.*, u.employee_no AS approver_employee_no, u.full_name AS approver_name, u.display_name AS approver_display
     FROM form_submission_steps st LEFT JOIN users u ON u.id = st.approver_user_id
     WHERE st.submission_id = @id ORDER BY st.step_no`,
    { id }
  )).recordset;
  return { ...sub, snapshot: JSON.parse(sub.snapshot_json), steps, senderName: `${sub.sender_name || sub.sender_display || ""}`.trim() };
}

function filesOf(sub) {
  return buildSubmissionFiles(sub.kind, sub.snapshot, approvalsOf(sub.steps));
}

// The mail to a step's candidates; cc (the rest of the section) on the first.
async function mailStep(sub, step, { ccSection }) {
  const candidates = await stepCandidates(step.id);
  const files = filesOf(sub);
  const kindLabel = KIND_LABEL[sub.kind];
  const month = monthLabel(sub.form_month);
  for (const c of candidates) {
    await notify({
      userId: c.id,
      sectionId: sub.section_id,
      type: "APPROVAL",
      title: `${kindLabel} ${month} needs approval`,
      body: `${ROLE_LABEL[step.role]} · sent by ${sub.senderName}`
    });
  }
  const to = candidates.filter(c => c.email).map(c => c.email);
  if (!to.length) return;
  const cc = ccSection
    ? (await sectionMailList(sub.section_id)).filter(u => !candidates.some(c => c.id === u.id)).map(u => u.email)
    : [];
  const mail = buildFormSubmissionEmail({
    stage: "APPROVE",
    kindLabel,
    monthLabel: month,
    sectionName: sub.section_name,
    sectionCode: sub.section_code,
    senderName: sub.senderName,
    greetingName: candidates.length === 1 ? nameOf(candidates[0]) : null,
    roleLabel: ROLE_LABEL[step.role],
    fileCount: files.length
  });
  await sendMail({
    to, cc, attachments: files, subject: mail.subject, html: mail.html, text: mail.text,
    type: mail.type, sectionId: sub.section_id
  });
}

// POST /api/form-submissions/submit { month, kinds: ['OT','OFFSITE'], esign: [employeeNo…] }
router.post("/submit", audit("SUBMIT", "FORM_SUBMISSION", req => req.section?.id), asyncHandler(async (req, res) => {
  const input = z.object({
    month: monthSchema,
    kinds: z.array(z.enum(KINDS)).min(1),
    esign: z.array(z.string().trim().max(50)).max(500).optional().default([])
  }).parse(req.body);
  const settings = await loadSettings(req.section.id);
  if (!canSubmit(req, settings)) throw httpError(403, "Only admins, section admins and document custodians can send the forms");
  const kinds = [...new Set(input.kinds)];
  const { ot, offsite } = await loadMonthData(req, input.month);

  // Check everything before creating anything, so a send is all or nothing.
  const pending = (await submissionsOf(req.section.id, input.month)).filter(s => s.status === "PENDING");
  for (const kind of kinds) {
    if (pending.some(s => s.kind === kind)) {
      throw httpError(409, `${KIND_LABEL[kind]} of ${monthLabel(input.month)} is already waiting for approval`);
    }
    if (kind === "OT" && !ot) throw httpError(422, "There is no OT form for this section");
    if (kind === "OT" && !ot.entries.length) throw httpError(422, `There is no OT in ${monthLabel(input.month)} to send`);
    if (kind === "OFFSITE" && !offsite.length) throw httpError(422, `There is no off-site work in ${monthLabel(input.month)} to send`);
    for (const role of CHAINS[kind]) {
      if (!settings[ROLE_SETTING[role]].length) {
        throw httpError(422, `Set the ${ROLE_LABEL[role]} approver for ${KIND_LABEL[kind]} in Settings first`);
      }
    }
  }

  const me = (await usersByIds([req.user.id]))[0];
  const created = [];
  for (const kind of kinds) {
    const snapshot = {
      month: input.month,
      sentOn: thaiToday(),
      sentBy: nameOf(me),
      esign: input.esign,
      ...(kind === "OT" ? { ot } : { offsite })
    };
    const subId = (await formsQuery(
      `INSERT INTO form_submissions (section_id, kind, form_month, status, snapshot_json, submitted_by)
       OUTPUT INSERTED.id VALUES (@sectionId, @kind, @ym, 'PENDING', @snapshot, @userId)`,
      { sectionId: req.section.id, kind, ym: input.month, snapshot: JSON.stringify(snapshot), userId: req.user.id }
    )).recordset[0].id;
    for (const [i, role] of CHAINS[kind].entries()) {
      const stepId = (await query(
        `INSERT INTO form_submission_steps (submission_id, step_no, role, status)
         OUTPUT INSERTED.id VALUES (@subId, @no, @role, @status)`,
        { subId, no: i + 1, role, status: i === 0 ? "PENDING" : "WAITING" }
      )).recordset[0].id;
      for (const userId of settings[ROLE_SETTING[role]]) {
        await query(`INSERT INTO form_submission_step_candidates (step_id, user_id) VALUES (@stepId, @userId)`,
          { stepId, userId });
      }
    }
    created.push(subId);
  }

  for (const id of created) {
    const sub = await loadSubmission(id);
    await mailStep(sub, sub.steps[0], { ccSection: true });
  }
  emitSystem("forms.updated", { sectionId: req.section.id });
  res.status(201).json({ ok: true, submissions: await submissionsOf(req.section.id, input.month) });
}));

// ── Approving ───────────────────────────────────────────────────────────────

// GET /api/form-submissions/pending — steps waiting for the caller: those it
// is an approver of (a global admin may act on any, so sees them all).
router.get("/pending", asyncHandler(async (req, res) => {
  const rows = (await formsQuery(
    `SELECT st.id AS step_id, st.role, st.step_no, s.id AS submission_id, s.kind, s.form_month, s.submitted_at,
            s.snapshot_json, u.full_name AS sender_name, u.display_name AS sender_display,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM form_submission_step_candidates c
                                   WHERE c.step_id = st.id AND c.user_id = @userId)
                      THEN 1 ELSE 0 END AS BIT) AS is_candidate
     FROM form_submission_steps st
     JOIN form_submissions s ON s.id = st.submission_id
     JOIN users u ON u.id = s.submitted_by
     WHERE s.section_id = @sectionId AND s.status = 'PENDING' AND st.status = 'PENDING'
     ORDER BY s.submitted_at`,
    { sectionId: req.section.id, userId: req.user.id }
  )).recordset;
  const admin = isAdmin(req.user);
  // Only what the caller can sign: a step's approvers (and a global admin,
  // who may act on any). Others — section admins included — don't see it.
  const data = rows.filter(r => r.is_candidate || admin).map(r => {
    const snap = JSON.parse(r.snapshot_json);
    const people = r.kind === "OT"
      ? new Set(snap.ot.entries.map(e => e.employeeNo)).size
      : snap.offsite.length;
    const entries = r.kind === "OT"
      ? snap.ot.entries.length
      : snap.offsite.reduce((n, p) => n + p.entries.length, 0);
    return {
      stepId: r.step_id,
      submissionId: r.submission_id,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind],
      month: r.form_month,
      monthLabel: monthLabel(r.form_month),
      role: r.role,
      roleLabel: ROLE_LABEL[r.role],
      stepNo: r.step_no,
      steps: CHAINS[r.kind].length,
      sentBy: `${r.sender_name || r.sender_display || ""}`.trim(),
      submittedAt: r.submitted_at,
      people,
      entries,
      canAct: !!r.is_candidate || admin
    };
  });
  res.json({ data });
}));

// GET /api/form-submissions/:id/download — the forms as they stand (signed
// so far): one .xlsx, or a .zip of several.
router.get("/:id/download", asyncHandler(async (req, res) => {
  const sub = await loadSubmission(Number(req.params.id));
  if (!sub || sub.section_id !== req.section.id) throw httpError(404, "Submission not found");
  const bundle = bundleFiles(filesOf(sub), `${sub.kind === "OT" ? "OT" : "Off-site"} ${monthLabel(sub.form_month)}`);
  res.header("Content-Type", bundle.zip
    ? "application/zip"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.attachment(bundle.filename).send(bundle.content);
}));

// GET /api/form-submissions/:id/files — the forms as they stand, as data URLs
// for the inbox's in-app Excel preview (each also downloadable from there).
router.get("/:id/files", asyncHandler(async (req, res) => {
  const sub = await loadSubmission(Number(req.params.id));
  if (!sub || sub.section_id !== req.section.id) throw httpError(404, "Submission not found");
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  res.json({
    files: filesOf(sub).map(f => ({
      fileName: f.filename,
      contentType: type,
      dataUrl: `data:${type};base64,${f.content.toString("base64")}`
    }))
  });
}));

// The step the caller may act on, or an error.
async function actionableStep(req) {
  const stepId = Number(req.params.stepId);
  const step = (await formsQuery(
    `SELECT st.*, s.section_id, s.status AS submission_status FROM form_submission_steps st
     JOIN form_submissions s ON s.id = st.submission_id WHERE st.id = @stepId`,
    { stepId }
  )).recordset[0];
  if (!step || step.section_id !== req.section.id) throw httpError(404, "Approval step not found");
  if (step.status !== "PENDING" || step.submission_status !== "PENDING") {
    throw httpError(409, "This step has already been decided");
  }
  const candidate = (await stepCandidates(step.id)).some(c => c.id === req.user.id);
  if (!candidate && !isAdmin(req.user)) throw httpError(403, "You are not an approver of this step");
  return step;
}

// Mail the sender (cc the section) the signed forms, or the rejection.
async function mailResult(sub, { rejected = false, approverName, reason } = {}) {
  await notify({
    userId: sub.submitted_by,
    sectionId: sub.section_id,
    type: "FORM",
    title: `${KIND_LABEL[sub.kind]} ${monthLabel(sub.form_month)} ${rejected ? "was rejected" : "is approved"}`,
    body: rejected ? `${approverName}: ${reason}` : "The signed forms are attached to the e-mail"
  });
  const files = rejected ? [] : filesOf(sub);
  const section = await sectionMailList(sub.section_id);
  const to = sub.sender_email ? [sub.sender_email] : [];
  const cc = rejected ? [] : section.filter(u => u.id !== sub.submitted_by).map(u => u.email);
  if (!to.length && !cc.length) return;
  const mail = buildFormSubmissionEmail({
    stage: rejected ? "REJECTED" : "APPROVED",
    kindLabel: KIND_LABEL[sub.kind],
    monthLabel: monthLabel(sub.form_month),
    sectionName: sub.section_name,
    sectionCode: sub.section_code,
    senderName: sub.senderName,
    greetingName: sub.senderName,
    approverName,
    rejectReason: reason,
    fileCount: files.length
  });
  await sendMail({
    to: to.length ? to : cc, cc: to.length ? cc : [], attachments: files,
    subject: mail.subject, html: mail.html, text: mail.text, type: mail.type, sectionId: sub.section_id
  });
}

// POST /api/form-submissions/steps/:stepId/approve
router.post("/steps/:stepId/approve", audit("APPROVE", "FORM_SUBMISSION", req => req.params.stepId),
  asyncHandler(async (req, res) => {
    const step = await actionableStep(req);
    const approve = id => query(
      `UPDATE form_submission_steps SET status = 'APPROVED', approver_user_id = @userId,
         decided_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHERE id = @id AND status IN ('PENDING', 'WAITING')`,
      { id, userId: req.user.id }
    );
    await approve(step.id);

    // Later steps this same person is also an approver of are signed in the
    // same go (OT: one person as both Chief/Asst.Mgr. and Manager).
    let sub = await loadSubmission(step.submission_id);
    let next = sub.steps.find(s => s.status === "WAITING");
    while (next && (await stepCandidates(next.id)).some(c => c.id === req.user.id)) {
      await approve(next.id);
      sub = await loadSubmission(step.submission_id);
      next = sub.steps.find(s => s.status === "WAITING");
    }

    if (next) {
      await query(`UPDATE form_submission_steps SET status = 'PENDING' WHERE id = @id`, { id: next.id });
      sub = await loadSubmission(step.submission_id);
      await mailStep(sub, sub.steps.find(s => s.id === next.id), { ccSection: false });
    } else {
      await query(
        `UPDATE form_submissions SET status = 'APPROVED', decided_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`,
        { id: sub.id }
      );
      sub = await loadSubmission(step.submission_id);
      await mailResult(sub);
    }
    emitSystem("forms.updated", { sectionId: req.section.id });
    res.json({ ok: true, status: sub.status });
  }));

// POST /api/form-submissions/steps/:stepId/reject { comment }
router.post("/steps/:stepId/reject", audit("REJECT", "FORM_SUBMISSION", req => req.params.stepId),
  asyncHandler(async (req, res) => {
    const { comment } = z.object({ comment: z.string().trim().min(1, "Please give a reason").max(500) }).parse(req.body);
    const step = await actionableStep(req);
    await query(
      `UPDATE form_submission_steps SET status = 'REJECTED', approver_user_id = @userId, comment = @comment,
         decided_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`,
      { id: step.id, userId: req.user.id, comment }
    );
    await query(
      `UPDATE form_submissions SET status = 'REJECTED', reject_reason = @comment,
         decided_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`,
      { id: step.submission_id, comment }
    );
    const sub = await loadSubmission(step.submission_id);
    const me = (await usersByIds([req.user.id]))[0];
    await mailResult(sub, { rejected: true, approverName: nameOf(me), reason: comment });
    emitSystem("forms.updated", { sectionId: req.section.id });
    res.json({ ok: true, status: "REJECTED" });
  }));

module.exports = router;
