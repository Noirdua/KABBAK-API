const { createConfigError } = require("../lib/config-error");

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_JSON_BODY_LIMIT = "40mb";

const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;
const nativeOriginPattern = /^(?:capacitor|ionic):\/\/localhost$/i;

function isPrivateLanHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) {
    return false;
  }
  const octets = parts.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isTrustedClientOrigin(origin) {
  const value = String(origin || "").trim();
  if (localOriginPattern.test(value) || nativeOriginPattern.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol)) {
      return false;
    }
    return isPrivateLanHost(url.hostname);
  } catch (_error) {
    return false;
  }
}

function parseAllowedOrigins(rawValue) {
  return Array.from(new Set(
    String(rawValue || "")
      .split(/[\r\n,;]+/)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ));
}

function parseBooleanEnv(name, defaultValue) {
  const rawValue = String(process.env[name] || "").trim().toLowerCase();
  if (!rawValue) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(rawValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(rawValue)) {
    return false;
  }

  throw createConfigError(`${name} must be a boolean-like value (true/false, 1/0, yes/no, on/off).`);
}

function parseHost(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || DEFAULT_HOST;
}

function parsePort(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return DEFAULT_PORT;
  }

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createConfigError("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

const REQUEST_LOG_MODES = Object.freeze(["errors", "all", "none"]);

function parseRequestLogMode(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return "all";
  }

  if (!REQUEST_LOG_MODES.includes(normalized)) {
    throw createConfigError(`KABBAK_REQUEST_LOG must be one of: ${REQUEST_LOG_MODES.join(", ")}.`);
  }

  return normalized;
}

function parseJsonBodyLimit(rawValue) {
  const val = String(rawValue || "").trim();
  if (!val) {
    return DEFAULT_JSON_BODY_LIMIT;
  }
  // Accept express-compatible strings like "10mb", "5mb", "500kb", or raw bytes
  return val;
}

function parseProfileEncryptionSecret(rawValue) {
  return String(rawValue || "").trim();
}

function parseBrowserTitle(rawValue) {
  return String(rawValue || "").trim().slice(0, 100);
}

function parsePluginUploadLimitMb(rawValue) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 25 * 1024 * 1024;
  }
  return Math.min(1024, Math.floor(numeric)) * 1024 * 1024;
}

const appEnv = Object.freeze({
  port: parsePort(process.env.PORT),
  host: parseHost(process.env.HOST || process.env.KABBAK_HOST),
  jsonBodyLimit: parseJsonBodyLimit(process.env.KABBAK_JSON_BODY_LIMIT || process.env.JSON_BODY_LIMIT),
  allowedOrigins: Object.freeze(parseAllowedOrigins(process.env.KABBAK_ALLOWED_ORIGINS)),
  allowNullOrigin: parseBooleanEnv("KABBAK_ALLOW_NULL_ORIGIN", false),
  autoMigrateEnabled: parseBooleanEnv("KABBAK_AUTO_MIGRATE", true),
  requestLogMode: parseRequestLogMode(process.env.KABBAK_REQUEST_LOG),
  profileEncryptionSecret: parseProfileEncryptionSecret(process.env.KABBAK_PROFILE_ENCRYPTION_SECRET),
  browserTitle: parseBrowserTitle(process.env.KABBAK_BROWSER_TITLE),
  pluginUploadLimitBytes: parsePluginUploadLimitMb(process.env.KABBAK_MAX_PLUGIN_UPLOAD_MB)
});

function isPublicCorsPath(pathname) {
  const path = String(pathname || "").split("?")[0];
  return /\/api\/v1\/(health|auth|branding|webhooks\/email)(?:\/|$)/.test(path);
}

function buildCorsOptions({ allowAnyOrigin = false } = {}) {
  const allowNullOrigin = appEnv.allowNullOrigin;

  return {
    origin(origin, callback) {
      if (!origin || allowAnyOrigin) {
        callback(null, true);
        return;
      }

      if (isTrustedClientOrigin(origin)) {
        callback(null, true);
        return;
      }

      // Consult the runtime settings store first so admins can adjust allowed
      // origins from the Admin panel without a restart.
      let configuredOrigins = appEnv.allowedOrigins;
      let runtimeAllowNullOrigin = allowNullOrigin;
      try {
        const runtime = require("../services/runtime-settings").getRuntimeSettings();
        if (Array.isArray(runtime.allowedOrigins)) {
          configuredOrigins = runtime.allowedOrigins;
        }
        runtimeAllowNullOrigin = runtime.allowNullOrigin === true;
      } catch (_error) {
        // Fall back to environment config.
      }

      const isAllowedOrigin = configuredOrigins.length > 0
        ? configuredOrigins.includes(origin)
        : runtimeAllowNullOrigin && origin === "null";

      if (isAllowedOrigin) {
        callback(null, true);
        return;
      }

      const error = new Error("Origin is not allowed.");
      error.status = 403;
      error.code = "forbidden_origin";
      callback(error);
    }
  };
}

module.exports = {
  appEnv,
  buildCorsOptions,
  isPublicCorsPath,
  isTrustedClientOrigin,
  parseBooleanEnv
};