const rateLimit = require("express-rate-limit");
const { isLoopbackOrPrivateIp, normalizeIp } = require("../lib/ip-utils");

const BAN_PRUNE_INTERVAL_MS = 60 * 1000;

const state = {
  // key -> { count, windowStartAt } for IPs that have recently tripped the limit
  violations: new Map(),
  // key -> unix timestamp until which the IP/client is banned
  bannedUntil: new Map()
};

function resolveClientKey(request) {
  const auth = request.auth || {};
  if (auth.clientId) {
    return `client:${auth.clientId}`;
  }
  return request.ip || request.socket?.remoteAddress || "anonymous";
}

function pruneBanState(banForMs) {
  const now = Date.now();
  for (const [key, until] of state.bannedUntil) {
    if (until <= now) {
      state.bannedUntil.delete(key);
    }
  }
  for (const [key, entry] of state.violations) {
    if (entry.windowStartAt + banForMs <= now) {
      state.violations.delete(key);
    }
  }
}

// Record a rate-limit violation; bans the key once it trips the limit enough
// times within a short span. Returns true when the key was just banned.
function registerViolation(key, banAfterViolations, banForMs) {
  const now = Date.now();
  const entry = state.violations.get(key) || { count: 0, windowStartAt: now };
  entry.count += 1;

  if (entry.count >= banAfterViolations) {
    state.bannedUntil.set(key, now + banForMs);
    state.violations.delete(key);
    return true;
  }

  state.violations.set(key, entry);
  return false;
}

function createGlobalRateLimiter({
  windowMs = 30_000,
  max = 300,
  banAfterViolations = 5,
  banForMs = 15 * 60 * 1000
} = {}) {
  const limiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: resolveClientKey,
    skip(request) {
      const ip = normalizeIp(request.ip || request.socket?.remoteAddress || "");
      if (/^127\./.test(ip) || ip === "::1") {
        return true;
      }
      const path = request.path || "";
      return path.startsWith("/health");
    },
    handler(request, response) {
      registerViolation(resolveClientKey(request), banAfterViolations, banForMs);
      response.status(429).json({
        error: "rate_limit_exceeded",
        message: "Too many requests. Please slow down.",
        requestId: response.locals?.requestId || request.id || ""
      });
    },
    validate: { keyGeneratorIpFallback: false }
  });

  setInterval(() => pruneBanState(banForMs), BAN_PRUNE_INTERVAL_MS).unref();
  return limiter;
}

// Reject requests from keys that have been temporarily banned for repeatedly
// tripping the rate limit.
function createIpBanGate({ logger = console } = {}) {
  return function ipBanGate(request, response, next) {
    if (isLoopbackOrPrivateIp(request.ip)) {
      return next();
    }

    const key = resolveClientKey(request);
    const bannedUntil = state.bannedUntil.get(key) || 0;
    const now = Date.now();

    if (now < bannedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bannedUntil - now) / 1000));
      if (typeof logger?.warn === "function") {
        logger.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "api_ip_banned",
          ip: request.ip || request.socket?.remoteAddress || "unknown",
          retryAfterSeconds
        }));
      }
      response.set("Retry-After", String(retryAfterSeconds));
      response.status(403).json({
        error: "ip_banned",
        message: "Access temporarily restricted due to repeated rate-limit violations.",
        requestId: response.locals?.requestId || request.id || ""
      });
      return;
    }

    next();
  };
}

module.exports = {
  createGlobalRateLimiter,
  createIpBanGate
};
