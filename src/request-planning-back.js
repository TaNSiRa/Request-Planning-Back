const compression = require("compression");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const http = require("http");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const { env } = require("./config/env");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { csrfProtection, forceHttps, sessionMiddleware } = require("./services/securityService");
const { registerRealtime } = require("./services/realtimeService");

const authRoutes = require("./modules/auth/auth.routes");
const userRoutes = require("./modules/users/users.routes");
const requestRoutes = require("./modules/requests/requests.routes");
const approvalRoutes = require("./modules/approvals/approvals.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const branchMapRoutes = require("./modules/branchmap/branchmap.routes");
const kpiRoutes = require("./modules/kpi/kpi.routes");
const notificationRoutes = require("./modules/notifications/notifications.routes");
const skillMatrixRoutes = require("./modules/skillmatrix/skillmatrix.routes");
const weeklyPlanRoutes = require("./modules/weeklyplan/weeklyplan.routes");
const healthRoutes = require("./modules/health/health.routes");

const app = express();
if (env.trustProxyHops > 0) app.set("trust proxy", env.trustProxyHops);
const server = http.createServer(app);
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
const io = new Server(server, {
  cors: { origin: env.frontendOrigins, credentials: true },
  path: "/ws"
});
registerRealtime(io);

app.disable("x-powered-by");
app.use(forceHttps);
app.use(helmet({
  crossOriginResourcePolicy: false,
  hsts: env.enableHsts
}));
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: "50mb" }));
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

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/branch-maps", branchMapRoutes);
app.use("/api/kpi", kpiRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/skill-matrix", skillMatrixRoutes);
app.use("/api/weekly-plan", weeklyPlanRoutes);

app.use(notFound);
app.use(errorHandler);

server.listen(env.apiPort, env.apiHost, () => {
  console.log(`Request & Planning API running at http://${env.apiHost}:${env.apiPort}`);
});
