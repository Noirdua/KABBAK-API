const express = require("express");
const cors = require("cors");
const compression = require("compression");

const { createNotFoundError } = require("./lib/http-errors");
const { escapeRegExp } = require("./lib/string-utils");
const { dataRoot, decksRoot, imgRoot } = require("./config/paths");
const { buildCorsOptions, isPublicCorsPath } = require("./config/app-env");
const { apiBasePath } = require("./config/service");
const { requireApiAccessLevel } = require("./middleware/api-access");
const { requireApiKey } = require("./middleware/api-key");
const { requireAssetGroupAccessLevel } = require("./middleware/asset-access");
const { attachRequestContext } = require("./middleware/request-context");
const { createApiRequestObserver } = require("./middleware/request-observability");
const { applyApiSecurityHeaders } = require("./middleware/security-headers");
const { apiNotFoundHandler } = require("./middleware/not-found");
const { createApiErrorHandler } = require("./middleware/error-handler");
const { createGlobalRateLimiter, createIpBanGate } = require("./middleware/rate-limiter");
const healthRoutes = require("./routes/health");
const metricsRoutes = require("./routes/metrics");
const adminRoutes = require("./routes/admin");
const bootstrapRoutes = require("./routes/bootstrap");
const deckRoutes = require("./routes/decks");
const deckResolutionRoutes = require("./routes/deck-resolution");
const tarotRoutes = require("./routes/tarot");
const domainRoutes = require("./routes/domains");
const calendarLiveRoutes = require("./routes/calendar-live");
const quizRoutes = require("./routes/quiz");
const textRoutes = require("./routes/texts");
const profileRoutes = require("./routes/profile");
const registryRoutes = require("./routes/registry");
const dlcRoutes = require("./routes/dlc");
const locationRoutes = require("./routes/locations");
const integrationRoutes = require("./routes/integrations");
const { createThumbFallback } = require("./middleware/thumb-fallback");
const { createPluginServerDispatch } = require("./services/plugin-servers");
const pluginsPublicRoutes = require("./routes/plugins-public");
const calendarFeedRoutes = require("./routes/calendar-feed");
const shareRoutes = require("./routes/share");
const directoryRoutes = require("./routes/directory");
const emailWebhookRoutes = require("./routes/email-webhooks");
const { createAuthRoutes } = require("./routes/auth");
const boardRoutes = require("./routes/board");
const gameRoutes = require("./routes/games");

const assetStaticOptions = {
  etag: true,
  lastModified: true,
  maxAge: "30d",
  immutable: true
};

const dataStaticOptions = {
  etag: true,
  lastModified: true,
  maxAge: "1h"
};

const assetGroups = Object.freeze([
  Object.freeze({ routeSegment: "img", rootPath: imgRoot, requiredAccessLevel: "" }),
  Object.freeze({ routeSegment: "tarot deck", rootPath: decksRoot, requiredAccessLevel: "premium" })
]);

function createAssetMountPath(routeSegment) {
  const normalizedSegment = String(routeSegment || "").trim();
  if (!/\s/.test(normalizedSegment)) {
    return `${apiBasePath}/assets/${normalizedSegment}`;
  }

  const escapedApiBasePath = escapeRegExp(apiBasePath);
  const encodedSegmentPattern = normalizedSegment
    .split(/\s+/)
    .map((segment) => escapeRegExp(segment))
    .join("(?:%20|\\s+)");

  return new RegExp(`^${escapedApiBasePath}/assets/${encodedSegmentPattern}(?=/|$)`, "i");
}

const protectedRoutes = [
  adminRoutes,
  metricsRoutes,
  bootstrapRoutes,
  deckRoutes,
  deckResolutionRoutes,
  tarotRoutes,
  domainRoutes,
  calendarLiveRoutes,
  quizRoutes,
  boardRoutes,
  gameRoutes,
  textRoutes,
  profileRoutes,
  registryRoutes,
  dlcRoutes,
  locationRoutes,
  integrationRoutes
];

const jsonBodyParsers = new Map();

function getJsonBodyParser(limit) {
  const key = String(limit || "");
  let parser = jsonBodyParsers.get(key);
  if (!parser) {
    parser = express.json({
      limit: key,
      strict: true,
      // Keep the raw bytes: provider webhooks are signed over the exact body.
      verify: (request, _response, buffer) => {
        if (buffer && buffer.length) {
          request.rawBody = Buffer.from(buffer);
        }
      }
    });
    jsonBodyParsers.set(key, parser);
  }
  return parser;
}

function createApp({ logger = console } = {}) {
  const app = express();

  app.disable("x-powered-by");
  const trustProxy = String(process.env.KABBAK_TRUST_PROXY || "").trim();
  if (trustProxy === "1" || /^true$/i.test(trustProxy)) {
    app.set("trust proxy", 1);
  } else if (/^\d+$/.test(trustProxy)) {
    app.set("trust proxy", Number(trustProxy));
  }
  app.locals.logger = logger;
  app.use(compression());
  app.use(attachRequestContext);
  app.use(createIpBanGate({ logger }));
  app.use(createApiRequestObserver({
    logger,
    logMode: () => require("./services/runtime-settings").getRuntimeSettings().requestLogMode
  }));
  app.use(applyApiSecurityHeaders);
  const publicCors = cors(buildCorsOptions({ allowAnyOrigin: true }));
  const restrictedCors = cors(buildCorsOptions());
  app.use((request, response, next) => {
    (isPublicCorsPath(request.path) ? publicCors : restrictedCors)(request, response, next);
  });
  // The body limit is runtime-adjustable from the Admin panel, so resolve it
  // per request (parsers are cached per limit value).
  app.use((request, response, next) => {
    const { jsonBodyLimit } = require("./services/runtime-settings").getRuntimeSettings();
    getJsonBodyParser(jsonBodyLimit)(request, response, next);
  });

  app.use(apiBasePath, healthRoutes);
  // Public trial-account signup/login (pre-auth for the connection gate). The
  // limiter is mounted on the auth subtree so it never throttles other routes.
  app.use(
    `${apiBasePath}/auth`,
    createGlobalRateLimiter({
      windowMs: 60_000,
      max: 20,
      banAfterViolations: 3,
      banForMs: 30 * 60 * 1000
    }),
    createAuthRoutes()
  );
  assetGroups.forEach(({ routeSegment, rootPath, requiredAccessLevel }) => {
    const mountPath = createAssetMountPath(routeSegment);
    if (requiredAccessLevel) {
      app.use(mountPath, requireApiKey, requireAssetGroupAccessLevel(routeSegment), express.static(rootPath, assetStaticOptions));
      if (routeSegment === "tarot deck") {
        app.use(mountPath, requireApiKey, requireAssetGroupAccessLevel(routeSegment), createThumbFallback(rootPath));
      }
      return;
    }

    app.use(mountPath, express.static(rootPath, assetStaticOptions));
  });
  app.use(`${apiBasePath}/assets`, (request, response, next) => {
    next(createNotFoundError("asset_not_found", "Unknown API asset path."));
  });
  // DLC plugins can opt into contributing server routes via a manifest `server`
  // entry. Mounted before requireApiKey so a plugin can expose public endpoints;
  // it gets its own rate limit and must enforce any auth it needs itself.
  app.use(
    `${apiBasePath}/plugins/:pluginName/server`,
    createGlobalRateLimiter(),
    createPluginServerDispatch()
  );
  // Public reads for plugins that opt in with "public": true (pre-auth).
  app.use(apiBasePath, pluginsPublicRoutes);
  // Public read-only calendar subscription feed (tokenized URL, pre-auth).
  app.use(apiBasePath, calendarFeedRoutes);
  // Public share pages for links and attachments (tokenized URLs, pre-auth).
  app.use(apiBasePath, shareRoutes);
  // Public directory of opt-in profiles (pre-auth, view-only).
  app.use(apiBasePath, directoryRoutes);
  // Inbound email provider webhooks (pre-auth, signature/token verified). Own
  // limiter so provider retries are not throttled by the global one.
  app.use(
    `${apiBasePath}/webhooks/email`,
    createGlobalRateLimiter({ windowMs: 60_000, max: 120, banAfterViolations: 10, banForMs: 10 * 60 * 1000 }),
    emailWebhookRoutes
  );
  app.use(apiBasePath, requireApiKey);
  app.use(apiBasePath, createGlobalRateLimiter());
  app.use(apiBasePath, requireApiAccessLevel);
  protectedRoutes.forEach((route) => {
    app.use(apiBasePath, route);
  });
  app.use(`${apiBasePath}/data`, express.static(dataRoot, dataStaticOptions));

  app.use(apiBasePath, apiNotFoundHandler);
  app.use(createApiErrorHandler({ logger }));

  return app;
}

module.exports = {
  createApp
};