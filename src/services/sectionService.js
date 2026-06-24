const { query } = require("../db/pool");

function normalizeSectionCode(value) {
  return `${value || ""}`.trim().toUpperCase();
}

function isAdmin(user) {
  return user?.roleCode === "ADMIN";
}

async function getUserSections(user) {
  if (!user?.id) return [];
  const result = await query(
    `SELECT s.id, s.code, s.name, s.description, s.request_prefix,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE COALESCE(m.can_request, 0) END AS BIT) AS can_request,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE COALESCE(m.can_work, 0) END AS BIT) AS can_work,
            CAST(CASE WHEN @isAdmin = 1 THEN 1 ELSE 0 END AS BIT) AS is_admin,
            CAST(CASE WHEN EXISTS (
              SELECT 1
              FROM approval_routes ar
              JOIN approval_route_steps ars ON ars.route_id = ar.id
              WHERE ar.section_id = s.id
                AND ar.is_active = 1
                AND ars.default_approver_user_id = @userId
            ) THEN 1 ELSE 0 END AS BIT) AS is_approver
     FROM request_sections s
     LEFT JOIN user_section_memberships m
       ON m.section_id = s.id AND m.user_id = @userId AND m.is_active = 1
     WHERE s.is_active = 1
       AND (@isAdmin = 1 OR m.id IS NOT NULL)
     ORDER BY s.name`,
    { userId: user.id, isAdmin: isAdmin(user) ? 1 : 0 }
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
    isApprover: section.is_approver === true || section.is_approver === 1
  }));
}

async function resolveSection(req, res, next) {
  try {
    const code = normalizeSectionCode(req.headers["x-section-code"] || req.query.sectionCode);
    if (!code) return res.status(400).json({ message: "Section is required" });

    const result = await query(
      `SELECT TOP 1 s.id, s.code, s.name, s.description, s.request_prefix,
              m.can_request, m.can_work,
              CAST(CASE WHEN EXISTS (
                SELECT 1
                FROM approval_routes ar
                JOIN approval_route_steps ars ON ars.route_id = ar.id
                WHERE ar.section_id = s.id
                  AND ar.is_active = 1
                  AND ars.default_approver_user_id = @userId
              ) THEN 1 ELSE 0 END AS BIT) AS is_approver
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
    req.section = {
      id: section.id,
      code: section.code,
      name: section.name,
      description: section.description,
      requestPrefix: section.request_prefix
    };
    req.sectionAccess = {
      isAdmin: admin,
      canRequest: admin || section.can_request === true || section.can_request === 1,
      canWork: admin || section.can_work === true || section.can_work === 1,
      isApprover: admin || section.is_approver === true || section.is_approver === 1,
      canViewAll: admin || section.is_approver === true || section.is_approver === 1
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return res.status(403).json({ message: "Forbidden" });
}

module.exports = {
  getUserSections,
  isAdmin,
  normalizeSectionCode,
  requireAdmin,
  resolveSection
};
