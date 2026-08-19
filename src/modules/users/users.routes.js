const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth, signToken } = require("../../middleware/auth");
const { setLoggedInSession } = require("../../services/securityService");
const { audit } = require("../../middleware/audit");
const { requireSectionAdmin, resolveSection, isAdmin, isViewer, canManageTargetRole } = require("../../services/sectionService");
const { blockViewerWrites } = require("../../middleware/viewerGuard");
const { rejectWeakPassword } = require("../../services/passwordPolicy");
const { bumpTokenVersion, forgetAccount, setMustChangePassword } = require("../../services/accountState");
const { recordSuccess: clearLoginLockout } = require("../../services/loginLockout");
const { VIEWER_PAGE_KEYS, getViewerOverrides, setViewerOverrides, sectionCanEdit } = require("../../services/viewerService");
const { routeStepUserCondition } = require("../../services/approverService");
const { getUserDisplayOrder, sortUsersByDisplayOrder } = require("../../services/settingsService");
const { assertAllowedAttachment, assertMagicByte, splitDataUrl } = require("../../services/attachmentStorage");
const { emitSystem } = require("../../services/realtimeService");
const {
  PRESETS,
  MAX_OFFSET_DAYS,
  MAX_OFFSETS_PER_SIDE,
  formatOffsetList
} = require("../../services/reminderPlan");

const router = express.Router();

router.use(requireAuth);
router.use(resolveSection);
router.use(blockViewerWrites("users"));

router.get("/", requireSectionAdmin, asyncHandler(async (req, res) => {
  // Global admins see every admin + this section's members.
  //
  // A section admin sees EVERYONE holding an active membership in their section,
  // whatever role they carry — a section admin of Automation who was granted
  // can_request here is a member of this section, and their access here is this
  // section's business. Global admins are the exception: they are system-wide
  // accounts a section admin has no authority over at all, so they stay hidden.
  // How much of a listed row may actually be changed is decided per role by the
  // PATCH guards below (identity and role stay off-limits for anyone the actor
  // may not manage — only PATCH /:id/section-access is open to them).
  const fullAdmin = isAdmin(req.user) ? 1 : 0;
  // "Approver of" badge counts primary approvers AND co-approvers.
  const approverCond = await routeStepUserCondition("ars", "u.id");
  const result = await query(
    `SELECT u.id, u.employee_no, u.email, u.display_name, u.full_name, u.name_prefix, u.branch, u.department, u.section, u.phone, u.is_active, u.role_id,
            u.position_id, p.name AS position_name, p.abbreviation AS position_abbr, p.sort_order AS position_sort,
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
        OR (@fullAdmin = 0 AND m.id IS NOT NULL AND m.is_active = 1 AND r.code <> 'ADMIN')
     ORDER BY u.display_name`,
    { sectionId: req.section.id, fullAdmin }
  );
  // Same fixed user order as the assignee dropdowns / weekly plan (set with the
  // weekly-plan arrows); users not in the saved order stay alphabetical.
  // Roles are grouped first — System Admin, Section Admin, Viewer, Requester —
  // and inside a role people are ranked by their job position exactly as the org
  // chart does it (positions.sort_order ascending, lowest = most senior; users
  // with no position last). The order above only breaks remaining ties.
  const ordered = sortUsersByDisplayOrder(result.recordset, await getUserDisplayOrder(req.section.id));
  const roleRank = { ADMIN: 0, SECTION_ADMIN: 1, VIEWER: 2, REQUESTER: 3 };
  const rankOf = row => roleRank[`${row.role_code}`.toUpperCase()] ?? 4;
  const positionRankOf = row =>
    row.position_sort === null || row.position_sort === undefined
      ? Number.MAX_SAFE_INTEGER
      : Number(row.position_sort);
  const rows = ordered
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        rankOf(a.row) - rankOf(b.row) ||
        positionRankOf(a.row) - positionRankOf(b.row) ||
        a.index - b.index
    )
    .map(({ row }) => {
      const { memberships_json, approver_sections_json, position_sort, ...rest } = row;
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
    employeeNo: z.string().min(1).max(50),
    email: z.string().email().max(255),
    displayName: z.string().min(2).max(150),
    fullName: z.string().max(200).optional().nullable(),
    namePrefix: z.string().max(20).optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
    password: z.string().min(1).max(128),
    roleId: z.number().int(),
    branch: z.string().min(1).max(100),
    department: z.string().min(1).max(100),
    section: z.string().min(1).max(100),
    phone: z.string().max(50).optional().nullable(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true),
    memberships: membershipsSchema
  });
  const input = schema.parse(req.body);
  if (rejectWeakPassword(res, input.password)) return;
  // Privilege guard: a section admin (non-global) may only create plain requesters,
  // and only into a section they administer — an account planted in someone else's
  // section would belong to that section the moment it existed.
  if (!canManageTargetRole(req.user, await roleCodeById(input.roleId))) {
    return res.status(403).json({ message: "You can only assign the Requester role" });
  }
  if (!await actorOwnsSectionLabel(req, input.section)) {
    return res.status(403).json({ message: "You can only create users in a section you administer" });
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
  // The password above was typed by whoever created the account, not by its
  // owner — flag it so the first sign-in has to replace it (see
  // patch_must_change_password.sql). Set separately from the INSERT so the
  // INSERT still works before that patch is applied.
  await setMustChangePassword(userId, true);
  await applyMembershipsForActor(req, userId, input);
  emitSystem("users.updated", { id: userId });
  res.status(201).json({ id: userId });
}));

router.patch("/:id(\\d+)", requireSectionAdmin, audit("EDIT", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({
    employeeNo: z.string().min(1).max(50),
    email: z.string().email().max(255),
    displayName: z.string().min(2).max(150),
    fullName: z.string().max(200).optional().nullable(),
    namePrefix: z.string().max(20).optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
    roleId: z.number().int(),
    branch: z.string().min(1).max(100),
    department: z.string().min(1).max(100),
    section: z.string().min(1).max(100),
    phone: z.string().max(50).optional().nullable(),
    isActive: z.boolean(),
    canRequest: z.boolean().optional().default(true),
    canWork: z.boolean().optional().default(true),
    memberships: membershipsSchema
  });
  const input = schema.parse(req.body);
  const targetId = Number(req.params.id);
  // Privilege guards for a section admin (non-global): may not touch admins/section
  // admins, and may only assign the Requester role.
  if (!isAdmin(req.user)) {
    if (targetId === req.user.id) {
      // Editing your OWN row is the exception — it is the only way a section
      // admin can set their own can_request / can_work, and the guard below
      // would otherwise refuse it for being a section-admin row. What it must
      // NOT become is a way to rewrite your own authority, so the three things
      // that decide that are pinned: your role, your active flag, and the
      // sections you administer.
      if (await roleCodeById(input.roleId) !== await targetRoleCode(targetId)) {
        return res.status(403).json({ message: "You cannot change your own role" });
      }
      if (input.isActive === false) {
        return res.status(403).json({ message: "You cannot deactivate your own account" });
      }
      // Unticking a section you administer would take away the access that let
      // you open this page, and only a global admin could give it back.
      if (input.memberships) {
        const submitted = new Set(input.memberships.map(m => m.sectionId));
        const dropped = (await sectionAdminSectionIds(targetId)).filter(id => !submitted.has(id));
        if (dropped.length) {
          return res.status(403).json({ message: "You cannot remove yourself from a section you administer" });
        }
      }
    } else {
      if (!canManageTargetRole(req.user, await targetRoleCode(targetId))) {
        return res.status(403).json({ message: "You cannot manage this user" });
      }
      // Role alone is not enough: a requester of ANOTHER section may be listed
      // here because they hold a membership in this one, and their account is
      // still that section's to edit. Only their section access is ours —
      // PATCH /:id/section-access is the door left open for that.
      if (!await actorOwnsUserHomeSection(req, targetId)) {
        return res.status(403).json({ message: "This account belongs to another section" });
      }
      if (!canManageTargetRole(req.user, await roleCodeById(input.roleId))) {
        return res.status(403).json({ message: "You can only assign the Requester role" });
      }
      // Nor may an account be handed to a section the actor does not administer.
      if (!await actorOwnsSectionLabel(req, input.section)) {
        return res.status(403).json({ message: "You can only move a user to a section you administer" });
      }
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
  // Deactivating an account must also cut off whatever token/session it already
  // holds, not just block the next login. Otherwise the cached account state is
  // simply dropped so the change is picked up on the next request.
  if (input.isActive === false) {
    await bumpTokenVersion(Number(req.params.id));
  } else {
    forgetAccount(Number(req.params.id));
  }
  await applyMembershipsForActor(req, Number(req.params.id), input);
  emitSystem("users.updated", { id: Number(req.params.id) });
  res.json({ ok: true });
}));

// Section access on its own, for a row the actor may SEE but not manage: another
// section's admin who also holds a membership here. Their identity, role, active
// flag and password belong to whoever administers them — PATCH /:id refuses the
// whole request for those accounts — but the access they hold in YOUR section is
// yours to set. Scoping is the same as everywhere else: applyMembershipsForActor
// only touches the sections the actor administers, and never a membership that
// carries is_section_admin.
router.patch("/:id(\\d+)/section-access", requireSectionAdmin, audit("EDIT_SECTION_ACCESS", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const input = z.object({ memberships: z.array(membershipEntrySchema) }).parse(req.body);
  const targetId = Number(req.params.id);
  // A global admin is a system-wide account, not a member a section admin has
  // any say over. (A global admin editing anyone still uses PATCH /:id.)
  if (!isAdmin(req.user) && await targetRoleCode(targetId) === "ADMIN") {
    return res.status(403).json({ message: "You cannot manage this user" });
  }
  await applyMembershipsForActor(req, targetId, { memberships: input.memberships });
  emitSystem("users.updated", { id: targetId });
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/reset-password", requireSectionAdmin, audit("RESET_PASSWORD", "USER", req => req.params.id), asyncHandler(async (req, res) => {
  const schema = z.object({ password: z.string().min(1) });
  const input = schema.parse(req.body);
  if (rejectWeakPassword(res, input.password)) return;
  if (!canManageTargetRole(req.user, await targetRoleCode(Number(req.params.id)))) {
    return res.status(403).json({ message: "You cannot manage this user" });
  }
  // A password is part of the account, not of the access it holds here — so it
  // follows the same rule as the identity block: only the section that owns the
  // account may reset it.
  if (!await actorOwnsUserHomeSection(req, Number(req.params.id))) {
    return res.status(403).json({ message: "This account belongs to another section" });
  }
  const passwordHash = await bcrypt.hash(input.password, env.bcryptRounds);
  await query("UPDATE users SET password_hash=@passwordHash, updated_at=SYSUTCDATETIME() WHERE id=@id", {
    id: Number(req.params.id),
    passwordHash
  });
  // An admin resetting a password is usually responding to a lost or leaked
  // credential — sign the account out everywhere it is currently signed in.
  await bumpTokenVersion(Number(req.params.id));
  // …and it is also how someone locked out by failed sign-ins gets back in, so
  // hand them an account that is actually open. Without this the new password
  // would be refused until the lock timed out on its own.
  await clearLoginLockout(Number(req.params.id));
  res.json({ ok: true });
}));

router.patch("/me", audit("EDIT_PROFILE", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  // Bounds mirror the `users` columns in database/schema.sql.
  const schema = z.object({
    employeeNo: z.string().trim().min(1).max(50),
    email: z.string().trim().email().max(255),
    displayName: z.string().min(2).max(150),
    fullName: z.string().max(200).optional().nullable(),
    namePrefix: z.string().max(20).optional().nullable(),
    positionId: z.number().int().positive().optional().nullable(),
    phone: z.string().max(50).optional().nullable(),
    branch: z.string().min(1).max(100),
    department: z.string().min(1).max(100),
    section: z.string().min(1).max(100),
    // Working days before a request end date to email a reminder (0 disables
    // the "near end date" digest; today/overdue reminders still send).
    endDateNotifyDays: z.number().int().min(0).max(365).optional(),
    // The same lead time for a to-do item's own end date.
    todoNotifyDays: z.number().int().min(0).max(365).optional()
  });
  const input = schema.parse(req.body);
  const email = input.email.toLowerCase();
  const clash = await findIdentityClash(req.user.id, {
    email,
    employeeNo: input.employeeNo,
    displayName: input.displayName
  });
  if (clash) return res.status(409).json({ message: clash });
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
    endDateNotifyDays: input.endDateNotifyDays ?? null,
    todoNotifyDays: input.todoNotifyDays ?? null
  };
  await query(
    `UPDATE users SET employee_no=@employeeNo, email=@email, display_name=@displayName, full_name=@fullName, name_prefix=@namePrefix, position_id=@positionId, phone=@phone, branch=@branch, department=@department, section=@section,
         end_date_notify_days=COALESCE(@endDateNotifyDays, end_date_notify_days),
         todo_notify_days=COALESCE(@todoNotifyDays, todo_notify_days), updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    { ...values, id: req.user.id }
  );
  emitSystem("users.updated", { id: req.user.id });
  res.json({ ok: true });
}));

// The three identity fields the Profile page lets people edit, and the only
// ones another account may not already be using:
//
//   email        — a hard unique key AND a login identifier.
//   employee_no  — the other login identifier, so a duplicate makes the login
//                  ambiguous (findActiveUserByIdentifier picks one by id).
//   display_name — the key the app identifies a person BY everywhere it is not
//                  holding a row: presence, avatars, the weekly plan's per-user
//                  columns, meeting viewers. Two people sharing one would show
//                  up as one person in all of them.
//
// Returns the first clashing field's code, or null. Compared case-insensitively
// and trimmed, because that is how a person reads "already taken".
async function findIdentityClash(userId, { email, employeeNo, displayName }) {
  const row = (await query(
    `SELECT TOP 1
       CASE WHEN @email <> '' AND LOWER(email)=@email THEN 'EMAIL_TAKEN'
            WHEN @employeeNo <> '' AND LTRIM(RTRIM(employee_no))=@employeeNo THEN 'EMPLOYEE_NO_TAKEN'
            ELSE 'DISPLAY_NAME_TAKEN' END AS reason
     FROM users
     WHERE id<>@id
       AND ((@email <> '' AND LOWER(email)=@email)
            OR (@employeeNo <> '' AND LTRIM(RTRIM(employee_no))=@employeeNo)
            OR (@displayName <> '' AND LOWER(LTRIM(RTRIM(display_name)))=@displayName))
     ORDER BY CASE WHEN @email <> '' AND LOWER(email)=@email THEN 0
                   WHEN @employeeNo <> '' AND LTRIM(RTRIM(employee_no))=@employeeNo THEN 1
                   ELSE 2 END`,
    {
      id: userId,
      email: `${email || ""}`.trim().toLowerCase(),
      employeeNo: `${employeeNo || ""}`.trim(),
      displayName: `${displayName || ""}`.trim().toLowerCase()
    }
  )).recordset[0];
  return row ? row.reason : null;
}

// Live "is this free?" check for the Profile page, so the three identity fields
// are flagged while they are being typed instead of only on save. Every field
// is optional — only the ones sent are checked. The PATCH above stays the
// authority: this is a hint, and two people editing at once can still race it.
router.get("/me/availability", asyncHandler(async (req, res) => {
  const taken = {};
  for (const [field, code] of [
    ["email", "EMAIL_TAKEN"],
    ["employeeNo", "EMPLOYEE_NO_TAKEN"],
    ["displayName", "DISPLAY_NAME_TAKEN"]
  ]) {
    const value = `${req.query[field] || ""}`.trim();
    if (!value) continue;
    // One field at a time, so a clash is reported against the field that
    // actually caused it rather than whichever the CASE ordering reached first.
    taken[field] = (await findIdentityClash(req.user.id, { [field]: value })) === code;
  }
  res.json({ taken });
}));

// ── Due-date reminder schedule (Profile › การแจ้งเตือน) ────────────────────
//
// Lists of WORKING days before / on / after an end date at which the reminder
// job emails this person. Saved on its own so editing the schedule never
// re-validates (or re-saves) the identity fields above.

const planSchema = z.object({
  before: z.array(z.number().int().min(1).max(MAX_OFFSET_DAYS)).max(MAX_OFFSETS_PER_SIDE),
  onDue: z.boolean(),
  after: z.array(z.number().int().min(1).max(MAX_OFFSET_DAYS)).max(MAX_OFFSETS_PER_SIDE)
});

const reminderSchema = z.object({
  // Which Profile preset produced these lists; drawing on the timeline sends
  // CUSTOM. Stored for the UI only — the job reads the lists themselves.
  preset: z.enum(["LOW", "NORMAL", "HIGH", "OFF", "CUSTOM"]).optional(),
  project: planSchema,
  todo: planSchema,
  pauseOnHold: z.boolean().optional()
});

router.patch("/me/reminders", audit("EDIT_REMINDERS", "USER", req => req.user.id), asyncHandler(async (req, res) => {
  const input = reminderSchema.parse(req.body);
  await query(
    `UPDATE users SET
       project_notify_before=@projectBefore, project_notify_on_due=@projectOnDue, project_notify_after=@projectAfter,
       todo_notify_before=@todoBefore, todo_notify_on_due=@todoOnDue, todo_notify_after=@todoAfter,
       reminder_pause_on_hold=@pauseOnHold, reminder_preset=@preset, updated_at=SYSUTCDATETIME()
     WHERE id=@id`,
    {
      // formatOffsetList de-duplicates, sorts and drops out-of-range values, so
      // what lands in the column is exactly what the job will read back.
      projectBefore: formatOffsetList(input.project.before),
      projectOnDue: input.project.onDue,
      projectAfter: formatOffsetList(input.project.after),
      todoBefore: formatOffsetList(input.todo.before),
      todoOnDue: input.todo.onDue,
      todoAfter: formatOffsetList(input.todo.after),
      pauseOnHold: input.pauseOnHold ?? true,
      preset: input.preset ?? "CUSTOM",
      id: req.user.id
    }
  );
  emitSystem("users.updated", { id: req.user.id });
  res.json({ ok: true });
}));

// The shipped presets, so the Profile page shows exactly what the job would do
// rather than hardcoding a second copy of the numbers.
router.get("/me/reminders/presets", asyncHandler(async (req, res) => {
  res.json(PRESETS);
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
  // The prefix above is a string the client writes, not evidence about the
  // bytes behind it: anything base64-encoded can be sent under
  // "data:image/png;base64,". Avatars used to stop at that prefix while every
  // other upload went through the attachment gate — this puts them through the
  // same door. It is the one upload path that stores its payload on the user
  // row rather than on disk, so it never met storeDataUrlAttachment().
  if (input.avatar) {
    const { contentType, buffer } = splitDataUrl(input.avatar);
    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    assertAllowedAttachment(`avatar${ext}`, contentType);
    assertMagicByte(`avatar${ext}`, buffer);
  }
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
  // Checked after the current-password proof so the policy text is never a
  // probing oracle for someone who doesn't already hold the account.
  if (rejectWeakPassword(res, input.newPassword)) return;
  if (input.newPassword === input.currentPassword) {
    return res.status(400).json({ message: "New password must be different from the current one" });
  }
  const passwordHash = await bcrypt.hash(input.newPassword, env.bcryptRounds);
  await query("UPDATE users SET password_hash=@passwordHash, updated_at=SYSUTCDATETIME() WHERE id=@id", { id: req.user.id, passwordHash });
  // The password is now one only its owner has typed, so the first-sign-in
  // dialog has served its purpose and must let go.
  await setMustChangePassword(req.user.id, false);
  // Changing your own password signs out every OTHER device holding a token for
  // this account — then re-issues a token and session for the caller, so the tab
  // that just did it stays logged in.
  await bumpTokenVersion(req.user.id);
  const refreshed = (await query(
    `SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = @id`,
    { id: req.user.id }
  )).recordset[0];
  const csrfToken = refreshed ? setLoggedInSession(req, refreshed) : null;
  res.json({ ok: true, token: refreshed ? signToken(refreshed) : null, csrfToken });
}));

// The forced first-sign-in change lives on the AUTH router, not here — this
// router resolves a section on every call, and that dialog opens before one has
// been picked. See POST /api/auth/first-password.

router.get("/roles", asyncHandler(async (req, res) => {
  const result = await query("SELECT id, code, name FROM roles ORDER BY name");
  res.json({ data: result.recordset });
}));

// All active request sections — feeds the user form's section-access editor.
// Every section is LISTED (a section admin has to see that a requester of theirs
// also belongs to Automation), but `manageable` says which rows that actor may
// actually change: all of them for a global admin, only the ones they administer
// for a section admin. The UI renders the rest disabled; applyMembershipsForActor
// enforces the same scope on save. Read-only lookup, so requireSectionAdmin is enough.
router.get("/manage-sections", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await query(
    "SELECT id, code, name FROM request_sections WHERE is_active=1 ORDER BY name"
  );
  const adminSectionIds = await actorAdminSectionIds(req);
  const adminSet = adminSectionIds == null ? null : new Set(adminSectionIds);
  res.json({
    data: result.recordset.map(s => ({
      ...s,
      manageable: adminSet == null || adminSet.has(s.id)
    }))
  });
}));

// Managing a VIEWER's page/section access is an administrative action, so it must
// never be reachable through a viewer's own edit grant — require a REAL admin or
// section admin (viewerPassesAdminGuard is deliberately not honoured here).
function realSectionAdminOnly(req, res, next) {
  if (isAdmin(req.user) || req.sectionAccess?.isSectionAdmin) return next();
  return res.status(403).json({ message: "Forbidden" });
}

// A section label reduced to what "the same section" means to a person: trimmed,
// case-insensitive, and without the trailing " Request" that every section name
// carries. users.section stores the HOME section as a plain label — the user form
// fills it from the live request-section list (Settings → org-options hands out
// request_sections.name) with that suffix stripped, which is why the two compare.
function sectionLabelKey(value) {
  const trimmed = `${value || ""}`.trim().toLowerCase();
  return trimmed.endsWith(" request") ? trimmed.slice(0, -" request".length).trim() : trimmed;
}

// Label keys of every section the actor administers, or null for "all of them".
async function actorAdministeredSectionKeys(req) {
  const allowed = await actorAdminSectionIds(req);
  if (allowed == null) return null;
  const keys = new Set();
  if (!allowed.length) return keys;
  const rows = (await query(
    `SELECT name, code FROM request_sections WHERE id IN (${allowed.map((_, i) => `@s${i}`).join(",")})`,
    Object.fromEntries(allowed.map((id, i) => [`s${i}`, id]))
  )).recordset;
  for (const row of rows) {
    keys.add(sectionLabelKey(row.name));
    keys.add(`${row.code || ""}`.trim().toLowerCase());
  }
  keys.delete("");
  return keys;
}

// Whether the actor administers the section an account BELONGS to. Holding a
// membership here is not belonging: a requester of Automation may be granted
// can_request in Delivery, and Delivery still does not own that person's name,
// email, role or password — only the access they hold in Delivery.
async function actorOwnsSectionLabel(req, label) {
  const keys = await actorAdministeredSectionKeys(req);
  if (keys == null) return true;
  const key = sectionLabelKey(label);
  return key !== "" && keys.has(key);
}

async function actorOwnsUserHomeSection(req, targetId) {
  const row = (await query("SELECT section FROM users WHERE id=@id", { id: targetId })).recordset[0];
  return actorOwnsSectionLabel(req, row?.section);
}

// Which sections the actor may hand out access in (global admin → every section,
// signalled by null). Scopes a section admin to the sections they administer, so
// they can only toggle another account's access — viewer overrides or plain
// section memberships — where their own authority actually reaches.
async function actorAdminSectionIds(req) {
  if (isAdmin(req.user)) return null; // null = all sections
  // A viewer granted edit on the Manage Users page administers nothing, but it
  // was let through here on the strength of its per-section edit grants — so
  // those grants are its scope. Without this branch the list below is empty and
  // a granted viewer could no longer change anything at all.
  if (isViewer(req.user)) {
    const overrides = req.viewerOverrides || (await getViewerOverrides(req.user.id));
    const rows = (await query(
      "SELECT id FROM request_sections WHERE is_active=1"
    )).recordset;
    return rows.map(r => r.id).filter(id => sectionCanEdit(overrides, id));
  }
  const rows = (await query(
    `SELECT ms.section_id FROM user_section_memberships ms
     WHERE ms.user_id=@userId AND ms.is_active=1 AND ms.is_section_admin=1`,
    { userId: req.user.id }
  )).recordset;
  return rows.map(r => r.section_id);
}

// The full page/section access matrix for a viewer — every page and every active
// section, each with the effective can_view / can_edit (defaults filled in). The
// Manage Users viewer editor renders straight from this.
router.get("/:id(\\d+)/viewer-permissions", realSectionAdminOnly, asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  if (await targetRoleCode(userId) !== "VIEWER") {
    return res.status(400).json({ message: "This user is not a viewer" });
  }
  const overrides = await getViewerOverrides(userId);
  const sectionRows = (await query(
    "SELECT id, code, name FROM request_sections WHERE is_active=1 ORDER BY name"
  )).recordset;
  const adminSectionIds = await actorAdminSectionIds(req);
  const adminSet = adminSectionIds == null ? null : new Set(adminSectionIds);
  res.json({
    // Global admins may retune page-level (cross-section) access; a section admin
    // may only toggle their own sections, so the UI hides the pages column.
    canEditPages: isAdmin(req.user),
    pages: VIEWER_PAGE_KEYS.map(pageKey => ({
      pageKey,
      canView: overrides.pages[pageKey] ? overrides.pages[pageKey].view : true,
      canEdit: overrides.pages[pageKey] ? overrides.pages[pageKey].edit : false
    })),
    sections: sectionRows.map(s => ({
      sectionId: s.id,
      code: s.code,
      name: s.name,
      // A section admin can only change the sections they administer.
      manageable: adminSet == null || adminSet.has(s.id),
      canView: overrides.sections[s.id] ? overrides.sections[s.id].view : true,
      canEdit: overrides.sections[s.id] ? overrides.sections[s.id].edit : false
    }))
  });
}));

router.put("/:id(\\d+)/viewer-permissions",
  realSectionAdminOnly,
  audit("EDIT", "VIEWER_PERMISSIONS", req => req.params.id),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (await targetRoleCode(userId) !== "VIEWER") {
      return res.status(400).json({ message: "This user is not a viewer" });
    }
    const schema = z.object({
      pages: z.array(z.object({
        pageKey: z.string(),
        canView: z.boolean().optional().default(true),
        canEdit: z.boolean().optional().default(false)
      })).optional(),
      sections: z.array(z.object({
        sectionId: z.number().int().positive(),
        canView: z.boolean().optional().default(true),
        canEdit: z.boolean().optional().default(false)
      })).optional()
    });
    const input = schema.parse(req.body);
    // Global admin controls the page matrix and every section; a section admin
    // may only touch their own sections and never the cross-section page matrix.
    const allowedSectionIds = await actorAdminSectionIds(req);
    await setViewerOverrides(userId, input, {
      allowPages: isAdmin(req.user),
      allowedSectionIds
    });
    emitSystem("users.updated", { id: userId });
    res.json({ ok: true });
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
const membershipEntrySchema = z.object({
  sectionId: z.number().int().positive(),
  canRequest: z.boolean().optional().default(true),
  canWork: z.boolean().optional().default(true),
  isSectionAdmin: z.boolean().optional().default(false)
});

const membershipsSchema = z.array(membershipEntrySchema).optional();

// [keepAdminIn] are section ids where the target ALREADY holds is_section_admin
// and the actor may not set that flag (i.e. the actor is not a global admin).
// Those rows are protected twice over: the flag survives the rewrite, and the
// row cannot be deactivated. Without the first, every save by a section admin
// would silently demote the person; without the second, unticking the row would
// do the same thing by another route — and both reach peers, not just the actor
// editing their own row.
//
// [allowedSectionIds] scopes the rewrite: null means "every section" (global
// admin), an array means only those rows may be created, changed or deactivated.
// A section admin editing a requester who also belongs to another section must
// leave that other membership exactly as it was — so the blanket "deactivate
// everything, then re-insert what was submitted" pass is narrowed to the allowed
// ids, and submitted rows outside them are dropped rather than written.
async function setMemberships(userId, memberships, allowSectionAdmin = false, keepAdminIn = [], allowedSectionIds = null) {
  const keep = new Set(keepAdminIn);
  const allowed = allowedSectionIds == null ? null : new Set(allowedSectionIds);
  const submitted = new Set(memberships.map(m => m.sectionId));
  if (allowed == null) {
    await query("UPDATE user_section_memberships SET is_active=0 WHERE user_id=@userId", { userId });
  } else {
    for (const sectionId of allowed) {
      if (submitted.has(sectionId) || keep.has(sectionId)) continue;
      await query(
        "UPDATE user_section_memberships SET is_active=0 WHERE user_id=@userId AND section_id=@sectionId",
        { userId, sectionId }
      );
    }
  }
  for (const m of memberships) {
    if (allowed != null && !allowed.has(m.sectionId)) continue;
    await upsertMembership(userId, m.sectionId, m.canRequest !== false, m.canWork !== false,
      (allowSectionAdmin && m.isSectionAdmin === true) || keep.has(m.sectionId));
  }
}

// Sections this user currently administers.
async function sectionAdminSectionIds(userId) {
  const rows = (await query(
    `SELECT section_id FROM user_section_memberships
     WHERE user_id=@userId AND is_active=1 AND is_section_admin=1`,
    { userId }
  )).recordset;
  return rows.map(row => row.section_id);
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
// replace-all control over every section (including granting section-admin). A
// section admin only controls can_request/can_work in the sections they actually
// administer — a requester of theirs may also belong to someone else's section,
// and that membership is not theirs to grant, revoke or retune. They can never
// grant section-admin anywhere.
async function applyMembershipsForActor(req, userId, input) {
  const allowSectionAdmin = isAdmin(req.user);
  if (input.memberships) {
    // Inside the allowed scope setMemberships still rewrites every row, and a
    // non-global actor is not allowed to set is_section_admin — so any flag the
    // target already holds has to be carried across, or the save is a silent
    // demotion. That is true whether the target is the actor themselves (the
    // flag that let them open the page) or a peer who administers another
    // section and merely holds a membership here.
    const keepAdminIn = allowSectionAdmin ? [] : await sectionAdminSectionIds(userId);
    // null for a global admin (every section), the administered ids otherwise.
    const allowedSectionIds = await actorAdminSectionIds(req);
    await setMemberships(userId, input.memberships, allowSectionAdmin, keepAdminIn, allowedSectionIds);
    return;
  }
  await upsertMembership(userId, req.section.id, input.canRequest, input.canWork, false);
}

module.exports = router;
