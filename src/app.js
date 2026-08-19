// Express app assembly, split out of request-planning-back.js so tests can
// exercise the full API in-process (supertest) without opening a port,
// starting socket.io, or launching the reminder scheduler.
const compression = require("compression");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { env } = require("./config/env");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { csrfProtection, forceHttps, sessionMiddleware } = require("./services/securityService");
const { requireAuth } = require("./middleware/auth");
const { requirePdpaConsent } = require("./services/pdpa");

const authRoutes = require("./modules/auth/auth.routes");
const userRoutes = require("./modules/users/users.routes");
const requestRoutes = require("./modules/requests/requests.routes");
const approvalRoutes = require("./modules/approvals/approvals.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const branchMapRoutes = require("./modules/branchmap/branchmap.routes");
const kpiRoutes = require("./modules/kpi/kpi.routes");
const notificationRoutes = require("./modules/notifications/notifications.routes");
const skillMatrixRoutes = require("./modules/skillmatrix/skillmatrix.routes");
const orgChartRoutes = require("./modules/orgchart/orgchart.routes");
const weeklyPlanRoutes = require("./modules/weeklyplan/weeklyplan.routes");
const personalTodoRoutes = require("./modules/personaltodo/personaltodo.routes");
const healthRoutes = require("./modules/health/health.routes");

function createApp() {
  const app = express();
  if (env.trustProxyHops > 0) app.set("trust proxy", env.trustProxyHops);

  const corsOptions = {
    origin(origin, callback) {
      if (!origin || env.frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  };

  app.disable("x-powered-by");
  app.use(forceHttps);
  // helmet's default CSP allows the whole `https:` scheme for fonts and styles.
  // Nothing here loads either from anywhere — the API only ever answers JSON —
  // so the policy is written out with no scheme-wide sources in it.
  //
  // Scope worth being clear about: this header rides on API RESPONSES. The page
  // that actually runs scripts is index.html, which nginx serves, so the SPA's
  // own policy lives in frontend/web/index.html (and should be repeated as a
  // header in the nginx config — see docs/security.md).
  app.use(helmet({
    crossOriginResourcePolicy: false,
    hsts: env.enableHsts,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        fontSrc: ["'none'"],
        connectSrc: ["'self'"]
      }
    }
  }));
  // Helmet does not ship a Permissions-Policy, and the standard asks for the
  // powerful features to be switched off explicitly. Nothing in this app uses
  // any of them, so the whole list is denied.
  app.use((req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
      "magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=()"
    );
    next();
  });
  app.use(cors(corsOptions));
  app.use(compression());

  // Body ceilings. Attachments travel as base64 inside the JSON body, so the
  // two paths that receive them are parsed with the larger limit and everything
  // else with the tighter one.
  //
  // ORDER MATTERS: the wider parsers are mounted FIRST. body-parser consumes
  // the stream and sets req._body, and the general parser below then returns
  // immediately for anything already parsed. Mounted the other way round the
  // 5MB parser would read — and reject — the upload before the 10MB one ever
  // ran, so the path limit would do nothing.
  const uploadJson = express.json({ limit: `${env.uploadBodyLimitMb}mb` });
  app.use("/api/requests", uploadJson);
  app.use("/api/branch-maps", uploadJson);
  app.use(express.json({ limit: `${env.bodyLimitMb}mb` }));
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    // Return JSON (not plain text) so the frontend can parse the error body.
    message: { message: "Too many requests, please slow down and try again shortly." }
  }));
  app.use(sessionMiddleware());
  app.use(csrfProtection);

  // Open to a signed-in account that has not consented yet: /health needs no
  // account at all, and /auth is how the consent page is reached, accepted and
  // left. Everything below them is closed until consent is on record — see
  // services/pdpa.js. Each business router runs requireAuth itself, so the gate
  // is mounted inside them rather than here (it needs req.user).
  app.use("/api/health", healthRoutes);
  app.use("/api/auth", authRoutes);

  const guarded = [
    ["/api/users", userRoutes],
    ["/api/requests", requestRoutes],
    ["/api/approvals", approvalRoutes],
    ["/api/settings", settingsRoutes],
    ["/api/branch-maps", branchMapRoutes],
    ["/api/kpi", kpiRoutes],
    ["/api/notifications", notificationRoutes],
    ["/api/skill-matrix", skillMatrixRoutes],
    ["/api/org-chart", orgChartRoutes],
    ["/api/weekly-plan", weeklyPlanRoutes],
    ["/api/personal-todo", personalTodoRoutes]
  ];
  for (const [path, router] of guarded) app.use(path, requireAuth, requirePdpaConsent, router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
