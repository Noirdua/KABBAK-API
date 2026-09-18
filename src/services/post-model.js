"use strict";

const crypto = require("node:crypto");

const {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_POST_COMMENT_LENGTH,
  MAX_POST_ATTACHMENTS,
  MAX_POST_TEXT_LENGTH,
  MAX_POST_BODY_LENGTH,
  MAX_POST_COMMENTS,
  MAX_POST_ITEMS,
  MAX_POST_ENTRIES,
  MAX_POSTS_PER_PROFILE
} = require("../config/profile-storage");
const { sanitizeMessageHtml } = require("../lib/html-sanitize");

const NOTE_KINDS = new Set(["dream", "waking"]);

function dateFromIso(iso) {
  const parsed = new Date(String(iso || ""));
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function isValidOccurredOn(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.getUTCFullYear() === year
    && utcDate.getUTCMonth() === month - 1
    && utcDate.getUTCDate() === day;
}

function normalizeStoredKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return NOTE_KINDS.has(normalized) ? normalized : "waking";
}

function normalizeStoredOccurredOn(value, fallbackIso) {
  const raw = String(value || "").trim();
  if (isValidOccurredOn(raw)) {
    return raw;
  }
  return dateFromIso(fallbackIso);
}

function resolveAttachmentBytesLimit(options = {}) {
  const numericValue = Number(options.maxAttachmentBytes);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return MAX_ATTACHMENT_SIZE_BYTES;
}

function normalizeStoredAttachment(att, options = {}) {
  if (!att || typeof att !== "object") return null;
  const name = String(att.name || "attachment").trim().slice(0, 255);
  const type = String(att.type || "application/octet-stream").trim();
  let data = "";
  if (typeof att.data === "string") {
    data = att.data;
  }
  const maxBytes = resolveAttachmentBytesLimit(options);
  const size = Math.max(0, Number(att.size) || (data.length * 0.75)); // rough for base64
  if (size > maxBytes) {
    // drop too large instead of crashing load
    return null;
  }
  return {
    id: String(att.id || `att_${crypto.randomBytes(6).toString("hex")}`),
    name,
    type,
    size: Math.min(size, maxBytes),
    data
  };
}

function normalizeStoredPostComment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const clientId = String(value.clientId || "").trim().slice(0, 120);
  const text = String(value.text || "").trim().slice(0, MAX_POST_COMMENT_LENGTH);
  if (!clientId || !text) {
    return null;
  }
  return {
    id: String(value.id || `pcmt_${crypto.randomBytes(6).toString("hex")}`),
    clientId,
    name: String(value.name || "").trim().slice(0, 80),
    text,
    createdAt: String(value.createdAt || "").trim()
  };
}

// Post content is rich HTML (sanitized); attachments reuse the profile store.
function normalizePostAttachments(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => normalizeStoredAttachment(entry, {}))
    .filter(Boolean)
    .slice(0, MAX_POST_ATTACHMENTS);
}

function normalizeStoredPostItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const title = String(value.title || "").trim().slice(0, 300) || "Item";
  const body = sanitizeMessageHtml(String(value.body || "").slice(0, MAX_POST_TEXT_LENGTH));
  return {
    id: String(value.id || `pitem_${crypto.randomBytes(6).toString("hex")}`),
    markType: String(value.markType || "").trim().slice(0, 40),
    markKey: String(value.markKey || "").trim().slice(0, 300),
    title,
    body,
    attachments: normalizePostAttachments(value.attachments),
    createdAt: String(value.createdAt || "").trim()
  };
}

function hasPostItemContent(input) {
  return Boolean(
    String(input?.title || "").trim()
    || String(input?.body || "").trim()
    || String(input?.markKey || "").trim()
  );
}

// Thread entries: prose the author writes, or a reference to a piece of evidence
// collected in the post's evidence bucket.
function normalizeStoredPostEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const kind = value.kind === "evidence" ? "evidence" : "text";
  const entry = {
    id: String(value.id || `pentry_${crypto.randomBytes(6).toString("hex")}`),
    kind,
    text: sanitizeMessageHtml(String(value.text || "").slice(0, MAX_POST_TEXT_LENGTH)),
    evidenceId: String(value.evidenceId || "").trim(),
    createdAt: String(value.createdAt || "").trim()
  };
  if (kind === "evidence" && !entry.evidenceId) {
    return null;
  }
  if (kind === "text" && !entry.text) {
    return null;
  }
  return entry;
}

function normalizeStoredPost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const title = String(value.title || "").trim().slice(0, 300) || "Untitled";
  const body = sanitizeMessageHtml(String(value.body || "").slice(0, MAX_POST_BODY_LENGTH));
  const attachments = normalizePostAttachments(value.attachments);
  const comments = (Array.isArray(value.comments) ? value.comments : [])
    .map(normalizeStoredPostComment)
    .filter(Boolean)
    .slice(0, MAX_POST_COMMENTS);
  // Evidence bucket. Legacy posts stored these as `items`.
  const sourceEvidence = Array.isArray(value.evidence)
    ? value.evidence
    : (Array.isArray(value.items) ? value.items : []);
  const items = sourceEvidence
    .map(normalizeStoredPostItem)
    .filter(Boolean)
    .slice(0, MAX_POST_ITEMS);
  const evidenceIds = new Set(items.map((item) => item.id));
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .map(normalizeStoredPostEntry)
    .filter((entry) => entry && (entry.kind === "text" || evidenceIds.has(entry.evidenceId)))
    .slice(0, MAX_POST_ENTRIES);
  const noteId = String(value.noteId || "").trim();
  return {
    id: String(value.id || `post_${crypto.randomBytes(8).toString("hex")}`),
    type: noteId ? "journal" : "post",
    noteId,
    title,
    kind: normalizeStoredKind(value.kind),
    occurredOn: normalizeStoredOccurredOn(value.occurredOn, value.createdAt),
    body,
    attachments,
    evidence: items,
    entries,
    comments,
    createdAt: String(value.createdAt || "").trim(),
    updatedAt: String(value.updatedAt || "").trim()
  };
}

function normalizeStoredPosts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const posts = [];
  value.forEach((entry) => {
    const post = normalizeStoredPost(entry);
    if (!post || seen.has(post.id)) {
      return;
    }
    seen.add(post.id);
    posts.push(post);
  });
  return posts.slice(-MAX_POSTS_PER_PROFILE);
}

function noteToPlainText(note) {
  const parts = [];
  (note?.scenes || []).forEach((scene) => {
    const lines = [
      [scene.time, scene.endTime].filter(Boolean).join("–"),
      scene.place,
      scene.scenario,
      scene.steps,
      scene.thoughts,
      scene.notes
    ].map((line) => String(line || "").trim()).filter(Boolean);
    if (lines.length) {
      parts.push(lines.join("\n"));
    }
  });
  return parts.join("\n\n").trim();
}

function decodeShareEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}

function plainTextFromHtml(value) {
  return decodeShareEntities(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function presentPost(post, authorClientId, authorName, sharePath) {
  const presented = {
    id: post.id,
    type: post.type || (post.noteId ? "journal" : "post"),
    noteId: post.noteId,
    title: post.title,
    kind: post.kind,
    occurredOn: post.occurredOn,
    body: post.body,
    attachments: (post.attachments || []).map((item) => ({ ...item })),
    evidence: (post.evidence || []).map((item) => ({ ...item })),
    evidenceCount: (post.evidence || []).length,
    entries: (post.entries || []).map((entry) => ({ ...entry })),
    authorClientId,
    authorName,
    commentCount: post.comments.length,
    comments: post.comments.map((comment) => ({ ...comment })),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt
  };
  // Owner-facing payloads carry the share path; feed/directory listings omit it.
  if (sharePath !== undefined) {
    presented.sharePath = sharePath;
  }
  return presented;
}

function isImageAttachmentType(type) {
  return String(type || "").startsWith("image/");
}

function postEvidenceAnchorId(item) {
  return `evidence-${String(item?.id || "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

module.exports = {
  NOTE_KINDS,
  dateFromIso,
  decodeShareEntities,
  hasPostItemContent,
  isImageAttachmentType,
  isValidOccurredOn,
  noteToPlainText,
  normalizePostAttachments,
  normalizeStoredAttachment,
  normalizeStoredKind,
  normalizeStoredOccurredOn,
  normalizeStoredPost,
  normalizeStoredPostComment,
  normalizeStoredPostEntry,
  normalizeStoredPostItem,
  normalizeStoredPosts,
  plainTextFromHtml,
  postEvidenceAnchorId,
  presentPost,
  resolveAttachmentBytesLimit
};
