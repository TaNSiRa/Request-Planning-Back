const { query } = require("../db/pool");
const { routeStepUserCondition } = require("./approverService");

function normalizeSectionCode(value) {
  return `${value || ""}`.trim().toUpperCase();
}

function isAdmin(user) {
  return user?.roleCode === "ADMIN";
}

// Whether the account is the section-admin "kind". Actual authority is still
// scoped per section by the is_section_admin membership flag (see resolveSection
// / getUserSections) — this only says the role permits it.
function isSectionAdminRole(user) {
  return user?.roleCode === "SECTION_ADMIN";
}

// Guard against privilege escalation: a global ADMIN can manage anyone; a
// section admin may only create/edit/reset plain REQUESTER accounts (never
// another admin or section admin).
function canManageTargetRole(actor, targetRoleCode) {
  if (isAdmin(actor)) return true;
  return targetRoleCode === "REQUESTER";
}

async function getUserSections(user) {
  if (!user?.id) return [];
  // "Is approver" counts both a step's primary approver and any co-approver.
  const approverCond = await routeStepUserCondition("ars", "@userId");
  const result = await query(
    `SELECT s.id, s.code, s.name, s.description, s.request_prefix,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE COALESCE(m.can_request, 0) END AS BIT) AS can_request,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE COALESCE(m.can_work, 0) END AS BIT) AS can_work,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE 0 END AS BIT) AS is_admin,
            CAST(CASE WHEN @isSectionAdminRole = 1 AND m.is_section_admin = 1 THEN 1 ELSE 0 END AS BIT) AS is_section_admin,
            (SELECT COUNT(1) FROM notifications n
               WHERE n.user_id = @userId AND n.section_id = s.id AND n.read_at IS NULL) AS unread_count,
            CAST(CASE WHEN EXISTS (
              SELECT 1
              FROM approval_routes ar
              JOIN approval_route_steps ars ON ars.route_id = ar.id
              WHERE ar.section_id = s.id
                AND ar.is_active = 1
                AND ${approverCond}
            ) THEN 1 ELSE 0 END AS BIT) AS is_approver,
            CAST(CASE WHEN EXISTS (
              SELECT 1
              FROM approval_routes ar
              JOIN approval_route_steps ars ON ars.route_id = ar.id
              WHERE ar.section_id = s.id
                AND ar.is_active = 1
                AND ar.requester_section_id IS NULL
                AND ${approverCond}
            ) THEN 1 ELSE 0 END AS BIT) AS is_internal_approver
     FROM request_sections s
     LEFT JOIN user_section_memberships m
       ON m.section_id = s.id AND m.user_id = @userId AND m.is_active = 1
     WHERE s.is_active = 1
       AND (@isAdmin = 1 OR m.id IS NOT NULL)
     ORDER BY s.name`,
    { userId: user.id, isAdmin: isAdmin(user) ? 1 : 0, isSectionAdminRole: isSectionAdminRole(user) ? 1 : 0 }
  );
  return result.recordset.map(section => ({
    id: section.id,
    code: section.code,
    name: section.name,
    description: section.description,
    requestPrefix: section.request_prefix,
    canRequest: section.can_request === true || section.can_request === 1,
    canWork: section.can_work === true || section.can_work === 1,
    isAdmin: section.is_admin === true || section.is_admin === 1,
    isSectionAdmin: section.is_section_admin === true || section.is_section_admin === 1,
    isApprover: section.is_approver === true || section.is_approver === 1,
    // Approver on one of the section's OWN routes (not a cross-section stage-1
    // route) — grants section-manager tools like the skill matrix.
    isInternalApprover: section.is_internal_approver === true || section.is_internal_approver === 1,
    unreadCount: section.unread_count || 0
  }));
}

async function resolveSection(req, res, next) {
  try {
    const code = normalizeSectionCode(req.headers["x-section-code"] || req.query.sectionCode);
    if (!code) return res.status(400).json({ message: "Section is required" });

    const approverCond = await routeStepUserCondition("ars", "@userId");
    const result = await query(
      `SELECT TOP 1 s.id, s.code, s.name, s.description, s.request_prefix,
              m.can_request, m.can_work, m.is_section_admin,
              CAST(CASE WHEN EXISTS (
                SELECT 1
                FROM approval_routes ar
                JOIN approval_route_steps ars ON ars.route_id = ar.id
                WHERE ar.section_id = s.id
                  AND ar.is_active = 1
                  AND ${approverCond}
              ) THEN 1 ELSE 0 END AS BIT) AS is_approver,
              CAST(CASE WHEN EXISTS (
                SELECT 1
                FROM approval_routes ar
                JOIN approval_route_steps ars ON ars.route_id = ar.id
                WHERE ar.section_id = s.id
                  AND ar.is_active = 1
                  AND ar.requester_section_id IS NULL
                  AND ${approverCond}
              ) THEN 1 ELSE 0 END AS BIT) AS is_internal_approver
       FROM request_sections s
       LEFT JOIN user_section_memberships m
         ON m.section_id = s.id AND m.user_id = @userId AND m.is_active = 1
       WHERE s.code = @code AND s.is_active = 1`,
      { code, userId: req.user.id }
    );
    const section = result.recordset[0];
    if (!section) return res.status(404).json({ message: "Section not found" });
    if (!isAdmin(req.user) && section.can_request == null && section.can_work == null) {
      return res.status(403).json({ message: "You do not have access to this section" });
    }

    const admin = isAdmin(req.user);
    // Section admin only for THIS section: the role permits it and the membership
    // flag scopes it. Never grants cross-section access (that stays global-admin only).
    const sectionAdmin = isSectionAdminRole(req.user) &&
      (section.is_section_admin === true || section.is_section_admin === 1);
    req.section = {
      id: section.id,
      code: section.code,
      name: section.name,
      description: section.description,
      requestPrefix: section.request_prefix
    };
    req.sectionAccess = {
      isAdmin: admin,
      isSectionAdmin: sectionAdmin,
      canRequest: admin || section.can_request === true || section.can_request === 1,
      canWork: admin || section.can_work === true || section.can_work === 1,
      isApprover: admin || section.is_approver === true || section.is_approver === 1,
      // Approver on one of the section's OWN routes (cross-section stage-1
      // routes don't count) — grants section-manager tools like the skill matrix.
      isInternalApprover:
        section.is_internal_approver === true || section.is_internal_approver === 1,
      canViewAll: admin || sectionAdmin || section.is_approver === true || section.is_approver === 1
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function getSectionName(requestId) {
  if (!requestId) return "Request";
  const result = await query(
    `SELECT s.name
     FROM requests r
     JOIN request_sections s ON s.id = r.section_id
     WHERE r.id = @requestId`,
    { requestId }
  );
  return result.recordset[0]?.name || "Request";
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return res.status(403).json({ message: "Forbidden" });
}

// Passes for a global admin OR a section admin of the resolved section. Must run
// AFTER resolveSection (relies on req.sectionAccess).
function requireSectionAdmin(req, res, next) {
  if (isAdmin(req.user) || req.sectionAccess?.isSectionAdmin) return next();
  return res.status(403).json({ message: "Forbidden" });
}

// Like requireSectionAdmin, but ALSO passes for an approver on one of the
// section's own (non-cross-section) approval routes. Used for section-manager
// tools such as the skill matrix. Must run AFTER resolveSection.
function requireSectionManager(req, res, next) {
  const access = req.sectionAccess || {};
  if (isAdmin(req.user) || access.isSectionAdmin || access.isInternalApprover) return next();
  return res.status(403).json({ message: "Forbidden" });
}

module.exports = {
  canManageTargetRole,
  getSectionName,
  getUserSections,
  isAdmin,
  isSectionAdminRole,
  normalizeSectionCode,
  requireAdmin,
  requireSectionAdmin,
  requireSectionManager,
  resolveSection
};
