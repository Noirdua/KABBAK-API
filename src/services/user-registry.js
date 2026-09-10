const { readManagedApiClients } = require("./api-client-registry");
const { getProfileSummary, readProfile } = require("./profile-service");

const PRESENCE_TTL_MINUTES = 10; // consider online if active in last 10 min

// In-memory presence store: clientId -> { lastSeen: ISO string }
const presenceStore = new Map();

function normalizeClientId(clientId) {
  return String(clientId || "").trim();
}

function touchPresence(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return;
  presenceStore.set(id, { lastSeen: new Date().toISOString() });
}

function getClientPresence(clientId) {
  const id = normalizeClientId(clientId);
  const entry = presenceStore.get(id);
  if (!entry) {
    return { status: "offline", lastSeen: null };
  }
  const last = new Date(entry.lastSeen);
  const now = new Date();
  const ageMinutes = (now.getTime() - last.getTime()) / (1000 * 60);
  const status = ageMinutes < PRESENCE_TTL_MINUTES ? "online" : "offline";
  return {
    status,
    lastSeen: entry.lastSeen
  };
}

function listRegistry({ includeOffline = true } = {}) {
  const clients = readManagedApiClients();
  const registry = [];

  for (const client of clients) {
    const id = client.id;
    const presence = getClientPresence(id);
    if (!includeOffline && presence.status === "offline") {
      continue;
    }

    let profileBio = "";
    try {
      const profile = readProfile(id);
      profileBio = profile.bio || "";
    } catch (_) {
      // profile may not exist yet
    }

    registry.push({
      id,
      name: client.name || id,
      accountId: client.accountId || "",
      accessLevel: client.accessLevel || "",
      bio: profileBio,
      status: presence.status,
      lastSeen: presence.lastSeen
    });
  }

  // Sort: online first, then by name
  registry.sort((a, b) => {
    if (a.status === "online" && b.status !== "online") return -1;
    if (b.status === "online" && a.status !== "online") return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  return registry;
}

function getClientRegistryEntry(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  const clients = readManagedApiClients();
  const client = clients.find((c) => c.id === id);
  if (!client) return null;

  const presence = getClientPresence(id);
  let profileBio = "";
  try {
    const profile = readProfile(id);
    profileBio = profile.bio || "";
  } catch (_) {}

  return {
    id,
    name: client.name || id,
    accountId: client.accountId || "",
    accessLevel: client.accessLevel || "",
    bio: profileBio,
    status: presence.status,
    lastSeen: presence.lastSeen
  };
}

module.exports = {
  touchPresence,
  getClientPresence,
  listRegistry,
  getClientRegistryEntry
};
