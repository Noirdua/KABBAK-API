const { createHttpError } = require("../lib/http-errors");

const ADMIN_API_MANAGEMENT_CAPABILITY = Object.freeze({
  anyRoles: Object.freeze(["admin"]),
  anyScopes: Object.freeze(["api:admin"])
});

function normalizeCapabilityToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCapabilityTokens(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeCapabilityToken(value))
      .filter(Boolean)
  ));
}

function requireApiClientCapability({
  capabilityName = "clientCapability",
  anyRoles = [],
  anyScopes = [],
  errorCode = "insufficient_client_capability",
  errorMessage = "The authenticated client does not have the required capability for this route."
} = {}) {
  const normalizedRoles = normalizeCapabilityTokens(anyRoles);
  const normalizedScopes = normalizeCapabilityTokens(anyScopes);

  return function apiClientCapabilityMiddleware(request, response, next) {
    if (request.method === "OPTIONS") {
      next();
      return;
    }

    if (!normalizedRoles.length && !normalizedScopes.length) {
      next();
      return;
    }

    const auth = response.locals?.auth || request.auth || null;
    const clientRoles = new Set(normalizeCapabilityTokens(auth?.roles));
    const clientScopes = new Set(normalizeCapabilityTokens(auth?.scopes));
    const matchedRole = normalizedRoles.find((role) => clientRoles.has(role)) || "";
    const matchedScope = normalizedScopes.find((scope) => clientScopes.has(scope)) || "";

    if (matchedRole || matchedScope) {
      response.locals.clientCapability = {
        capabilityName,
        matchedBy: matchedRole ? "role" : "scope",
        matchedValue: matchedRole || matchedScope,
        requiredRoles: [...normalizedRoles],
        requiredScopes: [...normalizedScopes]
      };
      next();
      return;
    }

    next(createHttpError(
      403,
      errorCode,
      errorMessage,
      {
        capabilityName,
        requiredRoles: [...normalizedRoles],
        requiredScopes: [...normalizedScopes]
      }
    ));
  };
}

module.exports = {
  ADMIN_API_MANAGEMENT_CAPABILITY,
  requireApiClientCapability
};