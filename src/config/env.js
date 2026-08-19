const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

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

// A secret with no value must stop the process, not quietly borrow another one.
// SESSION_SECRET used to fall back to JWT_SECRET, which meant a host where
// someone left it blank signed session cookies with the same key that signs
// bearer tokens — one leak costing both, and no sign anywhere that it had
// happened. Failing at startup is the only version of this a person notices.
function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || `${value}`.trim() === "") {
    throw new Error(`Refusing to start: ${name} is required (see .env.example)`);
  }
  return value;
}

const frontendOrigins = listEnv("FRONTEND_ORIGINS", "FRONTEND_ORIGIN");

const env = {
  nodeEnv: process.env.NODE_ENV,
  apiHost: process.env.API_HOST,
  apiPort: Number(firstEnv("API_PORT", "PORT")),
  frontendOrigin: frontendOrigins[0],
  frontendOrigins: frontendOrigins,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS),
  // Failed sign-ins allowed from one IP per 15 minutes (Control 16, R16.2).
  loginRateLimitMax: numberEnv("LOGIN_RATE_LIMIT_MAX", 5),
  attachmentRoot: process.env.ATTACHMENT_ROOT,
  // Request body ceilings, in MB. The security standard caps a JSON body at
  // 10MB, and at 5MB for anything that does not carry an upload — so the
  // ordinary limit is the tighter one and only the two routers that receive
  // base64 file payloads (requests, branch maps) get the larger one.
  bodyLimitMb: numberEnv("JSON_BODY_LIMIT_MB", 5),
  uploadBodyLimitMb: numberEnv("UPLOAD_BODY_LIMIT_MB", 10),
  // Per-file ceiling for one attachment, in MB of ACTUAL file bytes. A data URL
  // is base64, so it arrives about 4/3 the size of the file it carries — this
  // is checked against the decoded buffer, not the string.
  maxAttachmentMb: numberEnv("MAX_ATTACHMENT_MB", 6),
  forceHttps: boolEnv("FORCE_HTTPS"),
  enableHsts: boolEnv("ENABLE_HSTS"),
  trustProxyHops: numberEnv("TRUST_PROXY_HOPS"),
  session: {
    secret: requiredEnv("SESSION_SECRET"),
    cookieName: process.env.SESSION_COOKIE_NAME,
    cookieSecure: boolEnv("SESSION_COOKIE_SECURE"),
    cookieSameSite: (process.env.SESSION_COOKIE_SAME_SITE).toLowerCase(),
    idleTimeoutMinutes: numberEnv("SESSION_IDLE_TIMEOUT_MINUTES")
  },
  sql: {
    server: process.env.SQL_SERVER,
    port: Number(process.env.SQL_PORT),
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: String(process.env.SQL_ENCRYPT) === "true",
      trustServerCertificate: String(process.env.SQL_TRUST_SERVER_CERTIFICATE) === "true"
    }
  },
  // Read-only external DB holding company holidays (e.g. the SAR system's
  // Master_Holiday table). May live on a different host/database. Credentials +
  // port come from env; host/database/table can be overridden in Settings.
  holiday: {
    server: firstEnv("HOLIDAY_SQL_SERVER", "HOLIDAY_SQL_HOST"),
    port: Number(process.env.HOLIDAY_SQL_PORT || 1433),
    database: process.env.HOLIDAY_SQL_DATABASE || "",
    user: process.env.HOLIDAY_SQL_USER || "",
    password: process.env.HOLIDAY_SQL_PASSWORD || "",
    table: process.env.HOLIDAY_SQL_TABLE || "Master_Holiday",
    dateColumn: process.env.HOLIDAY_SQL_DATE_COLUMN || "HolidayDate",
    options: {
      encrypt: String(process.env.HOLIDAY_SQL_ENCRYPT) === "true",
      trustServerCertificate: String(process.env.HOLIDAY_SQL_TRUST_SERVER_CERTIFICATE) === "true"
    }
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE) === "true",
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM
  },
  microsoft: {
    clientId: firstEnv("MS365_CLIENT_ID", "MICROSOFT_CLIENT_ID"),
    tenantId: firstEnv("MS365_TENANT_ID", "MICROSOFT_TENANT_ID"),
    clientSecret: firstEnv("MS365_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET"),
    scopes: firstEnv("MS365_SCOPES", "MICROSOFT_SCOPES"),
    redirectUri: firstEnv("MS365_REDIRECT_URI", "MICROSOFT_REDIRECT_URI")
  }
};

module.exports = { env };
