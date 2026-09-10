const crypto = require("node:crypto");
const fs = require("node:fs");
const { parseBooleanEnv } = require("../config/app-env");
const { DEFAULT_CLIENT_ACCESS_LEVEL } = require("../config/api-access");
const { managedApiClientsPath } = require("../config/paths");
const {
  cloneConfiguredClients,
  parseConfiguredApiClients,
  parseConfiguredApiKeys,
  readManagedApiClients
} = require("../services/api-client-registry");
const { touchPresence } = require("../services/user-registry");

const MANAGED_CLIENT_STAT_INTERVAL_MS = 2000;

const managedClientCache = {
  exists: false,
  mtimeMs: -1,
  checkedAtMs: 0,
  clients: Object.freeze([]),
  clientsByKeyHash: new Map()
};

const envClientCache = {
  signature: "",
  clients: Object.freeze([]),
  clientsByKeyHash: new Map()
};

function hashApiKey(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildClientKeyHashMap(clients) {
  const map = new Map();
  (Array.isArray(clients) ? clients : []).forEach((client) => {
    const key = String(client?.key || "");
    if (!key) {
      return;
    }
    map.set(hashApiKey(key), client);
  });
  return map;
}

function createConfiguredClientSummary(client) {
  return {
    id: client.id,
    name: client.name,
    accountId: client.accountId,
    accessLevel: client.accessLevel,
    roles: [...client.roles],
    scopes: [...client.scopes]
  };
}

function freezeConfiguredClients(clients) {
  return Object.freeze(clients.map((client) => Object.freeze({
    ...client,
    roles: Object.freeze([...client.roles]),
    scopes: Object.freeze([...client.scopes])
  })));
}

function loadManagedApiClients() {
  const nowMs = Date.now();
  if (
    managedClientCache.checkedAtMs > 0
    && (nowMs - managedClientCache.checkedAtMs) < MANAGED_CLIENT_STAT_INTERVAL_MS
  ) {
    return managedClientCache.clients;
  }

  managedClientCache.checkedAtMs = nowMs;

  try {
    const stats = fs.statSync(managedApiClientsPath);
    if (managedClientCache.exists && managedClientCache.mtimeMs === stats.mtimeMs) {
      return managedClientCache.clients;
    }

    const nextClients = freezeConfiguredClients(readManagedApiClients({
      filePath: managedApiClientsPath
    }));
    managedClientCache.exists = true;
    managedClientCache.mtimeMs = stats.mtimeMs;
    managedClientCache.clients = nextClients;
    managedClientCache.clientsByKeyHash = buildClientKeyHashMap(nextClients);
    return managedClientCache.clients;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      managedClientCache.exists = false;
      managedClientCache.mtimeMs = -1;
      managedClientCache.clients = Object.freeze([]);
      managedClientCache.clientsByKeyHash = new Map();
      return managedClientCache.clients;
    }

    throw error;
  }
}

function createLegacyConfiguredClients() {
  const configuredKeys = parseConfiguredApiKeys(process.env.KABBAK_API_KEYS);
  if (configuredKeys.length > 0) {
    return freezeConfiguredClients(configuredKeys.map((key, index) => ({
      id: `client-${index + 1}`,
      key,
      name: "",
      accountId: "",
      accessLevel: DEFAULT_CLIENT_ACCESS_LEVEL,
      roles: [],
      scopes: []
    })));
  }

  const singleKey = String(process.env.KABBAK_API_KEY || "").trim();
  return singleKey ? freezeConfiguredClients([{
    id: "default",
    key: singleKey,
    name: "",
    accountId: "",
    accessLevel: DEFAULT_CLIENT_ACCESS_LEVEL,
    roles: [],
    scopes: []
  }]) : Object.freeze([]);
}

function getConfiguredApiKeys() {
  return getConfiguredApiClients().map((client) => client.key);
}

function getConfiguredApiClients() {
  const managedClients = loadManagedApiClients();
  if (managedClients.length > 0) {
    return managedClients;
  }

  const envSignature = [
    String(process.env.KABBAK_API_CLIENTS || ""),
    String(process.env.KABBAK_API_KEYS || ""),
    String(process.env.KABBAK_API_KEY || "")
  ].join("\u0000");

  if (envClientCache.signature === envSignature) {
    return envClientCache.clients;
  }

  const configuredClients = freezeConfiguredClients(parseConfiguredApiClients(process.env.KABBAK_API_CLIENTS));
  const nextClients = configuredClients.length > 0
    ? configuredClients
    : createLegacyConfiguredClients();

  envClientCache.signature = envSignature;
  envClientCache.clients = nextClients;
  envClientCache.clientsByKeyHash = buildClientKeyHashMap(nextClients);
  return nextClients;
}

function getConfiguredClientLookupMap() {
  const managedClients = loadManagedApiClients();
  if (managedClients.length > 0) {
    return managedClientCache.clientsByKeyHash;
  }

  // Ensure env cache is warm.
  getConfiguredApiClients();
  return envClientCache.clientsByKeyHash;
}

function getConfiguredApiKey() {
  return getConfiguredApiClients()[0]?.key || "";
}

function getConfiguredApiClientSummaries() {
  return getConfiguredApiClients().map((client) => createConfiguredClientSummary(client));
}

function isApiKeyProtectionEnabled() {
  try {
    if (parseBooleanEnv("KABBAK_NO_AUTH", false)) {
      return false;
    }
  } catch (_error) {}
  return getConfiguredApiClients().length > 0;
}

function getPresentedApiKey(request) {
  const headerKey = String(request.get("x-api-key") || "").trim();
  if (headerKey) {
    return headerKey;
  }

  const authorizationHeader = String(request.get("authorization") || "").trim();
  const bearerMatch = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return String(bearerMatch[1] || "").trim();
  }

  const queryKey = String(
    request.query?.apiKey
    || request.query?.api_key
    || request.query?.["x-api-key"]
    || ""
  ).trim();
  if (queryKey) {
    return queryKey;
  }

  return "";
}

function apiKeysMatch(expectedKey, presentedKey) {
  const expectedBuffer = Buffer.from(String(expectedKey || ""), "utf8");
  const presentedBuffer = Buffer.from(String(presentedKey || ""), "utf8");

  if (!expectedBuffer.length || !presentedBuffer.length) {
    return false;
  }

  if (expectedBuffer.length !== presentedBuffer.length) {
    const maxLength = Math.max(expectedBuffer.length, presentedBuffer.length);
    const paddedExpected = Buffer.alloc(maxLength, 0);
    const paddedPresented = Buffer.alloc(maxLength, 0);
    expectedBuffer.copy(paddedExpected, 0);
    presentedBuffer.copy(paddedPresented, 0);
    return crypto.timingSafeEqual(paddedExpected, paddedPresented);
  }

  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

function findConfiguredClientByApiKey(presentedKey) {
  const presented = String(presentedKey || "");
  if (!presented) {
    return null;
  }

  const hashed = hashApiKey(presented);
  const mappedClient = getConfiguredClientLookupMap().get(hashed) || null;
  if (mappedClient && apiKeysMatch(mappedClient.key, presented)) {
    return mappedClient;
  }

  // Fallback for rare hash collisions / legacy mismatched encodings.
  return getConfiguredApiClients().find((configuredClient) => apiKeysMatch(configuredClient.key, presented)) || null;
}

function createRequestAuthState(client) {
  if (!client) {
    return {
      authenticated: false,
      type: "anonymous",
      clientId: "",
      accountId: "",
      name: "",
      accessLevel: "",
      roles: [],
      scopes: []
    };
  }

  return {
    authenticated: true,
    type: "api-key",
    clientId: client.id,
    accountId: client.accountId,
    name: String(client?.name || "").trim(),
    accessLevel: client.accessLevel,
    roles: [...client.roles],
    scopes: [...client.scopes]
  };
}

function resolveRequestAuthState(request) {
  const configuredApiClients = getConfiguredApiClients();
  if (!configuredApiClients.length) {
    return createRequestAuthState(null);
  }

  const presentedApiKey = getPresentedApiKey(request);
  if (!presentedApiKey) {
    return createRequestAuthState(null);
  }

  return createRequestAuthState(findConfiguredClientByApiKey(presentedApiKey));
}

function requireApiKey(request, response, next) {
  if (request.method === "OPTIONS") {
    next();
    return;
  }

  // KABBAK_NO_AUTH=1 opens the API, but a presented key is still resolved so
  // per-client features (profiles) keep working for keyed clients.
  if (!isApiKeyProtectionEnabled()) {
    const authState = resolveRequestAuthState(request);
    request.auth = authState;
    response.locals.auth = authState;
    if (authState.clientId) {
      touchPresence(authState.clientId);
    }
    next();
    return;
  }

  const configuredApiClients = getConfiguredApiClients();
  if (!configuredApiClients.length) {
    const authState = createRequestAuthState(null);
    request.auth = authState;
    response.locals.auth = authState;
    next();
    return;
  }

  const presentedApiKey = getPresentedApiKey(request);
  const configuredClient = findConfiguredClientByApiKey(presentedApiKey);
  if (configuredClient) {
    const authState = createRequestAuthState(configuredClient);
    request.auth = authState;
    response.locals.auth = authState;
    touchPresence(authState.clientId);
    next();
    return;
  }

  response.status(401).json({
    error: "unauthorized",
    message: "A valid API key is required for this route.",
    requestId: response.locals?.requestId || request.id || "",
    hint: "Send x-api-key or Authorization: Bearer <key>."
  });
}

module.exports = {
  getConfiguredApiKey,
  getConfiguredApiClientSummaries,
  getConfiguredApiClients: () => cloneConfiguredClients(getConfiguredApiClients()),
  getConfiguredApiKeys: () => getConfiguredApiClients().map((client) => client.key),
  isApiKeyProtectionEnabled,
  resolveRequestAuthState,
  requireApiKey
};