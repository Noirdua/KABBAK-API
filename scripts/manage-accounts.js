#!/usr/bin/env node
"use strict";

/* Trial-account admin CLI.
 *
 *   npm run accounts -- list
 *   npm run accounts -- remove <accountId>
 *
 * Accounts are created by self-serve signup (/auth/signup). Listing shows the
 * trial client and its expiry; removing deletes the account and revokes its key.
 */
const accounts = require("../src/services/account-service");

function printHelp() {
  console.log([
    "KABBAK trial accounts",
    "",
    "  npm run accounts -- list",
    "  npm run accounts -- remove <accountId>",
    ""
  ].join("\n"));
}

function trialLabel(entry) {
  if (!entry.trial) return "no trial";
  if (!entry.keyPresent) return "key missing";
  return entry.trialActive ? "active" : "expired";
}

function list() {
  const rows = accounts.listAccounts();
  if (!rows.length) {
    console.log("No trial accounts yet.");
    return;
  }

  rows.forEach((entry) => {
    const expires = entry.trial?.expiresAt || "-";
    const clientId = entry.trial?.clientId || "-";
    const verified = entry.emailVerified ? "verified" : "unverified";
    console.log(`${entry.id}  ${entry.username}  <${entry.email}>  ${verified}  [${trialLabel(entry)}]  expires=${expires}  client=${clientId}`);
  });
}

function remove(accountId) {
  const result = accounts.removeAccount(accountId);
  if (!result.removed) {
    console.error(`No trial account with id '${accountId}'.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Removed ${result.account.email} (${result.account.id}) and revoked its trial key.`);
}

function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "list") {
    list();
    return;
  }

  if (command === "remove" || command === "delete") {
    const accountId = String(rest[0] || "").trim();
    if (!accountId) {
      console.error("Usage: npm run accounts -- remove <accountId>");
      process.exitCode = 1;
      return;
    }
    remove(accountId);
    return;
  }

  console.error(`Unknown command '${command}'.`);
  printHelp();
  process.exitCode = 1;
}

main(process.argv.slice(2));
