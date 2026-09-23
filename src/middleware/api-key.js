const crypto = require("node:crypto");
const fs = require("node:fs");
const { parseBooleanEnv } = require("../config/app-env");
const { DEFAULT_CLIENT_ACCESS_LEVEL } = require("../config/api-access");
const { managedApiClientsPath } = require("../config/paths");
const {
  cloneConfiguredClients,
  isClientExpired,
  onManagedApiClientsWritten,
  parseConfiguredApiClients,
  parseConfiguredApiKeys,
  readManagedApiClients
} = require("../services/api-client-registry");
const { touchPresence } = require("../services/user-registry");

function invalidateManagedClientCache() {
  managedClientCache.checkedAtMs = 0;
  managedClientCache.mtimeMs = -1;
}

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

onManagedApiClientsWritten(invalidateManagedClientCache);

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

  // Stat on every call so edits and deletions made outside the app (a different
  // process, an operator, or a test) are seen immediately. Only the file parse
  // is cached, keyed on mtime; the stat itself is cheap next to key hashing.
  let stats;
  try {
    stats = fs.statSync(managedApiClientsPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      managedClientCache.exists = false;
      managedClientCache.mtimeMs = -1;
      managedClientCache.checkedAtMs = nowMs;
      managedClientCache.clients = Object.freeze([]);
      managedClientCache.clientsByKeyHash = new Map();
      return managedClientCache.clients;
    }

    throw error;
  }

  if (managedClientCache.exists && managedClientCache.mtimeMs === stats.mtimeMs) {
    managedClientCache.checkedAtMs = nowMs;
    return managedClientCache.clients;
  }

  const nextClients = freezeConfiguredClients(readManagedApiClients({
    filePath: managedApiClientsPath
  }));
  managedClientCache.exists = true;
  managedClientCache.mtimeMs = stats.mtimeMs;
  managedClientCache.checkedAtMs = nowMs;
  managedClientCache.clients = nextClients;
  managedClientCache.clientsByKeyHash = buildClientKeyHashMap(nextClients);
  return managedClientCache.clients;
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

function ensureEnvConfiguredClients() {
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

function getConfiguredApiClients() {
  const managedClients = loadManagedApiClients();
  if (managedClients.length > 0) {
    return managedClients;
  }

  return ensureEnvConfiguredClients();
}

function getConfiguredClientLookupMap() {
  const managedClients = loadManagedApiClients();
  if (managedClients.length > 0) {
    return managedClientCache.clientsByKeyHash;
  }

  // Ensure env cache is warm.
  ensureEnvConfiguredClients();
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
    return activeClientOrNull(mappedClient);
  }

  // Managed clients take precedence, but operator-provided env keys must keep
  // working alongside them (e.g. a shared bot key configured in .env). Without
  // this, creating any managed client silently disables KABBAK_API_KEY(S).
  const envClients = ensureEnvConfiguredClients();
  if (envClients.length) {
    const envClient = envClientCache.clientsByKeyHash.get(hashed) || null;
    if (envClient && apiKeysMatch(envClient.key, presented)) {
      return activeClientOrNull(envClient);
    }
  }

  // Fallback for rare hash collisions / legacy mismatched encodings.
  const fallback = [...getConfiguredApiClients(), ...envClients]
    .find((configuredClient) => apiKeysMatch(configuredClient.key, presented)) || null;
  return activeClientOrNull(fallback);
}

// Expired clients (e.g. trial demo accounts) stop authenticating.
function activeClientOrNull(client) {
  if (!client) {
    return null;
  }
  return isClientExpired(client) ? null : client;
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

  const grants = require("../services/api-roles").resolveClientGrants(client);
  return {
    authenticated: true,
    type: "api-key",
    clientId: client.id,
    accountId: client.accountId,
    name: String(client?.name || "").trim(),
    accessLevel: grants.accessLevel || client.accessLevel,
    roles: [...client.roles],
    scopes: [...client.scopes],
    capabilities: grants.capabilities
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