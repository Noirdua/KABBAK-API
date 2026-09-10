const {
  beginRequestObservation,
  getRequestMetricsSnapshot,
  recordRequestObservation
} = require("../services/request-metrics");
const { sanitizeRequestUrl } = require("../lib/request-url");
const { createLogWriter } = require("../lib/logger-utils");

function createAnonymousAuthState() {
  return {
    authenticated: false,
    type: "anonymous",
    clientId: "",
    accountId: "",
    accessLevel: "",
    roles: [],
    scopes: []
  };
}

function createRequestObservationPayload(request, response, durationMs, outcome, bytesSent) {
  const auth = response.locals?.auth || request.auth || createAnonymousAuthState();
  return {
    timestamp: new Date().toISOString(),
    event: "api_request_complete",
    outcome,
    requestId: response.locals?.requestId || request.id || "unknown",
    method: request.method,
    path: sanitizeRequestUrl(request.originalUrl),
    statusCode: Number(response.statusCode || 0),
    durationMs: Number(durationMs.toFixed(3)),
    bytesSent: Math.max(0, Number(bytesSent) || 0),
    authenticated: auth.authenticated === true,
    clientId: auth.clientId || "",
    accountId: auth.accountId || "",
    accessLevel: auth.accessLevel || ""
  };
}

function shouldLogRequest(payload, logMode) {
  const resolvedMode = typeof logMode === "function" ? logMode() : logMode;
  if (resolvedMode === "all") {
    return true;
  }

  if (resolvedMode === "none") {
    return false;
  }

  // Default "errors": log failures and slow responses only. Successful, fast
  // requests are still counted in the in-memory metrics but not written to the
  // log stream, so a public server under bot scanning doesn't flood the journal.
  const statusCode = Number(payload?.statusCode || 0);
  const durationMs = Number(payload?.durationMs || 0);
  return statusCode >= 400 || durationMs >= 1000;
}

function createApiRequestObserver({ logger = console, logMode = "errors" } = {}) {
  const writeLog = createLogWriter(logger);

  // Periodic bandwidth summary so runaway traffic (e.g. a caching bug causing
  // clients to redownload large assets) is visible in the logs without
  // enabling full per-request logging.
  let lastBandwidthSnapshot = null;
  const summaryTimer = setInterval(() => {
    if (!writeLog) {
      return;
    }
    const snapshot = getRequestMetricsSnapshot();
    const previous = lastBandwidthSnapshot;
    lastBandwidthSnapshot = snapshot;
    if (!previous) {
      return;
    }
    const deltaRequests = snapshot.requests.total - previous.requests.total;
    const deltaBytes = snapshot.bandwidth.totalBytesSent - previous.bandwidth.totalBytesSent;
    if (deltaRequests <= 0 && deltaBytes <= 0) {
      return;
    }
    const topRouteGroups = Object.entries(snapshot.bandwidth.byRouteGroupBytes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([group, bytes]) => `${group}:${(bytes / (1024 * 1024)).toFixed(1)}MB`);
    writeLog(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "api_bandwidth_summary",
      intervalSeconds: 60,
      requests: deltaRequests,
      bytesSent: deltaBytes,
      bytesSentMB: Number((deltaBytes / (1024 * 1024)).toFixed(2)),
      topRouteGroups: topRouteGroups
    }));
  }, 60 * 1000);
  summaryTimer.unref?.();

  return function observeApiRequest(request, response, next) {
    beginRequestObservation();

    const startedAt = process.hrtime.bigint();
    let completed = false;
    let bytesSent = 0;

    // Count response bytes by wrapping the write/end calls (headers excluded).
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    response.write = (...args) => {
      const chunk = args[0];
      if (chunk) {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return originalWrite(...args);
    };
    response.end = (...args) => {
      const chunk = args[0];
      if (chunk) {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return originalEnd(...args);
    };

    function finalize(outcome) {
      if (completed) {
        return;
      }

      completed = true;
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const payload = createRequestObservationPayload(request, response, elapsedMs, outcome, bytesSent);
      recordRequestObservation(payload);

      if (writeLog && shouldLogRequest(payload, logMode)) {
        writeLog(JSON.stringify(payload));
      }
    }

    response.on("finish", () => {
      finalize("finish");
    });

    response.on("close", () => {
      finalize(response.writableEnded ? "finish" : "close");
    });

    next();
  };
}

module.exports = {
  createApiRequestObserver
};