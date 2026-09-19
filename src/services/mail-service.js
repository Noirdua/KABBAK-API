/* mail-service.js — outbound email for verification codes.
 *
 * Configure with a single URL:
 *   KABBAK_SMTP_URL=smtp://user:pass@host:587
 * or discrete vars:
 *   KABBAK_SMTP_HOST, KABBAK_SMTP_PORT, KABBAK_SMTP_USER, KABBAK_SMTP_PASS,
 *   KABBAK_SMTP_SECURE=1
 * plus KABBAK_MAIL_FROM="KABBAK <no-reply@example.com>".
 *
 * When SMTP is not configured the message is logged instead, and account
 * verification can surface the code in the API response while
 * KABBAK_EMAIL_DEV_FALLBACK is enabled (default: on for non-production).
 */
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
    from: String(process.env.KABBAK_MAIL_FROM || "").trim()
  };
}

function isMailConfigured() {
  const config = getMailConfig();
  return Boolean((config.smtpUrl || config.host) && config.from);
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

async function sendMail({ to, subject, text, html } = {}) {
  const recipients = normalizeList(to);
  if (!recipients.length) {
    return { delivered: false, reason: "no_recipient" };
  }

  if (!isMailConfigured()) {
    console.warn(`[mail] SMTP is not configured; would send "${subject}" to ${recipients.join(", ")}\n${text || ""}`);
    return { delivered: false, reason: "not_configured" };
  }

  try {
    const config = getMailConfig();
    await getTransporter().sendMail({
      from: config.from,
      to: recipients.join(", "),
      subject,
      text: text || "",
      html: html || undefined
    });
    return { delivered: true };
  } catch (error) {
    console.error(`[mail] Failed to send "${subject}": ${error?.message || error}`);
    return { delivered: false, reason: "send_failed" };
  }
}

module.exports = {
  getMailConfig,
  isMailConfigured,
  isDevFallbackEnabled,
  sendMail
};
