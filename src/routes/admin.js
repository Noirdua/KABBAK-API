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
  rotateManagedApiClientKey
} = require("../services/api-client-registry");
const { getRuntimeSettings, updateRuntimeSettings } = require("../services/runtime-settings");
const { clearLogEntries, getLogFacets, getRecentLogEvents } = require("../services/log-capture");
const { listJobs } = require("../services/job-progress");
const { listRegistry } = require("../services/user-registry");
const { createBroadcast, deleteBroadcast, listBroadcasts } = require("../services/message-store");
const { addProfileMessage, buildSharePath } = require("../services/profile-service");
const { resolveAudienceClientIds } = require("../services/audience-service");
const { appendLogEntry, clearLog, deleteLogEntry, listLogEntries } = require("../services/message-log");
const { clearReplies, deleteReply, listReplies } = require("../services/reply-store");
const { clearReports, deleteReport, listReports, resolveReport } = require("../services/report-store");
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
  invalidateCatalogCache,
  mergeTextDlcItems,
  buildTextMergeDraft
} = require("../services/dlc-catalog");
const dlcSources = require("../services/dlc-sources");
const dlcPublish = require("../services/dlc-publish");
const dlcEditor = require("../services/dlc-editor");
const dlcValidate = require("../services/dlc-validate");
const deckPreview = require("../services/deck-preview");
const { reloadPluginServers } = require("../services/plugin-servers");
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

function findManagedClientById(clientId) {
  return readManagedApiClients().find((client) => client.id === clientId) || null;
}

function rejectHiddenManagedClient(client, clientId) {
  if (client?.hidden === true) {
    throw createNotFoundError("api_client_not_found", `Managed API client '${clientId}' was not found.`);
  }
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
  // Hidden clients (e.g. plugin-managed demo accounts) are managed elsewhere.
  const managedClients = readManagedApiClients().filter((client) => client.hidden !== true);
  response.apiSuccess({
    count: managedClients.length,
    clients: managedClients.map((client) => toManagedApiClientSummary(client))
  });
});

// Merged user view: managed clients + registry presence (profile activity).
router.get("/admin/users", (_request, response) => {
  const allClients = readManagedApiClients();
  // Trial accounts own one hidden client each; show those (with the account's
  // username/email) while other hidden clients stay out of the panel.
  const accountsByClientId = new Map();
  try {
    require("../services/account-service").listAccounts().forEach((account) => {
      const clientId = String(account?.trial?.clientId || "").trim();
      if (clientId) {
        accountsByClientId.set(clientId, account);
      }
    });
  } catch (_error) {}
  const clients = allClients.filter((client) => client.hidden !== true || accountsByClientId.has(client.id));
  const hiddenClientIds = new Set(allClients.filter((client) => client.hidden === true).map((client) => client.id));
  const registryUsers = listRegistry({ includeOffline: true });
  const registryById = new Map(registryUsers.map((user) => [String(user.id), user]));

  const users = clients.map((client) => {
    const presence = registryById.get(client.id) || {};
    const account = accountsByClientId.get(client.id) || null;
    return {
      ...toManagedApiClientSummary(client),
      displayName: String(presence.name || client.name || "").trim(),
      status: String(presence.status || "never-seen"),
      lastSeen: String(presence.lastSeen || ""),
      bio: String(presence.bio || "").slice(0, 400),
      // Present only for self-serve trial accounts.
      isTrialAccount: Boolean(account),
      username: String(account?.username || ""),
      email: String(account?.email || ""),
      trialActive: account ? account.trialActive === true : false,
      trialKeyPresent: account ? account.keyPresent === true : false
    };
  });

  // Registry entries without a managed client entry (legacy) still show up.
  const seenIds = new Set(users.map((user) => user.id));
  for (const presence of registryUsers) {
    if (seenIds.has(presence.id) || hiddenClientIds.has(presence.id)) continue;
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

// --- Inbox messages ----------------------------------------------------------

function withMessagePath(message) {
  return {
    ...message,
    path: buildSharePath(message.token),
    seenCount: Object.keys(message.readers || {}).length
  };
}

router.get("/admin/messages", (_request, response) => {
  const messages = listBroadcasts();
  response.apiSuccess({ count: messages.length, messages: messages.map(withMessagePath) });
});

router.post("/admin/messages", (request, response) => {
  const body = getPatchBody(request);
  const message = createBroadcast(body, { sender: String(body.sender || "Admin") });
  emitAdminMutationAuditEvent(request, response, {
    action: "create_broadcast",
    targetMessageId: message.id
  });
  response.status(201).apiSuccess(withMessagePath(message));
});

router.delete("/admin/messages/:messageId", (request, response) => {
  let result;
  try {
    result = deleteBroadcast(request.params.messageId);
  } catch (error) {
    throw createNotFoundError("message_not_found", error.message);
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "delete_broadcast",
    targetMessageId: String(request.params.messageId || ""),
    removed: result.removed
  });
  response.apiSuccess(result);
});

// Send a message to an audience: everyone (global broadcast), specific users, or
// everyone holding selected roles/tiers (delivered per user).
router.post("/admin/messages/send", (request, response) => {
  const body = getPatchBody(request);
  const { type, clientIds } = resolveAudienceClientIds(body.audience);
  const message = {
    kind: body.kind,
    title: body.title,
    description: body.description,
    attachments: body.attachments,
    visibility: body.visibility,
    publishAt: body.publishAt,
    expiresAt: body.expiresAt,
    requiresAck: body.requiresAck
  };

  if (type === "all") {
    const broadcast = createBroadcast(message, { sender: "Admin" });
    appendLogEntry({
      audience: "all",
      title: message.title,
      kind: message.kind,
      visibility: message.visibility === "public" ? "public" : "internal",
      broadcast: true,
      token: broadcast.token,
      delivered: 0,
      sender: "Admin"
    });
    emitAdminMutationAuditEvent(request, response, {
      action: "send_broadcast",
      targetMessageId: broadcast.id
    });
    response.status(201).apiSuccess({
      broadcast: true,
      delivered: 0,
      recipients: [],
      message: withMessagePath(broadcast)
    });
    return;
  }

  if (!clientIds.length) {
    throw createHttpError(400, "empty_audience", "No recipients matched that audience.");
  }

  let delivered = 0;
  const failures = [];
  for (const clientId of clientIds) {
    try {
      addProfileMessage(
        clientId,
        { ...message, visibility: message.visibility || "internal" },
        { sender: "Admin" }
      );
      delivered += 1;
    } catch (error) {
      failures.push({ clientId, error: error?.code || error?.message });
    }
  }

  appendLogEntry({
    audience: type,
    audienceDetail: {
      roles: Array.isArray(body.audience?.roles) ? body.audience.roles : [],
      userCount: clientIds.length
    },
    title: message.title,
    kind: message.kind,
    visibility: "internal",
    broadcast: false,
    delivered,
    failures: failures.length,
    sender: "Admin"
  });

  emitAdminMutationAuditEvent(request, response, {
    action: "send_direct_messages",
    audience: type,
    delivered
  });
  response.status(201).apiSuccess({ broadcast: false, delivered, recipients: clientIds, failures });
});

// --- Send history ------------------------------------------------------------

router.get("/admin/messages/log", (_request, response) => {
  const entries = listLogEntries();
  response.apiSuccess({ count: entries.length, entries });
});

// "log/all" avoids colliding with DELETE /admin/messages/:messageId.
router.delete("/admin/messages/log/all", (_request, response) => {
  response.apiSuccess(clearLog());
});

router.delete("/admin/messages/log/:entryId", (request, response) => {
  response.apiSuccess(deleteLogEntry(request.params.entryId));
});

// --- Replies -----------------------------------------------------------------

router.get("/admin/messages/replies", (_request, response) => {
  const replies = listReplies();
  response.apiSuccess({ count: replies.length, replies });
});

router.delete("/admin/messages/replies/all", (_request, response) => {
  response.apiSuccess(clearReplies());
});

router.delete("/admin/messages/replies/:replyId", (request, response) => {
  response.apiSuccess(deleteReply(request.params.replyId));
});

// --- Community reports -------------------------------------------------------

router.get("/admin/reports", (_request, response) => {
  const reports = listReports();
  response.apiSuccess({ count: reports.length, reports });
});

// "all" is registered before the :reportId route so it is not shadowed.
router.delete("/admin/reports/all", (_request, response) => {
  response.apiSuccess(clearReports());
});

router.post("/admin/reports/:reportId/resolve", (request, response) => {
  let report;
  try {
    report = resolveReport(request.params.reportId);
  } catch (error) {
    throw createNotFoundError("report_not_found", error.message);
  }
  // Let the reporter know their report was actioned.
  if (report.reporterClientId) {
    try {
      addProfileMessage(report.reporterClientId, {
        kind: "report",
        title: `Report reviewed: ${report.topicTitle || report.topicId}`,
        description: "Thanks — an admin has reviewed your report.",
        visibility: "internal"
      }, { sender: "Community" });
    } catch (_error) {
      // Notification is best-effort.
    }
  }
  response.apiSuccess(report);
});

router.delete("/admin/reports/:reportId", (request, response) => {
  response.apiSuccess(deleteReport(request.params.reportId));
});

// Send a message into one user's inbox (direct send / plugin report).
router.post("/admin/users/:clientId/messages", (request, response) => {
  const body = getPatchBody(request);
  let result;
  try {
    result = addProfileMessage(request.params.clientId, body, { sender: String(body.sender || "Admin") });
  } catch (error) {
    if (error?.code === "invalid_message") {
      throw createHttpError(400, "invalid_message", error.message);
    }
    if (error?.code === "attachments_limit_reached" || error?.code === "messages_limit_reached") {
      throw createHttpError(409, error.code, error.message);
    }
    if (error?.code === "attachment_too_large") {
      throw createHttpError(413, "attachment_too_large", error.message);
    }
    throw error;
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "send_direct_message",
    targetClientId: String(request.params.clientId || ""),
    targetMessageId: result.message.id
  });
  response.status(201).apiSuccess(withMessagePath(result.message));
});

// Create a managed API client. Omitted id/key are generated server-side and the
// full key is returned exactly once (it is never stored in plaintext by the
// frontend after that).
router.post("/admin/api-clients", (request, response) => {
  const body = getPatchBody(request);
  const existingClients = readManagedApiClients();
  const clientId = normalizeClientId(body.id || body.clientId) || generateManagedApiClientId(existingClients);
  const apiKey = normalizeClientId(body.key || body.apiKey) || generateManagedApiClientKey(existingClients);
  rejectHiddenManagedClient(existingClients.find((client) => client.id === clientId) || null, clientId);

  const result = upsertManagedApiClient({
    ...body,
    id: clientId,
    key: apiKey,
    hidden: false
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

  rejectHiddenManagedClient(findManagedClientById(clientId), clientId);

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
  const mail = require("../services/mail-service");
  response.apiSuccess({
    ...getRuntimeSettings(),
    // What this server actually resolves to right now (read-only diagnostics).
    mailConfigured: mail.isMailConfigured(),
    mailTransportEffective: mail.resolveTransport()
  });
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

// Recent inbound provider webhook events (delivery, bounce, complaint).
router.get("/admin/email-events", (request, response) => {
  const requested = Number(request.query.limit);
  const events = require("../services/email-webhook-service").listEmailEvents(
    Number.isFinite(requested) ? requested : 50
  );
  response.apiSuccess({ events });
});

// One-click email diagnosis: reports the transport this server resolves to and
// what the provider said, so "no email arrived" can be pinpointed from the panel.
router.post("/admin/mail-test", async (request, response, next) => {
  try {
    const body = getPatchBody(request);
    const to = String(body?.to || "").trim();
    if (!to || !to.includes("@")) {
      throw createHttpError(400, "invalid_recipient", "Provide a recipient email address.");
    }

    const mail = require("../services/mail-service");
    const result = await mail.sendMail({
      to,
      subject: "KABBAK email test",
      text: "If you received this, KABBAK can send account email from this server."
    });

    emitAdminMutationAuditEvent(request, response, { action: "send_test_email" });

    response.apiSuccess({
      to,
      configured: mail.isMailConfigured(),
      transport: mail.resolveTransport(),
      from: mail.getMailConfig().from,
      delivered: result.delivered === true,
      reason: result.reason || "",
      status: Number.isFinite(result.status) ? result.status : null
    });
  } catch (error) {
    next(error);
  }
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

router.post("/admin/favicon", (request, response) => {
  const body = getPatchBody(request);
  let saved;
  try {
    saved = require("../services/favicon").saveFaviconFromDataUrl(body?.data || body?.dataUrl, body?.fileName);
    updateRuntimeSettings({ faviconUrl: saved.url });
  } catch (error) {
    throw createHttpError(400, "invalid_favicon", error.message);
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "upload_favicon"
  });
  response.apiSuccess({ faviconUrl: saved.url });
});

router.delete("/admin/favicon", (_request, response) => {
  require("../services/favicon").clearFaviconFile();
  updateRuntimeSettings({ faviconUrl: "" });
  emitAdminMutationAuditEvent(_request, response, {
    action: "clear_favicon"
  });
  response.apiSuccess({ faviconUrl: "" });
});

// --- Live log view -----------------------------------------------------------

function buildJobsPayload() {
  const storage = getHotReloadState();
  const installAll = getInstallAllState();
  const tracked = listJobs();
  return {
    jobs: [
      {
        id: "storage",
        label: "Storage snapshot",
        state: storage.state || "idle",
        current: "",
        done: storage.state === "done" ? 1 : 0,
        total: 1,
        message: storage.message || "",
        updatedAt: storage.finishedAt || storage.startedAt || ""
      },
      {
        id: "install-all",
        label: "Install All",
        state: installAll.state || "idle",
        current: installAll.current || "",
        done: Number(installAll.done) || 0,
        total: Number(installAll.total) || 0,
        message: installAll.message || "",
        updatedAt: ""
      },
      ...tracked
    ]
  };
}

router.get("/admin/jobs", (_request, response) => {
  response.apiSuccess(buildJobsPayload());
});

router.get("/admin/logs", (request, response) => {
  const level = String(request.query?.level || "all").toLowerCase();
  const event = String(request.query?.event || "").trim();
  const pathGroup = String(request.query?.pathGroup || request.query?.group || "").trim();
  const q = String(request.query?.q || request.query?.search || "").trim();
  const since = String(request.query?.since || "").trim();
  const until = String(request.query?.until || "").trim();
  const sinceMinutes = Number(request.query?.sinceMinutes) || 0;
  const limit = Number(request.query?.limit) || 200;
  const entries = getRecentLogEvents({
    limit,
    level,
    event,
    pathGroup,
    q,
    since,
    until,
    sinceMinutes
  });
  response.apiSuccess({
    count: entries.length,
    entries,
    facets: getLogFacets()
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
  reloadPluginServers();

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

// --- Publish DLC items back to a git source (admin-supplied HTTPS token) ----

router.get("/admin/dlc/publish", (_request, response) => {
  response.apiSuccess({ sources: dlcPublish.getPublishStatus() });
});

router.put("/admin/dlc/publish/credentials", (request, response) => {
  const body = getPatchBody(request);
  let sources;
  try {
    sources = dlcPublish.setPublishCredential(body.sourceId, {
      username: body.username,
      token: body.token
    });
  } catch (error) {
    throw createHttpError(400, "invalid_publish_credential", error.message);
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "set_dlc_publish_credential",
    sourceId: String(body.sourceId || "").trim()
  });
  response.apiSuccess({ sources });
});

router.delete("/admin/dlc/publish/credentials/:sourceId", (request, response) => {
  const sourceId = String(request.params.sourceId || "").trim();
  let sources;
  try {
    sources = dlcPublish.clearPublishCredential(sourceId);
  } catch (error) {
    throw createHttpError(400, "invalid_publish_credential", error.message);
  }
  emitAdminMutationAuditEvent(request, response, {
    action: "clear_dlc_publish_credential",
    sourceId
  });
  response.apiSuccess({ sources });
});

router.post("/admin/dlc/publish/status", (request, response) => {
  const body = getPatchBody(request);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
  const ctx = {};
  const statuses = items.map((item) => {
    const kind = String(item?.kind || "");
    const name = String(item?.name || "");
    const result = dlcPublish.getPublishPending({ kind, name, sourceId: String(item?.sourceId || "") }, ctx);
    return { kind, name, pending: result.pending === true, reason: result.reason };
  });
  dlcPublish.flushPublishSnapshots(ctx);
  response.apiSuccess({ statuses });
});

router.post("/admin/dlc/publish", (request, response) => {
  const body = getPatchBody(request);
  const kind = String(body?.kind || "").trim();
  const name = String(body?.name || "").trim();
  if (!kind || !name) {
    throw createHttpError(400, "invalid_publish_request", "Both `kind` and `name` are required.");
  }
  let result;
  try {
    result = dlcPublish.publishItem({
      kind,
      name,
      sourceId: body?.sourceId,
      message: body?.message
    }, {
      log: (message) => {
        const writeLog = createLogWriter(request.app?.locals?.logger || console);
        if (!writeLog) return;
        writeLog(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_dlc",
          action: "publish_dlc_item",
          message: String(message || "")
        }));
      }
    });
  } catch (error) {
    throw createHttpError(502, "dlc_publish_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "publish_dlc_item",
    itemKind: result.kind,
    itemName: result.name,
    sourceId: result.sourceId,
    branch: result.branch,
    committed: result.committed
  });
  response.apiSuccess(result);
});

// --- Edit / delete DLC items (uninstalled content only) ---------------------

function assertItemQuery(request) {
  const kind = String(request.query?.kind || request.body?.kind || "").trim();
  const name = String(request.query?.name || request.body?.name || "").trim();
  const sourceId = String(request.query?.sourceId || request.body?.sourceId || "").trim();
  const id = String(request.query?.id || request.body?.id || "").trim();
  if (!kind || !name) {
    throw createHttpError(400, "invalid_item_request", "Both `kind` and `name` are required.");
  }
  return { kind, name, sourceId, id };
}

router.get("/admin/dlc/validate", (request, response) => {
  const { kind, name, sourceId } = assertItemQuery(request);
  let dir;
  try {
    dir = dlcEditor.resolveEditableDir(kind, name, sourceId).dir;
  } catch (error) {
    throw createHttpError(400, "dlc_item_read_failed", error.message);
  }
  response.apiSuccess(dlcValidate.validateItemDir(kind, name, dir));
});

// Read-only deck preview (works for decks that are not installed/downloaded).
router.get("/admin/dlc/deck/preview", (request, response) => {
  const { kind, name, sourceId } = assertItemQuery(request);
  if (kind !== "deck") {
    throw createHttpError(400, "invalid_deck_preview", "Only decks can be previewed.");
  }
  let result;
  try {
    result = deckPreview.listDeckImages(name, sourceId);
  } catch (error) {
    throw createHttpError(400, "deck_preview_failed", error.message);
  }
  response.apiSuccess(result);
});

router.get("/admin/dlc/deck/image", (request, response) => {
  const { kind, name, sourceId } = assertItemQuery(request);
  if (kind !== "deck") {
    throw createHttpError(400, "invalid_deck_preview", "Only decks can be previewed.");
  }
  const filePath = String(request.query?.path || "").trim();
  let image;
  try {
    image = deckPreview.readDeckImage(name, filePath, sourceId);
  } catch (error) {
    throw createHttpError(400, "deck_preview_failed", error.message);
  }
  response.setHeader("Content-Type", image.contentType);
  response.setHeader("Cache-Control", "private, max-age=600");
  response.send(image.buffer);
});

router.get("/admin/dlc/item/draft", (request, response) => {
  const { kind, name, sourceId, id } = assertItemQuery(request);
  let result;
  try {
    result = dlcEditor.getItemDraft(kind, name, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_read_failed", error.message);
  }
  response.apiSuccess(result);
});

router.get("/admin/dlc/item/files", (request, response) => {
  const { kind, name, sourceId, id } = assertItemQuery(request);
  let result;
  try {
    result = dlcEditor.listItemFiles(kind, name, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_read_failed", error.message);
  }
  response.apiSuccess(result);
});

router.get("/admin/dlc/item/raw", (request, response) => {
  const { kind, name, sourceId, id } = assertItemQuery(request);
  const filePath = String(request.query?.path || "").trim();
  let asset;
  try {
    asset = dlcEditor.readItemAsset(kind, name, filePath, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_read_failed", error.message);
  }
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Cache-Control", "no-store");
  response.send(asset.buffer);
});

router.get("/admin/dlc/item/file", (request, response) => {
  const { kind, name, sourceId, id } = assertItemQuery(request);
  const filePath = String(request.query?.path || "").trim();
  let result;
  try {
    result = dlcEditor.readItemFile(kind, name, filePath, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_read_failed", error.message);
  }
  response.apiSuccess(result);
});

router.put("/admin/dlc/item/file", (request, response) => {
  const body = getPatchBody(request);
  const { kind, name, sourceId, id } = assertItemQuery(request);
  const filePath = String(body?.path || "").trim();
  let result;
  try {
    result = dlcEditor.writeItemFile(kind, name, filePath, body?.content, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_write_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "edit_dlc_item_file",
    itemKind: kind,
    itemName: name,
    file: result.path
  });
  response.apiSuccess(result);
});

// Merge draft for the text editor (no write): preview payload shaped like
// /dlc/texts/preview.
router.post("/admin/dlc/texts/merge-draft", (request, response) => {
  const body = getPatchBody(request);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 200) : [];
  let draft;
  try {
    draft = buildTextMergeDraft({
      items,
      title: body?.title,
      id: body?.id,
      description: body?.description,
      sourceNamePattern: body?.sourceNamePattern,
      sourceNameReplace: body?.sourceNameReplace,
      sourceNameFlags: body?.sourceNameFlags
    });
  } catch (error) {
    throw createHttpError(400, "dlc_text_merge_failed", error.message);
  }
  response.apiSuccess(draft);
});

// Merge several DLC text items into one text (works become Book 1, Book 2, …).
router.post("/admin/dlc/texts/merge", (request, response) => {
  const body = getPatchBody(request);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 200) : [];
  let result;
  try {
    result = mergeTextDlcItems({
      items,
      title: body?.title,
      id: body?.id,
      description: body?.description,
      language: body?.language,
      script: body?.script,
      tradition: body?.tradition,
      workLabel: body?.workLabel,
      sectionLabel: body?.sectionLabel,
      verseLabel: body?.verseLabel,
      document: body?.document,
      removeSources: body?.removeSources === true,
      sourceNamePattern: body?.sourceNamePattern,
      sourceNameReplace: body?.sourceNameReplace,
      sourceNameFlags: body?.sourceNameFlags
    });
  } catch (error) {
    throw createHttpError(400, "dlc_text_merge_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "merge_dlc_texts",
    itemName: result.name,
    merged: result.merged
  });
  response.apiSuccess(result);
});

// Delete an item locally, or from the repository (commit + push the removal).
router.post("/admin/dlc/delete", (request, response) => {
  const body = getPatchBody(request);
  const kind = String(body?.kind || "").trim();
  const name = String(body?.name || "").trim();
  const sourceId = String(body?.sourceId || "").trim();
  const id = String(body?.id || "").trim();
  if (!kind || !name) {
    throw createHttpError(400, "invalid_delete_request", "Both `kind` and `name` are required.");
  }
  const fromRepo = body?.fromRepo === true;
  let result;
  try {
    if (fromRepo) {
      dlcEditor.assertItemNotLive(kind, name, id);
      result = dlcPublish.deleteItemFromRepo({ kind, name, sourceId, message: body?.message });
    } else {
      result = dlcEditor.deleteItem(kind, name, sourceId, id);
    }
  } catch (error) {
    throw createHttpError(400, "dlc_item_delete_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: fromRepo ? "delete_dlc_item_repo" : "delete_dlc_item",
    itemKind: kind,
    itemName: name
  });
  response.apiSuccess(result);
});

router.delete("/admin/dlc/item", (request, response) => {
  const { kind, name, sourceId, id } = assertItemQuery(request);
  let result;
  try {
    result = dlcEditor.deleteItem(kind, name, sourceId, id);
  } catch (error) {
    throw createHttpError(400, "dlc_item_delete_failed", error.message);
  }
  invalidateCatalogCache();
  emitAdminMutationAuditEvent(request, response, {
    action: "delete_dlc_item",
    itemKind: kind,
    itemName: name
  });
  response.apiSuccess(result);
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
    })),
    jobs: buildJobsPayload().jobs
  });
});

router.patch("/admin/api-clients/:clientId", (request, response) => {
  const clientId = normalizeClientId(request.params.clientId);
  if (!clientId) {
    throw createHttpError(400, "invalid_client_id", "A clientId route parameter is required.");
  }
  const existingClient = findManagedClientById(clientId);
  rejectHiddenManagedClient(existingClient, clientId);
  const body = getPatchBody(request);
  if (body.id != null && normalizeClientId(body.id) !== clientId) {
    throw createHttpError(400, "invalid_client_id", "Client id in the request body must match the route parameter.");
  }

  const result = upsertManagedApiClient({
    ...body,
    id: clientId,
    hidden: false
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

  const existingClient = findManagedClientById(clientId);
  rejectHiddenManagedClient(existingClient, clientId);
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