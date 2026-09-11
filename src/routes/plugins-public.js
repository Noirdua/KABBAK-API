"use strict";

const fs = require("fs");
const { createApiRouter } = require("../lib/create-api-router");
const { createNotFoundError } = require("../lib/http-errors");
const {
  isPublicPlugin,
  listPublicPlugins,
  resolvePluginAsset,
  resolvePluginUploadLimit
} = require("../services/dlc-catalog");

// Public, pre-auth plugin reads for plugins that opt in with `"public": true`
// in their manifest. This lets the GUI load such a plugin before the user has
// an API key (e.g. the demo-users gate button). Everything else stays behind
// requireApiKey.
const router = createApiRouter();

function hasPresentedKey(request) {
  return Boolean(
    String(request.get("x-api-key") || "").trim()
    || String(request.get("authorization") || "").trim()
    || String(request.query?.apiKey || "").trim()
  );
}

// Only plugins with "public": true. Connected clients (key presented) fall
// through to the authenticated list so they still see every plugin.
router.get("/plugins", (request, response, next) => {
  if (hasPresentedKey(request)) {
    next();
    return;
  }
  response.apiSuccess({
    plugins: listPublicPlugins(),
    uploadLimitBytes: resolvePluginUploadLimit()
  });
});

// Public entry assets (JS/CSS/images) for opted-in plugins. A plugin's
// config.json is never public.
router.get("/plugins/:name/:fileName", (request, response, next) => {
  const name = String(request.params.name || "");
  if (!isPublicPlugin(name)) {
    next();
    return;
  }
  const fileName = String(request.params.fileName || "").trim();
  if (!fileName || /^config\.json$/i.test(fileName)) {
    next();
    return;
  }
  const fullPath = resolvePluginAsset(name, fileName);
  if (!fullPath) {
    next(createNotFoundError("plugin_asset_not_found", "Plugin asset not found."));
    return;
  }
  sendAsset(response, fullPath);
});

function sendAsset(response, fullPath) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch (_error) {
    throw createNotFoundError("plugin_asset_not_found", "Plugin asset not found.");
  }
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Length", String(stat.size));
  response.sendFile(fullPath);
}

module.exports = router;
