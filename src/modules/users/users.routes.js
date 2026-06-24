const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireAdmin, resolveSection } = require("../../services/sectionService");

const router = express.Router();

router.use(requireAuth);
router.use(resolveSection);

router.get("/", requireAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.branch, u.department, u.section, u.phone, u.is_active, u.role_id,
            r.code AS role_code, r.name AS role_name,
            m.can_request, m.can_work, m.is_active AS membership_active
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId
     WHERE r.code = 'ADMIN' OR m.id IS NOT NULL
     ORDER BY u.display_name`,
    { sectionId: req.section.id }
  );
  res.json({ data: result.recordset });
}));

router.get("/assignees", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.branch, u.department, u.section, r.code AS role_code
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1
     WHERE u.is_active = 1
       AND (r.code = 'ADMIN' OR m.can_work = 1)
     ORDER BY u.branch, u.department, u.section, u.display_name`
    , { sectionId: req.section.id }
  );
  res.json({ data: result.recordset });
}));

router.post("/", requireAdmin, audit("CREATE", "USER", req => req.body.email), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    password: z.string().min(10),
    roleId: z.number().int(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1),
    phone: z.string().optional().nullable(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true)
  });
  const input = schema.parse(req.body);
  const values = {
    ...input,
    employeeNo: input.employeeNo ?? null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null,
    phone: input.phone ?? null
  };
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  const result = await query(
    `INSERT INTO users (employee_no, email, display_name, password_hash, role_id, branch, department, section, phone)
     OUTPUT INSERTED.id
     VALUES (@employeeNo, @email, @displayName, @passwordHash, @roleId, @branch, @department, @section, @phone)`,
    { ...values, email: input.email.toLowerCase(), passwordHash }
  );
  const userId = result.recordset[0].id;
  await upsertMembership(userId, req.section.id, input.canRequest, input.canWork);
  res.status(201).json({ id: userId });
}));

router.patch("/:id(\\d+)", requireAdmin, audit("EDIT", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    roleId: z.number().int(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1),
    phone: z.string().optional().nullable(),
    isActive: z.boolean(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true)
  });
  const input = schema.parse(req.body);
  await query(
    `UPDATE users
     SET employee_no=@employeeNo, email=@email, display_name=@displayName, role_id=@roleId,
         branch=@branch, department=@department, section=@section, phone=@phone, is_active=@isActive, updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    {
      id: Number(req.params.id),
      employeeNo: input.employeeNo ?? null,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      roleId: input.roleId,
      branch: input.branch ?? null,
      department: input.department ?? null,
      section: input.section ?? null,
      phone: input.phone ?? null,
      isActive: input.isActive
    }
  );
  await upsertMembership(Number(req.params.id), req.section.id, input.canRequest, input.canWork);
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/reset-password", requireAdmin, audit("RESET_PASSWORD", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({ password: z.string().min(10) });
  const input = schema.parse(req.body);
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  await query("UPDATE users SET password_hash=@passwordHash, updated_at=SYSUTCDATETIME() WHERE id=@id", {
    id: Number(req.params.id),
    passwordHash
  });
  res.json({ ok: true });
}));

router.patch("/me", audit("EDIT_PROFILE", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    displayName: z.string().min(2),
    phone: z.string().optional().nullable(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1)
  });
  const input = schema.parse(req.body);
  const values = {
    ...input,
    phone: input.phone ?? null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null
  };
  await query(
    `UPDATE users SET display_name=@displayName, phone=@phone, branch=@branch, department=@department, section=@section, updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    { ...values, id: req.user.id }
  );
  res.json({ ok: true });
}));

router.patch("/me/password", audit("CHANGE_PASSWORD", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const schema = z.object({ currentPassword: z.string(), newPassword: z.string().min(10) });
  const input = schema.parse(req.body);
  const user = (await query("SELECT password_hash FROM users WHERE id=@id", { id: req.user.id })).recordset[0];
  if (!user || !(await bcrypt.compare(input.currentPassword, user.password_hash))) {
    return res.status(400).json({ message: "Current password is incorrect" });
  }
  const passwordHash = await bcrypt.hash(input.newPassword, env.bcryptRounds);
  await query("UPDATE users SET password_hash=@passwordHash, updated_at=SYSUTCDATETIME() WHERE id=@id", { id: req.user.id, passwordHash });
  res.json({ ok: true });
}));

router.get("/roles", asyncHandler(async (req, res) => {
  const result = await query("SELECT id, code, name FROM roles ORDER BY name");
  res.json({ data: result.recordset });
}));

async function upsertMembership(userId, sectionId, canRequest = true, canWork = true) {
  await query(
    `MERGE user_section_memberships AS target
     USING (SELECT @userId AS user_id, @sectionId AS section_id) AS source
     ON target.user_id = source.user_id AND target.section_id = source.section_id
     WHEN MATCHED THEN UPDATE SET can_request=@canRequest, can_work=@canWork, is_active=1
     WHEN NOT MATCHED THEN
       INSERT (user_id, section_id, can_request, can_work, is_active)
       VALUES (@userId, @sectionId, @canRequest, @canWork, 1);`,
    { userId, sectionId, canRequest, canWork }
  );
}

module.exports = router;
