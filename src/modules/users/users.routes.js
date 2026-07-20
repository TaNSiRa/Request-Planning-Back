const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth } = require("../../middleware/auth");
const { audit } = require("../../middleware/audit");
const { requireSectionAdmin, resolveSection, isAdmin, canManageTargetRole } = require("../../services/sectionService");
const { routeStepUserCondition } = require("../../services/approverService");
const { getUserDisplayOrder, sortUsersByDisplayOrder } = require("../../services/settingsService");
const { emitSystem } = require("../../services/realtimeService");

const router = express.Router();

router.use(requireAuth);
router.use(resolveSection);

router.get("/", requireSectionAdmin, asyncHandler(async (req, res) => {
  // Global admins see every admin + this section's members. A section admin only
  // manages plain requesters in their own section, so they see just those.
  const fullAdmin = isAdmin(req.user) ? 1 : 0;
  // "Approver of" badge counts primary approvers AND co-approvers.
  const approverCond = await routeStepUserCondition("ars", "u.id");
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.full_name, u.name_prefix, u.branch, u.department, u.section, u.phone, u.is_active, u.role_id,
            u.position_id, p.name AS position_name, p.abbreviation AS position_abbr,
            r.code AS role_code, r.name AS role_name,
            m.can_request, m.can_work, m.is_section_admin, m.is_active AS membership_active,
            (SELECT ms.section_id, ms.can_request, ms.can_work, ms.is_section_admin
               FROM user_section_memberships ms
               WHERE ms.user_id = u.id AND ms.is_active = 1
               FOR JSON PATH) AS memberships_json,
            (SELECT DISTINCT s2.name
               FROM approval_route_steps ars
               JOIN approval_routes ar ON ar.id = ars.route_id AND ar.is_active = 1
               JOIN request_sections s2 ON s2.id = ar.section_id
               WHERE ${approverCond}
               FOR JSON PATH) AS approver_sections_json
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId
     WHERE (@fullAdmin = 1 AND (r.code = 'ADMIN' OR m.id IS NOT NULL))
        OR (@fullAdmin = 0 AND m.id IS NOT NULL AND m.is_active = 1 AND r.code = 'REQUESTER')
     ORDER BY u.display_name`,
    { sectionId: req.section.id, fullAdmin }
  );
  // Same fixed user order as the assignee dropdowns / weekly plan (set with the
  // weekly-plan arrows); users not in the saved order stay alphabetical.
  // System administrators always come first, keeping that order among themselves.
  const ordered = sortUsersByDisplayOrder(result.recordset, await getUserDisplayOrder(req.section.id));
  const admins = ordered.filter(row => row.role_code === "ADMIN");
  const rest = ordered.filter(row => row.role_code !== "ADMIN");
  const rows = [...admins, ...rest].map(row => {
    const { memberships_json, approver_sections_json, ...rest } = row;
    return {
      ...rest,
      memberships: memberships_json ? JSON.parse(memberships_json) : [],
      approver_sections: approver_sections_json
        ? JSON.parse(approver_sections_json).map(s => s.name)
        : []
    };
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
  // The section's fixed user order (weekly-plan arrows) pins listed people to
  // their positions; anyone unlisted follows in the SQL order above.
  const users = sortUsersByDisplayOrder(result.recordset, await getUserDisplayOrder(req.section.id));
  const skillsByUser = await getAssigneeSkills(users.map(u => u.id), req.section.id);
  res.json({ data: users.map(u => ({ ...u, skills: skillsByUser.get(u.id) || [] })) });
}));

// Each assignee's self-rated skills (item + level), so the approver can judge
// who is qualified when assigning. Returns an empty map if the skill-matrix
// tables aren't installed yet.
async function getAssigneeSkills(userIds, sectionId) {
  const map = new Map();
  if (!userIds.length) return map;
  try {
    const rows = (await query(
      `SELECT usl.user_id, usl.item_id, i.name AS item_name,
              usl.level_id, l.name AS level_name, l.sort_order
       FROM user_skill_levels usl
       JOIN skill_matrix_items i ON i.id = usl.item_id AND i.section_id = @sectionId
       JOIN skill_matrix_levels l ON l.id = usl.level_id
       WHERE usl.user_id IN (${userIds.map((_, i) => `@u${i}`).join(",")})
       ORDER BY i.sort_order, i.id`,
      { ...Object.fromEntries(userIds.map((id, i) => [`u${i}`, id])), sectionId }
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

router.post("/", requireSectionAdmin, audit("CREATE", "USER", req => req.body.email), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    fullName: z.string().optional().nullable(),
    namePrefix: z.string().optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
    password: z.string().min(1),
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
  // Privilege guard: a section admin (non-global) may only create plain requesters.
  if (!canManageTargetRole(req.user, await roleCodeById(input.roleId))) {
    return res.status(403).json({ message: "You can only assign the Requester role" });
  }
  // Exclude non-column fields (arrays/flags) from the INSERT params — passing an
  // array to mssql throws "Invalid string".
  const { memberships, canRequest, canWork, ...userInput } = input;
  const values = {
    ...userInput,
    employeeNo: input.employeeNo ?? null,
    fullName: input.fullName?.trim() ? input.fullName.trim() : null,
    namePrefix: input.namePrefix?.trim() ? input.namePrefix.trim() : null,
    positionId: input.positionId ?? null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null,
    phone: input.phone ?? null
  };
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  const result = await query(
    `INSERT INTO users (employee_no, email, display_name, full_name, name_prefix, position_id, password_hash, role_id, branch, department, section, phone)
     OUTPUT INSERTED.id
     VALUES (@employeeNo, @email, @displayName, @fullName, @namePrefix, @positionId, @passwordHash, @roleId, @branch, @department, @section, @phone)`,
    { ...values, email: input.email.toLowerCase(), passwordHash }
  );
  const userId = result.recordset[0].id;
  await applyMembershipsForActor(req, userId, input);
  emitSystem("users.updated", { id: userId });
  res.status(201).json({ id: userId });
}));

router.patch("/:id(\\d+)", requireSectionAdmin, audit("EDIT", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(2),
    fullName: z.string().optional().nullable(),
    namePrefix: z.string().optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
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
  // Privilege guards for a section admin (non-global): may not touch admins/section
  // admins, and may only assign the Requester role.
  if (!isAdmin(req.user)) {
    if (!canManageTargetRole(req.user, await targetRoleCode(Number(req.params.id)))) {
      return res.status(403).json({ message: "You cannot manage this user" });
    }
    if (!canManageTargetRole(req.user, await roleCodeById(input.roleId))) {
      return res.status(403).json({ message: "You can only assign the Requester role" });
    }
  }
  await query(
    `UPDATE users
     SET employee_no=@employeeNo, email=@email, display_name=@displayName, full_name=@fullName, name_prefix=@namePrefix, position_id=@positionId, role_id=@roleId,
         branch=@branch, department=@department, section=@section, phone=@phone, is_active=@isActive, updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    {
      id: Number(req.params.id),
      employeeNo: input.employeeNo ?? null,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      fullName: input.fullName?.trim() ? input.fullName.trim() : null,
      namePrefix: input.namePrefix?.trim() ? input.namePrefix.trim() : null,
      positionId: input.positionId ?? null,
      roleId: input.roleId,
      branch: input.branch ?? null,
      department: input.department ?? null,
      section: input.section ?? null,
      phone: input.phone ?? null,
      isActive: input.isActive
    }
  );
  await applyMembershipsForActor(req, Number(req.params.id), input);
  emitSystem("users.updated", { id: Number(req.params.id) });
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/reset-password", requireSectionAdmin, audit("RESET_PASSWORD", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({ password: z.string().min(1) });
  const input = schema.parse(req.body);
  if (!canManageTargetRole(req.user, await targetRoleCode(Number(req.params.id)))) {
    return res.status(403).json({ message: "You cannot manage this user" });
  }
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  await query("UPDATE users SET password_hash=@passwordHash, updated_at=SYSUTCDATETIME() WHERE id=@id", {
    id: Number(req.params.id),
    passwordHash
  });
  res.json({ ok: true });
}));

router.patch("/me", audit("EDIT_PROFILE", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().trim().min(1),
    email: z.string().trim().email(),
    displayName: z.string().min(2),
    fullName: z.string().optional().nullable(),
    namePrefix: z.string().optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
    phone: z.string().optional().nullable(),
    branch: z.string().min(1),
    department: z.string().min(1),
    section: z.string().min(1),
    // Working days before a request end date to email a reminder (0 disables
    // the "near end date" digest; today/overdue reminders still send).
    endDateNotifyDays: z.number().int().min(0).max(365).optional()
  });
  const input = schema.parse(req.body);
  const email = input.email.toLowerCase();
  // Email is a hard unique key (also a login identifier) and employee_no is used
  // to log in too — block a change that would collide with another account and
  // return a clear message instead of a raw DB constraint error.
  const clash = (await query(
    `SELECT TOP 1 CASE WHEN LOWER(email)=@email THEN 'EMAIL_TAKEN' ELSE 'EMPLOYEE_NO_TAKEN' END AS reason
     FROM users
     WHERE id<>@id AND (LOWER(email)=@email OR employee_no=@employeeNo)
     ORDER BY CASE WHEN LOWER(email)=@email THEN 0 ELSE 1 END`,
    { email, employeeNo: input.employeeNo, id: req.user.id }
  )).recordset[0];
  if (clash) return res.status(409).json({ message: clash.reason });
  const values = {
    ...input,
    email,
    fullName: input.fullName?.trim() ? input.fullName.trim() : null,
    namePrefix: input.namePrefix?.trim() ? input.namePrefix.trim() : null,
    positionId: input.positionId ?? null,
    phone: input.phone ?? null,
    branch: input.branch ?? null,
    department: input.department ?? null,
    section: input.section ?? null,
    endDateNotifyDays: input.endDateNotifyDays ?? null
  };
  await query(
    `UPDATE users SET employee_no=@employeeNo, email=@email, display_name=@displayName, full_name=@fullName, name_prefix=@namePrefix, position_id=@positionId, phone=@phone, branch=@branch, department=@department, section=@section,
         end_date_notify_days=COALESCE(@endDateNotifyDays, end_date_notify_days), updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    { ...values, id: req.user.id }
  );
  emitSystem("users.updated", { id: req.user.id });
  res.json({ ok: true });
}));

// Own profile picture — a small square image data URL produced by the Profile
// page's crop editor. null clears the picture (avatar falls back to initials).
router.put("/me/avatar", audit("EDIT_AVATAR", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    avatar: z.string()
      .regex(/^data:image\/(png|jpeg|webp);base64,/, "Avatar must be an image data URL")
      .max(1_500_000, "Avatar image is too large")
      .nullable()
  });
  const input = schema.parse(req.body);
  try {
    await query("UPDATE users SET avatar=@avatar, updated_at=SYSUTCDATETIME() WHERE id=@id", {
      id: req.user.id,
      avatar: input.avatar
    });
  } catch (err) {
    if (`${err.message}`.includes("Invalid column name")) {
      return res.status(400).json({ message: "Profile pictures are not installed yet — run database/patch_user_avatar.sql" });
    }
    throw err;
  }
  emitSystem("users.updated", { id: req.user.id });
  res.json({ ok: true });
}));

// Display-name → picture map for every active user that has one. Feeds the
// frontend AvatarStore so DsAvatar swaps initials for photos everywhere
// (same name-keyed pattern as presence). Returns empty until the avatar
// column exists (patch_user_avatar.sql).
router.get("/avatars", asyncHandler(async (req, res) => {
  try {
    const result = await query(
      "SELECT display_name, avatar FROM users WHERE is_active=1 AND avatar IS NOT NULL"
    );
    res.json({ data: result.recordset.map(r => ({ displayName: r.display_name, avatar: r.avatar })) });
  } catch (err) {
    if (`${err.message}`.includes("Invalid column name")) return res.json({ data: [] });
    throw err;
  }
}));

router.patch("/me/password", audit("CHANGE_PASSWORD", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const schema = z.object({ currentPassword: z.string(), newPassword: z.string().min(1) });
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

// All active request sections — feeds the user form's section-access editor so
// a section admin can grant can_request/can_work in any section (not just the
// one they administer). Read-only lookup, so requireSectionAdmin is enough.
router.get("/manage-sections", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    "SELECT id, code, name FROM request_sections WHERE is_active=1 ORDER BY name"
  );
  res.json({ data: result.recordset });
}));

async function upsertMembership(userId, sectionId, canRequest = true, canWork = true, isSectionAdmin = false) {
  await query(
    `MERGE user_section_memberships AS target
     USING (SELECT @userId AS user_id, @sectionId AS section_id) AS source
     ON target.user_id = source.user_id AND target.section_id = source.section_id
     WHEN MATCHED THEN UPDATE SET can_request=@canRequest, can_work=@canWork, is_section_admin=@isSectionAdmin, is_active=1
     WHEN NOT MATCHED THEN
       INSERT (user_id, section_id, can_request, can_work, is_section_admin, is_active)
       VALUES (@userId, @sectionId, @canRequest, @canWork, @isSectionAdmin, 1);`,
    { userId, sectionId, canRequest, canWork, isSectionAdmin }
  );
}

// Per-section access chosen in the user form: which sections the user can
// request/work in (and, for global admins, administer). Deactivates any section
// not in the list. is_section_admin is only honoured when allowSectionAdmin is
// true (i.e. the actor is a global admin) — a section admin can never mint another.
const membershipsSchema = z
  .array(z.object({
    sectionId: z.number().int().positive(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true),
    isSectionAdmin: z.boolean().optional().default(false)
  }))
  .optional();

async function setMemberships(userId, memberships, allowSectionAdmin = false) {
  await query("UPDATE user_section_memberships SET is_active=0 WHERE user_id=@userId", { userId });
  for (const m of memberships) {
    await upsertMembership(userId, m.sectionId, m.canRequest !== false, m.canWork !== false,
      allowSectionAdmin && m.isSectionAdmin === true);
  }
}

async function roleCodeById(roleId) {
  const row = (await query("SELECT code FROM roles WHERE id=@roleId", { roleId })).recordset[0];
  return row?.code || null;
}

async function targetRoleCode(userId) {
  const row = (await query(
    "SELECT r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=@userId", { userId }
  )).recordset[0];
  return row?.code || null;
}

// Apply the section-membership part of a create/edit. A global admin gets full
// replace-all control (including granting section-admin). A section admin gets
// the same replace-all control over can_request/can_work for EVERY section
// (managed users are plain requesters), but can never grant section-admin.
async function applyMembershipsForActor(req, userId, input) {
  const allowSectionAdmin = isAdmin(req.user);
  if (input.memberships) {
    await setMemberships(userId, input.memberships, allowSectionAdmin);
    return;
  }
  await upsertMembership(userId, req.section.id, input.canRequest, input.canWork, false);
}

module.exports = router;
