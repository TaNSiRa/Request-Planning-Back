const { query } = require("../db/pool");

// Page identifiers a viewer's access can be scoped to. These mirror the
// frontend AppPage enum names (see app_shell.dart). "profile" is intentionally
// omitted — every account may always view and edit its own profile.
const VIEWER_PAGE_KEYS = [
  "dashboard",
  "create",
  "list",
  "workboard",
  "calendar",
  "meeting",
  "approvals",
  "kpi",
  "supSummary",
  "skillMatrix",
  "flow",
  "orgChart",
  "users",
  "settings"
];

function isViewer(user) {
  return user?.roleCode === "VIEWER";
}

// Missing tables (patch not applied yet) must never break the app: treat them
// as "no overrides", i.e. the permissive default (view all, edit nothing).
function isMissingTable(err) {
  return `${err?.message || ""}`.includes("Invalid object name");
}

// All override rows for a viewer, shaped as
//   { pages: { <pageKey>: { view, edit } }, sections: { <sectionId>: { view, edit } } }.
// Only rows the admin has customised are present; everything else is default.
async function getViewerOverrides(userId) {
  const empty = { pages: {}, sections: {} };
  if (!userId) return empty;
  try {
    const [pageRows, sectionRows] = await Promise.all([
      query("SELECT page_key, can_view, can_edit FROM viewer_page_permissions WHERE user_id = @userId", { userId }),
      query("SELECT section_id, can_view, can_edit FROM viewer_section_permissions WHERE user_id = @userId", { userId })
    ]);
    const pages = {};
    for (const r of pageRows.recordset) {
      pages[r.page_key] = { view: r.can_view === true || r.can_view === 1, edit: r.can_edit === true || r.can_edit === 1 };
    }
    const sections = {};
    for (const r of sectionRows.recordset) {
      sections[r.section_id] = { view: r.can_view === true || r.can_view === 1, edit: r.can_edit === true || r.can_edit === 1 };
    }
    return { pages, sections };
  } catch (err) {
    if (isMissingTable(err)) return empty;
    throw err;
  }
}

// Defaults: view = allowed, edit = denied, unless an override says otherwise.
function pageCanView(overrides, pageKey) {
  const o = overrides?.pages?.[pageKey];
  return o ? o.view : true;
}
function pageCanEdit(overrides, pageKey) {
  const o = overrides?.pages?.[pageKey];
  return o ? o.edit : false;
}
function sectionCanView(overrides, sectionId) {
  const o = overrides?.sections?.[sectionId];
  return o ? o.view : true;
}
function sectionCanEdit(overrides, sectionId) {
  const o = overrides?.sections?.[sectionId];
  return o ? o.edit : false;
}

// A viewer may write on a (page, section) pair only when BOTH grant edit.
function canEdit(overrides, pageKey, sectionId) {
  return pageCanEdit(overrides, pageKey) && sectionCanEdit(overrides, sectionId);
}

// Replace a viewer's overrides. Callers scope what may change:
//   allowPages       — false leaves page overrides untouched (section admins).
//   allowedSectionIds — null = every section; otherwise only these section rows
//                       may be replaced, others are preserved (section admins can
//                       only touch the sections they administer).
async function setViewerOverrides(userId, input, { allowPages = true, allowedSectionIds = null } = {}) {
  const pages = Array.isArray(input?.pages) ? input.pages : [];
  const sections = Array.isArray(input?.sections) ? input.sections : [];

  if (allowPages) {
    await query("DELETE FROM viewer_page_permissions WHERE user_id = @userId", { userId });
    for (const p of pages) {
      if (!VIEWER_PAGE_KEYS.includes(p.pageKey)) continue;
      // Only store real deviations from the default to keep the table sparse.
      const view = p.canView !== false;
      const edit = p.canEdit === true;
      if (view && !edit) continue;
      await query(
        `INSERT INTO viewer_page_permissions (user_id, page_key, can_view, can_edit, updated_at)
         VALUES (@userId, @pageKey, @view, @edit, SYSUTCDATETIME())`,
        { userId, pageKey: p.pageKey, view, edit }
      );
    }
  }

  const scope = allowedSectionIds == null ? null : new Set(allowedSectionIds.map(Number));
  if (scope == null) {
    await query("DELETE FROM viewer_section_permissions WHERE user_id = @userId", { userId });
  }
  for (const s of sections) {
    const sectionId = Number(s.sectionId);
    if (!Number.isInteger(sectionId)) continue;
    if (scope != null && !scope.has(sectionId)) continue;
    if (scope != null) {
      await query("DELETE FROM viewer_section_permissions WHERE user_id = @userId AND section_id = @sectionId", { userId, sectionId });
    }
    const view = s.canView !== false;
    const edit = s.canEdit === true;
    if (view && !edit) continue;
    await query(
      `INSERT INTO viewer_section_permissions (user_id, section_id, can_view, can_edit, updated_at)
       VALUES (@userId, @sectionId, @view, @edit, SYSUTCDATETIME())`,
      { userId, sectionId, view, edit }
    );
  }
}

module.exports = {
  VIEWER_PAGE_KEYS,
  isViewer,
  getViewerOverrides,
  pageCanView,
  pageCanEdit,
  sectionCanView,
  sectionCanEdit,
  canEdit,
  setViewerOverrides
};
