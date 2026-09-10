const { createHttpError } = require("../lib/http-errors");
const {
  getRequiredAccessLevelForAssetGroup,
  hasRequiredAccessLevel
} = require("../config/api-access");
const { isApiKeyProtectionEnabled } = require("./api-key");

function requireAssetGroupAccessLevel(assetGroup) {
  const normalizedAssetGroup = String(assetGroup || "").trim().toLowerCase();

  return function assetGroupAccessLevelMiddleware(request, response, next) {
    if (request.method === "OPTIONS" || !isApiKeyProtectionEnabled()) {
      next();
      return;
    }

    const auth = response.locals?.auth || request.auth || null;
    const requiredAccessLevel = getRequiredAccessLevelForAssetGroup(normalizedAssetGroup);
    const clientAccessLevel = String(auth?.accessLevel || "").trim().toLowerCase();

    if (!requiredAccessLevel) {
      next();
      return;
    }

    if (!clientAccessLevel) {
      next(createHttpError(
        403,
        "insufficient_access_level",
        `The '${normalizedAssetGroup}' asset group requires ${requiredAccessLevel} access.`,
        {
          assetGroup: normalizedAssetGroup,
          requiredAccessLevel,
          clientAccessLevel: "none"
        }
      ));
      return;
    }

    let clientMeetsRequirement;
    try {
      clientMeetsRequirement = hasRequiredAccessLevel(clientAccessLevel, requiredAccessLevel);
    } catch {
      next(createHttpError(
        403,
        "insufficient_access_level",
        `The '${normalizedAssetGroup}' asset group requires ${requiredAccessLevel} access.`,
        {
          assetGroup: normalizedAssetGroup,
          requiredAccessLevel,
          clientAccessLevel: clientAccessLevel || "unknown"
        }
      ));
      return;
    }

    if (clientMeetsRequirement) {
      response.locals.assetAccessPolicy = {
        assetGroup: normalizedAssetGroup,
        requiredAccessLevel,
        clientAccessLevel
      };
      next();
      return;
    }

    next(createHttpError(
      403,
      "insufficient_access_level",
      `The '${normalizedAssetGroup}' asset group requires ${requiredAccessLevel} access.`,
      {
        assetGroup: normalizedAssetGroup,
        requiredAccessLevel,
        clientAccessLevel: clientAccessLevel || "none"
      }
    ));
  };
}

module.exports = {
  requireAssetGroupAccessLevel
};