/* mail-service.js — outbound email for verification codes and password resets.
 *
 * Pick a transport with KABBAK_MAIL_TRANSPORT=auto|resend|smtp (default auto):
 *
 *   Resend (https://resend.com)
 *     KABBAK_RESEND_API_KEY=re_...
 *     KABBAK_RESEND_API_URL=https://api.resend.com/emails   (optional)
 *
 *   SMTP (nodemailer)
 *     KABBAK_SMTP_URL=smtp://user:pass@host:587
 *     or KABBAK_SMTP_HOST, KABBAK_SMTP_PORT, KABBAK_SMTP_USER, KABBAK_SMTP_PASS,
 *        KABBAK_SMTP_SECURE=1
 *
 * Both need KABBAK_MAIL_FROM="KABBAK <no-reply@example.com>". `auto` prefers
 * Resend when its key is set, otherwise SMTP.
 *
 * When no transport is configured the message is logged instead, and account
 * verification can surface the code in the API response while
 * KABBAK_EMAIL_DEV_FALLBACK is enabled (default: on for non-production).
 */
const RESEND_DEFAULT_URL = "https://api.resend.com/emails";

let cachedTransporter = null;
let cachedTransporterKey = "";

function normalizeList(value) {
  return String(value || "")
    .split(/[\r\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getMailConfig() {
  const secureRaw = String(process.env.KABBAK_SMTP_SECURE || "").trim().toLowerCase();
  const portRaw = Number(String(process.env.KABBAK_SMTP_PORT || "").trim());
  return {
    smtpUrl: String(process.env.KABBAK_SMTP_URL || "").trim(),
    host: String(process.env.KABBAK_SMTP_HOST || "").trim(),
    port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587,
    user: String(process.env.KABBAK_SMTP_USER || "").trim(),
    pass: String(process.env.KABBAK_SMTP_PASS || ""),
    secure: secureRaw === "1" || secureRaw === "true" || secureRaw === "yes",
    resendApiKey: String(process.env.KABBAK_RESEND_API_KEY || "").trim(),
    resendApiUrl: String(process.env.KABBAK_RESEND_API_URL || "").trim() || RESEND_DEFAULT_URL,
    from: String(process.env.KABBAK_MAIL_FROM || "").trim()
  };
}

// auto -> Resend when its key is present, else SMTP.
function resolveTransport(config = getMailConfig()) {
  const requested = String(process.env.KABBAK_MAIL_TRANSPORT || "").trim().toLowerCase();
  if (requested === "resend" || requested === "smtp") {
    return requested;
  }
  if (config.resendApiKey) {
    return "resend";
  }
  if (config.smtpUrl || config.host) {
    return "smtp";
  }
  return "";
}

function isMailConfigured() {
  const config = getMailConfig();
  if (!config.from) {
    return false;
  }
  const transport = resolveTransport(config);
  if (transport === "resend") {
    return Boolean(config.resendApiKey);
  }
  if (transport === "smtp") {
    return Boolean(config.smtpUrl || config.host);
  }
  return false;
}

function isDevFallbackEnabled() {
  const raw = String(process.env.KABBAK_EMAIL_DEV_FALLBACK ?? "").trim().toLowerCase();
  if (raw) {
    return ["1", "true", "yes", "on"].includes(raw);
  }
  return process.env.NODE_ENV !== "production" && !isMailConfigured();
}

function getTransporter() {
  const config = getMailConfig();
  const key = JSON.stringify(config);
  if (cachedTransporter && cachedTransporterKey === key) {
    return cachedTransporter;
  }

  const nodemailer = require("nodemailer");
  cachedTransporter = config.smtpUrl
    ? nodemailer.createTransport(config.smtpUrl)
    : nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined
      });
  cachedTransporterKey = key;
  return cachedTransporter;
}

async function sendViaResend(config, { recipients, subject, text, html }) {
  if (typeof fetch !== "function") {
    throw new Error("the Resend transport needs a runtime with fetch (Node 18+)");
  }
  const response = await fetch(config.resendApiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: config.from,
      to: recipients,
      subject,
      text: text || undefined,
      html: html || undefined
    })
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = String(await response.text()).slice(0, 500);
    } catch (_error) {}
    const error = new Error(`Resend responded ${response.status}${detail ? `: ${detail}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return true;
}

async function sendMail({ to, subject, text, html } = {}) {
  const recipients = normalizeList(to);
  if (!recipients.length) {
    return { delivered: false, reason: "no_recipient" };
  }

  if (!isMailConfigured()) {
    console.warn(`[mail] Email is not configured; would send "${subject}" to ${recipients.join(", ")}\n${text || ""}`);
    return { delivered: false, reason: "not_configured" };
  }

  const config = getMailConfig();
  const transport = resolveTransport(config);
  try {
    if (transport === "resend") {
      await sendViaResend(config, { recipients, subject, text, html });
    } else {
      await getTransporter().sendMail({
        from: config.from,
        to: recipients.join(", "),
        subject,
        text: text || "",
        html: html || undefined
      });
    }
    return { delivered: true, transport };
  } catch (error) {
    console.error(`[mail] Failed to send "${subject}" via ${transport}: ${error?.message || error}`);
    return { delivered: false, reason: "send_failed", transport };
  }
}

module.exports = {
  getMailConfig,
  isMailConfigured,
  isDevFallbackEnabled,
  resolveTransport,
  sendMail
};
