"use strict";

// Allowlist sanitiser for message and post HTML. Regex stripping is not enough:
// `<svg/onload=…>`, unquoted `javascript:`, and entity-encoded schemes all have
// to be rejected before the GUI assigns the result with innerHTML.
const MAX_HTML_LENGTH = 100_000;
const DANGEROUS_TAGS = "script|iframe|object|embed|link|meta|base|form|input|textarea|select|button|svg|math|style|video|audio|source|img|picture|canvas|noscript|template|frame|frameset|applet";
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "strike", "u", "ul"
]);

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");
}

function isSafeUrl(value) {
  const decoded = decodeEntities(value).replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (!decoded || decoded.startsWith("#") || decoded.startsWith("/") || decoded.startsWith("./") || decoded.startsWith("../")) {
    return true;
  }
  if (decoded.startsWith("mailto:")) {
    return !decoded.includes("javascript");
  }
  return decoded.startsWith("https:") || decoded.startsWith("http:");
}

function sanitizeOpenTag(name, raw) {
  const attrs = [];
  const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  if (name === "a" && href) {
    const url = href[1] ?? href[2] ?? href[3] ?? "";
    attrs.push(isSafeUrl(url) ? `href="${url.replace(/"/g, "%22")}"` : 'href="#"');
  }
  const color = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  if (color) {
    const value = color[1] ?? color[2] ?? color[3] ?? "";
    const match = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,8}|[a-z]{3,20})\s*(?:;|$)/i.exec(value);
    if (match) attrs.push(`style="color:${match[1]}"`);
  }
  const fontColor = /\scolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  if (name === "font" && fontColor) {
    const value = fontColor[1] ?? fontColor[2] ?? fontColor[3] ?? "";
    if (/^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]{3,20}$/i.test(value)) {
      attrs.push(`color="${value}"`);
    }
  }
  const tail = name === "br" || name === "hr" ? " /" : "";
  return `<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}${tail}>`;
}

function sanitizeMessageHtml(value) {
  let html = String(value == null ? "" : value);
  if (!html) {
    return "";
  }
  if (html.length > MAX_HTML_LENGTH) {
    html = html.slice(0, MAX_HTML_LENGTH);
  }
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  const paired = new RegExp(`<\\s*(${DANGEROUS_TAGS})\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi");
  const orphan = new RegExp(`<\\s*/?\\s*(${DANGEROUS_TAGS})\\b[^>]*>`, "gi");
  html = html.replace(paired, "").replace(orphan, "");
  html = html.replace(/[\s/]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/<\/?([a-z0-9:-]+)([^>]*)>/gi, (full, name) => {
    const tag = String(name || "").toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return "";
    }
    if (full.startsWith("</")) {
      return `</${tag}>`;
    }
    return sanitizeOpenTag(tag, full);
  });
  return html;
}

module.exports = {
  MAX_HTML_LENGTH,
  sanitizeMessageHtml
};
