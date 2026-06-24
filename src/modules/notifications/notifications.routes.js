const express = require("express");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { resolveSection } = require("../../services/sectionService");

const router = express.Router();
router.use(requireAuth);
router.use(resolveSection);

router.get("/", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT TOP 50 * FROM notifications
     WHERE user_id=@userId AND section_id=@sectionId
     ORDER BY created_at DESC`,
    { userId: req.user.id, sectionId: req.section.id }
  );
  res.json({ data: result.recordset });
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
