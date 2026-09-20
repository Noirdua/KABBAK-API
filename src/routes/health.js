const { createApiRouter } = require("../lib/create-api-router");
const rateLimit = require("express-rate-limit");
const { isLoopbackOrPrivateIp } = require("../lib/ip-utils");
const {
  getConfiguredApiClientSummaries,
  getConfiguredApiKeys,
  isApiKeyProtectionEnabled,
  resolveRequestAuthState
} = require("../middleware/api-key");
const { serviceName, serviceVersion } = require("../config/service");
const { getStorageStatus } = require("../services/storage-bootstrap");
const { isSharedDemoClientId } = require("../lib/demo-client");

const router = createApiRouter();

// Health endpoints are public (mounted before auth), so cap them lightly to keep
// scanners from hammering the server. No ban — just a cheap 429 backoff.
// Local/private clients (localhost, LAN, CGNAT/Tailscale) are skipped entirely,
// and unknown-IP requests are not counted so proxies can never wedge a client.
const healthRateLimiter = rateLimit({
  windowMs: 30_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(request) {
    const ip = String(request.ip || request.socket?.remoteAddress || "").trim();
    return ip;
  },
  skip(request) {
    const ip = String(request.ip || request.socket?.remoteAddress || "").trim();
    if (!ip) {
      return true;
    }
    if (isLoopbackOrPrivateIp(ip)) {
      return true;
    }
    // A request carrying a key is a configured client (the app probing its own
    // connection), not a scanner. Never throttle it.
    const apiKey = String(request.get("x-api-key") || "").trim();
    const authorization = String(request.get("authorization") || "").trim();
    return Boolean(apiKey || authorization);
  },
  handler(request, response) {
    const ip = String(request.ip || request.socket?.remoteAddress || "unknown");
    try {
      if (typeof request.app?.locals?.logger?.warn === "function") {
        request.app.locals.logger.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "health_rate_limited",
          ip
        }));
      }
    } catch {}
    response.status(429).json({
      error: "rate_limit_exceeded",
      message: "Too many health checks. Please slow down.",
      requestId: response.locals?.requestId || request.id || ""
    });
  },
  validate: { keyGeneratorIpFallback: false }
});

router.use(healthRateLimiter);

function createBaseHealthPayload() {
  const configuredClients = getConfiguredApiClientSummaries();
  return {
    service: serviceName,
    version: serviceVersion,
    uptimeSeconds: Math.round(process.uptime()),
    apiKeyRequired: isApiKeyProtectionEnabled(),
    hasConfiguredApiKeys: getConfiguredApiKeys().length > 0,
    configuredClientCount: configuredClients.length,
    timestamp: new Date().toISOString()
  };
}

function createHealthAuthPayload(request) {
  const auth = resolveRequestAuthState(request);
  const demo = isSharedDemoClientId(auth.clientId);
  return {
    authenticated: auth.authenticated === true,
    clientId: auth.clientId || "",
    accountId: auth.accountId || "",
    name: auth.name || "",
    accessLevel: auth.accessLevel || "",
    roles: [...(auth.roles || [])],
    scopes: [...(auth.scopes || [])],
    demo,
    personalFeatures: auth.authenticated === true && !demo
  };
}

function setNoStore(response) {
  response.setHeader("cache-control", "no-store");
}

function sendLiveHealth(request, response) {
  setNoStore(response);
  response.json({
    ok: true,
    live: true,
    ...createBaseHealthPayload(),
    auth: createHealthAuthPayload(request)
  });
}

async function resolveReadiness() {
  try {
    return await getStorageStatus();
  } catch (error) {
    return {
      ready: false,
      reason: String(error?.message || "Unable to determine storage readiness.")
    };
  }
}

router.get("/health", (request, response) => {
  sendLiveHealth(request, response);
});

router.get("/health/live", (request, response) => {
  sendLiveHealth(request, response);
});

router.get("/health/ready", async (request, response) => {
  const storage = await resolveReadiness();
  const isReady = storage.ready === true;

  setNoStore(response);
  response.status(isReady ? 200 : 503).json({
    ok: isReady,
    ready: isReady,
    ...createBaseHealthPayload(),
    auth: createHealthAuthPayload(request),
    storage
  });
});

// Public branding (browser tab title, favicon). Admin-editable via the Admin
// panel's server settings and persisted in runtime settings; empty means
// "frontend default". Public so the app shell can apply it before
// authentication.
router.get("/branding", (_request, response) => {
  let title = "";
  try {
    title = String(require("../services/runtime-settings").getRuntimeSettings().browserTitle || "").trim();
  } catch (_error) {
    // Keep the public response working even if settings storage is unavailable.
  }
  setNoStore(response);
  let overlayBackgroundUrl = "";
  try {
    overlayBackgroundUrl = String(require("../services/runtime-settings").getRuntimeSettings().overlayBackgroundUrl || "").trim();
  } catch (_error) {}
  let faviconUrl = "";
  try {
    faviconUrl = String(require("../services/runtime-settings").getRuntimeSettings().faviconUrl || "").trim();
  } catch (_error) {}
  response.json({ title, overlayBackgroundUrl, faviconUrl });
});

router.get("/branding/overlay", (_request, response) => {
  const { findOverlayFile } = require("../services/overlay-background");
  const filePath = findOverlayFile();
  if (!filePath) {
    response.status(404).end();
    return;
  }
  setNoStore(response);
  response.sendFile(filePath);
});

router.get("/branding/favicon", (_request, response) => {
  const { findFaviconFile } = require("../services/favicon");
  const filePath = findFaviconFile();
  if (!filePath) {
    response.status(404).end();
    return;
  }
  setNoStore(response);
  response.sendFile(filePath);
});

module.exports = router;