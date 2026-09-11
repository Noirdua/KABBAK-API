const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_CLIENT_ACCESS_LEVEL,
  normalizeAccessLevel
} = require("../config/api-access");
const { getAccessLevelDefaultCapabilities } = require("./api-access-levels");
const { managedApiClientsPath } = require("../config/paths");
const { createConfigError } = require("../lib/config-error");

function normalizeApiKey(value) {
  return String(value || "").trim();
}

function normalizeOptionalString(value) {
  return String(value || "").trim();
}

function parseConfiguredApiKeys(rawValue) {
  return Array.from(new Set(
    String(rawValue || "")
      .split(/[\r\n,;]+/)
      .map((value) => normalizeApiKey(value))
      .filter(Boolean)
  ));
}

function parseStringList(value, fieldName) {
  if (value == null || value === "") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw createConfigError(`${fieldName} must be an array of strings.`);
  }

  return Array.from(new Set(
    value
      .map((entry) => normalizeOptionalString(entry))
      .filter(Boolean)
  ));
}

function normalizeConfiguredClientEntries(entries, { sourceName = "apiClients" } = {}) {
  if (!Array.isArray(entries)) {
    throw createConfigError(`${sourceName} must be a JSON array of client definitions.`);
  }

  const seenIds = new Set();
  const seenKeys = new Set();

  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw createConfigError(`${sourceName}[${index}] must be an object.`);
    }

    const id = normalizeOptionalString(entry.id || entry.clientId || `client-${index + 1}`);
    const key = normalizeApiKey(entry.key || entry.apiKey);
    if (!id) {
      throw createConfigError(`${sourceName}[${index}] must include an id.`);
    }

    if (!key) {
      throw createConfigError(`${sourceName}[${index}] must include a key.`);
    }

    if (seenIds.has(id)) {
      throw createConfigError(`${sourceName} contains a duplicate client id '${id}'.`);
    }

    if (seenKeys.has(key)) {
      throw createConfigError(`${sourceName} contains a duplicate key for client '${id}'.`);
    }

    seenIds.add(id);
    seenKeys.add(key);

    const accessLevel = normalizeAccessLevel(entry.accessLevel || entry.plan || entry.tier, {
      fieldName: `${sourceName}[${index}].accessLevel`,
      defaultValue: DEFAULT_CLIENT_ACCESS_LEVEL
    });
    const defaultCapabilities = getAccessLevelDefaultCapabilities(accessLevel);

    return {
      id,
      key,
      name: normalizeOptionalString(entry.name),
      accountId: normalizeOptionalString(entry.accountId || entry.account || entry.userId),
      accessLevel,
      // Consumer roles/scopes default from the access level (pro+ includes all
      // consumer scopes). Explicitly provided lists always win.
      roles: Array.isArray(entry.roles)
        ? parseStringList(entry.roles, `${sourceName}[${index}].roles`)
        : [...defaultCapabilities.roles],
      scopes: Array.isArray(entry.scopes)
        ? parseStringList(entry.scopes, `${sourceName}[${index}].scopes`)
        : [...defaultCapabilities.scopes],
      // Generic client flags used by plugins/system clients: `hidden` keeps a
      // client out of the normal Users list; `expiresAt` (ISO) expires its key.
      hidden: entry.hidden === true,
      expiresAt: normalizeOptionalString(entry.expiresAt || entry.expires || "")
    };
  });
}

function isClientExpired(client, nowMs = Date.now()) {
  const value = String(client?.expiresAt || "").trim();
  if (!value) {
    return false;
  }
  const expiresMs = Date.parse(value);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function parseConfiguredApiClients(rawValue, { sourceName = "KABBAK_API_CLIENTS" } = {}) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return [];
  }

  let parsedValue;
  try {
    parsedValue = JSON.parse(normalized);
  } catch (error) {
    throw createConfigError(`${sourceName} must be valid JSON. ${error.message}`);
  }

  return normalizeConfiguredClientEntries(parsedValue, { sourceName });
}

function cloneConfiguredClient(client) {
  return {
    ...client,
    roles: [...client.roles],
    scopes: [...client.scopes]
  };
}

function cloneConfiguredClients(clients) {
  return clients.map((client) => cloneConfiguredClient(client));
}

function readManagedApiClients({ filePath = managedApiClientsPath } = {}) {
  try {
    const rawValue = fs.readFileSync(filePath, "utf8");
    return parseConfiguredApiClients(rawValue, { sourceName: filePath });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

const managedWriteListeners = [];

function onManagedApiClientsWritten(listener) {
  if (typeof listener === "function") {
    managedWriteListeners.push(listener);
  }
}

function notifyManagedApiClientsWritten() {
  managedWriteListeners.forEach((listener) => {
    try {
      listener();
    } catch (_error) {}
  });
}

function writeManagedApiClients(clients, { filePath = managedApiClientsPath } = {}) {
  const normalizedClients = normalizeConfiguredClientEntries(clients, { sourceName: filePath });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizedClients, null, 2)}\n`, "utf8");
  notifyManagedApiClientsWritten();
  return cloneConfiguredClients(normalizedClients);
}

function upsertManagedApiClient(clientInput, { filePath = managedApiClientsPath, mergeExisting = true } = {}) {
  const existingClients = readManagedApiClients({ filePath });
  const clientId = normalizeOptionalString(clientInput?.id || clientInput?.clientId);
  if (!clientId) {
    throw createConfigError("Managed client updates require an id.");
  }

  const existingClient = existingClients.find((client) => client.id === clientId) || null;
  const nextClientInput = mergeExisting && existingClient
    ? {
        ...existingClient,
        ...clientInput,
        id: clientId,
        roles: Object.prototype.hasOwnProperty.call(clientInput, "roles") ? clientInput.roles : existingClient.roles,
        scopes: Object.prototype.hasOwnProperty.call(clientInput, "scopes") ? clientInput.scopes : existingClient.scopes
      }
    : {
        ...clientInput,
        id: clientId
      };

  const nextClients = [
    ...existingClients.filter((client) => client.id !== clientId),
    nextClientInput
  ];
  const writtenClients = writeManagedApiClients(nextClients, { filePath });
  return {
    client: writtenClients.find((client) => client.id === clientId) || null,
    clients: writtenClients,
    created: !existingClient,
    updated: Boolean(existingClient)
  };
}

function removeManagedApiClient(clientId, { filePath = managedApiClientsPath } = {}) {
  const normalizedClientId = normalizeOptionalString(clientId);
  if (!normalizedClientId) {
    throw createConfigError("Managed client removal requires an id.");
  }

  const existingClients = readManagedApiClients({ filePath });
  const nextClients = existingClients.filter((client) => client.id !== normalizedClientId);
  if (nextClients.length === existingClients.length) {
    return {
      removed: false,
      clients: cloneConfiguredClients(existingClients)
    };
  }

  return {
    removed: true,
    clients: writeManagedApiClients(nextClients, { filePath })
  };
}

const GENERATED_CLIENT_ID_PREFIX = "cli_";
const GENERATED_CLIENT_ID_BYTES = 8;
const GENERATED_API_KEY_PREFIX = "kabbak_";
const GENERATED_API_KEY_BYTES = 32;

function generateManagedApiClientId(existingClients = []) {
  const takenIds = new Set(
    (Array.isArray(existingClients) ? existingClients : [])
      .map((client) => client?.id)
      .filter(Boolean)
  );

  let clientId = "";
  do {
    clientId = `${GENERATED_CLIENT_ID_PREFIX}${crypto.randomBytes(GENERATED_CLIENT_ID_BYTES).toString("hex")}`;
  } while (takenIds.has(clientId));

  return clientId;
}

function generateManagedApiClientKey(existingClients = []) {
  const takenKeys = new Set(
    (Array.isArray(existingClients) ? existingClients : [])
      .map((client) => normalizeApiKey(client?.key))
      .filter(Boolean)
  );

  let apiKey = "";
  do {
    apiKey = `${GENERATED_API_KEY_PREFIX}${crypto.randomBytes(GENERATED_API_KEY_BYTES).toString("base64url")}`;
  } while (takenKeys.has(apiKey));

  return apiKey;
}

function rotateManagedApiClientKey(clientId, { filePath = managedApiClientsPath } = {}) {
  const normalizedClientId = normalizeOptionalString(clientId);
  if (!normalizedClientId) {
    throw createConfigError("Managed client key rotation requires an id.");
  }

  const existingClients = readManagedApiClients({ filePath });
  const existingClient = existingClients.find((client) => client.id === normalizedClientId) || null;
  if (!existingClient) {
    throw createConfigError(`Managed API client '${normalizedClientId}' was not found in ${filePath}.`);
  }

  const nextKey = generateManagedApiClientKey(existingClients);
  const result = upsertManagedApiClient({
    ...existingClient,
    key: nextKey
  }, {
    filePath,
    mergeExisting: true
  });

  return {
    ...result,
    rotated: true,
    previousKey: existingClient.key
  };
}

module.exports = {
  cloneConfiguredClients,
  createConfigError,
  generateManagedApiClientId,
  generateManagedApiClientKey,
  isClientExpired,
  onManagedApiClientsWritten,
  parseConfiguredApiClients,
  parseConfiguredApiKeys,
  readManagedApiClients,
  removeManagedApiClient,
  rotateManagedApiClientKey,
  upsertManagedApiClient,
  writeManagedApiClients
};