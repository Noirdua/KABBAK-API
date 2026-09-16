/* runtime-settings.js — server settings that can be adjusted from the Admin
 * panel without a restart. Values start from appEnv (environment) and any
 * admin edits are persisted to storage/config/runtime-settings.json, which
 * wins over the environment on the next boot. Everything that can be set via
 * env vars is editable here; only PORT and HOST are restart-only.
 */
const fs = require("node:fs");
const path = require("node:path");

const { appEnv } = require("../config/app-env");
const { storageConfigRoot } = require("../config/paths");

const RUNTIME_SETTINGS_PATH = path.join(storageConfigRoot, "runtime-settings.json");

const REQUEST_LOG_MODES = new Set(["errors", "all", "none"]);
const MAX_PLUGIN_UPLOAD_BYTES = 1024 * 1024 * 1024;

const EDITABLE_KEYS = new Set([
  "requestLogMode",
  "allowedOrigins",
  "allowNullOrigin",
  "jsonBodyLimit",
  "pluginUploadLimitBytes",
  "autoMigrateEnabled",
  "profileEncryptionSecret",
  "browserTitle",
  "overlayBackgroundUrl",
  "faviconUrl",
  "digestEnabled",
  "digestHour"
]);

const ENV_VAR_NAMES = Object.freeze({
  requestLogMode: "KABBAK_REQUEST_LOG",
  allowedOrigins: "KABBAK_ALLOWED_ORIGINS",
  allowNullOrigin: "KABBAK_ALLOW_NULL_ORIGIN",
  jsonBodyLimit: "KABBAK_JSON_BODY_LIMIT",
  pluginUploadLimitBytes: "KABBAK_MAX_PLUGIN_UPLOAD_MB",
  autoMigrateEnabled: "KABBAK_AUTO_MIGRATE",
  profileEncryptionSecret: "KABBAK_PROFILE_ENCRYPTION_SECRET",
  browserTitle: "KABBAK_BROWSER_TITLE",
  digestEnabled: "KABBAK_DIGEST_ENABLED",
  digestHour: "KABBAK_DIGEST_HOUR",
  port: "PORT",
  host: "HOST"
});

function normalizeDigestHour(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 23) {
    return 8;
  }
  return numeric;
}

let state = null;

function readPersistedSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_SETTINGS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (_error) {
    return {};
  }
}

function persistSettings(settings) {
  fs.mkdirSync(path.dirname(RUNTIME_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizeRequestLogMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return REQUEST_LOG_MODES.has(normalized) ? normalized : "errors";
}

function normalizeAllowedOrigins(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : String(value).split(/[\r\n,;]+/);
  return Array.from(new Set(
    list.map((entry) => String(entry).trim()).filter(Boolean)
  ));
}

const BODY_LIMIT_PATTERN = /^\d+(?:\.\d+)?\s*(b|kb|mb|gb)?$/i;

function normalizeJsonBodyLimit(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return String(appEnv.jsonBodyLimit || "40mb");
  }
  if (!BODY_LIMIT_PATTERN.test(normalized)) {
    throw new Error("Request body limit must look like '64mb', '500kb' or '1048576'.");
  }
  return normalized;
}

function normalizePluginUploadLimitBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Plugin upload limit must be a positive number of bytes.");
  }
  return Math.min(MAX_PLUGIN_UPLOAD_BYTES, Math.floor(numeric));
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Auto migrate must be a boolean-like value (true/false, on/off).");
}

function normalizeProfileEncryptionSecret(value) {
  return String(value || "").trim();
}

function envDefault(key) {
  switch (key) {
    case "requestLogMode":
      return appEnv.requestLogMode;
    case "allowedOrigins":
      return [...appEnv.allowedOrigins];
    case "allowNullOrigin":
      return appEnv.allowNullOrigin === true;
    case "jsonBodyLimit":
    return String(appEnv.jsonBodyLimit || "40mb");
    case "pluginUploadLimitBytes":
      return appEnv.pluginUploadLimitBytes;
    case "autoMigrateEnabled":
      return appEnv.autoMigrateEnabled === true;
    case "profileEncryptionSecret":
      return String(appEnv.profileEncryptionSecret || "");
    case "browserTitle":
      return String(appEnv.browserTitle || "");
    case "overlayBackgroundUrl":
      return "";
    case "faviconUrl":
      return "";
    case "digestEnabled":
      return ["1", "true", "yes", "on"].includes(String(process.env.KABBAK_DIGEST_ENABLED || "").toLowerCase());
    case "digestHour":
      return normalizeDigestHour(process.env.KABBAK_DIGEST_HOUR);
    default:
      return undefined;
  }
}

function normalizePersistedValue(key, value) {
  switch (key) {
    case "requestLogMode":
      return normalizeRequestLogMode(value);
    case "allowedOrigins":
      return normalizeAllowedOrigins(value);
    case "allowNullOrigin":
      return Boolean(value);
    case "jsonBodyLimit":
      return normalizeJsonBodyLimit(value);
    case "pluginUploadLimitBytes":
      return normalizePluginUploadLimitBytes(value);
    case "autoMigrateEnabled":
      return normalizeBoolean(value);
    case "profileEncryptionSecret":
      return normalizeProfileEncryptionSecret(value);
    case "browserTitle":
      return String(value || "").trim().slice(0, 100);
    case "overlayBackgroundUrl":
      return String(value || "").trim().slice(0, 500);
    case "faviconUrl":
      return String(value || "").trim().slice(0, 500);
    case "digestEnabled":
      return Boolean(value);
    case "digestHour":
      return normalizeDigestHour(value);
    default:
      return value;
  }
}

function loadRuntimeSettings() {
  if (state) return state;
  const persisted = readPersistedSettings();
  state = {};
  for (const key of EDITABLE_KEYS) {
    state[key] = Object.prototype.hasOwnProperty.call(persisted, key)
      ? normalizePersistedValue(key, persisted[key])
      : envDefault(key);
  }
  return state;
}

function getEffectiveAllowedOrigins() {
  const { allowedOrigins } = loadRuntimeSettings();
  return Array.isArray(allowedOrigins) ? allowedOrigins : [...appEnv.allowedOrigins];
}

function getRuntimeSettings() {
  loadRuntimeSettings();
  return {
    requestLogMode: state.requestLogMode,
    allowedOrigins: getEffectiveAllowedOrigins(),
    allowNullOrigin: state.allowNullOrigin === true,
    jsonBodyLimit: state.jsonBodyLimit,
    pluginUploadLimitBytes: state.pluginUploadLimitBytes,
    autoMigrateEnabled: state.autoMigrateEnabled === true,
    profileEncryptionSecretSet: Boolean(state.profileEncryptionSecret),
    // Browser tab title (empty means "use the frontend default").
    browserTitle: state.browserTitle,
    overlayBackgroundUrl: String(state.overlayBackgroundUrl || ""),
    faviconUrl: String(state.faviconUrl || ""),
    digestEnabled: state.digestEnabled === true,
    digestHour: normalizeDigestHour(state.digestHour),
    // Restart-only values (shown for reference; changing them needs a restart).
    envOnly: {
      port: appEnv.port,
      host: appEnv.host,
      envVarNames: { ...ENV_VAR_NAMES }
    }
  };
}

// Internal-only accessor: the encryption secret is never sent to the client.
function getProfileEncryptionSecret() {
  return String(loadRuntimeSettings().profileEncryptionSecret || "");
}

function updateRuntimeSettings(input = {}) {
  const settings = loadRuntimeSettings();
  const changes = {};

  if (Object.prototype.hasOwnProperty.call(input, "requestLogMode")) {
    changes.requestLogMode = normalizeRequestLogMode(input.requestLogMode);
    settings.requestLogMode = changes.requestLogMode;
  }
  if (Object.prototype.hasOwnProperty.call(input, "allowedOrigins")) {
    const normalized = normalizeAllowedOrigins(input.allowedOrigins) || [];
    // An empty list means "no admin override": fall back to the environment
    // so saving from the panel can never accidentally lock the server to
    // localhost-only CORS.
    changes.allowedOrigins = normalized.length ? normalized : null;
    settings.allowedOrigins = changes.allowedOrigins;
  }
  if (Object.prototype.hasOwnProperty.call(input, "allowNullOrigin")) {
    changes.allowNullOrigin = Boolean(input.allowNullOrigin);
    settings.allowNullOrigin = changes.allowNullOrigin;
  }
  if (Object.prototype.hasOwnProperty.call(input, "jsonBodyLimit")) {
    changes.jsonBodyLimit = normalizeJsonBodyLimit(input.jsonBodyLimit);
    settings.jsonBodyLimit = changes.jsonBodyLimit;
  }
  if (Object.prototype.hasOwnProperty.call(input, "pluginUploadLimitBytes")) {
    changes.pluginUploadLimitBytes = normalizePluginUploadLimitBytes(input.pluginUploadLimitBytes);
    settings.pluginUploadLimitBytes = changes.pluginUploadLimitBytes;
  }
  if (Object.prototype.hasOwnProperty.call(input, "autoMigrateEnabled")) {
    changes.autoMigrateEnabled = normalizeBoolean(input.autoMigrateEnabled);
    settings.autoMigrateEnabled = changes.autoMigrateEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(input, "profileEncryptionSecret")) {
    const raw = input.profileEncryptionSecret;
    if (raw === null) {
      // Explicit clear: an empty persisted value disables the env secret too.
      changes.profileEncryptionSecret = "";
      settings.profileEncryptionSecret = "";
    } else {
      const normalized = normalizeProfileEncryptionSecret(raw);
      if (normalized) {
        changes.profileEncryptionSecret = normalized;
        settings.profileEncryptionSecret = normalized;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "browserTitle")) {
    // Empty string clears the override; the frontend falls back to its default.
    changes.browserTitle = String(input.browserTitle || "").trim().slice(0, 100);
    settings.browserTitle = changes.browserTitle;
  }
  if (Object.prototype.hasOwnProperty.call(input, "overlayBackgroundUrl")) {
    changes.overlayBackgroundUrl = String(input.overlayBackgroundUrl || "").trim().slice(0, 500);
    settings.overlayBackgroundUrl = changes.overlayBackgroundUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input, "faviconUrl")) {
    changes.faviconUrl = String(input.faviconUrl || "").trim().slice(0, 500);
    settings.faviconUrl = changes.faviconUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input, "digestEnabled")) {
    changes.digestEnabled = Boolean(input.digestEnabled);
    settings.digestEnabled = changes.digestEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(input, "digestHour")) {
    changes.digestHour = normalizeDigestHour(input.digestHour);
    settings.digestHour = changes.digestHour;
  }

  if (Object.keys(changes).length) {
    persistSettings({
      requestLogMode: settings.requestLogMode,
      allowedOrigins: settings.allowedOrigins,
      allowNullOrigin: settings.allowNullOrigin,
      jsonBodyLimit: settings.jsonBodyLimit,
      pluginUploadLimitBytes: settings.pluginUploadLimitBytes,
      autoMigrateEnabled: settings.autoMigrateEnabled,
      profileEncryptionSecret: settings.profileEncryptionSecret,
      browserTitle: settings.browserTitle,
      overlayBackgroundUrl: settings.overlayBackgroundUrl,
      faviconUrl: settings.faviconUrl,
      digestEnabled: settings.digestEnabled,
      digestHour: settings.digestHour
    });
  }

  return getRuntimeSettings();
}

function isRuntimeSettingEditable(key) {
  return EDITABLE_KEYS.has(String(key || ""));
}

module.exports = {
  getRuntimeSettings,
  getProfileEncryptionSecret,
  isRuntimeSettingEditable,
  updateRuntimeSettings
};
