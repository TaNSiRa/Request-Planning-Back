const { isViewer, canEdit } = require("../services/viewerService");

// The single write gate for VIEWER accounts. Mount AFTER resolveSection with the
// page key this router serves, e.g. router.use(blockViewerWrites("settings")).
// [pageKey] may also be a function (req) => key when one router serves writes
// belonging to different pages (e.g. creating a request vs. editing one).
//
// - Non-viewers pass straight through.
// - Reads (GET/HEAD/OPTIONS) always pass — a viewer may read any section it can
//   reach; per-PAGE view scoping is a frontend concern (pages share data, so the
//   backend can't cleanly gate reads per page).
// - A viewer may always edit its own profile (the /me* routes).
// - Any other write passes only when the viewer has an edit grant for BOTH this
//   page and the resolved section. When it does, req.viewerWriteApproved is set
//   so the downstream admin guards (requireSectionAdmin, etc.) let it through.
//
// req.viewerOverrides is attached by resolveSection.
function blockViewerWrites(pageKey) {
  return (req, res, next) => {
    if (!isViewer(req.user)) return next();
    const method = `${req.method}`.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (req.path === "/me" || req.path.startsWith("/me/")) {
      req.viewerWriteApproved = true;
      return next();
    }
    const sectionId = req.section?.id;
    const overrides = req.viewerOverrides || { pages: {}, sections: {} };
    const key = typeof pageKey === "function" ? pageKey(req) : pageKey;
    if (sectionId != null && canEdit(overrides, key, sectionId)) {
      req.viewerWriteApproved = true;
      return next();
    }
    return res.status(403).json({ message: "Your viewer account has read-only access here" });
  };
}

module.exports = { blockViewerWrites };
