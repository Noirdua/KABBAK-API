const {
  getProfileInboxReadMap,
  markProfileInboxRead,
  readProfile
} = require("./profile-service");
const { listBroadcasts, recordBroadcastRead } = require("./message-store");

// The inbox is a read-only view over two sources: server-wide broadcasts and
// per-profile messages (direct sends, plugin reports). Read state is per profile.

function inboxKey(scope, id) {
  return `${scope}:${id}`;
}

function summarizeInboxItem(item) {
  return {
    id: item.id,
    scope: item.scope,
    kind: item.kind,
    title: item.title,
    description: item.description,
    sender: item.sender || "",
    visibility: item.visibility === "public" ? "public" : "internal",
    hasHtml: Boolean(item.bodyHtml),
    attachmentCount: Array.isArray(item.attachments) ? item.attachments.length : 0,
    attachments: Array.isArray(item.attachments)
      ? item.attachments.map((att) => ({ id: att.id, name: att.name, type: att.type, size: att.size }))
      : [],
    token: item.token,
    createdAt: item.createdAt,
    publishAt: item.publishAt || "",
    expiresAt: item.expiresAt || "",
    requiresAck: item.requiresAck === true,
    read: Boolean(item.read)
  };
}

function isExpired(item, nowMs) {
  const expiresAt = String(item?.expiresAt || "").trim();
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function isScheduled(item, nowMs) {
  const publishAt = String(item?.publishAt || "").trim();
  if (!publishAt) {
    return false;
  }
  const parsed = Date.parse(publishAt);
  return Number.isFinite(parsed) && parsed > nowMs;
}

// Quiet hours hold unread alerts out of the inbox so nothing "pings" overnight.
function isQuietNow(quietHours, now) {
  if (!quietHours?.enabled) {
    return false;
  }
  const start = String(quietHours.start || "");
  const end = String(quietHours.end || "");
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    return false;
  }
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === endMinutes) {
    return false;
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return startMinutes < endMinutes
    ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
    : (nowMinutes >= startMinutes || nowMinutes < endMinutes);
}

function getInbox(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  const readMap = getProfileInboxReadMap(clientId, options);
  const nowMs = Date.now();

  const broadcasts = listBroadcasts({ filePath: options.broadcastsFilePath })
    .map((message) => ({ ...message, scope: "broadcast" }));
  const direct = (profile.messages || []).map((message) => ({ ...message, scope: "direct" }));

  const kindFilter = String(options.kind || "").trim().toLowerCase();
  const scopeFilter = String(options.scope || "").trim().toLowerCase();
  const quietNow = isQuietNow(profile.quietHours, new Date(nowMs));

  const visible = broadcasts
    .concat(direct)
    .filter((item) => !isExpired(item, nowMs))
    .filter((item) => !isScheduled(item, nowMs))
    .map((item) => summarizeInboxItem({ ...item, read: Boolean(readMap[inboxKey(item.scope, item.id)]) }))
    .filter((item) => !(quietNow && item.kind === "alert" && !item.read))
    .filter((item) => !kindFilter || String(item.kind || "").toLowerCase() === kindFilter)
    .filter((item) => !scopeFilter || item.scope === scopeFilter)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const listed = options.unreadOnly === true ? visible.filter((item) => !item.read) : visible;
  return {
    items: listed,
    total: listed.length,
    unreadCount: visible.filter((item) => !item.read).length
  };
}

function markInboxRead(clientId, scope, messageId, options = {}) {
  const normalizedScope = String(scope || "").trim().toLowerCase();
  if (normalizedScope !== "broadcast" && normalizedScope !== "direct") {
    const error = new Error("Inbox scope must be 'broadcast' or 'direct'.");
    error.code = "invalid_scope";
    throw error;
  }
  const normalizedId = String(messageId || "").trim();
  if (!normalizedId) {
    const error = new Error("A message id is required.");
    error.code = "invalid_scope";
    throw error;
  }
  const result = markProfileInboxRead(clientId, inboxKey(normalizedScope, normalizedId), options);
  if (normalizedScope === "broadcast") {
    try {
      recordBroadcastRead(normalizedId, clientId, { filePath: options.broadcastsFilePath });
    } catch (_error) {
      // Receipts are best-effort; read state is the source of truth.
    }
  }
  return result;
}

// "Mark all read" skips messages that require acknowledgement; those must be
// opened individually.
function markAllInboxRead(clientId, options = {}) {
  const { items } = getInbox(clientId, options);
  const markable = items.filter((item) => !item.requiresAck);
  const result = markProfileInboxRead(clientId, markable.map((item) => inboxKey(item.scope, item.id)), options);
  for (const item of markable) {
    if (item.scope !== "broadcast") {
      continue;
    }
    try {
      recordBroadcastRead(item.id, clientId, { filePath: options.broadcastsFilePath });
    } catch (_error) {
      // best-effort
    }
  }
  return result;
}

function findInboxMessage(clientId, scope, messageId, options = {}) {
  const normalizedScope = String(scope || "").trim().toLowerCase();
  const normalizedId = String(messageId || "").trim();
  if (!normalizedId) {
    return null;
  }
  if (normalizedScope === "broadcast") {
    return listBroadcasts({ filePath: options.broadcastsFilePath })
      .find((entry) => entry.id === normalizedId) || null;
  }
  if (normalizedScope === "direct") {
    const profile = readProfile(clientId, options);
    return (profile.messages || []).find((entry) => entry.id === normalizedId) || null;
  }
  return null;
}

// Full message for the authenticated viewer, including the HTML body (which is
// intentionally kept out of the list payload).
function getInboxMessage(clientId, scope, messageId, options = {}) {
  const normalizedScope = String(scope || "").trim().toLowerCase();
  if (normalizedScope !== "broadcast" && normalizedScope !== "direct") {
    const error = new Error("Inbox scope must be 'broadcast' or 'direct'.");
    error.code = "invalid_scope";
    throw error;
  }
  const message = findInboxMessage(clientId, normalizedScope, messageId, options);
  if (!message) {
    return null;
  }
  const readMap = getProfileInboxReadMap(clientId, options);
  const item = summarizeInboxItem({
    ...message,
    scope: normalizedScope,
    read: Boolean(readMap[inboxKey(normalizedScope, message.id)])
  });
  return {
    ...item,
    description: String(message.description || ""),
    bodyHtml: String(message.bodyHtml || "")
  };
}

// Authenticated access to one inbox message's attachment (works for internal
// messages, which the public share route refuses to serve).
function getInboxMessageAttachment(clientId, scope, messageId, attachmentId, options = {}) {
  const normalizedAttachmentId = String(attachmentId || "").trim();
  if (!normalizedAttachmentId) {
    return null;
  }
  const message = findInboxMessage(clientId, scope, messageId, options);
  if (!message) {
    return null;
  }
  return (message.attachments || []).find((entry) => entry.id === normalizedAttachmentId) || null;
}

module.exports = {
  getInbox,
  getInboxMessage,
  getInboxMessageAttachment,
  markAllInboxRead,
  markInboxRead
};
