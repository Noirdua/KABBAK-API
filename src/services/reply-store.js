const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Replies a user writes back to a message (broadcast or direct). Stored globally
// so the admin panel can read them without an admin profile inbox.
const DEFAULT_PATH = path.join(storageConfigRoot, "message-replies.json");
const MAX_REPLIES = 1000;

function resolvePath(options = {}) {
  return options.filePath || DEFAULT_PATH;
}

function readReplies(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePath(options), "utf8"));
    return Array.isArray(parsed?.replies) ? parsed.replies : [];
  } catch (_error) {
    return [];
  }
}

function writeReplies(replies, options = {}) {
  const filePath = resolvePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, replies }, null, 2)}\n`, "utf8");
}

function normalizeReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }
  return {
    id: String(reply.id || `rep_${crypto.randomBytes(8).toString("hex")}`),
    scope: reply.scope === "broadcast" ? "broadcast" : "direct",
    messageId: String(reply.messageId || "").slice(0, 80),
    messageTitle: String(reply.messageTitle || "").slice(0, 200),
    fromClientId: String(reply.fromClientId || "").slice(0, 120),
    fromName: String(reply.fromName || "").slice(0, 120),
    body: String(reply.body || "").slice(0, 4000),
    createdAt: String(reply.createdAt || new Date().toISOString())
  };
}

function appendReply(reply, options = {}) {
  const normalized = normalizeReply(reply);
  if (!normalized) {
    return null;
  }
  const replies = readReplies(options);
  replies.push(normalized);
  writeReplies(replies.slice(-MAX_REPLIES), options);
  return normalized;
}

function listReplies({ messageId } = {}, options = {}) {
  const target = String(messageId || "").trim();
  return readReplies(options)
    .map((reply) => normalizeReply(reply))
    .filter(Boolean)
    .filter((reply) => !target || reply.messageId === target)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function deleteReply(replyId, options = {}) {
  const replies = readReplies(options);
  const next = replies.filter((reply) => reply.id !== String(replyId || "").trim());
  writeReplies(next, options);
  return { removed: replies.length - next.length };
}

function clearReplies(options = {}) {
  const replies = readReplies(options);
  writeReplies([], options);
  return { removed: replies.length };
}

module.exports = {
  appendReply,
  clearReplies,
  deleteReply,
  listReplies
};
