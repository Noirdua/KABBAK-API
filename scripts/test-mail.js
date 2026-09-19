#!/usr/bin/env node
"use strict";

/* SMTP smoke test.
 *
 *   npm run mail:test -- --to you@example.com
 *
 * Loads .env, prints the resolved SMTP settings (never the password), and sends
 * one test message so verification email can be trusted before signup is opened.
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

  console.log("SMTP configured:", configured ? "yes" : "no");
  console.log("  transport:", config.smtpUrl ? "KABBAK_SMTP_URL" : (config.host ? `${config.host}:${config.port}` : "(none)"));
  console.log("  secure:", config.secure);
  console.log("  user:", config.user ? "(set)" : "(none)");
  console.log("  from:", config.from || "(none)");
  console.log("  dev fallback (code in API response):", mail.isDevFallbackEnabled() ? "on" : "off");

  if (!configured) {
    console.error("\nNo SMTP configured. Set KABBAK_SMTP_URL or KABBAK_SMTP_HOST/PORT/USER/PASS plus KABBAK_MAIL_FROM in .env (see .env.example), then retry.");
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
    subject: "KABBAK SMTP test",
    text: "If you received this, KABBAK can send account verification email."
  });

  if (result.delivered) {
    console.log(`\nTest email sent to ${to}. Check the inbox (and spam).`);
    return;
  }

  console.error(`\nSend failed (${result.reason}). Check host/port/credentials and your provider's requirements.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
