const { createHttpError } = require("../lib/http-errors");
const { readManagedApiClients } = require("./api-client-registry");

// Resolve a message audience into a concrete recipient list. "all" is a global
// broadcast (no list needed); "users" is an explicit set; "roles" matches any
// managed client whose assigned roles or access level are in the selected set.
function resolveAudienceClientIds(input, { clients } = {}) {
  const audience = input && typeof input === "object" ? input : {};
  const type = String(audience.type || "all").trim().toLowerCase();

  if (type === "all") {
    return { type: "all", clientIds: [] };
  }

  if (type === "users") {
    const ids = Array.isArray(audience.clientIds) ? audience.clientIds : [];
    return {
      type: "users",
      clientIds: Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)))
    };
  }

  if (type === "roles") {
    const roles = Array.isArray(audience.roles)
      ? audience.roles.map((role) => String(role || "").trim()).filter(Boolean)
      : [];
    if (!roles.length) {
      return { type: "roles", clientIds: [] };
    }
    const roleSet = new Set(roles);
    const list = Array.isArray(clients) ? clients : readManagedApiClients();
    const clientIds = list
      .filter((client) => {
        const assigned = Array.isArray(client.roles) ? client.roles.map((role) => String(role)) : [];
        return assigned.some((role) => roleSet.has(role)) || roleSet.has(String(client.accessLevel || ""));
      })
      .map((client) => String(client.id || "").trim())
      .filter(Boolean);
    return { type: "roles", clientIds: Array.from(new Set(clientIds)) };
  }

  throw createHttpError(400, "invalid_audience", "Audience type must be all, users, or roles.");
}

module.exports = { resolveAudienceClientIds };
