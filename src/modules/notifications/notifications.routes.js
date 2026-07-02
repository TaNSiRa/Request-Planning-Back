const express = require("express");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/", asyncHandler(async (req, res) => {
  const params = { userId: req.user.id, sectionId: req.section.id };
  // The list is capped for the popup, but the badge needs the true unread total
  // (so it can show 99+), independent of how many rows we fetch.
  const result = await query(
    `SELECT TOP 50 * FROM notifications
     WHERE user_id=@userId AND section_id=@sectionId
     ORDER BY created_at DESC`,
    params
  );
  const unread = await query(
    `SELECT COUNT(1) AS unread_count FROM notifications
     WHERE user_id=@userId AND section_id=@sectionId AND read_at IS NULL`,
    params
  );
  res.json({ data: result.recordset, unreadCount: unread.recordset[0].unread_count });
}));

router.patch("/:id/read", asyncHandler(async (req, res) => {
  await query(
    `UPDATE notifications
     SET read_at=SYSUTCDATETIME()
     WHERE id=@id AND user_id=@userId AND section_id=@sectionId`,
    { id: Number(req.params.id), userId: req.user.id, sectionId: req.section.id }
  );
  res.json({ ok: true });
}));

router.patch("/read-all", asyncHandler(async (req, res) => {
  await query(
    `UPDATE notifications
     SET read_at=SYSUTCDATETIME()
     WHERE user_id=@userId AND section_id=@sectionId AND read_at IS NULL`,
    { userId: req.user.id, sectionId: req.section.id }
  );
  res.json({ ok: true });
}));

module.exports = router;
