/* email-webhook-service.js — inbound delivery events from an email provider.
 *
 * Resend (and Svix generally) signs webhooks with a `whsec_…` secret:
 *   signed content = "<svix-id>.<svix-timestamp>.<raw body>"
 *   signature      = base64(HMAC-SHA256(base64decode(secret), content))
 * Other providers can post to the generic endpoint with a shared token instead.
 *
 * Events are kept in a small bounded file so the Admin panel can show delivery,
 * bounce, and complaint history without a database.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Overridable so tests can use a scratch file instead of the live store.
const EVENTS_PATH = process.env.KABBAK_EMAIL_EVENTS_PATH
  ? path.resolve(String(process.env.KABBAK_EMAIL_EVENTS_PATH))
  : path.join(storageConfigRoot, "email-events.json");
const MAX_EVENTS = 200;
const SVIX_TOLERANCE_SECONDS = 5 * 60;

function readEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeEvents(events) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  fs.writeFileSync(EVENTS_PATH, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

function recordEmailEvent(event = {}) {
  const record = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    provider: String(event.provider || "unknown").slice(0, 40),
    type: String(event.type || "unknown").slice(0, 80),
    recipient: String(event.recipient || "").slice(0, 320),
    subject: String(event.subject || "").slice(0, 200),
    providerMessageId: String(event.providerMessageId || "").slice(0, 200),
    reason: String(event.reason || "").slice(0, 300)
  };
  const events = readEvents();
  events.unshift(record);
  writeEvents(events.slice(0, MAX_EVENTS));
  return record;
}

function listEmailEvents(limit = 50) {
  const capped = Math.min(MAX_EVENTS, Math.max(1, Number(limit) || 50));
  return readEvents().slice(0, capped);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function safeTokenEqual(expected, provided) {
  return timingSafeEqual(String(expected || ""), String(provided || ""));
}

function svixSignatureValues(headerValue) {
  return String(headerValue || "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^v\d+,/, ""));
}

// Verifies a Svix/Resend webhook signature. Returns false for any mismatch.
function verifySvixSignature({ rawBody, headers = {}, secret = "", nowMs = Date.now() } = {}) {
  const header = (name) => String(headers[name.toLowerCase()] || headers[name] || "").trim();
  const svixId = header("svix-id");
  const svixTimestamp = header("svix-timestamp");
  const svixSignature = header("svix-signature");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  if (!svixId || !svixTimestamp || !svixSignature || !body.length) {
    return false;
  }

  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (skewSeconds > SVIX_TOLERANCE_SECONDS) {
    return false;
  }

  const secretValue = String(secret || "").trim().replace(/^whsec_/, "");
  let key;
  try {
    key = Buffer.from(secretValue, "base64");
  } catch (_error) {
    return false;
  }
  if (!key.length) {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${body.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest("base64");
  return svixSignatureValues(svixSignature).some((value) => safeTokenEqual(value, expected));
}

function extractWebhookToken(request = {}) {
  const headers = request.headers || {};
  const headerToken = String(headers["x-webhook-token"] || headers["x-kabbak-token"] || "").trim();
  if (headerToken) {
    return headerToken;
  }
  const authorization = String(headers.authorization || "").trim();
  if (/^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, "").trim();
  }
  const queryToken = request.query?.token;
  return String(queryToken || "").trim();
}

function firstRecipient(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean).join(", ");
  }
  return String(value || "").trim();
}

function normalizeResendEvent(payload = {}) {
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return {
    provider: "resend",
    type: payload.type,
    recipient: firstRecipient(data.to),
    subject: data.subject,
    providerMessageId: data.email_id || data.id,
    reason: data.bounce?.message || data.reason || data.error?.message || ""
  };
}

function normalizeGenericEvent(payload = {}) {
  return {
    provider: payload.provider || "generic",
    type: payload.type || payload.event || "unknown",
    recipient: firstRecipient(payload.recipient || payload.to || payload.email),
    subject: payload.subject,
    providerMessageId: payload.id || payload.messageId || payload.message_id,
    reason: payload.reason || payload.error || payload.detail || ""
  };
}

module.exports = {
  EVENTS_PATH,
  MAX_EVENTS,
  SVIX_TOLERANCE_SECONDS,
  extractWebhookToken,
  listEmailEvents,
  normalizeGenericEvent,
  normalizeResendEvent,
  recordEmailEvent,
  safeTokenEqual,
  verifySvixSignature
};
