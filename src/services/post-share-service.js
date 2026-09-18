"use strict";

const { MAX_ATTACHMENT_SIZE_BYTES } = require("../config/profile-storage");
const {
  ProfileStorageError,
  buildPostShareToken,
  buildSharePath,
  readProfile,
  resolveShareSecret
} = require("./profile-service");
const {
  escapeHtml: escapeShareText,
  renderPostPage,
  resolveSignedShareTokenContext
} = require("./share-service");
const {
  isImageAttachmentType,
  normalizeStoredPost,
  normalizeStoredPosts,
  postEvidenceAnchorId
} = require("./post-model");

function resolvePostShareToken(token, options = {}) {
  const context = resolveSignedShareTokenContext(token, {
    expectType: "p",
    loadProfile: (clientId) => readProfile(clientId, options),
    resolveSecret: resolveShareSecret
  });
  if (!context) {
    return null;
  }
  const { clientId, profile, verified } = context;
  const post = normalizeStoredPosts(profile.posts).find((entry) => entry.id === String(verified.p || "")) || null;
  if (!post) {
    return null;
  }
  return { clientId, profile, post };
}

function postAssetUrl(token, assetId) {
  const raw = String(token || "").trim();
  if (!raw || !assetId) {
    return "";
  }
  return `${buildSharePath(raw)}/asset/${encodeURIComponent(assetId)}`;
}

function postAttachmentUrl(attachment, token, inlineAssets) {
  if (inlineAssets) {
    const data = String(attachment?.data || "");
    // Base64 inflates ~4/3; anything past the per-attachment budget stays out.
    return data.length > MAX_ATTACHMENT_SIZE_BYTES * 2 ? "" : data;
  }
  return postAssetUrl(token, attachment?.id);
}

function renderPostEvidenceMarker(item) {
  const title = escapeShareText(item.title || "Evidence");
  const anchor = postEvidenceAnchorId(item);
  return `<div class="block evidence-marker"><span class="evidence-marker-label">Evidence</span>`
    + `<a href="#${escapeShareText(anchor)}">${title}</a></div>`;
}

function renderPostEvidenceMeta(item, hasBody) {
  const parts = [];
  if (hasBody) {
    parts.push(`<span class="rail-item-title">${escapeShareText(item.title || "Evidence")}</span>`);
  }
  const markType = String(item.markType || "").trim();
  const markKey = String(item.markKey || "").trim();
  if (markType) {
    parts.push(`<span class="rail-item-mark">${escapeShareText(markType)}</span>`);
  }
  if (markKey) {
    parts.push(`<span class="rail-item-mark">${escapeShareText(markKey)}</span>`);
  }
  return parts.length ? `<div class="rail-item-meta">${parts.join("")}</div>` : "";
}

function renderPostEvidenceBlock(item, token, inlineAssets = false) {
  const title = escapeShareText(item.title || "Evidence");
  const anchor = postEvidenceAnchorId(item);
  const attachments = item.attachments || [];
  const image = attachments.find((attachment) => isImageAttachmentType(attachment.type)
    && postAttachmentUrl(attachment, token, inlineAssets));
  const mediaAttachment = image
    || attachments.find((attachment) => postAttachmentUrl(attachment, token, inlineAssets))
    || null;
  const url = mediaAttachment ? postAttachmentUrl(mediaAttachment, token, inlineAssets) : "";
  let media = "";
  if (url && image) {
    media = `<figure><img src="${escapeShareText(url)}" alt="${title}" loading="lazy">`
      + `<figcaption><span>${title}</span>`
      + `<a class="download" href="${escapeShareText(url)}" download>Download</a></figcaption></figure>`;
  } else if (url && mediaAttachment) {
    media = `<a class="file" href="${escapeShareText(url)}" download>`
      + `<span>${title}</span><span>Download</span></a>`;
  }
  const body = String(item.body || "").trim();
  const main = body
    ? `<div class="rail-item-body">${body}</div>`
    : `<div class="rail-item-body">${title}</div>`;
  return `<div class="rail-item" id="${escapeShareText(anchor)}">`
    + main
    + renderPostEvidenceMeta(item, Boolean(body))
    + media
    + "</div>";
}

// The post column keeps the stored entry order: prose renders in full and an
// evidence entry becomes a compact marker that links to its rail entry.
function renderPostShareBlocks(post) {
  const evidence = post.evidence || [];
  return (post.entries || [])
    .map((entry) => {
      if (entry.kind === "evidence") {
        const item = evidence.find((candidate) => candidate.id === entry.evidenceId);
        return item ? renderPostEvidenceMarker(item) : "";
      }
      return entry.text ? `<div class="block">${entry.text}</div>` : "";
    })
    .join("");
}

// The rail carries full evidence detail, unique by id in first-reference order.
// The bucket is internal: evidence with no thread entry must not render at all.
function renderPostShareRail(post, token, inlineAssets = false) {
  const evidence = post.evidence || [];
  const usedIds = new Set();
  const railItems = [];
  (post.entries || []).forEach((entry) => {
    if (entry.kind !== "evidence" || !entry.evidenceId || usedIds.has(entry.evidenceId)) {
      return;
    }
    const item = evidence.find((candidate) => candidate.id === entry.evidenceId);
    if (!item) {
      return;
    }
    usedIds.add(item.id);
    railItems.push(item);
  });
  return {
    asideHtml: railItems.map((item) => renderPostEvidenceBlock(item, token, inlineAssets)).join(""),
    railCount: railItems.length
  };
}

function renderPostShareHtml(profile, post, { token = "", inlineAssets = false } = {}) {
  const author = String(profile.displayName || "").trim() || profile.clientId;
  const items = (post.attachments || []).map((attachment) => ({
    name: attachment.name,
    size: attachment.size,
    isImage: isImageAttachmentType(attachment.type),
    url: inlineAssets ? postAttachmentUrl(attachment, token, true) : postAssetUrl(token, attachment.id)
  })).filter((item) => item.url);
  const rail = renderPostShareRail(post, token, inlineAssets);
  return renderPostPage({
    title: post.title,
    kind: String(post.kind || "").trim() || "Theory",
    author,
    dateLine: post.occurredOn || post.createdAt || "",
    bodyHtml: post.body || "",
    blocksHtml: renderPostShareBlocks(post),
    items,
    ogImageUrl: (items.find((item) => item.isImage) || {}).url || "",
    asideHtml: rail.asideHtml,
    railTitle: "Evidence",
    railCount: rail.railCount
  });
}

function previewProfilePost(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const draft = normalizeStoredPost({
    ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
    id: "post_preview"
  });
  if (!draft) {
    throw new ProfileStorageError("invalid_post", "Write something first.");
  }
  // Drafts are not persisted, so share asset URLs cannot resolve; render the
  // inline data: payloads instead to keep the preview self-contained.
  return { html: renderPostShareHtml(profile, draft, { inlineAssets: true }) };
}

function getProfilePostShare(clientId, postId, options = {}) {
  const profile = readProfile(clientId, options);
  const wanted = String(postId || "").trim();
  const post = normalizeStoredPosts(profile.posts).find((entry) => entry.id === wanted) || null;
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  const token = buildPostShareToken(profile, post);
  return {
    path: token ? buildSharePath(token) : "",
    token,
    html: renderPostShareHtml(profile, post, { token })
  };
}

module.exports = {
  getProfilePostShare,
  postAssetUrl,
  postAttachmentUrl,
  previewProfilePost,
  renderPostEvidenceBlock,
  renderPostEvidenceMarker,
  renderPostShareBlocks,
  renderPostShareHtml,
  renderPostShareRail,
  resolvePostShareToken
};
