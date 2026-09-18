const crypto = require("node:crypto");

const { SHARE_SIGNED_PREFIX } = require("../config/profile-storage");

// Generic share surface: any plugin can hand a user a public link that renders a
// clean, mobile-friendly page for a message and/or its files. Two token kinds:
//   lk1.<clientId>.<random>   stored link (profile.links)
//   s1.<payload>.<hmac>       stateless signed reference (e.g. a calendar file)

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function base64UrlEncode(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), "base64url").toString("utf8");
}

function signPayload(encodedPayload, secret) {
  return crypto.createHmac("sha256", String(secret)).update(encodedPayload).digest("base64url");
}

function buildSignedShareToken(payload, secret) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${SHARE_SIGNED_PREFIX}.${encoded}.${signPayload(encoded, secret)}`;
}

function verifySignedShareToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== SHARE_SIGNED_PREFIX) {
    return null;
  }
  const expected = signPayload(parts[1], secret);
  const provided = parts[2];
  if (expected.length !== provided.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(parts[1]));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Shared preamble for the signed `s1.` share tokens: decode the payload, load
// the owning profile and verify the signature. Callers supply profile access
// because profile-service owns storage; `expectType` narrows to one token kind.
function resolveSignedShareTokenContext(token, { expectType = "", loadProfile, resolveSecret } = {}) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== SHARE_SIGNED_PREFIX) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
  if (expectType && String(payload?.t || "") !== expectType) {
    return null;
  }
  const clientId = String(payload?.c || "").trim();
  if (!clientId) {
    return null;
  }
  let profile;
  try {
    profile = loadProfile(clientId);
  } catch {
    return null;
  }
  const secret = resolveSecret(profile);
  if (!secret) {
    return null;
  }
  const verified = verifySignedShareToken(raw, secret);
  if (!verified || (expectType && verified.t !== expectType)) {
    return null;
  }
  return { raw, payload, clientId, profile, secret, verified };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function shareStyles() {
  return [
    ":root{color-scheme:dark}",
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;padding:24px 16px;background:#0f0f14;color:#f4f4f5;",
    "font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".card{max-width:720px;margin:0 auto;background:#18181b;border:1px solid #3f3f46;border-radius:16px;padding:24px}",
    ".brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a1a1aa}",
    ".kind{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:999px;background:rgba(99,102,241,.18);",
    "color:#c7d2fe;font-size:11px;letter-spacing:.06em;text-transform:uppercase}",
    "h1{margin:12px 0 6px;font-size:24px;line-height:1.25;color:#fff;overflow-wrap:anywhere}",
    ".meta{margin:2px 0;font-size:13px;color:#a1a1aa}",
    ".body{margin-top:18px;color:#e4e4e7}",
    ".body p{margin:0 0 12px}",
    ".blocks{margin-top:18px;color:#e4e4e7}",
    ".block{margin:0 0 14px}",
    ".block:last-child{margin-bottom:0}",
    ".block p{margin:0 0 12px}",
    ".items{margin-top:20px;display:flex;flex-direction:column;gap:14px}",
    "figure{margin:0}",
    "img{max-width:100%;height:auto;border-radius:12px;border:1px solid #3f3f46;background:#111118;display:block}",
    ".html-body{display:block;width:100%;min-height:520px;border:1px solid #3f3f46;border-radius:12px;background:#fff}",
    "figcaption{margin-top:8px;font-size:13px;color:#a1a1aa;display:flex;gap:10px;flex-wrap:wrap;align-items:center}",
    "a{color:#a5b4fc}",
    ".file{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;",
    "border:1px solid #3f3f46;background:#111118;text-decoration:none;color:#e4e4e7}",
    ".file span:last-child{color:#a1a1aa;font-size:13px;flex:0 0 auto}",
    "footer{margin-top:22px;padding-top:14px;border-top:1px solid #27272a;font-size:12px;color:#71717a}",
    ".download{font-size:12px}"
  ].join("");
}

// Only injected when a post supplies an aside, so link/message/broadcast pages
// keep their exact single-column stylesheet.
function postLayoutStyles() {
  return [
    ".post-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(200px,280px);",
    "gap:22px;align-items:start}",
    ".post-column{min-width:0}",
    ".rail{border:1px solid #3f3f46;border-radius:12px;background:#111118;padding:14px;min-width:0}",
    ".rail-title{margin:0 0 12px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a1a1aa;",
    "display:flex;justify-content:space-between;gap:8px;align-items:center}",
    ".rail-count{font-size:11px;letter-spacing:.04em;color:#71717a}",
    ".rail-items{display:flex;flex-direction:column;gap:14px}",
    ".rail-item{padding-top:14px;border-top:1px solid #27272a}",
    ".rail-item:first-child{padding-top:0;border-top:0}",
    ".rail-item-body{color:#f4f4f5;font-size:15px;line-height:1.5;overflow-wrap:anywhere}",
    ".rail-item-body p{margin:0 0 10px}",
    ".rail-item-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:8px;font-size:12px;line-height:1.35}",
    ".rail-item-title{color:#a1a1aa;overflow-wrap:anywhere}",
    ".rail-item-mark{color:#71717a;letter-spacing:.04em}",
    ".evidence-marker{display:flex;gap:8px;align-items:baseline;padding:8px 12px;border:1px solid #3f3f46;",
    "border-radius:10px;background:#111118;font-size:13px}",
    ".evidence-marker-label{flex:0 0 auto;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#71717a}",
    ".evidence-marker a{color:#c7d2fe;text-decoration:none}",
    ".evidence-marker a:hover{text-decoration:underline}",
    "@media (max-width:640px){.post-layout{grid-template-columns:1fr;gap:18px}}"
  ].join("");
}

function renderShareBody({ title, description, bodyHtml, inlineBody }) {
  if (bodyHtml) {
    if (inlineBody) {
      // Callers using inline bodies (profile posts) guarantee sanitized HTML.
      return `<section class="body">${bodyHtml}</section>`;
    }
    // HTML bodies render inside a script-less sandbox so newsletter markup can
    // never touch the surrounding page.
    return `<section class="body"><iframe class="html-body" sandbox="" title="${title}" srcdoc="${escapeHtml(bodyHtml)}"></iframe></section>`;
  }
  return description ? `<section class="body">${renderParagraphs(description)}</section>` : "";
}

function renderShareCard({
  title,
  description,
  kind,
  metaLines = [],
  items = [],
  ogImageUrl = "",
  bodyHtml = "",
  blocksHtml = "",
  inlineBody = false,
  asideHtml = "",
  railTitle = "Evidence",
  railCount = 0
}) {
  const safeTitle = escapeHtml(title || "Shared item");
  const safeKind = kind ? `<div class="kind">${escapeHtml(kind)}</div>` : "";
  const meta = metaLines
    .filter(Boolean)
    .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
    .join("");
  const body = renderShareBody({ title: safeTitle, description, bodyHtml, inlineBody });
  const blocks = blocksHtml ? `<section class="blocks">${blocksHtml}</section>` : "";
  const itemsHtml = items
    .map((item) => {
      const name = escapeHtml(item.name || "file");
      const size = formatBytes(item.size);
      if (item.isImage && item.url) {
        return `<figure><img src="${escapeHtml(item.url)}" alt="${name}" loading="lazy">`
          + `<figcaption><span>${name}${size ? ` · ${size}` : ""}</span>`
          + `<a class="download" href="${escapeHtml(item.url)}" download>Download</a></figcaption></figure>`;
      }
      return `<a class="file" href="${escapeHtml(item.url || "#")}" download>`
        + `<span>${name}</span><span>${size || "Download"}</span></a>`;
    })
    .join("");
  const itemsSection = itemsHtml ? `<section class="items">${itemsHtml}</section>` : "";
  const header = `${safeKind}<h1>${safeTitle}</h1>${meta}`;
  const content = `${body}${blocks}${itemsSection}`;
  const rail = asideHtml
    ? `<aside class="rail"><h2 class="rail-title"><span>${escapeHtml(railTitle)}</span>`
      + `<span class="rail-count">${escapeHtml(String(railCount))}</span></h2>`
      + `<div class="rail-items">${asideHtml}</div></aside>`
    : "";
  const cardContent = asideHtml
    ? `<div class="post-layout"><div class="post-column">${header}${content}</div>${rail}</div>`
    : `${header}${content}`;
  const ogImage = ogImageUrl
    ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">`
    : "";
  const descriptionMeta = description
    ? `<meta property="og:description" content="${escapeHtml(String(description).slice(0, 200))}">`
    : "";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${safeTitle} · KABBAK</title>`,
    '<meta property="og:title" content="' + safeTitle + '">',
    '<meta property="og:type" content="article">',
    ogImage,
    descriptionMeta,
    `<style>${shareStyles()}${asideHtml ? postLayoutStyles() : ""}</style>`,
    "</head>",
    "<body>",
    '<main class="card">',
    '<div class="brand">KABBAK</div>',
    cardContent,
    "<footer>Shared from KABBAK</footer>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function renderSharePage(params = {}) {
  return renderShareCard(params);
}

// Profile posts/theories render their already-sanitized HTML inline (not in an
// iframe) with an optional block list below the body and an optional evidence
// rail beside the post column.
function renderPostPage({
  title,
  kind,
  author,
  dateLine,
  bodyHtml,
  blocksHtml,
  items,
  ogImageUrl,
  asideHtml,
  railTitle,
  railCount
}) {
  return renderShareCard({
    title,
    kind,
    metaLines: [author ? `By ${author}` : "", dateLine || ""],
    items,
    ogImageUrl,
    bodyHtml,
    blocksHtml,
    inlineBody: true,
    asideHtml,
    railTitle,
    railCount
  });
}

function renderShareErrorPage({ title = "Not available", message = "This link is unavailable or has expired." } = {}) {
  const safeTitle = escapeHtml(title);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${safeTitle} · KABBAK</title>`,
    `<style>${shareStyles()}</style>`,
    "</head>",
    "<body>",
    '<main class="card">',
    '<div class="brand">KABBAK</div>',
    `<h1>${safeTitle}</h1>`,
    `<section class="body"><p>${escapeHtml(message)}</p></section>`,
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

module.exports = {
  buildSignedShareToken,
  escapeHtml,
  renderPostPage,
  renderShareErrorPage,
  renderSharePage,
  resolveSignedShareTokenContext,
  verifySignedShareToken
};
