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
const { listAccessLevelDefinitions } = require("../src/services/api-access-levels");
const { KNOWN_CAPABILITIES, listRoleDefinitions } = require("../src/services/api-roles");

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

const LIMIT_KEY_ORDER = ["notes", "events", "attachmentsPerScene", "attachmentBytes", "storageBytes"];

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  if (value >= 1024 * 1024) {
    return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  }
  if (value >= 1024) {
    return `${Math.round((value / 1024) * 10) / 10} KB`;
  }
  return `${value} B`;
}

function formatLimits(limits) {
  const source = limits && typeof limits === "object" ? limits : {};
  return LIMIT_KEY_ORDER
    .filter((key) => source[key] != null && source[key] !== "")
    .map((key) => {
      const isBytes = key === "attachmentBytes" || key === "storageBytes";
      return `${key}=${isBytes ? formatBytes(source[key]) : source[key]}`;
    })
    .join("  ");
}

function formatPrice(price) {
  const amount = Number(price?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "free";
  }
  const plan = String(price?.providerPlanId || "").trim();
  return `${amount} ${price?.currency || "USD"}${plan ? ` (plan ${plan})` : ""}`;
}

const CAPABILITY_DESCRIPTIONS = Object.freeze({
  tarot: "Tarot decks and spreads.",
  adminApiManagement: "Admin panel and admin API management."
});

// Live definitions, not just the ids: admins can list what a server currently
// offers without opening the Admin panel or the JSON files. The optional
// file paths exist so callers/tests can point at another configuration.
function printCurrentAccessLevels(options = {}) {
  console.log("  Current access levels (--access <id>; label, scopes, and limits editable in Admin > Tiers):");
  const levelOptions = options.levelsFile ? { filePath: options.levelsFile } : {};
  listAccessLevelDefinitions(levelOptions).forEach((level) => {
    console.log(`    ${level.id.padEnd(8)} ${level.label}`);
    if (level.description) {
      console.log(`      ${level.description}`);
    }
    console.log(`      default roles:  ${(level.roles || []).join(", ") || "-"}`);
    console.log(`      default scopes: ${(level.scopes || []).join(", ") || "-"}`);
    const limits = formatLimits(level.limits);
    if (limits) {
      console.log(`      limits: ${limits}`);
    }
    console.log(`      price: ${formatPrice(level.price)}`);
  });
}

function printCurrentRoles(options = {}) {
  console.log("  Current roles (--roles <id>; custom tiers from Admin > Tiers or storage/config/api-roles.json):");
  console.log("    admin    built-in — always grants the Admin panel (same as --scopes api:admin).");
  const roleOptions = options.rolesFile ? { filePath: options.rolesFile } : {};
  const roles = listRoleDefinitions(roleOptions);
  if (!roles.length) {
    console.log("    (no custom roles yet) — create one in Admin > Tiers to add limits, capabilities, or pricing.");
    return;
  }
  roles.forEach((role) => {
    const label = role.label && role.label !== role.id ? ` — ${role.label}` : "";
    console.log(`    ${role.id.padEnd(8)}${label}`);
    if (role.description) {
      console.log(`      ${role.description}`);
    }
    if (role.accessLevel) {
      console.log(`      raises the access level to: ${role.accessLevel}`);
    }
    if (role.capabilities?.length) {
      console.log(`      capabilities: ${role.capabilities.join(", ")}`);
    }
    const limits = formatLimits(role.limits);
    if (limits) {
      console.log(`      limits (highest wins with the tier): ${limits}`);
    }
    if (Number(role.price?.amount) > 0 || role.price?.providerPlanId) {
      console.log(`      price: ${formatPrice(role.price)}`);
    }
  });
}

function printScopesAndCapabilities() {
  console.log("  Scopes (--scopes <id>):");
  console.log("    api:admin      Admin panel and admin API. The only scope enforced as a capability.");
  console.log("    api:read       Built-in default on every access level.");
  console.log("    api:tarot      Built-in default on premium and pro+.");
  console.log("    api:decks      Built-in default on premium and pro+.");
  console.log("    api:metrics    Built-in default on pro+.");
  console.log("    Defaults come from the client's access level and can be overridden per");
  console.log("    client; custom scope names are allowed. The current defaults are listed");
  console.log("    under each access level above.");
  console.log("");
  console.log("  Role capabilities (set on a role in Admin > Tiers):");
  KNOWN_CAPABILITIES.forEach((name) => {
    console.log(`    ${name.padEnd(20)} ${CAPABILITY_DESCRIPTIONS[name] || ""}`.trimEnd());
  });
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
      [`--access <level>`, `Access level: ${ACCESS_LEVELS.join(" | ")} (default ${DEFAULT_CLIENT_ACCESS_LEVEL}). Current labels and limits: \`help tiers\`.`],
      ["--account-id <id>", "Optional account id for this client."],
      ["--roles <a,b>", "Roles, e.g. admin. Defaults come from the access level; `help tiers` lists current roles."],
      ["--scopes <a,b>", "Scopes, e.g. api:admin. Defaults come from the access level; `help tiers` lists the scope ids."]
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
      ["--access <level>", `Access level: ${ACCESS_LEVELS.join(" | ")}. Current labels and limits: \`help tiers\`.`],
      ["--roles <a,b>", "Set roles. Use `admin` to grant the Admin panel; `help tiers` lists current roles."],
      ["--scopes <a,b>", "Set scopes. Use `api:admin` to grant the Admin panel; `help tiers` lists the scope ids."]
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

function printCommandHelp(command, options = {}) {
  if (command === "tiers" || command === "roles" || command === "admin") {
    printTiersHelp(options);
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

function printTiersHelp(options = {}) {
  console.log("Tiers, roles, and admin accounts (current values from this server).");
  console.log("");
  console.log("  What's what:");
  console.log("    - Access levels are the fixed tiers every client has. The ids never change;");
  console.log("      labels, descriptions, default roles/scopes, and limits are editable in");
  console.log("      Admin > Tiers or storage/config/api-access-levels.json.");
  console.log("    - Custom tiers (a.k.a. roles, e.g. 'mystic-moon') stack on top: they can raise");
  console.log("      limits, grant capabilities (tarot, adminApiManagement), and carry pricing for");
  console.log("      future subscription billing.");
  console.log("    - The built-in 'admin' role is special: it always grants the Admin panel.");
  console.log("");
  printCurrentAccessLevels(options);
  console.log("");
  printCurrentRoles(options);
  console.log("");
  printScopesAndCapabilities();
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
  console.log("    Limits: notes, events, attachmentsPerScene, attachmentBytes, storageBytes (bytes).");
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
  console.log("  Tiers, roles, and scopes: `help tiers` lists the current levels, roles, limits, and scope ids.");
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