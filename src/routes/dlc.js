const fs = require("node:fs");
const path = require("node:path");

const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const { createLogWriter } = require("../lib/logger-utils");
const { sanitizeRequestUrl } = require("../lib/request-url");
const {
  ADMIN_API_MANAGEMENT_CAPABILITY,
  requireApiClientCapability
} = require("../middleware/api-client-capability");
const {
  assertSafeName,
  categoryByKind,
  createPluginPlaylist,
  createPluginScaffold,
  expandPack,
  findCatalogItem,
  getCatalog,
  installItem,
  listInstalledPlugins,
  listPluginAssets,
  listPluginSubdirs,
  readPluginConfig,
  removePluginAssetFile,
  removePluginPlaylist,
  resolvePluginAsset,
  resolvePluginUploadLimit,
  uninstallItem,
  updateItem,
  writePluginAssetFile,
  writePluginConfig
} = require("../services/dlc-catalog");

function redactPluginConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const next = { ...config };
  for (const key of Object.keys(next)) {
    if (!/key|secret|password|token/i.test(key)) continue;
    if (!next[key]) continue;
    next[key] = "***";
    next[`${key}Set`] = true;
  }
  return next;
}

function normalizeHydrusPluginConfig(config) {
  const src = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const categories = (Array.isArray(src.categories) ? src.categories : [])
    .map((item) => ({
      name: String(item?.name || item?.label || "").trim(),
      search: String(
        item?.search
        || (Array.isArray(item?.tags) ? item.tags.join(",") : "")
      ).trim()
    }))
    .filter((item) => item.name && item.search);
  return {
    allowSearch: Boolean(src.allowSearch),
    collapseTags: src.collapseTags !== false,
    origin: String(src.origin || "").trim().replace(/\/+$/, ""),
    apiKey: String(src.apiKey || "").trim(),
    categories
  };
}

const router = createApiRouter();

const { startBackgroundHotReload } = require("../services/storage-bootstrap");

const CONTENT_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
});

const CODE_ASSET_EXTENSIONS = Object.freeze(new Set([".js", ".mjs", ".css", ".json"]));

function setPluginAssetHeaders(response, extension) {
  response.setHeader("Content-Type", CONTENT_TYPES[extension] || "application/octet-stream");
  // Code and config revalidate quickly so plugin updates show up; media caches longer.
  response.setHeader("Cache-Control", CODE_ASSET_EXTENSIONS.has(extension) ? "no-cache" : "public, max-age=86400");
}

// Streams a plugin file with HTTP Range support so media (audio/video) seeking
// works in browsers.
function sendPluginFile(response, fullPath, extension) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch (error) {
    throw createNotFoundError("plugin_asset_not_found", "Plugin asset not found.");
  }

  setPluginAssetHeaders(response, extension);
  const total = stat.size;
  const rangeHeader = String(response.req?.headers?.range || "").trim();

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (match) {
      let start = match[1] === "" ? null : Number(match[1]);
      let end = match[2] === "" ? null : Number(match[2]);
      if (start == null && end != null) {
        // suffix range: last N bytes
        start = Math.max(0, total - end);
        end = total - 1;
      } else {
        start = Math.max(0, Number.isFinite(start) ? start : 0);
        end = Number.isFinite(end) ? Math.min(end, total - 1) : total - 1;
      }
      if (start > end || start >= total) {
        response.status(416);
        response.setHeader("Content-Range", `bytes */${total}`);
        response.end();
        return;
      }
      response.status(206);
      response.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", String(end - start + 1));
      const stream = fs.createReadStream(fullPath, { start, end });
      stream.pipe(response);
      return;
    }
  }

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", String(total));
  const stream = fs.createReadStream(fullPath);
  stream.pipe(response);
}

function getRequestBody(request) {
  if (request.body == null) {
    return {};
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw createHttpError(400, "invalid_request_body", "Request body must be a JSON object.");
  }
  return request.body;
}

function emitDlcLog(request, message, extra = {}) {
  const writeLog = createLogWriter(request.app?.locals?.logger || console);
  if (!writeLog) return;
  writeLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: extra.event || "api_dlc",
    requestId: request.id || "unknown",
    message: String(message || ""),
    ...extra
  }));
}

function emitDlcMutationAuditEvent(request, response, payload) {
  const writeLog = createLogWriter(request.app?.locals?.logger || console);
  if (!writeLog) return;
  const auth = response.locals?.auth || request.auth || {};
  writeLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "api_dlc_mutation",
    requestId: response.locals?.requestId || request.id || "unknown",
    method: request.method,
    path: sanitizeRequestUrl(request.originalUrl),
    actorClientId: auth.clientId || "",
    ...payload
  }));
}

function assertDlcMutationBody(body) {
  const kind = String(body?.kind || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();
  const sourceId = String(body?.sourceId || body?.source || "").trim();
  if (!kind || !name) {
    throw createHttpError(400, "invalid_dlc_request", "Both `kind` and `name` are required.");
  }
  if (!categoryByKind(kind)) {
    throw createHttpError(400, "unknown_dlc_kind", `Unknown DLC kind '${kind}'.`);
  }
  try {
    assertSafeName(name);
  } catch (error) {
    throw createHttpError(400, "invalid_dlc_name", error.message);
  }
  return { kind, name, sourceId };
}

// Available catalog (all categories). Plugins are what the shop installs.
router.get("/dlc/catalog", async (request, response) => {
  const refresh = ["1", "true", "yes"].includes(String(request.query?.refresh || "").toLowerCase());
  const catalog = await getCatalog({ refresh });
  response.apiSuccess(catalog);
});

// Installed plugins (manifests from the DLC checkout).
router.get("/plugins", (_request, response) => {
  response.apiSuccess({
    plugins: listInstalledPlugins(),
    uploadLimitBytes: resolvePluginUploadLimit()
  });
});

// List asset files inside a plugin subfolder (e.g. ?dir=music) so plugins can
// discover admin-managed content at runtime. Also lists subfolders so
// folder-based playlists (music player) can be discovered.
router.get("/plugins/:name/contents", (request, response) => {
  const dirName = String(request.query?.dir || "").trim();
  response.apiSuccess({
    name: String(request.params.name || ""),
    dir: dirName,
    files: listPluginAssets(request.params.name, dirName),
    dirs: listPluginSubdirs(request.params.name, dirName)
  });
});

// Create an (empty) plugin playlist folder (admin only). Playlists are plain
// folders inside the plugin; the music player treats every folder as one.
router.post(
  "/plugins/:name/playlists",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const name = String(request.params.name || "");
    const body = getRequestBody(request);
    const playlistName = String(body?.playlistName || body?.name || "").trim();

    let result;
    try {
      result = createPluginPlaylist(name, playlistName);
    } catch (error) {
      throw createHttpError(400, "invalid_playlist_name", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "create_plugin_playlist",
      pluginName: name,
      playlistName: result.name
    });

    response.apiSuccess(result);
  }
);

// Delete a plugin playlist folder and everything in it (admin only). The
// default "music" playlist is protected.
router.delete(
  "/plugins/:name/playlists/:playlistName",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const name = String(request.params.name || "");
    const playlistName = String(request.params.playlistName || "").trim();

    let result;
    try {
      result = removePluginPlaylist(name, playlistName);
    } catch (error) {
      throw createHttpError(400, "invalid_playlist_name", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "delete_plugin_playlist",
      pluginName: name,
      playlistName: result.name
    });

    response.apiSuccess(result);
  }
);

// Read a plugin's config.json (admin-managed plugin settings).
router.get("/plugins/:name/config", (request, response) => {
  const name = String(request.params.name || "");
  let config = readPluginConfig(name);
  if (name === "hydrus-network") {
    config = normalizeHydrusPluginConfig(config);
  }
  response.apiSuccess({ name, config: redactPluginConfig(config) });
});

// Write a plugin's config.json (admin only). Plugins re-read it on demand.
router.post(
  "/plugins/:name/config",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const name = String(request.params.name || "");
    const body = getRequestBody(request);
    let config;
    try {
      const incoming = body?.config ?? body;
      let nextConfig = incoming;
      if (name === "hydrus-network") {
        const current = readPluginConfig(name) || {};
        nextConfig = normalizeHydrusPluginConfig(incoming);
        if (!nextConfig.apiKey || nextConfig.apiKey === "***") {
          nextConfig.apiKey = String(current.apiKey || "").trim();
        }
        if (!nextConfig.origin) {
          nextConfig.origin = String(current.origin || "").trim();
        }
      }
      config = writePluginConfig(name, nextConfig);
    } catch (error) {
      throw createHttpError(400, "invalid_plugin_config", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "update_plugin_config",
      pluginName: name
    });

    response.apiSuccess({ name, config });
  }
);

// Serve plugin assets from a subfolder (e.g. music/ambient.mp3).
router.get("/plugins/:name/files/:dirName/:fileName", (request, response) => {
  const { name, dirName, fileName } = request.params;
  const fullPath = resolvePluginAsset(String(name || ""), String(fileName || ""), String(dirName || ""));
  if (!fullPath) {
    throw createNotFoundError("plugin_asset_not_found", "Plugin asset not found.");
  }
  const extension = path.extname(fullPath).toLowerCase();
  sendPluginFile(response, fullPath, extension);
});

function decodeUploadedFileData(body) {
  const raw = body?.data;
  if (typeof raw !== "string" || !raw.trim()) {
    throw createHttpError(400, "invalid_plugin_upload", "The upload requires a `data` field with base64 (or data URL) content.");
  }
  const b64 = (raw.includes(",") ? raw.split(",")[1] : raw).replace(/\s+/g, "");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length || buffer.toString("base64").replace(/=+$/u, "").length !== b64.replace(/=+$/u, "").length) {
    throw createHttpError(400, "invalid_plugin_upload", "The upload data is not valid base64.");
  }
  return buffer;
}

// Upload a file into a plugin's root folder (admin only) — e.g. homepage/index.html.
router.post(
  "/plugins/:name/files",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const { name } = request.params;
    const body = getRequestBody(request);
    const dataBuffer = decodeUploadedFileData(body);

    let saved;
    try {
      saved = writePluginAssetFile(String(name || ""), "", String(body?.fileName || ""), dataBuffer);
    } catch (error) {
      throw createHttpError(400, "invalid_plugin_upload", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "upload_plugin_asset",
      pluginName: String(name || ""),
      dirName: "",
      fileName: saved.name,
      bytes: saved.size
    });

    response.status(201).apiSuccess({ name: String(name || ""), dir: "", file: saved.name, size: saved.size });
  }
);

// Upload a file into a plugin subfolder (admin only).
router.post(
  "/plugins/:name/files/:dirName",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const { name, dirName } = request.params;
    const body = getRequestBody(request);
    const dataBuffer = decodeUploadedFileData(body);

    let saved;
    try {
      saved = writePluginAssetFile(String(name || ""), String(dirName || ""), String(body?.fileName || ""), dataBuffer);
    } catch (error) {
      throw createHttpError(400, "invalid_plugin_upload", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "upload_plugin_asset",
      pluginName: String(name || ""),
      dirName: String(dirName || ""),
      fileName: saved.name,
      bytes: saved.size
    });

    response.status(201).apiSuccess({ name: String(name || ""), dir: String(dirName || ""), file: saved.name, size: saved.size });
  }
);

// Delete a file from a plugin subfolder (admin only).
router.delete(
  "/plugins/:name/files/:dirName/:fileName",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const { name, dirName, fileName } = request.params;
    let removed = false;
    try {
      removed = removePluginAssetFile(String(name || ""), String(dirName || ""), String(fileName || ""));
    } catch (error) {
      throw createHttpError(400, "invalid_plugin_delete", error.message);
    }
    if (!removed) {
      throw createNotFoundError("plugin_asset_not_found", "Plugin file not found.");
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "delete_plugin_asset",
      pluginName: String(name || ""),
      dirName: String(dirName || ""),
      fileName: String(fileName || "")
    });

    response.apiSuccess({ name: String(name || ""), dir: String(dirName || ""), file: String(fileName || ""), removed: true });
  }
);

// Serve top-level plugin assets (entry JS, CSS, config, bundled images).
router.get("/plugins/:name/:fileName", (request, response) => {
  const { name, fileName } = request.params;
  const fullPath = resolvePluginAsset(String(name || ""), String(fileName || ""));
  if (!fullPath) {
    throw createNotFoundError("plugin_asset_not_found", "Plugin asset not found.");
  }
  const extension = path.extname(fullPath).toLowerCase();
  sendPluginFile(response, fullPath, extension);
});

// Create a third-party plugin scaffold (admin only): manifest.json, entry
// script, and config.json are generated in the plugin folder.
router.post(
  "/plugins",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const body = getRequestBody(request);
    let plugin;
    try {
      plugin = createPluginScaffold(String(body?.name || ""), body);
    } catch (error) {
      throw createHttpError(400, "invalid_plugin_scaffold", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "create_plugin",
      pluginName: plugin.name
    });

    response.status(201).apiSuccess({ plugin });
  }
);

router.post(
  "/dlc/install",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  async (request, response) => {
    const { kind, name, sourceId } = assertDlcMutationBody(getRequestBody(request));
    if (kind === "pack") {
      throw createHttpError(400, "unsupported_dlc_kind", "Packs cannot be installed directly. Install their items individually or use the dlc CLI.");
    }

    let installed = false;
    try {
      const catalog = await getCatalog();
      const found = findCatalogItem(catalog.items, name, kind, sourceId);
      if (!found.item && found.matches.length > 1) {
        throw new Error(`'${name}' is in more than one DLC repo. Pass sourceId (${found.matches.map((match) => match.sourceId).join(", ")}).`);
      }
      installed = installItem(found.item || { kind, name, sourceId }, { log: (message) => emitDlcLog(request, message) });
    } catch (error) {
      emitDlcLog(request, error.message || "DLC install failed.", {
        event: "api_dlc_error",
        action: "install_dlc_item",
        itemKind: kind,
        itemName: name
      });
      throw createHttpError(502, "dlc_install_failed", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "install_dlc_item",
      itemKind: kind,
      itemName: name,
      installed: Boolean(installed)
    });

    // Plugins are live immediately. Decks/texts/references are staged into
    // their import folders and need the storage snapshot refreshed — do it in
    // the background so no server restart is required.
    if (kind !== "plugin") {
      startBackgroundHotReload();
    }

    // Plugins are live immediately. Decks/texts/references are staged into
    // their import folders and activate on the next server migration.
    response.apiSuccess({
      kind,
      name,
      installed: Boolean(installed),
      staged: kind !== "plugin"
    });
  }
);

// Update one installed plugin to the latest published version without
// touching the rest of the checkout (admin-only, like install/uninstall).
router.post(
  "/dlc/update",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  (request, response) => {
    const { kind, name, sourceId } = assertDlcMutationBody(getRequestBody(request));

    let result;
    try {
      result = updateItem({ kind, name, sourceId }, { log: (message) => emitDlcLog(request, message) });
    } catch (error) {
      emitDlcLog(request, error.message || "DLC update failed.", {
        event: "api_dlc_error",
        action: "update_dlc_item",
        itemKind: kind,
        itemName: name
      });
      throw createHttpError(502, "dlc_update_failed", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "update_dlc_item",
      itemKind: kind,
      itemName: name,
      updatedFiles: result.updatedFiles,
      keptPaths: result.keptPaths
    });

    response.apiSuccess(result);
  }
);

router.post(
  "/dlc/uninstall",
  requireApiClientCapability({
    capabilityName: "adminApiManagement",
    anyRoles: ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles,
    anyScopes: ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes,
    errorCode: "insufficient_admin_capability",
    errorMessage: "This route requires the admin role or api:admin scope."
  }),
  async (request, response) => {
    const { kind, name, sourceId } = assertDlcMutationBody(getRequestBody(request));

    let removed = 0;
    try {
      if (kind === "pack") {
        const catalog = await getCatalog({ refresh: true });
        const { item: packItem } = findCatalogItem(catalog.items, name, "pack", sourceId);
        if (!packItem) {
          throw new Error(`Pack '${name}' was not found in the catalog.`);
        }
        const { members, missing } = expandPack(packItem, catalog.items);
        for (const member of members) {
          try {
            removed += uninstallItem({ kind: member.kind, name: member.name }, { purge: true });
          } catch (_memberError) {
            // Keep uninstalling the other members.
          }
        }
      } else {
        removed = uninstallItem({ kind, name }, { purge: true });
      }
    } catch (error) {
      emitDlcLog(request, error.message || "DLC uninstall failed.", {
        event: "api_dlc_error",
        action: "uninstall_dlc_item",
        itemKind: kind,
        itemName: name
      });
      throw createHttpError(502, "dlc_uninstall_failed", error.message);
    }

    emitDlcMutationAuditEvent(request, response, {
      action: "uninstall_dlc_item",
      itemKind: kind,
      itemName: name,
      removed
    });

    // Removing content changes the storage snapshot; refresh it in the
    // background. Plugins are read straight from the checkout (no refresh
    // needed), but a pack uninstall removes its deck/text members.
    if (kind !== "plugin") {
      startBackgroundHotReload();
    }

    response.apiSuccess({ kind, name, removed });
  }
);

module.exports = router;
