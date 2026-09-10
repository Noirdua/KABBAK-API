const { createConfigError } = require("../lib/config-error");

const ACCESS_LEVELS = Object.freeze(["basic", "premium", "pro+"]);
const DEFAULT_CLIENT_ACCESS_LEVEL = "premium";
const DEFAULT_ROUTE_ACCESS_LEVEL = "basic";

const ACCESS_LEVEL_DEFAULT_CAPABILITIES = Object.freeze({
  basic: Object.freeze({
    roles: Object.freeze(["reader"]),
    scopes: Object.freeze(["api:read"])
  }),
  premium: Object.freeze({
    roles: Object.freeze(["reader"]),
    scopes: Object.freeze(["api:read", "api:tarot", "api:decks"])
  }),
  "pro+": Object.freeze({
    roles: Object.freeze(["reader"]),
    scopes: Object.freeze(["api:read", "api:tarot", "api:decks", "api:metrics"])
  })
});

const routeGroupAccessPolicy = Object.freeze({
  admin: Object.freeze({ requiredAccessLevel: "premium" }),
  decks: Object.freeze({ requiredAccessLevel: "premium" }),
  tarot: Object.freeze({ requiredAccessLevel: "premium" }),
  metrics: Object.freeze({ requiredAccessLevel: "premium" })
});

const assetGroupAccessPolicy = Object.freeze({
  "tarot deck": Object.freeze({ requiredAccessLevel: "premium" })
});

const accessLevelRank = new Map(ACCESS_LEVELS.map((level, index) => [level, index]));

function normalizeAccessLevel(value, { fieldName = "accessLevel", defaultValue = DEFAULT_CLIENT_ACCESS_LEVEL } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (!accessLevelRank.has(normalized)) {
    throw createConfigError(`${fieldName} must be one of: ${ACCESS_LEVELS.join(", ")}.`);
  }

  return normalized;
}

function getRequiredAccessLevelForRouteGroup(routeGroup) {
  return routeGroupAccessPolicy[routeGroup]?.requiredAccessLevel || DEFAULT_ROUTE_ACCESS_LEVEL;
}

function getRequiredAccessLevelForAssetGroup(assetGroup) {
  return assetGroupAccessPolicy[String(assetGroup || "").trim().toLowerCase()]?.requiredAccessLevel || "";
}

function hasRequiredAccessLevel(currentLevel, requiredLevel) {
  const normalizedCurrent = normalizeAccessLevel(currentLevel, {
    fieldName: "currentAccessLevel",
    defaultValue: DEFAULT_CLIENT_ACCESS_LEVEL
  });
  const normalizedRequired = normalizeAccessLevel(requiredLevel, {
    fieldName: "requiredAccessLevel",
    defaultValue: DEFAULT_ROUTE_ACCESS_LEVEL
  });

  return accessLevelRank.get(normalizedCurrent) >= accessLevelRank.get(normalizedRequired);
}

function getDefaultCapabilitiesForAccessLevel(accessLevel) {
  const normalized = normalizeAccessLevel(accessLevel, {
    fieldName: "accessLevel",
    defaultValue: DEFAULT_CLIENT_ACCESS_LEVEL
  });
  const defaults = ACCESS_LEVEL_DEFAULT_CAPABILITIES[normalized];

  return {
    roles: [...defaults.roles],
    scopes: [...defaults.scopes]
  };
}

module.exports = {
  ACCESS_LEVELS,
  ACCESS_LEVEL_DEFAULT_CAPABILITIES,
  assetGroupAccessPolicy,
  DEFAULT_CLIENT_ACCESS_LEVEL,
  DEFAULT_ROUTE_ACCESS_LEVEL,
  getDefaultCapabilitiesForAccessLevel,
  getRequiredAccessLevelForAssetGroup,
  getRequiredAccessLevelForRouteGroup,
  hasRequiredAccessLevel,
  normalizeAccessLevel,
  routeGroupAccessPolicy
};