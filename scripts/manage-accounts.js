#!/usr/bin/env node
"use strict";

/* Accounts and API-client admin CLI (the two used to be separate scripts).
 *
 *   npm run accounts -- list
 *   npm run accounts -- show @maya
 *   npm run accounts -- passwd @maya
 *   npm run accounts -- rekey @maya
 *   npm run accounts -- clients add --name "Discord bot"
 *
 * Accounts are self-serve trial logins from /auth/signup; each owns exactly one
 * hidden trial client. API clients are the operator/bot/admin keys in the
 * managed registry. `npm run clients` is now an alias for this CLI.
 *
 * Client add/set/remove/rekey are delegated to scripts/manage-api-clients.js so
 * there is a single implementation and the legacy flags/output stay stable.
 */
const crypto = require("node:crypto");

const accounts = require("../src/services/account-service");
const {
  readManagedApiClients,
  rotateManagedApiClientKey
} = require("../src/services/api-client-registry");
const { accountsPath, managedApiClientsPath } = require("../src/config/paths");
const {
  ACCESS_LEVELS,
  DEFAULT_CLIENT_ACCESS_LEVEL
} = require("../src/config/api-access");
const clientsCli = require("./manage-api-clients");

const CLI_NAME = "npm run accounts --";

const FLAG_ALIASES = new Map([
  ["--file", "file"],
  ["-file", "file"],
  ["-f", "file"],
  ["--accounts-file", "accountsFile"],
  ["-accountsfile", "accountsFile"],
  ["--id", "id"],
  ["-id", "id"],
  ["--name", "name"],
  ["-name", "name"],
  ["--key", "key"],
  ["-key", "key"],
  ["--account-id", "accountId"],
  ["-accountid", "accountId"],
  ["--accountid", "accountId"],
  ["--access", "access"],
  ["-access", "access"],
  ["--access-level", "access"],
  ["--accesslevel", "access"],
  ["-accesslevel", "access"],
  ["--roles", "roles"],
  ["-roles", "roles"],
  ["--scopes", "scopes"],
  ["-scopes", "scopes"],
  ["--password", "password"],
  ["-password", "password"],
  ["--account", "account"],
  ["-account", "account"],
  ["--client", "client"],
  ["-client", "client"],
  ["--username", "username"],
  ["-username", "username"],
  ["--user", "username"],
  ["-user", "username"]
]);

function parseFlags(argv) {
  const values = {};
  const provided = new Set();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] ?? "");
    const target = FLAG_ALIASES.get(raw.toLowerCase());
    if (target) {
      values[target] = String(argv[index + 1] ?? "").trim();
      provided.add(target);
      index += 1;
      continue;
    }
    if (raw.trim()) {
      positionals.push(raw.trim());
    }
  }

  return { values, provided, positionals };
}

function pathsFor(values = {}) {
  return {
    accountsFile: values.accountsFile || accountsPath,
    clientsFile: values.file || managedApiClientsPath
  };
}

function maskApiKey(apiKey) {
  const value = String(apiKey || "").trim();
  if (!value) return "";
  if (value.length <= 6) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function stripAt(selector) {
  const value = String(selector || "").trim();
  return value.startsWith("@") ? value.slice(1) : value;
}

function resolveAccount(selector, { accountsFile }) {
  const value = stripAt(selector);
  if (!value) return null;
  if (value.startsWith("acc_")) {
    return accounts.getAccountById(value, { filePath: accountsFile });
  }
  return accounts.findAccountByIdentifier(value, { filePath: accountsFile });
}

function resolveClient(selector, { clientsFile }) {
  const value = stripAt(selector);
  if (!value) return null;
  const list = readManagedApiClients({ filePath: clientsFile });
  const byId = list.find((client) => client.id === value);
  if (byId) return byId;
  const byName = list.filter((client) => client.name === value);
  if (byName.length > 1) {
    throw new Error(`Multiple clients are named '${value}'. Pass the client id instead.`);
  }
  return byName[0] || null;
}

// A bare selector is an account id, username, or email first, then a client id
// or unique client name. Use --account/--client to force one side.
function resolveTarget({ values, provided, positionals }, paths) {
  // Legacy `-Id`/`-Name` flags count as selectors too, so `npm run clients --`
  // style calls keep working against the merged CLI.
  const selector = provided.has("account")
    ? values.account
    : provided.has("client")
      ? values.client
      : (positionals[0] || values.id || values.username || values.name || "");
  const forced = provided.has("account") ? "account" : provided.has("client") ? "client" : "";

  if (!selector) {
    throw new Error("Which account or client? Pass an id, username, email, or client name.");
  }

  if (forced === "account" || selector.startsWith("acc_")) {
    const account = resolveAccount(selector, paths);
    if (!account) throw new Error(`No account matches '${selector}'.`);
    return { kind: "account", account };
  }
  if (forced === "client" || selector.startsWith("cli_")) {
    const client = resolveClient(selector, paths);
    if (!client) throw new Error(`No client matches '${selector}'.`);
    return { kind: "client", client };
  }

  const account = resolveAccount(selector, paths);
  if (account) return { kind: "account", account };
  const client = resolveClient(selector, paths);
  if (client) return { kind: "client", client };
  throw new Error(`No account or client matches '${selector}'.`);
}

function printAccounts({ accountsFile, clientsFile }) {
  const rows = accounts.listAccounts({ filePath: accountsFile, clientsFilePath: clientsFile });
  const shownPath = accountsFile === accountsPath
    ? "storage/config/accounts.json"
    : accountsFile;
  console.log(`Trial accounts: ${shownPath}`);
  if (!rows.length) {
    console.log("  (none)");
    return;
  }
  rows.forEach((entry) => {
    const trial = entry.trial || null;
    const trialState = entry.trialActive ? "active" : entry.keyPresent ? "expired" : "no key";
    // Labelled fields so an id/username can be copied straight into a command.
    console.log([
      `id=${entry.id}`,
      `username=@${entry.username}`,
      `email=${entry.email}`,
      `verified=${entry.emailVerified ? "yes" : "no"}`,
      `status=${entry.status || "active"}`,
      `trial=${trialState}`,
      `expires=${trial?.expiresAt || "-"}`,
      `client=${trial?.clientId || "-"}`
    ].join("  "));
  });
}

function runList(rest) {
  const { values, positionals } = parseFlags(rest);
  const paths = pathsFor(values);
  const which = String(positionals[0] || "all").toLowerCase();
  if (!["all", "accounts", "clients"].includes(which)) {
    throw new Error(`Unknown list target '${which}'. Use accounts, clients, or all.`);
  }

  if (which === "all" || which === "accounts") {
    printAccounts(paths);
  }
  if (which === "all" || which === "clients") {
    if (which === "all") console.log("");
    return clientsCli.run(["list", "-File", paths.clientsFile]);
  }
  return 0;
}

function describeAccount(account, paths) {
  const trial = account.trial || null;
  console.log(`Account ${account.id}`);
  console.log(`  Username:   @${account.username}`);
  console.log(`  Email:      ${account.email}`);
  console.log(`  Status:     ${account.status || "active"} (${account.emailVerified ? "email verified" : "email unverified"})`);
  console.log(`  Created:    ${account.createdAt || "-"}`);
  console.log(`  Last login: ${account.lastLoginAt || "-"}`);
  if (!trial) {
    console.log("  Trial:      none");
    return;
  }
  const client = readManagedApiClients({ filePath: paths.clientsFile })
    .find((entry) => entry.id === trial.clientId) || null;
  console.log(`  Trial:      ${trial.accessLevel || "-"} key, expires ${trial.expiresAt || "-"}`);
  console.log(`  Client:     ${trial.clientId || "-"}`);
  console.log(`  API key:    ${client ? `present (${maskApiKey(client.key)})` : "missing from the registry"}`);
}

function describeClient(client) {
  console.log(`Client ${client.id}`);
  console.log(`  Name:    ${client.name || "-"}`);
  console.log(`  Account: ${client.accountId || "-"}`);
  console.log(`  Access:  ${client.accessLevel || "-"}`);
  console.log(`  Roles:   ${(client.roles || []).join(",") || "-"}`);
  console.log(`  Scopes:  ${(client.scopes || []).join(",") || "-"}`);
  console.log(`  Hidden:  ${client.hidden ? "yes" : "no"}`);
  console.log(`  Expires: ${client.expiresAt || "never"}`);
  console.log(`  Key:     ${maskApiKey(client.key)}`);
}

function runShow(rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const target = resolveTarget(parsed, paths);
  if (target.kind === "account") {
    describeAccount(target.account, paths);
  } else {
    describeClient(target.client);
  }
  return 0;
}

function runRekey(rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const target = resolveTarget(parsed, paths);

  if (target.kind === "account") {
    const trialClientId = target.account.trial?.clientId || "";
    if (!trialClientId) {
      throw new Error(`Account @${target.account.username} has no trial key yet (signup not verified?).`);
    }
    const result = rotateManagedApiClientKey(trialClientId, { filePath: paths.clientsFile });
    console.log(`Rotated the trial API key for @${target.account.username} (${target.account.id}).`);
    console.log(`  New key: ${result.client.key}`);
    console.log("");
    console.log("Copy the key now — it is shown in full only once.");
    return 0;
  }

  return clientsCli.run(["rekey", "-File", paths.clientsFile, "-Id", target.client.id]);
}

function runVerify(rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const target = resolveTarget(parsed, paths);
  if (target.kind !== "account") {
    throw new Error("verify applies to trial accounts only.");
  }

  const result = accounts.verifyAccountManually(target.account.id, {
    filePath: paths.accountsFile,
    clientsFilePath: paths.clientsFile
  });

  console.log(`Verified account @${target.account.username} (${target.account.id}).`);
  if (result.trial?.apiKey) {
    console.log(`  Trial:     ${result.trial.accessLevel || "-"} until ${result.trial.expiresAt || "-"}`);
    console.log(`  Client:    ${result.trial.clientId || "-"}`);
    console.log(`  API key:   ${result.trial.apiKey}`);
    console.log("");
    console.log("Copy the key now — it is shown in full only once.");
  }
  return 0;
}

function generatePassword() {
  return crypto.randomBytes(12).toString("base64url");
}

function runPasswd(rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const target = resolveTarget(parsed, paths);

  if (target.kind !== "account") {
    throw new Error("passwd applies to trial accounts only. Use `rekey` for an API client key.");
  }

  const password = parsed.provided.has("password") ? parsed.values.password : generatePassword();
  const result = accounts.setAccountPassword(target.account.id, password, { filePath: paths.accountsFile });
  if (!result.updated) {
    throw new Error(`No account '${target.account.id}'.`);
  }

  // Reset also signs other devices out by rotating the trial key.
  let rotatedKey = "";
  const trialClientId = target.account.trial?.clientId || "";
  if (trialClientId) {
    try {
      rotatedKey = rotateManagedApiClientKey(trialClientId, { filePath: paths.clientsFile }).client.key;
    } catch (_error) {
      rotatedKey = "";
    }
  }

  console.log(`Set a new password for @${target.account.username} (${target.account.id}).`);
  console.log(`  Password: ${password}`);
  if (rotatedKey) {
    console.log(`  New API key: ${rotatedKey}`);
    console.log("");
    console.log("The previous trial key is invalid; devices signed in with it are logged out.");
  }
  console.log("");
  console.log("Copy these now — they are shown in full only once.");
  return 0;
}

function runRemove(rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const target = resolveTarget(parsed, paths);

  if (target.kind === "account") {
    const result = accounts.removeAccount(target.account.id, {
      filePath: paths.accountsFile,
      clientsFilePath: paths.clientsFile
    });
    if (!result.removed) {
      throw new Error(`No account '${target.account.id}'.`);
    }
    console.log(`Removed account @${target.account.username} (${target.account.id}) and revoked its trial key.`);
    return 0;
  }

  return clientsCli.run(["remove", "-File", paths.clientsFile, "-Id", target.client.id]);
}

// Delegate client work to the legacy CLI so there is one implementation.
function runClientCommand(command, rest) {
  const parsed = parseFlags(rest);
  const paths = pathsFor(parsed.values);
  const args = [command, "-File", paths.clientsFile];

  if (parsed.provided.has("id")) args.push("-Id", parsed.values.id);
  if (parsed.provided.has("key")) args.push("-Key", parsed.values.key);
  if (parsed.provided.has("name")) args.push("-Name", parsed.values.name);
  if (parsed.provided.has("accountId")) args.push("-AccountId", parsed.values.accountId);
  if (parsed.provided.has("access")) args.push("-AccessLevel", parsed.values.access);
  if (parsed.provided.has("roles")) args.push("-Roles", parsed.values.roles);
  if (parsed.provided.has("scopes")) args.push("-Scopes", parsed.values.scopes);

  return clientsCli.run(args);
}

function printHelp() {
  console.log([
    "KABBAK accounts and API clients",
    "",
    `  Usage: ${CLI_NAME} <command> [options]`,
    "",
    "  Accounts (self-serve trial logins)",
    "    list accounts                List trial accounts",
    "    show <id|@username|email>    Show one account and its trial key",
    "    passwd <id|@username>        Set a new password and rotate the trial key",
    "    verify <id|@username>        Verify by hand and issue the trial key (no email needed)",
    "    rekey <id|@username>         Rotate the trial API key",
    "    remove <id|@username>        Delete the account and revoke its key",
    "",
    "  API clients (operator, bot, and admin keys)",
    "    list clients                 List managed API clients",
    "    add --name <name> [--access <level>] [--roles a,b] [--scopes a,b]",
    "    set --id <id> [--name] [--access] [--roles] [--scopes]",
    "    rekey --id <id>              Rotate a client key",
    "    remove --id <id>             Delete a client",
    "",
    "  Both",
    "    list                         List accounts and clients",
    "    show <name>                  A bare name resolves to an account, then a client",
    "    help [command|tiers]         This help, one command, or tiers/roles",
    "",
    "  Selectors",
    "    Accounts: an id (acc_…), @username, or email — e.g. `verify @mark`.",
    "    Clients:  an id (cli_…) or a unique name.",
    "    Long form: --account <x> / --client <x> / --username <x> force the kind.",
    "    In PowerShell quote the handle, or it is read as a splat: verify \"@mark\".",
    "",
    "  Options",
    "    --file <path>                Managed clients file (default storage/config/api-clients.json)",
    "    --accounts-file <path>       Accounts file (default storage/config/accounts.json)",
    "    --password <value>           passwd: set this password instead of generating one",
    "    --account <selector>         Force account resolution",
    "    --client <selector>          Force client resolution",
    "    --username <name>            Account selector (same as @name)",
    "",
    `  Access levels: ${ACCESS_LEVELS.join(", ")} (default ${DEFAULT_CLIENT_ACCESS_LEVEL}).`,
    "  Tiers and roles: " + `${CLI_NAME} help tiers`,
    "",
    "  Notes",
    "    - Full API keys and generated passwords print once. Copy them right away.",
    "    - passwd and rekey change the account's API key, signing other devices out.",
    "    - The registry is re-read within a couple of seconds; no server restart needed."
  ].join("\n"));
}

function main(argv) {
  const [command, ...rest] = argv;
  const normalized = String(command || "").toLowerCase();

  if (!normalized || normalized === "help" || normalized === "--help" || normalized === "-h") {
    const topic = String(rest[0] || "").toLowerCase();
    if (topic === "tiers" || topic === "roles" || topic === "admin") {
      clientsCli.printCommandHelp("tiers");
      return 0;
    }
    printHelp();
    return 0;
  }

  switch (normalized) {
    case "list":
      return runList(rest);
    case "show":
      return runShow(rest);
    case "rekey":
      return runRekey(rest);
    case "passwd":
    case "reset-password":
    case "reset":
      return runPasswd(rest);
    case "verify":
      return runVerify(rest);
    case "add":
      return runClientCommand("add", rest);
    case "set":
    case "upsert":
      return runClientCommand("upsert", rest);
    case "remove":
    case "delete":
      return runRemove(rest);
    case "clients": {
      const [subCommand, ...subRest] = rest;
      return runClientCommand(String(subCommand || "list").toLowerCase(), subRest);
    }
    case "tiers":
      clientsCli.printCommandHelp("tiers");
      return 0;
    default:
      throw new Error(`Unknown command '${command}'.`);
  }
}

function run(argv = process.argv.slice(2)) {
  try {
    return main(argv);
  } catch (error) {
    console.error(error?.message || error);
    console.error("");
    console.error(`Run \`${CLI_NAME} help\` for usage.`);
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exitCode = run();
}
