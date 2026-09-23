const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomicSync } = require("../lib/atomic-file");

const { storageConfigRoot } = require("../config/paths");
const {
  MESSAGE_BROADCAST_PREFIX,
  MAX_BROADCASTS
} = require("../config/profile-storage");
const {
  ProfileStorageError,
  normalizeMessageInputFields,
  normalizeStoredMessageFields
} = require("./profile-service");

// Broadcasts are server-wide messages (admin -> every user's inbox). They live
// in a small JSON file rather than a profile because they are shared, not owned.
const DEFAULT_BROADCASTS_FILE = path.join(storageConfigRoot, "broadcasts.json");

function resolveFilePath(options = {}) {
  return options.filePath || DEFAULT_BROADCASTS_FILE;
}

function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return { version: 1, messages: [] };
    }
    const parsed = JSON.parse(raw);
    return { version: 1, messages: Array.isArray(parsed?.messages) ? parsed.messages : [] };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { version: 1, messages: [] };
    }
    throw error;
  }
}

function writeStore(filePath, store) {
  writeFileAtomicSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

function generateBroadcastToken() {
  return `${MESSAGE_BROADCAST_PREFIX}.${crypto.randomBytes(18).toString("base64url")}`;
}

function normalizeReaders(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, iso] of Object.entries(source)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      continue;
    }
    result[normalizedKey] = String(iso || "").trim() || new Date().toISOString();
  }
  return result;
}

function normalizeStoredBroadcast(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const createdAt = String(message.createdAt || new Date().toISOString());
  return {
    id: String(message.id || `bc_${crypto.randomBytes(8).toString("hex")}`),
    ...normalizeStoredMessageFields(message),
    token: String(message.token || "").trim(),
    sender: String(message.sender || "").trim().slice(0, 120),
    readers: normalizeReaders(message.readers),
    createdAt,
    updatedAt: String(message.updatedAt || createdAt)
  };
}

function listBroadcasts(options = {}) {
  return readStore(resolveFilePath(options))
    .messages
    .map((entry) => normalizeStoredBroadcast(entry))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function createBroadcast(input, { sender = "", filePath = DEFAULT_BROADCASTS_FILE } = {}) {
  const store = readStore(filePath);
  if (store.messages.length >= MAX_BROADCASTS) {
    throw new ProfileStorageError("messages_limit_reached", `At most ${MAX_BROADCASTS} broadcasts can be stored.`);
  }
  const fields = normalizeMessageInputFields(input);
  const nowIso = new Date().toISOString();
  const broadcast = {
    id: `bc_${crypto.randomBytes(8).toString("hex")}`,
    ...fields,
    token: generateBroadcastToken(),
    sender: String(sender || "").trim().slice(0, 120),
    createdAt: nowIso,
    updatedAt: nowIso
  };
  store.messages = [...store.messages, broadcast];
  writeStore(filePath, store);
  return broadcast;
}

function deleteBroadcast(messageId, options = {}) {
  const filePath = resolveFilePath(options);
  const store = readStore(filePath);
  const index = store.messages.findIndex((entry) => entry.id === String(messageId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("message_not_found", `Broadcast '${messageId}' was not found.`);
  }
  store.messages.splice(index, 1);
  writeStore(filePath, store);
  return { removed: true };
}

// Delivery receipt: remember which profiles have opened a broadcast.
function recordBroadcastRead(messageId, clientId, options = {}) {
  const filePath = resolveFilePath(options);
  const store = readStore(filePath);
  const index = store.messages.findIndex((entry) => entry.id === String(messageId || "").trim());
  const reader = String(clientId || "").trim();
  if (index === -1 || !reader) {
    return { recorded: false };
  }
  const message = store.messages[index];
  const readers = message && typeof message.readers === "object" && !Array.isArray(message.readers)
    ? { ...message.readers }
    : {};
  if (readers[reader]) {
    return { recorded: false };
  }
  readers[reader] = new Date().toISOString();
  store.messages[index] = { ...message, readers };
  writeStore(filePath, store);
  return { recorded: true };
}

function resolveBroadcastToken(token, options = {}) {
  const raw = String(token || "").trim();
  if (!raw.startsWith(`${MESSAGE_BROADCAST_PREFIX}.`)) {
    return null;
  }
  const message = listBroadcasts(options).find((entry) => entry.token === raw) || null;
  return message ? { message } : null;
}

module.exports = {
  createBroadcast,
  deleteBroadcast,
  listBroadcasts,
  recordBroadcastRead,
  resolveBroadcastToken
};
