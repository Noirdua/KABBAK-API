const { createApiRouter } = require("../lib/create-api-router");
const { createNotFoundError } = require("../lib/http-errors");
const { listRegistry, getClientRegistryEntry } = require("../services/user-registry");

const router = createApiRouter();

router.get("/registry/users", (request, response) => {
  // Allow any authenticated or not? For registry, make it public-ish but use auth if present.
  // For now, return the list (can be called without key? but to be consistent with profile, require? 
  // Let's allow without strict auth for viewing registry.
  const includeOffline = String(request.query.includeOffline || "true").toLowerCase() !== "false";
  const users = listRegistry({ includeOffline });
  response.apiSuccess({
    count: users.length,
    users
  });
});

router.get("/registry/users/:clientId", (request, response) => {
  const entry = getClientRegistryEntry(request.params.clientId);
  if (!entry) {
    throw createNotFoundError("user_not_found", "No such user in registry.");
  }
  response.apiSuccess(entry);
});

module.exports = router;
