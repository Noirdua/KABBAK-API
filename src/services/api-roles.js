/* api-roles.js — custom role definitions with capabilities and granulated limits.
 * Roles are stored in storage/config/api-roles.json. Managed API clients carry
 * role ids in their `roles` array; grants are merged from all of the client's
 * roles (highest limit wins) and applied to profile storage limits.
 */
const fs = require("node:fs");
const { writeFileAtomicSync } = require("../lib/atomic-file");

const { apiRolesPath } = require("../config/paths");
const {
  PROFILE_STORAGE_QUOTA_BYTES,
  MAX_NOTES_PER_PROFILE,
  MAX_ATTACHMENTS_PER_SCENE,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_EVENTS_PER_PROFILE
} = require("../config/profile-storage");
const { ACCESS_LEVELS, normalizeAccessLevel } = require("../config/api-access");
const { getAccessLevelLimits } = require("./api-access-levels");

const KNOWN_CAPABILITIES = Object.freeze(["tarot", "adminApiManagement"]);
const KNOWN_LIMIT_KEYS = Object.freeze(["notes", "events", "attachmentsPerScene", "attachmentBytes", "storageBytes"]);

const DEFAULT_LIMITS = Object.freeze({
  notes: MAX_NOTES_PER_PROFILE,
  events: MAX_EVENTS_PER_PROFILE,
  attachmentsPerScene: MAX_ATTACHMENTS_PER_SCENE,
  attachmentBytes: MAX_ATTACHMENT_SIZE_BYTES,
  storageBytes: PROFILE_STORAGE_QUOTA_BYTES
});

const MAX_ROLE_ID_LENGTH = 40;
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeRoleId(roleId) {
  return String(roleId || "").trim().toLowerCase();
}

function assertValidRoleId(roleId) {
  const normalized = normalizeRoleId(roleId);
  if (!normalized || normalized.length > MAX_ROLE_ID_LENGTH || !ROLE_ID_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid role id. Use ${MAX_ROLE_ID_LENGTH} or fewer characters: letters, numbers, dot, dash, underscore (e.g. "premium-plus").`
    );
  }
  return normalized;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function normalizePrice(input) {
  const amount = Number(input?.amount ?? input?.priceAmount);
  const currency = String(input?.currency || "USD").trim().toUpperCase().slice(0, 3);
  return {
    amount: Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : 0,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    providerPlanId: String(input?.providerPlanId || "").trim().slice(0, 120)
  };
}

function normalizeRoleDefinition(roleId, definition) {
  let accessLevel = "";
  try {
    accessLevel = normalizeAccessLevel(definition?.accessLevel, { defaultValue: "" });
  } catch (_error) {
    accessLevel = "";
  }

  const capabilities = Array.from(new Set(
    (Array.isArray(definition?.capabilities) ? definition.capabilities : [])
      .map((value) => String(value || "").trim())
      .filter((value) => KNOWN_CAPABILITIES.includes(value))
  ));

  const rawLimits = definition?.limits && typeof definition.limits === "object" ? definition.limits : {};
  const limits = {};
  for (const key of KNOWN_LIMIT_KEYS) {
    const value = normalizePositiveInteger(rawLimits[key]);
    if (value != null) {
      limits[key] = value;
    }
  }

  return {
    id: roleId,
    label: String(definition?.label || roleId).trim().slice(0, 80),
    description: String(definition?.description || "").trim().slice(0, 400),
    accessLevel,
    capabilities,
    limits,
    price: normalizePrice(definition?.price)
  };
}

function getRolesFilePath(options = {}) {
  return String(options.filePath || apiRolesPath || "").trim();
}

function readRoleDefinitions(options = {}) {
  const filePath = getRolesFilePath(options);
  const roles = {};
  if (!filePath) {
    return { roles };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rawRoles = parsed && typeof parsed === "object" && parsed.roles && typeof parsed.roles === "object"
      ? parsed.roles
      : {};
    for (const [roleId, definition] of Object.entries(rawRoles)) {
      let safeId = "";
      try {
        safeId = assertValidRoleId(roleId);
      } catch (_error) {
        continue;
      }
      roles[safeId] = normalizeRoleDefinition(safeId, definition);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { roles };
    }
    throw error;
  }
  return { roles };
}

function writeRoleDefinitions(roles, options = {}) {
  const filePath = getRolesFilePath(options);
  if (!filePath) {
    throw new Error("No roles file path configured.");
  }
  writeFileAtomicSync(filePath, `${JSON.stringify({ roles }, null, 2)}\n`);
  return filePath;
}

function listRoleDefinitions(options = {}) {
  return Object.values(readRoleDefinitions(options).roles)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getRoleDefinition(roleId, options = {}) {
  const safeId = normalizeRoleId(roleId);
  return readRoleDefinitions(options).roles[safeId] || null;
}

function upsertRoleDefinition(roleId, input, options = {}) {
  const safeId = assertValidRoleId(roleId);
  const definition = normalizeRoleDefinition(safeId, input);
  const { roles } = readRoleDefinitions(options);
  roles[safeId] = definition;
  writeRoleDefinitions(roles, options);
  return definition;
}

function removeRoleDefinition(roleId, options = {}) {
  const safeId = normalizeRoleId(roleId);
  const { roles } = readRoleDefinitions(options);
  if (!roles[safeId]) {
    return false;
  }
  delete roles[safeId];
  writeRoleDefinitions(roles, options);
  return true;
}

function accessLevelRank(accessLevel) {
  const index = ACCESS_LEVELS.indexOf(String(accessLevel || ""));
  return index < 0 ? -1 : index;
}

function cloneLimits(limits) {
  return { ...(limits || {}) };
}

function resolveClientGrants(client, options = {}) {
  const roleIds = Array.isArray(client?.roles)
    ? client.roles.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const scopes = Array.isArray(client?.scopes)
    ? client.scopes.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  const capabilities = new Set();
  // Start from the client's access-level tier limits; explicit role limits
  // override the tier (highest across roles wins).
  const limits = { ...getAccessLevelLimits(client?.accessLevel, options) };
  const seenLimitKeys = new Set();
  let accessLevel = String(client?.accessLevel || "");

  for (const roleId of roleIds) {
    // The built-in "admin" role is a capability shortcut, not a definition.
    if (roleId === "admin") {
      capabilities.add("adminApiManagement");
    }
    const definition = getRoleDefinition(roleId, options);
    if (!definition) continue;
    if (definition.accessLevel && accessLevelRank(definition.accessLevel) > accessLevelRank(accessLevel)) {
      accessLevel = definition.accessLevel;
    }
    definition.capabilities.forEach((capability) => capabilities.add(capability));
    for (const [key, value] of Object.entries(definition.limits || {})) {
      if (!Number.isFinite(value) || value <= 0) continue;
      // First explicit role limit overrides the default; further roles keep the
      // highest value across all of them.
      if (!seenLimitKeys.has(key)) {
        limits[key] = value;
        seenLimitKeys.add(key);
      } else if (value > limits[key]) {
        limits[key] = value;
      }
    }
  }

  if (scopes.includes("api:admin")) {
    capabilities.add("adminApiManagement");
  }

  return {
    accessLevel,
    capabilities: [...capabilities],
    limits: cloneLimits(limits)
  };
}

function resolveClientLimits(client, options = {}) {
  return resolveClientGrants(client, options).limits;
}

module.exports = {
  DEFAULT_LIMITS,
  KNOWN_CAPABILITIES,
  KNOWN_LIMIT_KEYS,
  getRoleDefinition,
  listRoleDefinitions,
  readRoleDefinitions,
  removeRoleDefinition,
  resolveClientGrants,
  resolveClientLimits,
  upsertRoleDefinition
};
