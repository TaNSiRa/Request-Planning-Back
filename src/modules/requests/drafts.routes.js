const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");

// Create Request drafts (patch_request_drafts.sql). Mounted inside the requests
// router AFTER resolveSection, so every draft belongs to the caller AND the
// section they are raising into — a draft written for one section never shows
// up on another section's form, where its type/route would not make sense.
//
// The form auto-saves: the first save creates a draft (POST), every later one
// overwrites it (PUT). PUT never creates, so a save that lands after the draft
// was submitted or deleted is a harmless 404 instead of a resurrected draft.
const router = express.Router();

const MAX_DRAFTS = 5;
const TEXT_MAX = 20000;

// Same idea as the personal-todo layout check: without the patch the endpoints
// answer 503 and the page simply offers no drafts. Checked once, then cached —
// but only a positive answer is cached, so applying the patch needs no restart.
let draftsTableReady = false;

async function hasDraftsTable() {
  if (draftsTableReady) return true;
  try {
    const row = (await query("SELECT OBJECT_ID('request_drafts') AS id")).recordset[0];
    draftsTableReady = row?.id != null;
  } catch {
    draftsTableReady = false;
  }
  return draftsTableReady;
}

router.use(asyncHandler(async (req, res, next) => {
  if (!(await hasDraftsTable())) {
    return res.status(503).json({ message: "Drafts are not available yet (database patch not applied)" });
  }
  next();
}));

// Everything is optional and may be empty: a draft is by definition unfinished.
// The ceilings match POST /requests so a draft can always be submitted as-is.
const draftSchema = z.object({
  title: z.string().max(255).optional().default(""),
  requestType: z.string().max(80).optional().default(""),
  systemArea: z.string().max(100).optional().default(""),
  priority: z.string().max(20).optional().default(""),
  dueDate: z.string().max(40).optional().default(""),
  description: z.string().max(TEXT_MAX).optional().default(""),
  businessImpact: z.string().max(TEXT_MAX).optional().default(""),
  attachments: z.array(z.object({
    fileName: z.string().min(1).max(255),
    contentType: z.string().max(100).optional().nullable(),
    dataUrl: z.string().startsWith("data:")
  })).max(20).optional().default([])
});

function draftId(req) {
  const id = Number(req.params.draftId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function summaryRow(row) {
  return {
    id: row.id,
    title: row.title || "",
    requestType: row.request_type || "",
    attachmentCount: row.attachment_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function columnValues(input) {
  return {
    title: input.title.trim().slice(0, 255) || null,
    requestType: input.requestType || null,
    attachmentCount: input.attachments.length,
    payload: JSON.stringify(input)
  };
}

router.get("/", asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT id, title, request_type, attachment_count, created_at, updated_at
     FROM request_drafts
     WHERE user_id=@userId AND section_id=@sectionId
     ORDER BY updated_at DESC, id DESC`,
    { userId: req.user.id, sectionId: req.section.id }
  )).recordset;
  res.json({ data: rows.map(summaryRow), max: MAX_DRAFTS });
}));

router.get("/:draftId", asyncHandler(async (req, res) => {
  const id = draftId(req);
  if (!id) return res.status(400).json({ message: "Invalid draft id" });
  const row = (await query(
    `SELECT id, title, request_type, attachment_count, payload, created_at, updated_at
     FROM request_drafts
     WHERE id=@id AND user_id=@userId AND section_id=@sectionId`,
    { id, userId: req.user.id, sectionId: req.section.id }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "Draft not found" });
  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  res.json({ ...summaryRow(row), payload });
}));

router.post("/", asyncHandler(async (req, res) => {
  const input = draftSchema.parse(req.body);
  // The cap is enforced in the INSERT itself, so two tabs auto-saving at the
  // same moment can't both squeeze past a separate count check.
  const inserted = (await query(
    `INSERT INTO request_drafts (user_id, section_id, title, request_type, attachment_count, payload)
     OUTPUT INSERTED.id, INSERTED.title, INSERTED.request_type, INSERTED.attachment_count,
            INSERTED.created_at, INSERTED.updated_at
     SELECT @userId, @sectionId, @title, @requestType, @attachmentCount, @payload
     WHERE (SELECT COUNT(1) FROM request_drafts WITH (UPDLOCK, HOLDLOCK)
            WHERE user_id=@userId AND section_id=@sectionId) < @max`,
    { userId: req.user.id, sectionId: req.section.id, max: MAX_DRAFTS, ...columnValues(input) }
  )).recordset[0];
  if (!inserted) {
    return res.status(409).json({
      code: "DRAFT_LIMIT",
      message: `You can keep up to ${MAX_DRAFTS} drafts. Delete one to save another.`
    });
  }
  res.status(201).json(summaryRow(inserted));
}));

router.put("/:draftId", asyncHandler(async (req, res) => {
  const id = draftId(req);
  if (!id) return res.status(400).json({ message: "Invalid draft id" });
  const input = draftSchema.parse(req.body);
  const row = (await query(
    `UPDATE request_drafts
     SET title=@title, request_type=@requestType, attachment_count=@attachmentCount,
         payload=@payload, updated_at=DATEADD(HOUR, 7, SYSUTCDATETIME())
     OUTPUT INSERTED.id, INSERTED.title, INSERTED.request_type, INSERTED.attachment_count,
            INSERTED.created_at, INSERTED.updated_at
     WHERE id=@id AND user_id=@userId AND section_id=@sectionId`,
    { id, userId: req.user.id, sectionId: req.section.id, ...columnValues(input) }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "Draft not found" });
  res.json(summaryRow(row));
}));

router.delete("/:draftId", asyncHandler(async (req, res) => {
  const id = draftId(req);
  if (!id) return res.status(400).json({ message: "Invalid draft id" });
  await deleteDraft(id, req.user.id, req.section.id);
  res.json({ ok: true });
}));

// Also used by POST /requests once a request raised from a draft is created.
// Quietly does nothing if the draft is already gone or the patch isn't applied.
async function deleteDraft(id, userId, sectionId) {
  if (!id || !(await hasDraftsTable())) return;
  await query(
    "DELETE FROM request_drafts WHERE id=@id AND user_id=@userId AND section_id=@sectionId",
    { id, userId, sectionId }
  );
}

module.exports = { draftRoutes: router, deleteDraft, MAX_DRAFTS };
