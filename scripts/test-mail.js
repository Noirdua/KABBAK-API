#!/usr/bin/env node
"use strict";

/* Email smoke test (Resend or SMTP).
 *
 *   npm run mail:test -- --to you@example.com
 *
 * Loads .env, prints the resolved transport (never the secret), and sends one
 * test message so verification email can be trusted before signup is opened.
 */
require("dotenv").config();

const mail = require("../src/services/mail-service");

function parseRecipient(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--to" || value === "-t") {
      return String(argv[index + 1] || "").trim();
    }
    if (value.startsWith("--to=")) {
      return value.slice("--to=".length).trim();
    }
  }
  return String(argv.find((entry) => entry.includes("@")) || "").trim();
}

async function main() {
  const config = mail.getMailConfig();
  const configured = mail.isMailConfigured();
  const to = parseRecipient(process.argv.slice(2)) || String(process.env.KABBAK_MAIL_TEST_TO || "").trim();

  const transport = mail.resolveTransport(config);
  console.log("Email configured:", configured ? "yes" : "no");
  console.log("  transport:", transport || "(none)");
  if (transport === "resend") {
    console.log("  endpoint:", config.resendApiUrl);
    console.log("  api key:", config.resendApiKey ? "(set)" : "(none)");
  } else if (transport === "smtp") {
    console.log("  host:", config.smtpUrl ? "KABBAK_SMTP_URL" : (config.host ? `${config.host}:${config.port}` : "(none)"));
    console.log("  secure:", config.secure);
    console.log("  user:", config.user ? "(set)" : "(none)");
  }
  console.log("  from:", config.from || "(none)");
  console.log("  dev fallback (code in API response):", mail.isDevFallbackEnabled() ? "on" : "off");

  if (!configured) {
    console.error("\nNo email transport configured. Set KABBAK_RESEND_API_KEY (recommended) or KABBAK_SMTP_URL / KABBAK_SMTP_HOST+PORT+USER+PASS, plus KABBAK_MAIL_FROM in .env (see .env.example), then retry.");
    process.exitCode = 1;
    return;
  }

  if (!to) {
    console.error("\nProvide a recipient: npm run mail:test -- --to you@example.com");
    process.exitCode = 1;
    return;
  }

  const result = await mail.sendMail({
    to,
    subject: "KABBAK email test",
    text: "If you received this, KABBAK can send account verification email."
  });

  if (result.delivered) {
    console.log(`\nTest email sent to ${to}. Check the inbox (and spam).`);
    return;
  }

  console.error(`\nSend failed (${result.reason}${result.transport ? `, ${result.transport}` : ""}). Check the credentials, the sender (KABBAK_MAIL_FROM must be a verified sender), and your provider's requirements.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
