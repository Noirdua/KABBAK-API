const {
  managedApiClientsPath
} = require("../src/config/paths");
const {
  generateManagedApiClientId,
  generateManagedApiClientKey,
  readManagedApiClients,
  removeManagedApiClient,
  rotateManagedApiClientKey,
  upsertManagedApiClient
} = require("../src/services/api-client-registry");
const {
  ACCESS_LEVELS,
  DEFAULT_CLIENT_ACCESS_LEVEL,
  normalizeAccessLevel
} = require("../src/config/api-access");

function parseArguments(argv) {
  const values = {
    filePath: managedApiClientsPath,
    id: "",
    key: "",
    name: "",
    accountId: "",
    accessLevel: "",
    roles: "",
    scopes: ""
  };
  const provided = new Set();

  const keyMap = new Map([
    ["-file", "filePath"],
    ["--file", "filePath"],
    ["-id", "id"],
    ["--id", "id"],
    ["-key", "key"],
    ["--key", "key"],
    ["-name", "name"],
    ["--name", "name"],
    ["-accountid", "accountId"],
    ["--account-id", "accountId"],
    ["--accountid", "accountId"],
    ["-access", "accessLevel"],
    ["--access", "accessLevel"],
    ["-accesslevel", "accessLevel"],
    ["--access-level", "accessLevel"],
    ["--accesslevel", "accessLevel"],
    ["-roles", "roles"],
    ["--roles", "roles"],
    ["-scopes", "scopes"],
    ["--scopes", "scopes"]
  ]);

  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const rawArgument = String(argv[index] || "").trim();
    if (!rawArgument) {
      continue;
    }

    const normalizedArgument = rawArgument.toLowerCase();
    if (keyMap.has(normalizedArgument)) {
      const targetKey = keyMap.get(normalizedArgument);
      values[targetKey] = String(argv[index + 1] || "").trim();
      provided.add(targetKey);
      index += 1;
      continue;
    }

    positionals.push(normalizedArgument);
  }

  return {
    command: positionals[0] || "",
    subCommand: positionals[1] || "",
    values,
    provided
  };
}

const CLI_NAME = "npm run clients --";

function printSection(title) {
  console.log("");
  console.log(`  ${title}`);
}

function printOptionLine(flag, description) {
  console.log(`    ${flag.padEnd(24)} ${description}`);
}

const COMMAND_DOCS = {
  list: {
    summary: "Show every managed API client (keys are masked).",
    usage: `${CLI_NAME} list [--file <path>]`,
    options: [
      ["--file <path>", "Registry file to read. Defaults to the managed clients file."]
    ],
    example: `${CLI_NAME} list`
  },
  add: {
    summary: "Create a new client. The id and API key are generated for you and the full key is shown once.",
    usage: `${CLI_NAME} add --name <name> [--access <level>] [--account-id <id>] [--roles <a,b>] [--scopes <a,b>] [--file <path>]`,
    options: [
      ["--name <name>", "(required) Friendly name for the client."],
      [`--access <level>`, `Access level: ${ACCESS_LEVELS.join(" | ")} (default ${DEFAULT_CLIENT_ACCESS_LEVEL}).`],
      ["--account-id <id>", "Optional account id for this client."],
      ["--roles <a,b>", "Roles, e.g. admin. Defaults come from the access level."],
      ["--scopes <a,b>", "Scopes, e.g. api:admin. Defaults come from the access level."]
    ],
    example: `${CLI_NAME} add --name "Mystic Maya" --access pro+ --roles admin`
  },
  rekey: {
    summary: "Generate a replacement key for a client that lost theirs. The old key stops working immediately and the new key is shown once.",
    usage: `${CLI_NAME} rekey --id <id> | --name <name> [--file <path>]`,
    options: [
      ["--id <id>", "The client id to rekey."],
      ["--name <name>", "Alternative lookup by name (must be unique)."]
    ],
    example: `${CLI_NAME} rekey --name "Mystic Maya"`
  },
  upsert: {
    summary: "Update an existing client (or create one with a known id). Only the flags you pass are changed.",
    usage: `${CLI_NAME} upsert --id <id> [--key <key>] [--name <name>] [--account-id <id>] [--access <level>] [--roles <a,b>] [--scopes <a,b>] [--file <path>]`,
    options: [
      ["--id <id>", "(required) Client id to update or create."],
      ["--key <key>", "Set the key directly (rarely needed)."],
      ["--name <name>", "Rename the client."],
      ["--access <level>", `Access level: ${ACCESS_LEVELS.join(" | ")}.`],
      ["--roles <a,b>", "Set roles. Use `admin` to grant the Admin panel."],
      ["--scopes <a,b>", "Set scopes. Use `api:admin` to grant the Admin panel."]
    ],
    example: `${CLI_NAME} upsert --id cli_818c822b5ad3191a --roles admin`
  },
  remove: {
    summary: "Delete a client. Their key, profile, and API access stop working.",
    usage: `${CLI_NAME} remove --id <id> [--file <path>]`,
    options: [
      ["--id <id>", "(required) Client id to remove."]
    ],
    example: `${CLI_NAME} remove --id cli_818c822b5ad3191a`
  }
};

function printCommandHelp(command) {
  if (command === "tiers" || command === "roles" || command === "admin") {
    printTiersHelp();
    return;
  }
  const doc = COMMAND_DOCS[String(command || "").toLowerCase()];
  if (!doc) {
    console.log(`Unknown command '${command}'.`);
    printFullUsage();
    return;
  }
  console.log(`${doc.summary}`);
  console.log("");
  console.log(`  Usage: ${doc.usage}`);
  printSection("Options");
  doc.options.forEach(([flag, description]) => printOptionLine(flag, description));
  printSection("Example");
  console.log(`    ${doc.example}`);
  printCommonNotes();
}

function printTiersHelp() {
  console.log("Tiers, roles, and admin accounts.");
  console.log("");
  console.log("  What's what:");
  console.log("    - Access levels (basic, premium, pro+) are the fixed tiers every client has.");
  console.log("      Their meaning (price, limits, description) is editable in the Admin panel");
  console.log("      or in storage/config/api-access-levels.json.");
  console.log("    - Custom tiers (a.k.a. roles, e.g. 'mystic-moon') stack on top: they can raise");
  console.log("      limits, grant capabilities (tarot, adminApiManagement), and carry pricing for");
  console.log("      future subscription billing.");
  console.log("    - The built-in 'admin' role is special: it always grants the Admin panel.");
  console.log("");
  console.log("  Make an admin account:");
  console.log(`    ${CLI_NAME} upsert --id <existing-id> --roles admin`);
  console.log(`    ${CLI_NAME} add --name "Admin" --access pro+ --roles admin   (new client, key shown once)`);
  console.log("");
  console.log("  Make a custom tier (role):");
  console.log("    Easiest: Admin panel (top bar) > Tiers > Create Tier. The CLI has no tier");
  console.log("    command, but you can edit storage/config/api-roles.json directly:");
  console.log("");
  console.log(`    {
  "roles": {
    "mystic-moon": {
      "label": "Mystic Moon",
      "description": "Patreon subscriber tier",
      "accessLevel": "pro+",
      "capabilities": ["tarot"],
      "limits": {
        "notes": 999,
        "attachmentsPerScene": 10,
        "attachmentBytes": 10485760,
        "storageBytes": 262144000
      },
      "price": {
        "amount": 9.5,
        "currency": "USD",
        "providerPlanId": "price_mystic"
      }
    }
  }
}`);
  console.log("");
  console.log("  Assign the tier to a client:");
  console.log(`    ${CLI_NAME} upsert --id <id> --roles mystic-moon`);
  console.log(`    ${CLI_NAME} upsert --id <id> --roles "mystic-moon, admin"   (tier + admin panel)`);
  console.log("");
  console.log("    Limits: notes, attachmentsPerScene, attachmentBytes, storageBytes (bytes).");
  console.log("    Capabilities: tarot, adminApiManagement. Access levels: basic, premium, pro+.");
  printCommonNotes();
}

function printCommonNotes() {
  printSection("Notes");
  console.log("    - Full API keys are printed exactly once (after add/rekey). Copy them right away.");
  console.log("    - The registry file is re-read within a couple of seconds — no server restart needed.");
  console.log("    - Granting admin: use --roles admin or --scopes api:admin (unlocks the Admin panel).");
  console.log("    - Tier and role details: " + `${CLI_NAME} help tiers`);
  console.log("");
}

function printFullUsage() {
  console.log("Manage API clients (keys, names, access levels, and roles).");
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <command> [options]`);
  console.log("");
  console.log("  Commands:");
  Object.entries(COMMAND_DOCS).forEach(([command, doc]) => {
    console.log(`    ${command.padEnd(10)} ${doc.summary}`);
  });
  console.log("    help [cmd]".padEnd(10) + " Show this help, or details for one command.");
  console.log("    help tiers".padEnd(10) + " How tiers, roles, and admin accounts work.");
  console.log("");
  console.log("  Quick start:");
  console.log(`    ${CLI_NAME} list                              List all clients`);
  console.log(`    ${CLI_NAME} add --name "Mystic Maya"           Create a client (id + key generated)`);
  console.log(`    ${CLI_NAME} add --name "Admin" --roles admin  Create an admin account (id + key generated)`);
  console.log(`    ${CLI_NAME} upsert --id <id> --roles admin     Promote an existing client to admin`);
  console.log(`    ${CLI_NAME} rekey --id <id>                   Give a client a fresh key`);
  console.log(`    ${CLI_NAME} remove --id <id>                  Delete a client`);
  console.log("");
  console.log(`  Access levels: ${ACCESS_LEVELS.join(", ")} (default ${DEFAULT_CLIENT_ACCESS_LEVEL}).`);
  console.log("  Tiers & roles: see " + `${CLI_NAME} help tiers`);
  printSection("Examples");
  console.log(`    ${CLI_NAME} add --name "Mystic Maya" --access pro+ --roles admin`);
  console.log(`    ${CLI_NAME} upsert --id cli_818c822b5ad3191a --roles admin`);
  console.log(`    ${CLI_NAME} list --file ./api-clients.json`);
  printCommonNotes();
}

function printUsage(subCommand = "") {
  if (subCommand) {
    printCommandHelp(subCommand);
    return;
  }
  printFullUsage();
}

function parseCliList(rawValue) {
  return Array.from(new Set(
    String(rawValue || "")
      .split(/[\r\n,;]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  ));
}

function maskApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= 6) {
    return `${normalized.slice(0, 1)}***${normalized.slice(-1)}`;
  }

  return `${normalized.slice(0, 3)}...${normalized.slice(-3)}`;
}

function toDisplayValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.join(",") : "-";
  }

  return String(value || "").trim() || "-";
}

function printClientLines(clients) {
  if (!clients.length) {
    console.log("No managed API clients configured.");
    return;
  }

  clients.forEach((client) => {
    console.log([
      `id=${client.id}`,
      `name=${toDisplayValue(client.name)}`,
      `access=${client.accessLevel}`,
      `account=${toDisplayValue(client.accountId)}`,
      `roles=${toDisplayValue(client.roles)}`,
      `scopes=${toDisplayValue(client.scopes)}`,
      `key=${maskApiKey(client.key)}`
    ].join("  "));
  });
}

function resolveRekeyClientId(values, provided, { filePath }) {
  if (provided.has("id") && values.id) {
    return values.id;
  }

  if (provided.has("name") && values.name) {
    const matches = readManagedApiClients({ filePath })
      .filter((client) => client.name === values.name);
    if (!matches.length) {
      throw new Error(`No managed API client named '${values.name}' was found in ${filePath}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple managed API clients are named '${values.name}'. Re-run with -Id <id> instead.`);
    }
    return matches[0].id;
  }

  throw new Error("The rekey command requires -Id <value> or -Name <value>.");
}

function buildUpsertInput(values, provided) {
  if (!provided.has("id") || !values.id) {
    throw new Error("The upsert command requires -Id <value>.");
  }

  const input = {
    id: values.id
  };

  if (provided.has("key")) {
    input.key = values.key;
  }
  if (provided.has("name")) {
    input.name = values.name;
  }
  if (provided.has("accountId")) {
    input.accountId = values.accountId;
  }
  if (provided.has("accessLevel")) {
    try {
      input.accessLevel = normalizeAccessLevel(values.accessLevel, {
        fieldName: "AccessLevel",
        defaultValue: ""
      });
    } catch (error) {
      throw new Error(`Invalid access level '${values.accessLevel}'. Must be one of: ${ACCESS_LEVELS.join(", ")}.`);
    }
  }
  if (provided.has("roles")) {
    input.roles = parseCliList(values.roles);
  }
  if (provided.has("scopes")) {
    input.scopes = parseCliList(values.scopes);
  }

  return input;
}

function main(argv) {
  const { command, subCommand, values, provided } = parseArguments(argv);

  if (!command || command === "help" || command === "--help" || command === "-help") {
    printUsage(subCommand);
    return;
  }

  if (command === "list") {
    const clients = readManagedApiClients({ filePath: values.filePath });
    console.log(`Managed API clients: ${values.filePath}`);
    printClientLines(clients);
    return;
  }

  if (command === "add") {
    if (!values.name) {
      throw new Error("The add command requires -Name <value>.");
    }

    let accessLevel;
    try {
      accessLevel = normalizeAccessLevel(values.accessLevel, {
        fieldName: "AccessLevel",
        defaultValue: DEFAULT_CLIENT_ACCESS_LEVEL
      });
    } catch (error) {
      throw new Error(`Invalid access level '${values.accessLevel}'. Must be one of: ${ACCESS_LEVELS.join(", ")}.`);
    }

    const existingClients = readManagedApiClients({ filePath: values.filePath });
    const clientId = generateManagedApiClientId(existingClients);
    const apiKey = generateManagedApiClientKey(existingClients);

    const clientInput = {
      id: clientId,
      key: apiKey,
      name: values.name,
      accountId: values.accountId,
      accessLevel
    };
    if (provided.has("roles")) {
      clientInput.roles = parseCliList(values.roles);
    }
    if (provided.has("scopes")) {
      clientInput.scopes = parseCliList(values.scopes);
    }

    // Roles and scopes that are not provided default from the access level
    // (see ACCESS_LEVEL_DEFAULT_CAPABILITIES) inside the registry service.
    const result = upsertManagedApiClient(clientInput, {
      filePath: values.filePath,
      mergeExisting: true
    });

    const createdClient = result.client;
    console.log(`Created managed API client '${createdClient?.id || clientId}' in ${values.filePath}.`);
    console.log(`  Id:      ${createdClient?.id || clientId}`);
    console.log(`  Name:    ${createdClient?.name || values.name}`);
    console.log(`  Account: ${createdClient?.accountId || "(none)"}`);
    console.log(`  Access:  ${createdClient?.accessLevel || accessLevel}`);
    console.log(`  Key:     ${createdClient?.key || apiKey}`);
    console.log("");
    console.log("Copy the key now — it is shown in full only once.");
    printClientLines(result.clients);
    return;
  }

  if (command === "rekey") {
    const clientId = resolveRekeyClientId(values, provided, { filePath: values.filePath });
    const result = rotateManagedApiClientKey(clientId, {
      filePath: values.filePath
    });

    console.log(`Rotated API key for managed client '${result.client.id}' in ${values.filePath}.`);
    console.log(`  New key: ${result.client.key}`);
    console.log("");
    console.log("Copy the key now — it is shown in full only once.");
    printClientLines(result.clients);
    return;
  }

  if (command === "upsert") {
    const result = upsertManagedApiClient(buildUpsertInput(values, provided), {
      filePath: values.filePath,
      mergeExisting: true
    });
    console.log(`${result.created ? "Created" : "Updated"} managed API client '${result.client?.id || values.id}' in ${values.filePath}.`);
    printClientLines(result.clients);
    return;
  }

  if (command === "remove") {
    if (!provided.has("id") || !values.id) {
      throw new Error("The remove command requires -Id <value>.");
    }

    const result = removeManagedApiClient(values.id, {
      filePath: values.filePath
    });
    if (!result.removed) {
      throw new Error(`Managed API client '${values.id}' was not found in ${values.filePath}.`);
    }

    console.log(`Removed managed API client '${values.id}' from ${values.filePath}.`);
    printClientLines(result.clients);
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

// Reused by the merged `npm run accounts` CLI; still runnable on its own.
function run(argv = process.argv.slice(2)) {
  try {
    main(argv);
    return 0;
  } catch (error) {
    console.error(error?.message || error);
    printUsage();
    return 1;
  }
}

module.exports = { run, printUsage, printFullUsage, printCommandHelp };

if (require.main === module) {
  process.exitCode = run();
}