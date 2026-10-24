"use strict";

try {
  require("dotenv").config({ quiet: true });
} catch (_error) {}

const { getRuntimeSettings, updateRuntimeSettings } = require("../src/services/runtime-settings");
const { readManagedApiClients } = require("../src/services/api-client-registry");

const CLI = "npm run settings --";

function printHelp() {
  console.log([
    "KABBAK server defaults (GUI connection URL + allowed CORS origins)",
    "",
    `  ${CLI} show`,
    `  ${CLI} set-url http://api.example.com:3100`,
    `  ${CLI} clear-url`,
    `  ${CLI} add-origins http://gui.example.com:8080`,
    `  ${CLI} set-origins http://gui.example.com:8080,http://localhost:8080`,
    `  ${CLI} remove-origins http://old.example.com:8080`,
    `  ${CLI} fix --url http://api.example.com:3100 --gui http://gui.example.com:8080`,
    "",
    "  fix is the one-shot repair: it sets the GUI's default API URL and adds",
    "  the GUI origin to the allowed origins.",
    "",
    "  Options:",
    "    --offline        Save only; do not call the running API.",
    "    --api <base>     Running API base (default http://127.0.0.1:3100/api/v1).",
    "    --key <key>      Admin key (default: KABBAK_ADMIN_KEY, then a managed admin client).",
    "",
    "  Without a reachable admin key the change is saved to",
    "  storage/config/runtime-settings.json and applies when the API restarts."
  ].join("\n"));
}

function splitList(values) {
  return String((values || []).join(","))
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

function normalizeOrigin(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Origin cannot be empty.");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Origin must use http:// or https://: ${value}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Use an origin only (scheme://host[:port]), no path: ${value}`);
  }
  return parsed.origin;
}

function normalizeApiBase(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  raw = raw.replace(/\/+$/, "");
  if (!/\/api\/v1$/i.test(raw)) {
    raw += "/api/v1";
  }
  return raw;
}

function runningApiBase(flagValue) {
  const configured = flagValue
    || process.env.KABBAK_INTERNAL_API_URL
    || process.env.KABBAK_API_URL
    || `http://127.0.0.1:${process.env.PORT || 3100}/api/v1`;
  return normalizeApiBase(configured);
}

function resolveAdminKey(explicit) {
  if (explicit) {
    return { key: String(explicit), source: "--key" };
  }
  if (process.env.KABBAK_ADMIN_KEY) {
    return { key: String(process.env.KABBAK_ADMIN_KEY), source: "KABBAK_ADMIN_KEY" };
  }
  if (process.env.KABBAK_API_KEY) {
    return { key: String(process.env.KABBAK_API_KEY), source: "KABBAK_API_KEY" };
  }
  let clients = [];
  try {
    clients = readManagedApiClients();
  } catch (_error) {
    clients = [];
  }
  const now = Date.now();
  const client = clients.find((entry) => {
    if (!entry || !entry.key) return false;
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) return false;
    const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
    const roles = Array.isArray(entry.roles) ? entry.roles : [];
    return scopes.includes("api:admin") || roles.includes("admin");
  });
  if (!client) {
    return null;
  }
  return {
    key: client.key,
    source: client.name || client.id || "managed admin client"
  };
}

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    if (!token || token === "--") continue;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = args[index + 1];
      if (next != null && !String(next).startsWith("--")) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function pickChanges(updated, requested) {
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(requested, "clientApiBaseUrl")) {
    changes.clientApiBaseUrl = updated.clientApiBaseUrl;
  }
  if (Object.prototype.hasOwnProperty.call(requested, "allowedOrigins")) {
    changes.allowedOrigins = updated.allowedOrigins;
  }
  return changes;
}

async function applyChanges(changes, flags) {
  const updated = updateRuntimeSettings(changes);
  const applied = pickChanges(updated, changes);

  if (Object.prototype.hasOwnProperty.call(applied, "clientApiBaseUrl")) {
    console.log(`Default connection URL: ${applied.clientApiBaseUrl || "(not set; the gate auto-detects)"}`);
  }
  if (Object.prototype.hasOwnProperty.call(applied, "allowedOrigins")) {
    console.log(`Allowed CORS origins: ${(applied.allowedOrigins || []).join(", ") || "(none)"}`);
  }

  if (flags.offline) {
    console.log("Saved to storage/config/runtime-settings.json. Restart the API to apply.");
    return;
  }

  const apiBase = runningApiBase(flags.api);
  const admin = resolveAdminKey(flags.key);
  if (!admin) {
    console.log("No admin key found (--key, KABBAK_ADMIN_KEY, or a managed admin client).");
    console.log("Saved to storage/config/runtime-settings.json. Restart the API to apply.");
    return;
  }

  try {
    const response = await fetch(`${apiBase}/admin/settings`, {
      method: "PATCH",
      headers: {
        "x-api-key": admin.key,
        "content-type": "application/json"
      },
      body: JSON.stringify(applied)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.log(`Saved, but the running API at ${apiBase} rejected the live update (HTTP ${response.status}).`);
      if (detail) console.log(detail.slice(0, 300));
      console.log("Restart the API to apply the saved settings.");
      return;
    }
    console.log(`Applied live to ${apiBase} using ${admin.source}.`);
  } catch (error) {
    console.log(`Saved, but could not reach the running API at ${apiBase}: ${error.message}`);
    console.log("Restart the API to apply the saved settings.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = String(args[0] || "").toLowerCase();
  const { flags, positionals } = parseArgs(args.slice(1));

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "show") {
    const settings = getRuntimeSettings();
    console.log(`Default connection URL: ${settings.clientApiBaseUrl || "(not set; the gate auto-detects)"}`);
    console.log(`Allowed CORS origins: ${(settings.allowedOrigins || []).join(", ") || "(none)"}`);
    console.log(`Public API URL: ${settings.publicApiUrl || "(not set)"}`);
    return 0;
  }

  if (command === "set-url" || command === "set-default" || command === "set-default-url") {
    const value = positionals[0] ?? flags.url;
    if (value == null) {
      throw new Error(`Usage: ${CLI} set-url http://api.example.com:3100`);
    }
    const next = /^(?:-|none|clear)$/i.test(String(value).trim()) ? "" : String(value).trim();
    await applyChanges({ clientApiBaseUrl: next }, flags);
    return 0;
  }

  if (command === "clear-url" || command === "clear-default") {
    await applyChanges({ clientApiBaseUrl: "" }, flags);
    return 0;
  }

  if (command === "set-origins" || command === "origins") {
    const values = [...positionals, ...(flags.origins ? [flags.origins] : [])];
    const origins = unique(splitList(values).map(normalizeOrigin));
    await applyChanges({ allowedOrigins: origins }, flags);
    return 0;
  }

  if (command === "add-origins" || command === "add-origin") {
    const values = [...positionals, ...(flags.origins ? [flags.origins] : [])];
    const added = splitList(values).map(normalizeOrigin);
    if (!added.length) {
      throw new Error(`Usage: ${CLI} add-origins http://gui.example.com:8080`);
    }
    const current = getRuntimeSettings().allowedOrigins || [];
    await applyChanges({ allowedOrigins: unique([...current, ...added]) }, flags);
    return 0;
  }

  if (command === "remove-origins" || command === "remove-origin") {
    const values = [...positionals, ...(flags.origins ? [flags.origins] : [])];
    const removed = new Set(splitList(values).map(normalizeOrigin));
    if (!removed.size) {
      throw new Error(`Usage: ${CLI} remove-origins http://old.example.com:8080`);
    }
    const current = getRuntimeSettings().allowedOrigins || [];
    await applyChanges({ allowedOrigins: current.filter((origin) => !removed.has(origin)) }, flags);
    return 0;
  }

  if (command === "fix" || command === "setup") {
    const url = flags.url ?? flags["client-url"];
    const gui = flags.gui ?? flags.origin ?? flags.origins;
    if (url == null) {
      throw new Error(`Usage: ${CLI} fix --url http://api.example.com:3100 --gui http://gui.example.com:8080`);
    }
    const changes = {
      clientApiBaseUrl: /^(?:-|none|clear)$/i.test(String(url).trim()) ? "" : String(url).trim()
    };
    if (gui) {
      const added = splitList([gui]).map(normalizeOrigin);
      const current = getRuntimeSettings().allowedOrigins || [];
      changes.allowedOrigins = unique([...current, ...added]);
    }
    await applyChanges(changes, flags);
    return 0;
  }

  throw new Error(`Unknown command: ${command}\n\n${CLI} help`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
