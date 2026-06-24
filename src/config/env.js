require("dotenv").config();

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}

function numberEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid number environment variable: ${name}`);
  return parsed;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function listEnv(name, fallback) {
  return (firstEnv(name, fallback) || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

const frontendOrigins = listEnv("FRONTEND_ORIGINS", "FRONTEND_ORIGIN");

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  apiHost: process.env.API_HOST || "127.0.0.1",
  apiPort: Number(firstEnv("API_PORT", "PORT") || 4310),
  frontendOrigin: frontendOrigins[0] || "http://127.0.0.1:5320",
  frontendOrigins: frontendOrigins.length ? frontendOrigins : ["http://127.0.0.1:5320"],
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  attachmentRoot: process.env.ATTACHMENT_ROOT || "C:\\AutomationProject\\RAP",
  forceHttps: boolEnv("FORCE_HTTPS", false),
  enableHsts: boolEnv("ENABLE_HSTS", false),
  trustProxyHops: numberEnv("TRUST_PROXY_HOPS", 0),
  session: {
    secret: firstEnv("SESSION_SECRET", "JWT_SECRET") || "dev-session-secret-change-me",
    cookieName: process.env.SESSION_COOKIE_NAME || "automation_request_session",
    cookieSecure: boolEnv("SESSION_COOKIE_SECURE", false),
    cookieSameSite: (process.env.SESSION_COOKIE_SAME_SITE || "strict").toLowerCase(),
    idleTimeoutMinutes: numberEnv("SESSION_IDLE_TIMEOUT_MINUTES", 15)
  },
  sql: {
    server: process.env.SQL_SERVER || "127.0.0.1",
    port: Number(process.env.SQL_PORT || 1433),
    database: process.env.SQL_DATABASE || "AutomationRequest",
    user: process.env.SQL_USER || "",
    password: process.env.SQL_PASSWORD || "",
    options: {
      encrypt: String(process.env.SQL_ENCRYPT || "false") === "true",
      trustServerCertificate: String(process.env.SQL_TRUST_SERVER_CERTIFICATE || "true") === "true"
    }
  },
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.SMTP_FROM || ""
  },
  microsoft: {
    clientId: firstEnv("MS365_CLIENT_ID", "MICROSOFT_CLIENT_ID"),
    tenantId: firstEnv("MS365_TENANT_ID", "MICROSOFT_TENANT_ID"),
    clientSecret: firstEnv("MS365_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET"),
    scopes: firstEnv("MS365_SCOPES", "MICROSOFT_SCOPES") || "openid profile email User.Read",
    redirectUri: firstEnv("MS365_REDIRECT_URI", "MICROSOFT_REDIRECT_URI") ||
      "http://127.0.0.1:4310/api/auth/microsoft/callback"
  }
};

module.exports = { env };
