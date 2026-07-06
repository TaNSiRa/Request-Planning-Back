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
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.full_name, u.branch, u.department, u.section, u.phone, u.is_active, u.role_id,
            r.code AS role_code, r.name AS role_name,
            m.can_request, m.can_work, m.is_active AS membership_active,
            (SELECT ms.section_id, ms.can_request, ms.can_work
               FROM user_section_memberships ms
               WHERE ms.user_id = u.id AND ms.is_active = 1
               FOR JSON PATH) AS memberships_json
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId
     WHERE r.code = 'ADMIN' OR m.id IS NOT NULL
     ORDER BY u.display_name`,
    { sectionId: req.section.id }
  );
  const rows = result.recordset.map(row => {
    const { memberships_json, ...rest } = row;
    return { ...rest, memberships: memberships_json ? JSON.parse(memberships_json) : [] };
  });
  res.json({ data: rows });
}));

router.get("/assignees", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.full_name, u.branch, u.department, u.section, r.code AS role_code
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1
     WHERE u.is_active = 1
       -- Strict: only users with can_work = 1 in this section can be assigned,
       -- with no admin exception.
       AND m.can_work = 1
     ORDER BY u.branch, u.department, u.section, u.display_name`
    , { sectionId: req.section.id }
  );
  const users = result.recordset;
  const skillsByUser = await getAssigneeSkills(users.map(u => u.id));
  res.json({ data: users.map(u => ({ ...u, skills: skillsByUser.get(u.id) || [] })) });
}));

// Each assignee's self-rated skills (item + level), so the approver can judge
// who is qualified when assigning. Returns an empty map if the skill-matrix
// tables aren't installed yet.
async function getAssigneeSkills(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  try {
    const rows = (await query(
      `SELECT usl.user_id, usl.item_id, i.name AS item_name,
              usl.level_id, l.name AS level_name, l.sort_order
       FROM user_skill_levels usl
       JOIN skill_matrix_items i ON i.id = usl.item_id
       JOIN skill_matrix_levels l ON l.id = usl.level_id
       WHERE usl.user_id IN (${userIds.map((_, i) => `@u${i}`).join(",")})
       ORDER BY i.sort_order, i.id`,
      Object.fromEntries(userIds.map((id, i) => [`u${i}`, id]))
    )).recordset;
    for (const r of rows) {
      if (!map.has(r.user_id)) map.set(r.user_id, []);
      map.get(r.user_id).push({
        itemId: r.item_id,
        itemName: r.item_name,
        levelId: r.level_id,
        levelName: r.level_name,
        sortOrder: r.sort_order
      });
    }
  } catch (err) {
    if (`${err.message}`.includes("Invalid object name")) return map;
    throw err;
  }
  return map;
}

router.post("/", requireAdmin, audit("CREATE", "USER", req => req.body.email), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    fullName: z.string().optional().nullable(),
    password: z.string().min(10),
    roleId: z.number().int(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1),
    phone: z.string().optional().nullable(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true),
    memberships: membershipsSchema
  });
  const input = schema.parse(req.body);
  // Exclude non-column fields (arrays/flags) from the INSERT params — passing an
  // array to mssql throws "Invalid string".
  const { memberships, canRequest, canWork, ...userInput } = input;
  const values = {
    ...userInput,
    employeeNo: input.employeeNo ?? null,
    fullName: input.fullName?.trim() ? input.fullName.trim() : null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null,
    phone: input.phone ?? null
  };
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  const result = await query(
    `INSERT INTO users (employee_no, email, display_name, full_name, password_hash, role_id, branch, department, section, phone)
     OUTPUT INSERTED.id
     VALUES (@employeeNo, @email, @displayName, @fullName, @passwordHash, @roleId, @branch, @department, @section, @phone)`,
    { ...values, email: input.email.toLowerCase(), passwordHash }
  );
  const userId = result.recordset[0].id;
  if (input.memberships && input.memberships.length) {
    await setMemberships(userId, input.memberships);
  } else {
    await upsertMembership(userId, req.section.id, input.canRequest, input.canWork);
  }
  res.status(201).json({ id: userId });
}));

router.patch("/:id(\\d+)", requireAdmin, audit("EDIT", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    fullName: z.string().optional().nullable(),
    roleId: z.number().int(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1),
    phone: z.string().optional().nullable(),
    isActive: z.boolean(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true),
    memberships: membershipsSchema
  });
  const input = schema.parse(req.body);
  await query(
    `UPDATE users
     SET employee_no=@employeeNo, email=@email, display_name=@displayName, full_name=@fullName, role_id=@roleId,
         branch=@branch, department=@department, section=@section, phone=@phone, is_active=@isActive, updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    {
      id: Number(req.params.id),
      employeeNo: input.employeeNo ?? null,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      fullName: input.fullName?.trim() ? input.fullName.trim() : null,
      roleId: input.roleId,
      branch: input.branch ?? null,
      department: input.department ?? null,
      section: input.section ?? null,
      phone: input.phone ?? null,
      isActive: input.isActive
    }
  );
  if (input.memberships) {
    await setMemberships(Number(req.params.id), input.memberships);
  } else {
    await upsertMembership(Number(req.params.id), req.section.id, input.canRequest, input.canWork);
  }
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
    fullName: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1)
  });
  const input = schema.parse(req.body);
  const values = {
    ...input,
    fullName: input.fullName?.trim() ? input.fullName.trim() : null,
    phone: input.phone ?? null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null
  };
  await query(
    `UPDATE users SET display_name=@displayName, full_name=@fullName, phone=@phone, branch=@branch, department=@department, section=@section, updated_at=SYSUTCDATETIME()
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

// Per-section access chosen in the user form: which sections the user can
// request/work in. Deactivates any section not in the list.
const membershipsSchema = z
  .array(z.object({
    sectionId: z.number().int().positive(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true)
  }))
  .optional();

async function setMemberships(userId, memberships) {
  await query("UPDATE user_section_memberships SET is_active=0 WHERE user_id=@userId", { userId });
  for (const m of memberships) {
    await upsertMembership(userId, m.sectionId, m.canRequest !== false, m.canWork !== false);
  }
}

module.exports = router;
