const crypto = require("crypto");
const https = require("https");
const { env } = require("../config/env");

let cachedKeys = null;
let cachedKeysExpiresAt = 0;

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function parseJwt(token) {
  const parts = `${token || ""}`.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  return {
    header: JSON.parse(base64UrlDecode(parts[0]).toString("utf8")),
    payload: JSON.parse(base64UrlDecode(parts[1]).toString("utf8")),
    signedPart: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2])
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        let body = "";
        response.on("data", chunk => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Microsoft JWKS request failed: ${response.statusCode}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      })
      .on("error", reject);
  });
}

async function getMicrosoftKeys(tenantId) {
  if (cachedKeys && cachedKeysExpiresAt > Date.now()) return cachedKeys;
  const jwks = await getJson(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
  cachedKeys = jwks.keys || [];
  cachedKeysExpiresAt = Date.now() + 60 * 60 * 1000;
  return cachedKeys;
}

function assertMicrosoftConfig() {
  if (!env.microsoft.clientId || !env.microsoft.tenantId) {
    throw new Error("Microsoft 365 login is not configured");
  }
}

function validatePayload(payload) {
  const now = Math.floor(Date.now() / 1000);
  const issuer = `https://login.microsoftonline.com/${env.microsoft.tenantId}/v2.0`;
  if (payload.aud !== env.microsoft.clientId) throw new Error("Invalid token audience");
  if (payload.iss !== issuer) throw new Error("Invalid token issuer");
  if (payload.exp && payload.exp <= now) throw new Error("Expired token");
  if (payload.nbf && payload.nbf > now) throw new Error("Token is not active yet");
}

async function verifyMicrosoftIdToken(token) {
  assertMicrosoftConfig();
  const parsed = parseJwt(token);
  if (parsed.header.alg !== "RS256") throw new Error("Unsupported token algorithm");

  const keys = await getMicrosoftKeys(env.microsoft.tenantId);
  const key = keys.find(candidate => candidate.kid === parsed.header.kid);
  if (!key) throw new Error("Microsoft signing key not found");

  const publicKey = crypto.createPublicKey({ key, format: "jwk" });
  const valid = crypto.verify("RSA-SHA256", Buffer.from(parsed.signedPart), publicKey, parsed.signature);
  if (!valid) throw new Error("Invalid token signature");

  validatePayload(parsed.payload);
  return parsed.payload;
}

module.exports = { verifyMicrosoftIdToken };
