const { resolveApiRouteGroup } = require("../lib/api-route-groups");

const startedAt = new Date().toISOString();

const state = {
  activeRequests: 0,
  totalRequests: 0,
  authenticatedRequests: 0,
  anonymousRequests: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  totalBytesSent: 0,
  byStatus: Object.create(null),
  byStatusClass: Object.create(null),
  byAccessLevel: Object.create(null),
  byRouteGroup: Object.create(null),
  byRouteGroupBytes: Object.create(null),
  byClientId: Object.create(null)
};

function incrementCounter(target, key) {
  const normalizedKey = String(key || "unknown").trim() || "unknown";
  target[normalizedKey] = Number(target[normalizedKey] || 0) + 1;
}

function addBytes(target, key, bytes) {
  const normalizedKey = String(key || "unknown").trim() || "unknown";
  target[normalizedKey] = Number(target[normalizedKey] || 0) + bytes;
}

function normalizeDurationMs(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }

  return Number(durationMs.toFixed(3));
}

function beginRequestObservation() {
  state.activeRequests += 1;
}

function recordRequestObservation(entry) {
  state.activeRequests = Math.max(0, state.activeRequests - 1);
  state.totalRequests += 1;

  const durationMs = normalizeDurationMs(entry?.durationMs);
  state.totalDurationMs += durationMs;
  if (durationMs > state.maxDurationMs) {
    state.maxDurationMs = durationMs;
  }

  incrementCounter(state.byStatus, String(entry?.statusCode || "unknown"));
  const statusClass = Number(entry?.statusCode) >= 100
    ? `${Math.floor(Number(entry.statusCode) / 100)}xx`
    : "unknown";
  incrementCounter(state.byStatusClass, statusClass);
  const routeGroup = resolveApiRouteGroup(entry?.path);
  incrementCounter(state.byRouteGroup, routeGroup);

  const bytesSent = Math.max(0, Number(entry?.bytesSent) || 0);
  state.totalBytesSent += bytesSent;
  addBytes(state.byRouteGroupBytes, routeGroup, bytesSent);

  if (entry?.authenticated) {
    state.authenticatedRequests += 1;
    incrementCounter(state.byAccessLevel, entry?.accessLevel || "unknown");
    if (entry?.clientId) {
      incrementCounter(state.byClientId, entry.clientId);
    }
  } else {
    state.anonymousRequests += 1;
  }
}

function getRequestMetricsSnapshot() {
  const averageDurationMs = state.totalRequests > 0
    ? Number((state.totalDurationMs / state.totalRequests).toFixed(3))
    : 0;

  return {
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    requests: {
      active: state.activeRequests,
      total: state.totalRequests,
      authenticated: state.authenticatedRequests,
      anonymous: state.anonymousRequests,
      averageDurationMs,
      maxDurationMs: Number(state.maxDurationMs.toFixed(3)),
      byStatus: { ...state.byStatus },
      byStatusClass: { ...state.byStatusClass },
      byAccessLevel: { ...state.byAccessLevel },
      byRouteGroup: { ...state.byRouteGroup },
      byClientId: { ...state.byClientId }
    },
    bandwidth: {
      totalBytesSent: state.totalBytesSent,
      totalBytesSentMB: Number((state.totalBytesSent / (1024 * 1024)).toFixed(2)),
      byRouteGroupBytes: { ...state.byRouteGroupBytes }
    }
  };
}

const MAX_CLIENT_ID_ENTRIES = 200;

function pruneClientIdCounters() {
  const entries = Object.entries(state.byClientId);
  if (entries.length <= MAX_CLIENT_ID_ENTRIES) {
    return;
  }

  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const keep = sorted.slice(0, MAX_CLIENT_ID_ENTRIES);
  state.byClientId = Object.create(null);
  for (const [key, value] of keep) {
    state.byClientId[key] = value;
  }
}

setInterval(pruneClientIdCounters, 60 * 60 * 1000).unref();

module.exports = {
  beginRequestObservation,
  getRequestMetricsSnapshot,
  recordRequestObservation
};