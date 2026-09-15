/* api-access-levels.js — editable definitions for the fixed access tiers
 * (basic, premium, pro+). Admins can tune labels, descriptions, default
 * roles/scopes, and granulated limits per tier. The tier ids themselves stay
 * fixed so validation and rank ordering across the API never drift.
 *
 * Built-in defaults live in code; storage/config/api-access-levels.json only
 * stores overrides.
 */
const fs = require("node:fs");
const path = require("node:path");

const { apiAccessLevelsPath } = require("../config/paths");
const {
  ACCESS_LEVELS,
  ACCESS_LEVEL_DEFAULT_CAPABILITIES,
  normalizeAccessLevel
} = require("../config/api-access");
const {
  PROFILE_STORAGE_QUOTA_BYTES,
  MAX_NOTES_PER_PROFILE,
  MAX_ATTACHMENTS_PER_SCENE,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_EVENTS_PER_PROFILE
} = require("../config/profile-storage");

const MB = 1024 * 1024;

const BUILTIN_ACCESS_LEVELS = Object.freeze({
  basic: Object.freeze({
    id: "basic",
    label: "Basic",
    description: "Starter tier. Tarot browsing, profiles, and a small notebook.",
    roles: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES.basic.roles]),
    scopes: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES.basic.scopes]),
    limits: Object.freeze({
      notes: 50,
      events: 100,
      attachmentsPerScene: 3,
      attachmentBytes: 2 * MB,
      storageBytes: 25 * MB
    }),
    price: Object.freeze({ amount: 0, currency: "USD", providerPlanId: "" })
  }),
  premium: Object.freeze({
    id: "premium",
    label: "Premium",
    description: "Standard tier. Full tarot decks and a roomy notebook.",
    roles: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES.premium.roles]),
    scopes: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES.premium.scopes]),
    limits: Object.freeze({
      notes: 500,
      events: 1000,
      attachmentsPerScene: 5,
      attachmentBytes: 5 * MB,
      storageBytes: PROFILE_STORAGE_QUOTA_BYTES
    }),
    price: Object.freeze({ amount: 0, currency: "USD", providerPlanId: "" })
  }),
  "pro+": Object.freeze({
    id: "pro+",
    label: "Pro+",
    description: "Top tier. Maximum notebook, attachments, and storage.",
    roles: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES["pro+"].roles]),
    scopes: Object.freeze([...ACCESS_LEVEL_DEFAULT_CAPABILITIES["pro+"].scopes]),
    limits: Object.freeze({
      notes: MAX_NOTES_PER_PROFILE,
      events: MAX_EVENTS_PER_PROFILE,
      attachmentsPerScene: MAX_ATTACHMENTS_PER_SCENE,
      attachmentBytes: MAX_ATTACHMENT_SIZE_BYTES,
      storageBytes: 250 * MB
    }),
    price: Object.freeze({ amount: 0, currency: "USD", providerPlanId: "" })
  })
});

function getLevelsFilePath(options = {}) {
  return String(options.filePath || apiAccessLevelsPath || "").trim();
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function normalizeStringList(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(
    value.map((entry) => String(entry || "").trim()).filter(Boolean)
  ));
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

function normalizeLevelOverrides(levelId, input) {
  const builtin = BUILTIN_ACCESS_LEVELS[levelId];
  const roles = normalizeStringList(input?.roles) || builtin.roles;
  const scopes = normalizeStringList(input?.scopes) || builtin.scopes;
  const rawLimits = input?.limits && typeof input.limits === "object" ? input.limits : {};
  const limits = { ...builtin.limits };
  for (const key of Object.keys(limits)) {
    const value = normalizePositiveInteger(rawLimits[key]);
    if (value != null) {
      limits[key] = value;
    }
  }
  return {
    id: levelId,
    label: String(input?.label || builtin.label).trim().slice(0, 80),
    description: String(input?.description || builtin.description).trim().slice(0, 400),
    roles,
    scopes,
    limits,
    price: normalizePrice(input?.price ?? builtin.price)
  };
}

function readAccessLevelDefinitions(options = {}) {
  const levels = {};
  for (const levelId of ACCESS_LEVELS) {
    levels[levelId] = {
      id: levelId,
      label: BUILTIN_ACCESS_LEVELS[levelId].label,
      description: BUILTIN_ACCESS_LEVELS[levelId].description,
      roles: [...BUILTIN_ACCESS_LEVELS[levelId].roles],
      scopes: [...BUILTIN_ACCESS_LEVELS[levelId].scopes],
      limits: { ...BUILTIN_ACCESS_LEVELS[levelId].limits },
      price: { ...BUILTIN_ACCESS_LEVELS[levelId].price }
    };
  }

  const filePath = getLevelsFilePath(options);
  if (!filePath) {
    return { levels };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rawLevels = parsed && typeof parsed === "object" && parsed.levels && typeof parsed.levels === "object"
      ? parsed.levels
      : {};
    for (const levelId of ACCESS_LEVELS) {
      const raw = rawLevels[levelId];
      if (raw && typeof raw === "object") {
        levels[levelId] = normalizeLevelOverrides(levelId, raw);
      }
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { levels };
    }
    throw error;
  }
  return { levels };
}

function writeAccessLevelOverrides(overrides, options = {}) {
  const filePath = getLevelsFilePath(options);
  if (!filePath) {
    throw new Error("No access levels file path configured.");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ levels: overrides }, null, 2)}\n`, "utf8");
  return filePath;
}

function listAccessLevelDefinitions(options = {}) {
  return ACCESS_LEVELS.map((levelId) => readAccessLevelDefinitions(options).levels[levelId]);
}

function getAccessLevelDefinition(levelId, options = {}) {
  let normalized = "";
  try {
    normalized = normalizeAccessLevel(levelId, { defaultValue: "" });
  } catch (_error) {
    return null;
  }
  return normalized ? readAccessLevelDefinitions(options).levels[normalized] : null;
}

function upsertAccessLevelDefinition(levelId, input, options = {}) {
  const normalized = normalizeAccessLevel(levelId, { defaultValue: "" });
  const definition = normalizeLevelOverrides(normalized, input);

  const filePath = getLevelsFilePath(options);
  const existingOverrides = {};
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.levels && typeof parsed.levels === "object") {
        Object.assign(existingOverrides, parsed.levels);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  existingOverrides[normalized] = definition;
  writeAccessLevelOverrides(existingOverrides, options);
  return definition;
}

function getAccessLevelLimits(levelId, options = {}) {
  const definition = getAccessLevelDefinition(levelId, options);
  return definition ? { ...definition.limits } : {
    notes: MAX_NOTES_PER_PROFILE,
    events: MAX_EVENTS_PER_PROFILE,
    attachmentsPerScene: MAX_ATTACHMENTS_PER_SCENE,
    attachmentBytes: MAX_ATTACHMENT_SIZE_BYTES,
    storageBytes: PROFILE_STORAGE_QUOTA_BYTES
  };
}

function getAccessLevelDefaultCapabilities(levelId, options = {}) {
  const definition = getAccessLevelDefinition(levelId, options);
  if (!definition) {
    return {
      roles: [...ACCESS_LEVEL_DEFAULT_CAPABILITIES[levelId].roles],
      scopes: [...ACCESS_LEVEL_DEFAULT_CAPABILITIES[levelId].scopes]
    };
  }
  return {
    roles: [...definition.roles],
    scopes: [...definition.scopes]
  };
}

module.exports = {
  BUILTIN_ACCESS_LEVELS,
  getAccessLevelDefaultCapabilities,
  getAccessLevelDefinition,
  getAccessLevelLimits,
  listAccessLevelDefinitions,
  readAccessLevelDefinitions,
  upsertAccessLevelDefinition
};
