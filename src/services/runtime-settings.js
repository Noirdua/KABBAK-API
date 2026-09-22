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
const { ACCESS_LEVELS, DEFAULT_CLIENT_ACCESS_LEVEL } = require("../config/api-access");

// Overridable so tests (and alternate deployments) can point at their own file.
const RUNTIME_SETTINGS_PATH = process.env.KABBAK_RUNTIME_SETTINGS_PATH
  ? path.resolve(String(process.env.KABBAK_RUNTIME_SETTINGS_PATH))
  : path.join(storageConfigRoot, "runtime-settings.json");

const REQUEST_LOG_MODES = new Set(["errors", "all", "none"]);
const MAX_PLUGIN_UPLOAD_BYTES = 1024 * 1024 * 1024;
const TRIAL_ACCESS_DEFAULT = "premium";

const EDITABLE_KEYS = new Set([
  "requestLogMode",
  "allowedOrigins",
  "allowNullOrigin",
  "jsonBodyLimit",
  "pluginUploadLimitBytes",
  "autoMigrateEnabled",
  "profileEncryptionSecret",
  "browserTitle",
  "brandingHomeLabel",
  "brandingLogoUrl",
  "overlayBackgroundUrl",
  "faviconUrl",
  "digestEnabled",
  "digestHour",
  // Email
  "mailTransport",
  "resendApiKey",
  "resendApiUrl",
  "mailFrom",
  "smtpUrl",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
  "smtpPass",
  "emailDevFallback",
  "resendWebhookSecret",
  "emailWebhookToken",
  // Accounts
  "signupEnabled",
  "trialDays",
  "trialAccessLevel",
  "publicApiUrl"
]);

// Secrets are persisted but never returned by the API; the panel only sees
// `<key>Set: true/false` and can clear or replace them.
const SECRET_KEYS = new Set(["resendApiKey", "smtpPass", "smtpUrl", "resendWebhookSecret", "emailWebhookToken"]);

const ENV_VAR_NAMES = Object.freeze({
  requestLogMode: "KABBAK_REQUEST_LOG",
  allowedOrigins: "KABBAK_ALLOWED_ORIGINS",
  allowNullOrigin: "KABBAK_ALLOW_NULL_ORIGIN",
  jsonBodyLimit: "KABBAK_JSON_BODY_LIMIT",
  pluginUploadLimitBytes: "KABBAK_MAX_PLUGIN_UPLOAD_MB",
  autoMigrateEnabled: "KABBAK_AUTO_MIGRATE",
  profileEncryptionSecret: "KABBAK_PROFILE_ENCRYPTION_SECRET",
  browserTitle: "KABBAK_BROWSER_TITLE",
  brandingHomeLabel: "KABBAK_BRANDING_HOME_LABEL",
  brandingLogoUrl: "KABBAK_BRANDING_LOGO_URL",
  digestEnabled: "KABBAK_DIGEST_ENABLED",
  digestHour: "KABBAK_DIGEST_HOUR",
  mailTransport: "KABBAK_MAIL_TRANSPORT",
  resendApiKey: "KABBAK_RESEND_API_KEY",
  resendApiUrl: "KABBAK_RESEND_API_URL",
  mailFrom: "KABBAK_MAIL_FROM",
  smtpUrl: "KABBAK_SMTP_URL",
  smtpHost: "KABBAK_SMTP_HOST",
  smtpPort: "KABBAK_SMTP_PORT",
  smtpSecure: "KABBAK_SMTP_SECURE",
  smtpUser: "KABBAK_SMTP_USER",
  smtpPass: "KABBAK_SMTP_PASS",
  emailDevFallback: "KABBAK_EMAIL_DEV_FALLBACK",
  resendWebhookSecret: "KABBAK_RESEND_WEBHOOK_SECRET",
  emailWebhookToken: "KABBAK_EMAIL_WEBHOOK_TOKEN",
  signupEnabled: "KABBAK_SIGNUP_ENABLED",
  trialDays: "KABBAK_TRIAL_DAYS",
  trialAccessLevel: "KABBAK_TRIAL_ACCESS_LEVEL",
  publicApiUrl: "KABBAK_PUBLIC_API_URL",
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
// Keys explicitly stored in runtime-settings.json. Everything else is a live
// environment default, so an env change (or a test) is still picked up.
let persistedKeys = new Set();

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

function coerceBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

// Tri-state for settings whose default depends on other configuration
// (e.g. the dev email fallback): null means "auto".
function coerceBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

const MAIL_TRANSPORTS = new Set(["auto", "smtp", "resend"]);

function normalizeMailTransport(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MAIL_TRANSPORTS.has(normalized) ? normalized : "auto";
}

function normalizeText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function normalizeSmtpPort(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    return 587;
  }
  return numeric;
}

// Accepts "email@domain" or "Display Name <email@domain>". A space before "<"
// is required: Resend rejects "Name<email@domain>" (it parses the name as part
// of the address).
const MAIL_FROM_PATTERN = /^(?:[^<>]{1,80}\s+<\s*[^<>@\s]+@[^<>\s]+\.[^<>\s]+\s*>|[^<>@\s]+@[^<>\s]+\.[^<>\s]+)$/;

function assertMailFrom(value) {
  const raw = normalizeText(value, 200);
  if (!raw) {
    return "";
  }
  if (!MAIL_FROM_PATTERN.test(raw)) {
    throw new Error("Sender must look like 'no-reply@example.com' or 'Name <no-reply@example.com>'.");
  }
  return raw;
}

function normalizeTrialDays(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 365) {
    return 30;
  }
  return numeric;
}

function normalizeTrialAccessLevel(value) {
  const normalized = String(value || "").trim();
  if (ACCESS_LEVELS.includes(normalized)) {
    return normalized;
  }
  return ACCESS_LEVELS.includes(TRIAL_ACCESS_DEFAULT) ? TRIAL_ACCESS_DEFAULT : DEFAULT_CLIENT_ACCESS_LEVEL;
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
    case "brandingHomeLabel":
      return normalizeText(process.env.KABBAK_BRANDING_HOME_LABEL, 100);
    case "brandingLogoUrl":
      return normalizeText(process.env.KABBAK_BRANDING_LOGO_URL, 500);
    case "overlayBackgroundUrl":
      return "";
    case "faviconUrl":
      return "";
    case "digestEnabled":
      return ["1", "true", "yes", "on"].includes(String(process.env.KABBAK_DIGEST_ENABLED || "").toLowerCase());
    case "digestHour":
      return normalizeDigestHour(process.env.KABBAK_DIGEST_HOUR);
    case "mailTransport":
      return normalizeMailTransport(process.env.KABBAK_MAIL_TRANSPORT);
    case "resendApiKey":
      return normalizeText(process.env.KABBAK_RESEND_API_KEY, 300);
    case "resendApiUrl":
      return normalizeText(process.env.KABBAK_RESEND_API_URL, 300) || "https://api.resend.com/emails";
    case "mailFrom":
      return normalizeText(process.env.KABBAK_MAIL_FROM, 200);
    case "smtpUrl":
      return normalizeText(process.env.KABBAK_SMTP_URL, 300);
    case "smtpHost":
      return normalizeText(process.env.KABBAK_SMTP_HOST, 200);
    case "smtpPort":
      return normalizeSmtpPort(process.env.KABBAK_SMTP_PORT || 587);
    case "smtpSecure":
      return coerceBoolean(process.env.KABBAK_SMTP_SECURE, false);
    case "smtpUser":
      return normalizeText(process.env.KABBAK_SMTP_USER, 200);
    case "smtpPass":
      return String(process.env.KABBAK_SMTP_PASS || "");
    case "emailDevFallback":
      return coerceBooleanOrNull(process.env.KABBAK_EMAIL_DEV_FALLBACK);
    case "resendWebhookSecret":
      return normalizeText(process.env.KABBAK_RESEND_WEBHOOK_SECRET, 300);
    case "emailWebhookToken":
      return normalizeText(process.env.KABBAK_EMAIL_WEBHOOK_TOKEN, 300);
    case "signupEnabled":
      return coerceBoolean(process.env.KABBAK_SIGNUP_ENABLED, true);
    case "trialDays":
      return normalizeTrialDays(process.env.KABBAK_TRIAL_DAYS || 30);
    case "trialAccessLevel":
      return normalizeTrialAccessLevel(process.env.KABBAK_TRIAL_ACCESS_LEVEL || TRIAL_ACCESS_DEFAULT);
    case "publicApiUrl":
      return normalizeText(process.env.KABBAK_PUBLIC_API_URL, 300).replace(/\/+$/, "");
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
    case "brandingHomeLabel":
      return normalizeText(value, 100);
    case "brandingLogoUrl":
      return normalizeText(value, 500);
    case "overlayBackgroundUrl":
      return String(value || "").trim().slice(0, 500);
    case "faviconUrl":
      return String(value || "").trim().slice(0, 500);
    case "digestEnabled":
      return Boolean(value);
    case "digestHour":
      return normalizeDigestHour(value);
    case "mailTransport":
      return normalizeMailTransport(value);
    case "resendApiKey":
    case "smtpPass":
    case "smtpUrl":
    case "resendWebhookSecret":
    case "emailWebhookToken":
      return String(value || "");
    case "resendApiUrl":
      return normalizeText(value, 300) || "https://api.resend.com/emails";
    case "mailFrom":
      return normalizeText(value, 200);
    case "smtpHost":
    case "smtpUser":
      return normalizeText(value, 200);
    case "smtpPort":
      return normalizeSmtpPort(value);
    case "smtpSecure":
      return coerceBoolean(value, false);
    case "emailDevFallback":
      return coerceBooleanOrNull(value);
    case "signupEnabled":
      return coerceBoolean(value, true);
    case "trialDays":
      return normalizeTrialDays(value);
    case "trialAccessLevel":
      return normalizeTrialAccessLevel(value);
    case "publicApiUrl":
      return normalizeText(value, 300).replace(/\/+$/, "");
    default:
      return value;
  }
}

function loadRuntimeSettings() {
  if (state) return state;
  const persisted = readPersistedSettings();
  persistedKeys = new Set(Object.keys(persisted || {}));
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
    brandingHomeLabel: normalizeText(state.brandingHomeLabel, 100),
    brandingLogoUrl: normalizeText(state.brandingLogoUrl, 500),
    overlayBackgroundUrl: String(state.overlayBackgroundUrl || ""),
    faviconUrl: String(state.faviconUrl || ""),
    digestEnabled: state.digestEnabled === true,
    digestHour: normalizeDigestHour(state.digestHour),
    // Email (secrets are reported as "set" only, never returned).
    mailTransport: normalizeMailTransport(state.mailTransport),
    resendApiKeySet: Boolean(state.resendApiKey),
    resendApiUrl: normalizeText(state.resendApiUrl, 300) || "https://api.resend.com/emails",
    mailFrom: normalizeText(state.mailFrom, 200),
    smtpUrlSet: Boolean(state.smtpUrl),
    smtpHost: normalizeText(state.smtpHost, 200),
    smtpPort: normalizeSmtpPort(state.smtpPort),
    smtpSecure: state.smtpSecure === true,
    smtpUser: normalizeText(state.smtpUser, 200),
    smtpPassSet: Boolean(state.smtpPass),
    emailDevFallback: coerceBooleanOrNull(state.emailDevFallback),
    resendWebhookSecretSet: Boolean(state.resendWebhookSecret),
    emailWebhookTokenSet: Boolean(state.emailWebhookToken),
    // Accounts.
    signupEnabled: state.signupEnabled !== false,
    trialDays: normalizeTrialDays(state.trialDays),
    trialAccessLevel: normalizeTrialAccessLevel(state.trialAccessLevel),
    publicApiUrl: normalizeText(state.publicApiUrl, 300).replace(/\/+$/, ""),
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

// Internal-only accessor: raw current value, including secrets. Server-side
// consumers read this so an Admin panel edit applies without a restart. A key
// the admin never saved falls through to the environment (live), so unset
// values keep following the env/`.env` file.
function getRuntimeSettingValue(key) {
  const name = String(key || "");
  loadRuntimeSettings();
  return persistedKeys.has(name) ? state[name] : envDefault(name);
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
  if (Object.prototype.hasOwnProperty.call(input, "brandingHomeLabel")) {
    changes.brandingHomeLabel = normalizeText(input.brandingHomeLabel, 100);
    settings.brandingHomeLabel = changes.brandingHomeLabel;
  }
  if (Object.prototype.hasOwnProperty.call(input, "brandingLogoUrl")) {
    changes.brandingLogoUrl = normalizeText(input.brandingLogoUrl, 500);
    settings.brandingLogoUrl = changes.brandingLogoUrl;
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

  // Email
  if (Object.prototype.hasOwnProperty.call(input, "mailTransport")) {
    changes.mailTransport = normalizeMailTransport(input.mailTransport);
    settings.mailTransport = changes.mailTransport;
  }
  if (Object.prototype.hasOwnProperty.call(input, "resendApiUrl")) {
    changes.resendApiUrl = normalizeText(input.resendApiUrl, 300) || "https://api.resend.com/emails";
    settings.resendApiUrl = changes.resendApiUrl;
  }
  if (Object.prototype.hasOwnProperty.call(input, "mailFrom")) {
    changes.mailFrom = assertMailFrom(input.mailFrom);
    settings.mailFrom = changes.mailFrom;
  }
  if (Object.prototype.hasOwnProperty.call(input, "smtpHost")) {
    changes.smtpHost = normalizeText(input.smtpHost, 200);
    settings.smtpHost = changes.smtpHost;
  }
  if (Object.prototype.hasOwnProperty.call(input, "smtpPort")) {
    changes.smtpPort = normalizeSmtpPort(input.smtpPort);
    settings.smtpPort = changes.smtpPort;
  }
  if (Object.prototype.hasOwnProperty.call(input, "smtpSecure")) {
    changes.smtpSecure = coerceBoolean(input.smtpSecure, false);
    settings.smtpSecure = changes.smtpSecure;
  }
  if (Object.prototype.hasOwnProperty.call(input, "smtpUser")) {
    changes.smtpUser = normalizeText(input.smtpUser, 200);
    settings.smtpUser = changes.smtpUser;
  }
  if (Object.prototype.hasOwnProperty.call(input, "emailDevFallback")) {
    // "auto"/null keeps the built-in behaviour (on only when unconfigured).
    changes.emailDevFallback = coerceBooleanOrNull(input.emailDevFallback);
    settings.emailDevFallback = changes.emailDevFallback;
  }
  // Secrets: null clears, empty keeps the current value, anything else replaces.
  ["resendApiKey", "smtpPass", "smtpUrl", "resendWebhookSecret", "emailWebhookToken"].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return;
    if (input[key] === null) {
      changes[key] = "";
      settings[key] = "";
      return;
    }
    const normalized = String(input[key] || "").trim();
    if (normalized) {
      changes[key] = normalized;
      settings[key] = normalized;
    }
  });

  // Accounts
  if (Object.prototype.hasOwnProperty.call(input, "signupEnabled")) {
    changes.signupEnabled = coerceBoolean(input.signupEnabled, true);
    settings.signupEnabled = changes.signupEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(input, "trialDays")) {
    changes.trialDays = normalizeTrialDays(input.trialDays);
    settings.trialDays = changes.trialDays;
  }
  if (Object.prototype.hasOwnProperty.call(input, "trialAccessLevel")) {
    changes.trialAccessLevel = normalizeTrialAccessLevel(input.trialAccessLevel);
    settings.trialAccessLevel = changes.trialAccessLevel;
  }
  if (Object.prototype.hasOwnProperty.call(input, "publicApiUrl")) {
    changes.publicApiUrl = normalizeText(input.publicApiUrl, 300).replace(/\/+$/, "");
    settings.publicApiUrl = changes.publicApiUrl;
  }

  if (Object.keys(changes).length) {
    // Persist the whole set (editable keys only) so new keys survive without a
    // matching update to this list. Everything we write now counts as an
    // explicit admin value, so it takes precedence over the environment.
    persistSettings({ ...settings });
    persistedKeys = new Set(Object.keys(settings));
  }

  return getRuntimeSettings();
}

function isRuntimeSettingEditable(key) {
  return EDITABLE_KEYS.has(String(key || ""));
}

module.exports = {
  getRuntimeSettings,
  getProfileEncryptionSecret,
  getRuntimeSettingValue,
  isRuntimeSettingEditable,
  updateRuntimeSettings
};
