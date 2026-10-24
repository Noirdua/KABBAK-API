/* plugin-config-secrets.js — safe read/write handling for plugin config secrets.
 *
 * Config keys are considered secret when a camelCase/snake_case segment (or a
 * known compact spelling) is key/secret/password/token. This deliberately does
 * not match words like "keywords" or "keyboard".
 */

"use strict";

const SECRET_SEGMENTS = new Set([
  "key",
  "keys",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "passwds",
  "token",
  "tokens"
]);

const COMPACT_SECRET_NAMES = new Set([
  "apikey",
  "apikeys",
  "secretkey",
  "secretkeys",
  "privatekey",
  "privatekeys",
  "signingkey",
  "signingkeys",
  "accesskey",
  "accesskeys",
  "licensekey",
  "licensekeys",
  "passkey",
  "passkeys",
  "clientsecret",
  "clientsecrets",
  "webhooksecret",
  "webhooksecrets",
  "accesstoken",
  "accesstokens",
  "refreshtoken",
  "refreshtokens",
  "authtoken",
  "authtokens",
  "idtoken",
  "idtokens",
  "apitoken",
  "apitokens",
  "bottoken",
  "bottokens"
]);

const REDACTED_VALUE = "***";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function keySegments(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretKey(name) {
  const segments = keySegments(name);
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) {
    return true;
  }
  return COMPACT_SECRET_NAMES.has(segments.join(""));
}

function isSecretSetFlag(name) {
  const raw = String(name || "");
  if (!/Set$/.test(raw)) return false;
  return isSecretKey(raw.slice(0, -3));
}

function redactPluginConfig(config) {
  if (Array.isArray(config)) {
    return config.map((entry) => redactPluginConfig(entry));
  }
  if (!isPlainObject(config)) {
    return config;
  }
  const next = {};
  for (const key of Object.keys(config)) {
    if (isSecretSetFlag(key)) continue;
    const value = config[key];
    if (isSecretKey(key) && value) {
      next[key] = REDACTED_VALUE;
      next[`${key}Set`] = true;
      continue;
    }
    next[key] = isPlainObject(value) || Array.isArray(value) ? redactPluginConfig(value) : value;
  }
  return next;
}

// Restore "***" placeholders from the current config so saving a partially
// redacted config from the generic editor cannot overwrite a stored secret.
function restoreRedactedSecrets(incoming, current) {
  if (Array.isArray(incoming)) {
    const currentList = Array.isArray(current) ? current : [];
    return incoming.map((entry, index) => restoreRedactedSecrets(entry, currentList[index]));
  }
  if (!isPlainObject(incoming)) {
    return incoming;
  }
  const currentObject = isPlainObject(current) ? current : {};
  const next = {};
  for (const key of Object.keys(incoming)) {
    if (isSecretSetFlag(key)) continue;
    const value = incoming[key];
    const currentValue = currentObject[key];
    if (isSecretKey(key)) {
      if (value === REDACTED_VALUE) {
        if (currentValue !== undefined && currentValue !== null) {
          next[key] = currentValue;
        }
        continue;
      }
      next[key] = value;
      continue;
    }
    next[key] = isPlainObject(value) || Array.isArray(value)
      ? restoreRedactedSecrets(value, currentValue)
      : value;
  }
  return next;
}

module.exports = {
  REDACTED_VALUE,
  isSecretKey,
  isSecretSetFlag,
  redactPluginConfig,
  restoreRedactedSecrets
};
