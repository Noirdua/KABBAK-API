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

function renderSharePage({ title, description, kind, metaLines = [], items = [], ogImageUrl = "", bodyHtml = "" }) {
  const safeTitle = escapeHtml(title || "Shared item");
  const safeKind = kind ? `<div class="kind">${escapeHtml(kind)}</div>` : "";
  const meta = metaLines
    .filter(Boolean)
    .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
    .join("");
  // HTML bodies render inside a script-less sandbox so newsletter markup can
  // never touch the surrounding page.
  const body = bodyHtml
    ? `<section class="body"><iframe class="html-body" sandbox="" title="${safeTitle}" srcdoc="${escapeHtml(bodyHtml)}"></iframe></section>`
    : (description ? `<section class="body">${renderParagraphs(description)}</section>` : "");
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
    `<style>${shareStyles()}</style>`,
    "</head>",
    "<body>",
    '<main class="card">',
    '<div class="brand">KABBAK</div>',
    safeKind,
    `<h1>${safeTitle}</h1>`,
    meta,
    body,
    itemsSection,
    "<footer>Shared from KABBAK</footer>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
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
  renderShareErrorPage,
  renderSharePage,
  verifySignedShareToken
};
