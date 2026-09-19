/* auth-secret.js — HMAC key for signed captcha and email-verification tokens.
 * Prefers KABBAK_AUTH_SECRET, then a generated secret persisted under
 * storage/config/auth-secret.json so tokens survive restarts. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");
const { writeFileAtomicSync } = require("../lib/atomic-file");

const AUTH_SECRET_PATH = path.join(storageConfigRoot, "auth-secret.json");
let cachedSecret = "";

function getAuthSecret() {
  if (cachedSecret) {
    return cachedSecret;
  }

  const envSecret = String(process.env.KABBAK_AUTH_SECRET || "").trim();
  if (envSecret) {
    cachedSecret = envSecret;
    return cachedSecret;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_SECRET_PATH, "utf8"));
    const stored = String(parsed?.secret || "").trim();
    if (stored) {
      cachedSecret = stored;
      return cachedSecret;
    }
  } catch (_error) {}

  const generated = crypto.randomBytes(32).toString("base64url");
  try {
    writeFileAtomicSync(
      AUTH_SECRET_PATH,
      `${JSON.stringify({ secret: generated, createdAt: new Date().toISOString() }, null, 2)}\n`
    );
  } catch (_error) {}
  cachedSecret = generated;
  return cachedSecret;
}

function signToken(payload, { ttlMs = 0 } = {}) {
  const body = { ...payload };
  if (ttlMs > 0) {
    body.exp = Date.now() + ttlMs;
  }
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getAuthSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  const raw = String(token || "");
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }

  const encoded = raw.slice(0, separator);
  const signature = Buffer.from(raw.slice(separator + 1));
  const expected = Buffer.from(crypto.createHmac("sha256", getAuthSecret()).update(encoded).digest("base64url"));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return null;
  }

  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (_error) {
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.exp && Date.now() > Number(payload.exp)) {
    return null;
  }
  return payload;
}

module.exports = {
  AUTH_SECRET_PATH,
  getAuthSecret,
  signToken,
  verifyToken
};
