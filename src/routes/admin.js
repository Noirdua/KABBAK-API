const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const { createLogWriter } = require("../lib/logger-utils");
const { sanitizeRequestUrl } = require("../lib/request-url");
const {
  readManagedApiClients,
  removeManagedApiClient,
  upsertManagedApiClient,
  generateManagedApiClientId,
  generateManagedApiClientKey,
  rotateManagedApiClientKey,
  ensureDemoClient,
  findDemoClient
} = require("../services/api-client-registry");
const { resetProfile } = require("../services/profile-service");
const { getRuntimeSettings, updateRuntimeSettings } = require("../services/runtime-settings");
const { clearLogEntries, getRecentLogEvents } = require("../services/log-capture");
const { listRegistry } = require("../services/user-registry");
const { resolvePluginUploadLimit } = require("../services/dlc-catalog");
const {
  getHotReloadState,
  startBackgroundHotReload
} = require("../services/storage-bootstrap");
const {
  DEFAULT_LIMITS,
  KNOWN_CAPABILITIES,
  KNOWN_LIMIT_KEYS,
  listRoleDefinitions,
  removeRoleDefinition,
  upsertRoleDefinition
} = require("../services/api-roles");
const {
  listAccessLevelDefinitions,
  upsertAccessLevelDefinition
} = require("../services/api-access-levels");
const {
  getCatalog,
  getInstallAllState,
  listInstalledPlugins,
  isRepoPresent,
  isSparse,
  resolveBranch,
  resolveRepoUrl,
  startInstallAll,
  updateRepo,
  invalidateCatalogCache
} = require("../services/dlc-catalog");
const dlcSources = require("../services/dlc-sources");
const {
  ADMIN_API_MANAGEMENT_CAPABILITY,
  requireApiClientCapability
} = require("../middleware/api-client-capability");

const router = createApiRouter();

function normalizeClientId(value) {
  return String(value || "").trim();
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

function toManagedApiClientSummary(client) {
  return {
    id: client.id,
    name: client.name,
    accountId: client.accountId,
    accessLevel: client.accessLevel,
    roles: [...client.roles],
    scopes: [...client.scopes],
    hasKey: Boolean(String(client.key || "").trim()),
    keyPreview: maskApiKey(client.key)
  };
}

function toManagedApiClientAuditSnapshot(client) {
  if (!client) {
    return null;
  }

  return {
    id: client.id,
    name: client.name,
    accountId: client.accountId,
    accessLevel: client.accessLevel,
    roles: [...client.roles],
    scopes: [...client.scopes],
    hasKey: Boolean(String(client.key || "").trim())
  };
}

function emitAdminMutationAuditEvent(request, response, payload) {
  const writeLog = createLogWriter(request.app?.locals?.logger || console);
  if (!writeLog) {
    return;
  }

  const auth = response.locals?.auth || request.auth || {};
  writeLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "api_admin_mutation",
    requestId: response.locals?.requestId || request.id || "unknown",
    method: request.method,
    path: sanitizeRequestUrl(request.originalUrl),
    actorClientId: auth.clientId || "",
    actorAccountId: auth.accountId || "",
    actorAccessLevel: auth.accessLevel || "",
    ...payload
  }));
}

function getPatchBody(request) {
  if (request.body == null) {
    return {};
  }

  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw createHttpError(400, "invalid_request_body", "Request body must be a JSON object.");
  }

  return request.body;
}

router.use(
  "/admin",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  })
);

router.get("/admin/api-clients", (_request, response) => {
  const managedClients = readManagedApiClients();
  response.apiSuccess({
    count: managedClients.length,
    clients: managedClients.map((client) => toManagedApiClientSummary(client))
  });
});

// Shared demo user key (admin only). The full key is returned once per request
// so admins can hand it out; it is never shown in regular listings.
router.get("/admin/demo-key", (request, response) => {
  const demoClient = findDemoClient();
  if (!demoClient) {
    throw createNotFoundError("demo_client_not_found", "No demo user configured.");
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "read_demo_key",
    targetClientId: demoClient.id
  });

  response.apiSuccess({
    id: demoClient.id,
    name: demoClient.name,
    accessLevel: demoClient.accessLevel,
    apiKey: String(demoClient.key || "")
  });
});

// Create the demo user if it doesn't exist (idempotent). The key is only
// returned when the demo user was just created.
router.post("/admin/demo-user", (request, response) => {
  const result = ensureDemoClient();

  emitAdminMutationAuditEvent(request, response, {
    action: "create_demo_user",
    targetClientId: result.client?.id || "",
    created: result.created
  });

  response.apiSuccess({
    created: result.created,
    id: result.client?.id || "",
    name: result.client?.name || "",
    accessLevel: result.client?.accessLevel || "",
    apiKey: result.created ? String(result.client?.key || "") : ""
  });
});

// Rotate the demo key. Everyone using the old demo key loses access.
router.post("/admin/demo-user/rotate-key", (request, response) => {
  const demoClient = findDemoClient();
  if (!demoClient) {
    throw createNotFoundError("demo_client_not_found", "No demo user configured.");
  }

  const result = rotateManagedApiClientKey(demoClient.id);

  emitAdminMutationAuditEvent(request, response, {
    action: "rotate_demo_key",
    targetClientId: demoClient.id
  });

  response.apiSuccess({
    rotated: true,
    id: demoClient.id,
    apiKey: String(result.client?.key || "")
  });
});

// Wipe the demo profile so the next visitors start from a clean notebook.
router.post("/admin/demo-user/reset-profile", (request, response) => {
  const demoClient = findDemoClient();
  if (!demoClient) {
    throw createNotFoundError("demo_client_not_found", "No demo user configured.");
  }

  const reset = resetProfile(demoClient.id);

  emitAdminMutationAuditEvent(request, response, {
    action: "reset_demo_profile",
    targetClientId: demoClient.id
  });

  response.apiSuccess({
    reset,
    id: demoClient.id
  });
});

// Remove the demo user entirely.
router.delete("/admin/demo-user", (request, response) => {
  const demoClient = findDemoClient();
  if (!demoClient) {
    throw createNotFoundError("demo_client_not_found", "No demo user configured.");
  }

  const result = removeManagedApiClient(demoClient.id);

  emitAdminMutationAuditEvent(request, response, {
    action: "delete_demo_user",
    targetClientId: demoClient.id,
    removed: result.removed
  });

  response.apiSuccess({
    removed: result.removed,
    id: demoClient.id
  });
});

// Merged user view: managed clients + registry presence (profile activity).
router.get("/admin/users", (_request, response) => {  const clients = readManagedApiClients();
  const registryUsers = listRegistry({ includeOffline: true });
  const registryById = new Map(registryUsers.map((user) => [String(user.id), user]));

  const users = clients.map((client) => {
    const presence = registryById.get(client.id) || {};
    return {
      ...toManagedApiClientSummary(client),
      displayName: String(presence.name || client.name || "").trim(),
      status: String(presence.status || "never-seen"),
      lastSeen: String(presence.lastSeen || ""),
      bio: String(presence.bio || "").slice(0, 400)
    };
  });

  // Registry entries without a managed client entry (legacy) still show up.
  const seenIds = new Set(users.map((user) => user.id));
  for (const presence of registryUsers) {
    if (seenIds.has(presence.id)) continue;
    users.push({
      id: presence.id,
      name: String(presence.name || "").trim(),
      displayName: String(presence.name || "").trim(),
      accountId: "",
      accessLevel: String(presence.accessLevel || ""),
      roles: [],
      scopes: [],
      hasKey: false,
      keyPreview: "",
      status: String(presence.status || "offline"),
      lastSeen: String(presence.lastSeen || ""),
      bio: String(presence.bio || "").slice(0, 400)
    });
  }

  response.apiSuccess({ count: users.length, users });
});

// Create a managed API client. Omitted id/key are generated server-side and the
// full key is returned exactly once (it is never stored in plaintext by the
// frontend after that).
router.post("/admin/api-clients", (request, response) => {
  const body = getPatchBody(request);
  const existingClients = readManagedApiClients();
  const clientId = normalizeClientId(body.id || body.clientId) || generateManagedApiClientId(existingClients);
  const apiKey = normalizeClientId(body.key || body.apiKey) || generateManagedApiClientKey(existingClients);

  const result = upsertManagedApiClient({
    ...body,
    id: clientId,
    key: apiKey
  });

  emitAdminMutationAuditEvent(request, response, {
    action: "create_managed_api_client",
    targetClientId: clientId,
    created: result.created,
    nextClient: toManagedApiClientAuditSnapshot(result.client)
  });

  response.status(201).apiSuccess({
    created: result.created,
    count: result.clients.length,
    client: result.client ? toManagedApiClientSummary(result.client) : null,
    apiKey
  });
});

// Rotate a client's key. The new full key is returned exactly once.
router.post("/admin/api-clients/:clientId/rotate-key", (request, response) => {
  const clientId = normalizeClientId(request.params.clientId);
  if (!clientId) {
    throw createHttpError(400, "invalid_client_id", "A clientId route parameter is required.");
  }

  let result;
  try {
    result = rotateManagedApiClientKey(clientId);
  } catch (error) {
    throw createNotFoundError("api_client_not_found", error.message);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "rotate_managed_api_client_key",
    targetClientId: clientId,
    rotated: true,
    nextClient: toManagedApiClientAuditSnapshot(result.client)
  });

  response.apiSuccess({
    rotated: true,
    clientId,
    client: result.client ? toManagedApiClientSummary(result.client) : null,
    apiKey: String(result.client?.key || "")
  });
});

// --- Role definitions (capabilities + granulated limits) ---------------------

function buildRolesPayload() {
  return {
    roles: listRoleDefinitions(),
    capabilities: [...KNOWN_CAPABILITIES],
    limitKeys: [...KNOWN_LIMIT_KEYS],
    defaultLimits: { ...DEFAULT_LIMITS }
  };
}

router.get("/admin/roles", (_request, response) => {
  response.apiSuccess(buildRolesPayload());
});

router.put("/admin/roles/:roleId", (request, response) => {
  const roleId = normalizeClientId(request.params.roleId);
  if (!roleId) {
    throw createHttpError(400, "invalid_role_id", "A roleId route parameter is required.");
  }
  const body = getPatchBody(request);
  let definition;
  try {
    definition = upsertRoleDefinition(roleId, body);
  } catch (error) {
    throw createHttpError(400, "invalid_role_definition", error.message);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "upsert_role_definition",
    roleId: definition.id,
    nextRole: definition
  });

  response.apiSuccess({
    role: definition,
    ...buildRolesPayload()
  });
});

router.delete("/admin/roles/:roleId", (request, response) => {
  const roleId = normalizeClientId(request.params.roleId);
  if (!roleId) {
    throw createHttpError(400, "invalid_role_id", "A roleId route parameter is required.");
  }
  const removed = removeRoleDefinition(roleId);
  if (!removed) {
    throw createNotFoundError("role_not_found", `Role '${roleId}' was not found.`);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "delete_role_definition",
    roleId
  });

  response.apiSuccess({
    removed: true,
    roleId,
    ...buildRolesPayload()
  });
});

// --- Server settings (runtime-adjustable) ------------------------------------

router.get("/admin/settings", (_request, response) => {
  response.apiSuccess(getRuntimeSettings());
});

router.patch("/admin/settings", (request, response) => {
  const body = getPatchBody(request);
  let updated;
  try {
    updated = updateRuntimeSettings(body);
  } catch (error) {
    throw createHttpError(400, "invalid_runtime_setting", error.message);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "update_runtime_settings",
    keys: Object.keys(body || {})
  });

  response.apiSuccess(updated);
});

router.post("/admin/overlay-background", (request, response) => {
  const body = getPatchBody(request);
  let saved;
  try {
    saved = require("../services/overlay-background").saveOverlayFromDataUrl(body?.data || body?.dataUrl);
    updateRuntimeSettings({ overlayBackgroundUrl: saved.url });
  } catch (error) {
    throw createHttpError(400, "invalid_overlay_background", error.message);
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "upload_overlay_background"
  });
  response.apiSuccess({ overlayBackgroundUrl: saved.url });
});

router.delete("/admin/overlay-background", (_request, response) => {
  require("../services/overlay-background").clearOverlayFile();
  updateRuntimeSettings({ overlayBackgroundUrl: "" });
  emitAdminMutationAuditEvent(_request, response, {
    action: "clear_overlay_background"
  });
  response.apiSuccess({ overlayBackgroundUrl: "" });
});

// --- Live log view -----------------------------------------------------------

router.get("/admin/logs", (request, response) => {
  const level = String(request.query?.level || "all").toLowerCase();
  const event = String(request.query?.event || "").trim();
  const limit = Number(request.query?.limit) || 200;
  const entries = getRecentLogEvents({ limit, level, event });
  response.apiSuccess({
    count: entries.length,
    entries
  });
});

router.delete("/admin/logs", (request, response) => {
  clearLogEntries();
  emitAdminMutationAuditEvent(request, response, {
    action: "clear_log_buffer"
  });
  response.apiSuccess({ cleared: true });
});

// --- Storage hot reload (DLC install/uninstall without a restart) ------------
router.post("/admin/dlc/reload", (request, response) => {
  startBackgroundHotReload();

  emitAdminMutationAuditEvent(request, response, {
    action: "reload_storage_snapshot"
  });

  response.apiSuccess({
    started: true,
    ...getHotReloadState()
  });
});

// Pull every DLC checkout (git fetch + fast-forward) so installed plugins pick
// up the latest files. The catalog is listed from the git tree. Failures are
// reported in-band (the generic 5xx envelope hides details, but admins need the git error).
router.post("/admin/dlc/update", (request, response) => {
  let head = "";
  let failure = "";
  let synced = [];
  try {
    const writeLog = createLogWriter(request.app?.locals?.logger || console);
    const log = (message) => {
      if (!writeLog) return;
      writeLog(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "api_dlc",
        action: "update_dlc_checkout",
        message: String(message || "")
      }));
    };
    synced = dlcSources.syncAllEnabledSources({ log });
    const primary = synced.find((source) => source.primary) || synced[0];
    head = primary?.head || updateRepo({ log });
  } catch (error) {
    failure = String(error?.message || "The DLC checkout could not be updated.");
  }
  invalidateCatalogCache();

  emitAdminMutationAuditEvent(request, response, {
    action: "update_dlc_checkout",
    branch: resolveBranch(),
    head,
    failed: Boolean(failure),
    error: failure
  });

  response.apiSuccess({
    updated: !failure,
    branch: resolveBranch(),
    head,
    url: resolveRepoUrl(),
    sources: dlcSources.listDescribedSources(),
    error: failure
  });
});

router.get("/admin/dlc/reload-status", (_request, response) => {
  response.apiSuccess(getHotReloadState());
});

// Install every available item of one category in the background so the client
// can navigate away without cancelling the work. Progress is polled here.
router.post(
  "/admin/dlc/install-all",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const kind = String(getPatchBody(request)?.kind || "").trim();
    const writeLog = createLogWriter(request.app?.locals?.logger || console);
    startInstallAll({
      kind,
      log: (message) => {
        if (!writeLog) return;
        writeLog(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_dlc",
          action: "install_all_dlc_items",
          message: String(message || "")
        }));
      }
    });

    emitAdminMutationAuditEvent(request, response, {
      action: "install_all_dlc_items",
      kind
    });

    response.apiSuccess({ started: true, ...getInstallAllState() });
  }
);

router.get("/admin/dlc/install-status", (_request, response) => {
  response.apiSuccess(getInstallAllState());
});

router.get("/admin/dlc/sources", (_request, response) => {
  response.apiSuccess({
    sources: dlcSources.listDescribedSources()
  });
});

router.post("/admin/dlc/sources", (request, response) => {
  const body = getPatchBody(request);
  let source;
  try {
    source = dlcSources.addSource({
      name: body.name,
      url: body.url,
      branch: body.branch
    }, {
      log: (message) => {
        const writeLog = createLogWriter(request.app?.locals?.logger || console);
        if (!writeLog) return;
        writeLog(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_dlc",
          action: "add_dlc_source",
          message: String(message || "")
        }));
      }
    });
  } catch (error) {
    throw createHttpError(400, "invalid_dlc_source", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "add_dlc_source",
    sourceId: source.id,
    url: source.url
  });
  response.status(201).apiSuccess({
    source,
    sources: dlcSources.listDescribedSources()
  });
});

router.patch("/admin/dlc/sources/:sourceId", (request, response) => {
  const sourceId = String(request.params.sourceId || "").trim();
  const body = getPatchBody(request);
  let source;
  try {
    source = dlcSources.updateSource(sourceId, body, {
      log: (message) => {
        const writeLog = createLogWriter(request.app?.locals?.logger || console);
        if (!writeLog) return;
        writeLog(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_dlc",
          action: "update_dlc_source",
          message: String(message || "")
        }));
      }
    });
  } catch (error) {
    throw createHttpError(400, "invalid_dlc_source", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "update_dlc_source",
    sourceId: source.id
  });
  response.apiSuccess({
    source,
    sources: dlcSources.listDescribedSources()
  });
});

router.delete("/admin/dlc/sources/:sourceId", (request, response) => {
  const sourceId = String(request.params.sourceId || "").trim();
  let result;
  try {
    result = dlcSources.removeSource(sourceId);
  } catch (error) {
    throw createHttpError(400, "invalid_dlc_source", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "remove_dlc_source",
    sourceId
  });
  response.apiSuccess({
    ...result,
    sources: dlcSources.listDescribedSources()
  });
});

router.post("/admin/dlc/sources/:sourceId/sync", (request, response) => {
  const sourceId = String(request.params.sourceId || "").trim();
  let source;
  try {
    source = dlcSources.syncSource(sourceId, {
      log: (message) => {
        const writeLog = createLogWriter(request.app?.locals?.logger || console);
        if (!writeLog) return;
        writeLog(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_dlc",
          action: "sync_dlc_source",
          message: String(message || "")
        }));
      }
    });
  } catch (error) {
    throw createHttpError(502, "dlc_sync_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "sync_dlc_source",
    sourceId,
    head: source.head
  });
  response.apiSuccess({
    source,
    sources: dlcSources.listDescribedSources()
  });
});

// --- Access level definitions (what basic/premium/pro+ mean) -----------------

function buildAccessLevelsPayload() {
  return {
    levels: listAccessLevelDefinitions(),
    limitKeys: [...KNOWN_LIMIT_KEYS],
    defaultLimits: { ...DEFAULT_LIMITS }
  };
}

// --- Tier overview (base access tiers + custom tiers, billing-ready) --------

const SUPPORTED_CURRENCIES = Object.freeze(["USD", "EUR", "GBP", "AUD", "CAD"]);

function buildTiersPayload() {
  return {
    baseTiers: listAccessLevelDefinitions(),
    customTiers: listRoleDefinitions(),
    capabilities: [...KNOWN_CAPABILITIES],
    limitKeys: [...KNOWN_LIMIT_KEYS],
    defaultLimits: { ...DEFAULT_LIMITS },
    currencies: [...SUPPORTED_CURRENCIES]
  };
}

router.get("/admin/tiers", (_request, response) => {
  response.apiSuccess(buildTiersPayload());
});

router.get("/admin/access-levels", (_request, response) => {
  response.apiSuccess(buildAccessLevelsPayload());
});

router.put("/admin/access-levels/:levelId", (request, response) => {
  const levelId = normalizeClientId(request.params.levelId);
  if (!levelId) {
    throw createHttpError(400, "invalid_access_level", "A levelId route parameter is required.");
  }
  const body = getPatchBody(request);
  let definition;
  try {
    definition = upsertAccessLevelDefinition(levelId, body);
  } catch (error) {
    throw createHttpError(400, "invalid_access_level_definition", error.message);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "upsert_access_level_definition",
    levelId: definition.id,
    nextLevel: definition
  });

  response.apiSuccess({
    level: definition,
    ...buildAccessLevelsPayload()
  });
});

router.get("/admin/overview", async (_request, response) => {
  const clients = readManagedApiClients();
  const registry = listRegistry({ includeOffline: true });
  const onlineCount = registry.filter((user) => user.status === "online").length;
  const plugins = listInstalledPlugins();
  const catalog = await getCatalog();
  const catalogCounts = {};
  for (const item of catalog.items) {
    catalogCounts[item.kind] = (catalogCounts[item.kind] || 0) + 1;
  }

  let dlcRepo = null;
  try {
    dlcRepo = {
      present: isRepoPresent(),
      sparse: isSparse(),
      branch: resolveBranch(),
      url: resolveRepoUrl(),
      sources: dlcSources.listDescribedSources()
    };
  } catch (_error) {
    dlcRepo = { present: false, sparse: false, branch: "", url: "" };
  }

  response.apiSuccess({
    serverTime: new Date().toISOString(),
    counts: {
      apiClients: clients.length,
      registryUsers: registry.length,
      registryOnline: onlineCount,
      installedPlugins: plugins.length,
      roles: listRoleDefinitions().length
    },
    catalog: {
      origin: catalog.origin,
      counts: catalogCounts,
      items: catalog.items.length
    },
    limits: {
      jsonBodyLimit: String(getRuntimeSettings().jsonBodyLimit || "40mb"),
      pluginUploadBytes: resolvePluginUploadLimit()
    },
    dlcRepo,
    installedPlugins: plugins.map((plugin) => ({
      name: plugin.name,
      title: plugin.title,
      version: plugin.version
    }))
  });
});

router.patch("/admin/api-clients/:clientId", (request, response) => {
  const clientId = normalizeClientId(request.params.clientId);
  if (!clientId) {
    throw createHttpError(400, "invalid_client_id", "A clientId route parameter is required.");
  }
  const existingClient = readManagedApiClients().find((client) => client.id === clientId) || null;
  const body = getPatchBody(request);
  if (body.id != null && normalizeClientId(body.id) !== clientId) {
    throw createHttpError(400, "invalid_client_id", "Client id in the request body must match the route parameter.");
  }

  const result = upsertManagedApiClient({
    ...body,
    id: clientId
  });

  emitAdminMutationAuditEvent(request, response, {
    action: result.created ? "create_managed_api_client" : "update_managed_api_client",
    targetClientId: clientId,
    created: result.created,
    updated: result.updated,
    keyChanged: String(existingClient?.key || "") !== String(result.client?.key || ""),
    previousClient: toManagedApiClientAuditSnapshot(existingClient),
    nextClient: toManagedApiClientAuditSnapshot(result.client)
  });

  response.status(result.created ? 201 : 200).apiSuccess({
    created: result.created,
    updated: result.updated,
    count: result.clients.length,
    client: result.client ? toManagedApiClientSummary(result.client) : null
  });
});

router.delete("/admin/api-clients/:clientId", (request, response) => {
  const clientId = normalizeClientId(request.params.clientId);
  if (!clientId) {
    throw createHttpError(400, "invalid_client_id", "A clientId route parameter is required.");
  }

  const existingClient = readManagedApiClients().find((client) => client.id === clientId) || null;
  const result = removeManagedApiClient(clientId);
  if (!result.removed) {
    throw createNotFoundError("api_client_not_found", `Managed API client '${clientId}' was not found.`);
  }

  emitAdminMutationAuditEvent(request, response, {
    action: "delete_managed_api_client",
    targetClientId: clientId,
    removed: true,
    previousClient: toManagedApiClientAuditSnapshot(existingClient),
    nextClient: null
  });

  response.apiSuccess({
    removed: true,
    clientId,
    count: result.clients.length
  });
});

module.exports = router;