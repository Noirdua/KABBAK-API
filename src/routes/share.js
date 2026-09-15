const rateLimit = require("express-rate-limit");

const { createApiRouter } = require("../lib/create-api-router");
const {
  buildSharePath,
  decodeAttachmentPayload,
  resolveDirectMessageToken,
  resolveProfileLinkToken,
  resolveSignedShareAttachment
} = require("../services/profile-service");
const { resolveBroadcastToken } = require("../services/message-store");
const { renderShareErrorPage, renderSharePage } = require("../services/share-service");

const router = createApiRouter();

// Public, pre-auth share surface. Token kinds:
//   lk1.…  stored profile link          s1.…  signed event/note attachment
//   bc1.…  server broadcast message     dm1.… profile inbox message
const shareRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
});

function assetUrl(token, attachmentId) {
  return `${buildSharePath(token)}/asset/${encodeURIComponent(attachmentId)}`;
}

function isImageType(type) {
  return String(type || "").startsWith("image/");
}

function setHtmlHeaders(response) {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, max-age=60");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'"
  );
}

function itemsFor(token, attachments) {
  return (attachments || []).map((att) => ({
    name: att.name,
    size: att.size,
    isImage: isImageType(att.type),
    url: assetUrl(token, att.id)
  }));
}

function renderStoredLink(token, resolved) {
  const link = resolved.link;
  const items = itemsFor(token, link.attachments);
  return renderSharePage({
    title: link.title,
    description: link.description,
    kind: link.kind,
    metaLines: [items.length ? `${items.length} file${items.length === 1 ? "" : "s"}` : ""],
    items,
    ogImageUrl: (items.find((item) => item.isImage) || {}).url || "",
    bodyHtml: link.bodyHtml || ""
  });
}

function renderSignedAttachment(token, resolved) {
  const attachment = resolved.attachment;
  const item = {
    name: attachment.name,
    size: attachment.size,
    isImage: isImageType(attachment.type),
    url: assetUrl(token, attachment.id)
  };
  return renderSharePage({
    title: resolved.title,
    description: "",
    kind: resolved.kind,
    metaLines: resolved.metaLines,
    items: [item],
    ogImageUrl: item.isImage ? item.url : ""
  });
}

function renderMessage(token, message, label) {
  const items = itemsFor(token, message.attachments);
  return renderSharePage({
    title: message.title,
    description: message.description,
    kind: label || message.kind,
    metaLines: [message.sender ? `From ${message.sender}` : ""],
    items,
    ogImageUrl: (items.find((item) => item.isImage) || {}).url || "",
    bodyHtml: message.bodyHtml || ""
  });
}

function resolveAttachmentForToken(token, attachmentId) {
  // Internal content is auth-only; the public route must not serve it.
  const stored = resolveProfileLinkToken(token);
  if (stored && stored.link.visibility === "public") {
    return (stored.link.attachments || []).find((entry) => entry.id === attachmentId) || null;
  }
  const signed = resolveSignedShareAttachment(token);
  if (signed && signed.attachment.id === attachmentId) {
    return signed.attachment;
  }
  const broadcast = resolveBroadcastToken(token);
  if (broadcast && broadcast.message.visibility === "public") {
    return (broadcast.message.attachments || []).find((entry) => entry.id === attachmentId) || null;
  }
  const direct = resolveDirectMessageToken(token);
  if (direct && direct.message.visibility === "public") {
    return (direct.message.attachments || []).find((entry) => entry.id === attachmentId) || null;
  }
  return null;
}

router.get("/share/:token", shareRateLimiter, (request, response) => {
  const token = String(request.params.token || "").trim();

  const stored = resolveProfileLinkToken(token);
  if (stored && stored.link.visibility === "public") {
    setHtmlHeaders(response);
    response.send(renderStoredLink(token, stored));
    return;
  }

  const signed = resolveSignedShareAttachment(token);
  if (signed) {
    setHtmlHeaders(response);
    response.send(renderSignedAttachment(token, signed));
    return;
  }

  const broadcast = resolveBroadcastToken(token);
  if (broadcast && broadcast.message.visibility === "public") {
    setHtmlHeaders(response);
    response.send(renderMessage(token, broadcast.message, "Announcement"));
    return;
  }

  const direct = resolveDirectMessageToken(token);
  if (direct && direct.message.visibility === "public") {
    setHtmlHeaders(response);
    response.send(renderMessage(token, direct.message, "Message"));
    return;
  }

  response.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.send(renderShareErrorPage({}));
});

router.get("/share/:token/asset/:attachmentId", shareRateLimiter, (request, response) => {
  const token = String(request.params.token || "").trim();
  const attachmentId = String(request.params.attachmentId || "").trim();
  const attachment = resolveAttachmentForToken(token, attachmentId);

  if (!attachment || !attachment.data) {
    response.status(404).type("text/plain").send("Not found.");
    return;
  }

  const { type, buffer } = decodeAttachmentPayload(attachment);
  response.setHeader("Content-Type", type || "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(attachment.name || "attachment")}"`
  );
  response.setHeader("Cache-Control", "private, max-age=300");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.send(buffer);
});

module.exports = router;
