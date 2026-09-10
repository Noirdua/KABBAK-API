const { createHttpError } = require("../lib/http-errors");
const { resolveApiRouteGroup } = require("../lib/api-route-groups");
const {
  getRequiredAccessLevelForRouteGroup,
  hasRequiredAccessLevel
} = require("../config/api-access");
const { isApiKeyProtectionEnabled } = require("./api-key");

function requireApiAccessLevel(request, response, next) {
  if (request.method === "OPTIONS" || !isApiKeyProtectionEnabled()) {
    next();
    return;
  }

  const auth = response.locals?.auth || request.auth || null;
  const routeGroup = resolveApiRouteGroup(request.path || request.originalUrl);
  const requiredAccessLevel = getRequiredAccessLevelForRouteGroup(routeGroup);
  const clientAccessLevel = String(auth?.accessLevel || "").trim().toLowerCase();

  if (clientAccessLevel && hasRequiredAccessLevel(clientAccessLevel, requiredAccessLevel)) {
    response.locals.accessPolicy = {
      routeGroup,
      requiredAccessLevel,
      clientAccessLevel
    };
    next();
    return;
  }

  next(createHttpError(
    403,
    "insufficient_access_level",
    `The '${routeGroup}' API requires ${requiredAccessLevel} access.`,
    {
      routeGroup,
      requiredAccessLevel,
      clientAccessLevel: clientAccessLevel || "none"
    }
  ));
}

module.exports = {
  requireApiAccessLevel
};