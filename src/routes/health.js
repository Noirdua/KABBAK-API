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
const { findDemoClient } = require("../services/api-client-registry");

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
    return isLoopbackOrPrivateIp(ip);
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
  return {
    authenticated: auth.authenticated === true,
    clientId: auth.clientId || "",
    accountId: auth.accountId || "",
    name: auth.name || "",
    accessLevel: auth.accessLevel || "",
    roles: [...(auth.roles || [])],
    scopes: [...(auth.scopes || [])]
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

// Public branding (browser tab title). Admin-editable via the Admin panel's
// server settings and persisted in runtime settings; empty means "frontend
// default". Public so the app shell can apply it before authentication.
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
  response.json({ title, overlayBackgroundUrl });
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

function isDemoAccessAllowed(request) {
  const raw = String(process.env.KABBAK_DEMO_ACCESS || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  const ip = String(request.ip || request.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1");
}

// Demo connection info for the login gate. Off the loopback unless
// KABBAK_DEMO_ACCESS=1 so a public bind does not leak a live premium key.
router.get("/demo-access", (request, response) => {
  const demoClient = findDemoClient();
  setNoStore(response);
  if (!demoClient || !isDemoAccessAllowed(request)) {
    response.json({
      enabled: false
    });
    return;
  }

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(request.headers.host || "localhost:3100").split(",")[0].trim();
  const apiBaseUrl = `${forwardedProto || "http"}://${host}`;

  response.json({
    enabled: true,
    id: demoClient.id,
    name: demoClient.name,
    accessLevel: demoClient.accessLevel,
    apiKey: String(demoClient.key || ""),
    apiBaseUrl
  });
});

module.exports = router;