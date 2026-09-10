const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError } = require("../lib/http-errors");
const { createLogWriter } = require("../lib/logger-utils");
const { readPluginConfig } = require("../services/dlc-catalog");

const URANTIA_ORIGIN = "https://api.urantia.dev";
const HYDRUS_PLUGIN_NAME = "hydrus-network";
const HYDRUS_DEFAULT_ORIGIN = "http://localhost:45869";

function resolveHydrusSettings() {
  const config = readPluginConfig(HYDRUS_PLUGIN_NAME) || {};
  const originRaw = String(process.env.KABBAK_HYDRUS_ORIGIN || config.origin || HYDRUS_DEFAULT_ORIGIN).trim();
  const apiKey = String(process.env.KABBAK_HYDRUS_API_KEY || config.apiKey || "").trim();
  if (!apiKey) {
    throw createHttpError(503, "hydrus_misconfigured", "Hydrus API key is not configured.");
  }
  let parsed;
  try {
    parsed = new URL(originRaw);
  } catch {
    throw createHttpError(500, "hydrus_misconfigured", "Hydrus origin is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createHttpError(500, "hydrus_misconfigured", "Hydrus origin must be http or https.");
  }
  return { origin: parsed.origin, apiKey };
}

const HYDRUS_SESSION_TTL_MS = 20 * 60 * 60 * 1000;
const hydrusSessionCache = new Map();

function hydrusSessionCacheKey(origin, apiKey) {
  return `${origin}|${apiKey}`;
}

async function fetchHydrusSessionKey(origin, apiKey) {
  let upstream;
  try {
    upstream = await fetch(`${origin}/session_key`, {
      headers: { "Hydrus-Client-API-Access-Key": apiKey }
    });
  } catch (error) {
    throw createHttpError(502, "hydrus_unreachable", error.message || "Could not reach the Hydrus Network client API.");
  }
  if (!upstream.ok) {
    throw createHttpError(502, "hydrus_session_failed", "Could not obtain a Hydrus session key.");
  }
  let payload = {};
  try {
    payload = await upstream.json();
  } catch (_error) {
    payload = {};
  }
  const key = String(payload?.session_key || "").trim();
  if (!key) {
    throw createHttpError(502, "hydrus_session_failed", "Could not obtain a Hydrus session key.");
  }
  return key;
}

async function resolveHydrusSessionKey(origin, apiKey, { refresh = false } = {}) {
  const cacheKey = hydrusSessionCacheKey(origin, apiKey);
  if (!refresh) {
    const cached = hydrusSessionCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) return cached.key;
  }
  const key = await fetchHydrusSessionKey(origin, apiKey);
  hydrusSessionCache.set(cacheKey, { key, expiresAtMs: Date.now() + HYDRUS_SESSION_TTL_MS });
  return key;
}

function emitIntegrationLog(request, level, payload) {
  const logger = request.app?.locals?.logger || console;
  const write = typeof logger?.[level] === "function"
    ? logger[level].bind(logger)
    : createLogWriter(logger);
  if (!write) return;
  write(JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  }));
}

async function proxyToOrigin(request, response, origin, extraHeaders, errorCode, errorMessage) {
  const target = new URL(request.url || "/", `${origin}/`);
  if (target.origin !== origin) {
    throw createHttpError(400, "invalid_integration_url", "Invalid integration request path.");
  }
  const headers = {
    Accept: request.get("accept") || "application/json",
    ...extraHeaders
  };
  if (request.get("content-type")) {
    headers["Content-Type"] = request.get("content-type");
  }
  const init = {
    method: request.method,
    headers
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body != null) {
    init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    emitIntegrationLog(request, "error", {
      event: "api_integration_error",
      integration: errorCode,
      path: target.pathname,
      message: error.message || errorMessage
    });
    throw createHttpError(502, errorCode, error.message || errorMessage);
  }
  const contentType = upstream.headers.get("content-type") || "application/json";
  const payload = await upstream.arrayBuffer();
  if (upstream.status >= 400) {
    let detail = errorMessage;
    try {
      detail = Buffer.from(payload).toString("utf8").slice(0, 300) || errorMessage;
    } catch (_error) {
      detail = errorMessage;
    }
    emitIntegrationLog(request, upstream.status >= 500 ? "error" : "warn", {
      event: "api_integration_error",
      integration: errorCode,
      path: target.pathname,
      status: upstream.status,
      message: detail
    });
  }
  response.status(upstream.status);
  response.set("Content-Type", contentType);
  response.send(Buffer.from(payload));
}

const router = createApiRouter();

router.use("/integrations/urantia", async (request, response) => {
  await proxyToOrigin(
    request,
    response,
    URANTIA_ORIGIN,
    {},
    "urantia_unreachable",
    "Could not reach the Urantia API."
  );
});

async function proxyHydrusRequest(request, response, origin, apiKey) {
  if (!apiKey) {
    emitIntegrationLog(request, "error", {
      event: "api_integration_error",
      integration: "hydrus_misconfigured",
      message: "Hydrus API key is not set."
    });
    throw createHttpError(502, "hydrus_misconfigured", "Hydrus API key is not set.");
  }

  let sessionKey = await resolveHydrusSessionKey(origin, apiKey);

  const send = async () => {
    const target = new URL(request.url || "/", `${origin}/`);
    if (target.origin !== origin) {
      throw createHttpError(400, "invalid_integration_url", "Invalid integration request path.");
    }
    const headers = {
      Accept: request.get("accept") || "application/json",
      "Hydrus-Client-API-Session-Key": sessionKey
    };
    if (request.get("content-type")) {
      headers["Content-Type"] = request.get("content-type");
    }
    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body != null) {
      init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    }
    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (error) {
      emitIntegrationLog(request, "error", {
        event: "api_integration_error",
        integration: "hydrus_unreachable",
        path: target.pathname,
        message: error.message || "Could not reach the Hydrus Network client API."
      });
      throw createHttpError(502, "hydrus_unreachable", error.message || "Could not reach the Hydrus Network client API.");
    }
    const contentType = upstream.headers.get("content-type") || "application/json";
    const payload = await upstream.arrayBuffer();
    return { upstream, contentType, payload };
  };

  let result = await send();
  if (result.upstream.status === 419) {
    sessionKey = await resolveHydrusSessionKey(origin, apiKey, { refresh: true });
    result = await send();
  }

  if (result.upstream.status >= 400) {
    let detail = "Hydrus request failed.";
    try {
      detail = Buffer.from(result.payload).toString("utf8").slice(0, 300) || detail;
    } catch (_error) {
      // keep generic detail
    }
    emitIntegrationLog(request, result.upstream.status >= 500 ? "error" : "warn", {
      event: "api_integration_error",
      integration: "hydrus_request",
      path: String(request.url || "/").split("?")[0],
      status: result.upstream.status,
      message: detail
    });
  }

  response.status(result.upstream.status);
  response.set("Content-Type", result.contentType);
  response.send(Buffer.from(result.payload));
}

router.get("/integrations/hydrus-network/_web-url", async (request, response) => {
  const { origin, apiKey } = resolveHydrusSettings();
  const fileId = String(request.query?.file_id || "").trim();
  if (!fileId) {
    throw createHttpError(400, "invalid_web_url", "A file_id is required.");
  }
  const url = new URL("/get_files/file", `${origin}/`);
  url.searchParams.set("file_id", fileId);
  url.searchParams.set("Hydrus-Client-API-Access-Key", apiKey);
  response.apiSuccess({ url: url.toString() });
});

router.use("/integrations/hydrus-network", async (request, response) => {
  const { origin, apiKey } = resolveHydrusSettings();
  await proxyHydrusRequest(request, response, origin, apiKey);
});

module.exports = router;
