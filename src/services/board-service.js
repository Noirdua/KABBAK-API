const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Minimal internal message board: topics with flat replies, stored in a single
// JSON file. Internal-only (the route layer requires an API key) and private by
// default; there is no public surface.
const DEFAULT_BOARD_PATH = path.join(storageConfigRoot, "message-board.json");
const MAX_TOPICS = 500;
const MAX_REPLIES_PER_TOPIC = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 10_000;
const MAX_REPLY_LENGTH = 5_000;
const MAX_QUOTE_LENGTH = 500;

function resolveBoardPath(options = {}) {
  return options.filePath || DEFAULT_BOARD_PATH;
}

function readBoard(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveBoardPath(options), "utf8"));
    return Array.isArray(parsed?.topics) ? parsed.topics : [];
  } catch (_error) {
    return [];
  }
}

function writeBoard(topics, options = {}) {
  const filePath = resolveBoardPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, topics }, null, 2)}\n`, "utf8");
}

function boardError(message) {
  const error = new Error(message);
  error.code = "invalid_post";
  return error;
}

function normalizeTitle(value) {
  const title = String(value || "").trim();
  if (!title) {
    throw boardError("A topic title is required.");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw boardError(`A topic title cannot exceed ${MAX_TITLE_LENGTH} characters.`);
  }
  return title;
}

function normalizeBody(value, limit, label) {
  const body = String(value || "").trim();
  if (!body) {
    throw boardError(`A ${label} body is required.`);
  }
  if (body.length > limit) {
    throw boardError(`A ${label} body cannot exceed ${limit} characters.`);
  }
  return body;
}

function normalizeAuthor(input = {}) {
  return {
    authorClientId: String(input.clientId || "").trim().slice(0, 120),
    authorName: String(input.name || "").trim().slice(0, 80)
  };
}

function normalizeQuote(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!raw) {
    return null;
  }
  const excerpt = String(raw.excerpt || "").trim().slice(0, MAX_QUOTE_LENGTH);
  if (!excerpt) {
    return null;
  }
  return {
    authorName: String(raw.authorName || "").trim().slice(0, 80),
    excerpt
  };
}

function normalizeStoredReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }
  const createdAt = String(reply.createdAt || new Date().toISOString());
  return {
    id: String(reply.id || `rep_${crypto.randomBytes(6).toString("hex")}`),
    body: String(reply.body || "").slice(0, MAX_REPLY_LENGTH),
    authorClientId: String(reply.authorClientId || "").slice(0, 120),
    authorName: String(reply.authorName || "").slice(0, 80),
    quote: normalizeQuote(reply.quote),
    createdAt
  };
}

function normalizeStoredTopic(topic) {
  if (!topic || typeof topic !== "object") {
    return null;
  }
  const createdAt = String(topic.createdAt || new Date().toISOString());
  return {
    id: String(topic.id || `topic_${crypto.randomBytes(6).toString("hex")}`),
    title: String(topic.title || "").slice(0, MAX_TITLE_LENGTH),
    body: String(topic.body || "").slice(0, MAX_BODY_LENGTH),
    authorClientId: String(topic.authorClientId || "").slice(0, 120),
    authorName: String(topic.authorName || "").slice(0, 80),
    createdAt,
    updatedAt: String(topic.updatedAt || createdAt),
    pinned: topic.pinned === true,
    replies: Array.isArray(topic.replies)
      ? topic.replies.map((reply) => normalizeStoredReply(reply)).filter(Boolean).slice(-MAX_REPLIES_PER_TOPIC)
      : []
  };
}

// Board snapshots can predate a user setting a display name; resolve at read
// time so views never fall back to a raw client id.
function withResolvedNames(topic) {
  if (!topic) {
    return topic;
  }
  return {
    ...topic,
    authorName: resolveContributorName(topic.authorClientId, topic.authorName),
    replies: (Array.isArray(topic.replies) ? topic.replies : []).map((reply) => ({
      ...reply,
      authorName: resolveContributorName(reply.authorClientId, reply.authorName)
    }))
  };
}

function summarizeTopic(topic) {
  return {
    id: topic.id,
    title: topic.title,
    authorName: resolveContributorName(topic.authorClientId, topic.authorName),
    authorClientId: topic.authorClientId,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    pinned: topic.pinned === true,
    replyCount: topic.replies.length
  };
}

function listTopics(options = {}) {
  return readBoard(options)
    .map((topic) => normalizeStoredTopic(topic))
    .filter(Boolean)
    .map(summarizeTopic)
    .sort((left, right) => (
      (Number(right.pinned) - Number(left.pinned))
      || String(right.updatedAt).localeCompare(String(left.updatedAt))
    ));
}

function getTopic(topicId, options = {}) {
  const wanted = String(topicId || "").trim();
  const topic = readBoard(options)
    .map((entry) => normalizeStoredTopic(entry))
    .filter(Boolean)
    .find((entry) => entry.id === wanted) || null;
  return withResolvedNames(topic);
}

function findTopicIndex(topics, topicId) {
  const wanted = String(topicId || "").trim();
  return topics.findIndex((topic) => String(topic?.id || "") === wanted);
}

function createTopic(input, author = {}, options = {}) {
  const topics = readBoard(options);
  if (topics.length >= MAX_TOPICS) {
    throw boardError(`The board can hold at most ${MAX_TOPICS} topics.`);
  }
  const nowIso = new Date().toISOString();
  const topic = {
    id: `topic_${crypto.randomBytes(6).toString("hex")}`,
    title: normalizeTitle(input?.title),
    body: normalizeBody(input?.body, MAX_BODY_LENGTH, "topic"),
    ...normalizeAuthor(author),
    createdAt: nowIso,
    updatedAt: nowIso,
    replies: []
  };
  topics.push(topic);
  writeBoard(topics.slice(-MAX_TOPICS), options);
  return normalizeStoredTopic(topic);
}

function addReply(topicId, input, author = {}, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  const topic = normalizeStoredTopic(topics[index]);
  const nowIso = new Date().toISOString();
  topic.replies.push({
    id: `rep_${crypto.randomBytes(6).toString("hex")}`,
    body: normalizeBody(input?.body, MAX_REPLY_LENGTH, "reply"),
    quote: normalizeQuote(input?.quote),
    ...normalizeAuthor(author),
    createdAt: nowIso
  });
  topic.replies = topic.replies.slice(-MAX_REPLIES_PER_TOPIC);
  topic.updatedAt = nowIso;
  topics[index] = topic;
  writeBoard(topics, options);
  return topic;
}

function updateTopic(topicId, input = {}, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  const topic = normalizeStoredTopic(topics[index]);
  if (input && input.title !== undefined) {
    topic.title = normalizeTitle(input.title);
  }
  if (input && input.body !== undefined) {
    topic.body = normalizeBody(input.body, MAX_BODY_LENGTH, "topic");
  }
  topic.updatedAt = new Date().toISOString();
  topics[index] = topic;
  writeBoard(topics, options);
  return topic;
}

function updateReply(topicId, replyId, input = {}, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  const topic = normalizeStoredTopic(topics[index]);
  const reply = topic.replies.find((entry) => entry.id === String(replyId || "").trim());
  if (!reply) {
    const error = new Error(`Reply '${replyId}' was not found.`);
    error.code = "reply_not_found";
    throw error;
  }
  reply.body = normalizeBody(input?.body, MAX_REPLY_LENGTH, "reply");
  topic.updatedAt = new Date().toISOString();
  topics[index] = topic;
  writeBoard(topics, options);
  return topic;
}

// Pinning is an admin action (enforced by the route layer).
function setPinned(topicId, pinned, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  const topic = normalizeStoredTopic(topics[index]);
  topic.pinned = pinned === true;
  topics[index] = topic;
  writeBoard(topics, options);
  return topic;
}

// Board snapshots store the display name at post time; for accounts that never
// set one, fall back to their public username so a raw cli_* id is never shown.
function resolveContributorName(clientId, storedName = "") {
  const id = String(clientId || "").trim();
  const stored = String(storedName || "").trim();
  if (stored && !stored.startsWith("cli_") && stored !== id) {
    return stored;
  }
  if (id) {
    try {
      const displayName = String(require("./profile-service").readProfile(id)?.displayName || "").trim();
      if (displayName) {
        return displayName;
      }
    } catch (_error) {}
    try {
      const account = require("./account-service").findAccountByClientId(id);
      const username = String(account?.username || "").trim();
      if (username) {
        return `@${username}`;
      }
    } catch (_error) {}
  }
  return stored || id;
}

// Top posters by topics + replies, derived from the board itself.
function getContributors(options = {}) {
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 10;
  const counts = new Map();

  const record = (clientId, name, topicsDelta, repliesDelta) => {
    const key = String(clientId || "").trim() || `name:${String(name || "").trim().toLowerCase()}`;
    if (!key) {
      return;
    }
    const entry = counts.get(key) || {
      clientId: String(clientId || ""),
      name: String(name || "").trim(),
      topics: 0,
      replies: 0,
      posts: 0
    };
    entry.topics += topicsDelta;
    entry.replies += repliesDelta;
    entry.posts += topicsDelta + repliesDelta;
    if (!entry.name && name) {
      entry.name = String(name).trim();
    }
    counts.set(key, entry);
  };

  readBoard(options)
    .map((topic) => normalizeStoredTopic(topic))
    .filter(Boolean)
    .forEach((topic) => {
      record(topic.authorClientId, topic.authorName, 1, 0);
      topic.replies.forEach((reply) => record(reply.authorClientId, reply.authorName, 0, 1));
    });

  return [...counts.values()]
    .map((entry) => ({ ...entry, name: resolveContributorName(entry.clientId, entry.name) }))
    .sort((left, right) => (right.posts - left.posts) || String(left.name).localeCompare(String(right.name)))
    .slice(0, limit);
}

function deleteTopic(topicId, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  topics.splice(index, 1);
  writeBoard(topics, options);
  return { removed: true };
}

function deleteReply(topicId, replyId, options = {}) {
  const topics = readBoard(options);
  const index = findTopicIndex(topics, topicId);
  if (index === -1) {
    const error = new Error(`Topic '${topicId}' was not found.`);
    error.code = "topic_not_found";
    throw error;
  }
  const topic = normalizeStoredTopic(topics[index]);
  const replyIndex = topic.replies.findIndex((reply) => reply.id === String(replyId || "").trim());
  if (replyIndex === -1) {
    const error = new Error(`Reply '${replyId}' was not found.`);
    error.code = "reply_not_found";
    throw error;
  }
  topic.replies.splice(replyIndex, 1);
  topics[index] = topic;
  writeBoard(topics, options);
  return { removed: true };
}

module.exports = {
  addReply,
  createTopic,
  deleteReply,
  deleteTopic,
  getContributors,
  getTopic,
  listTopics,
  setPinned,
  updateReply,
  updateTopic
};
