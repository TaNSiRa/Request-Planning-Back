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
  nodeEnv: process.env.NODE_ENV,
  apiHost: process.env.API_HOST,
  apiPort: Number(firstEnv("API_PORT", "PORT")),
  frontendOrigin: frontendOrigins[0],
  frontendOrigins: frontendOrigins.length ? frontendOrigins : ["http://172.23.10.51:5320"],
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS),
  attachmentRoot: process.env.ATTACHMENT_ROOT,
  forceHttps: boolEnv("FORCE_HTTPS"),
  enableHsts: boolEnv("ENABLE_HSTS"),
  trustProxyHops: numberEnv("TRUST_PROXY_HOPS"),
  session: {
    secret: firstEnv("SESSION_SECRET", "JWT_SECRET"),
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
