"use strict";

// Conservative sanitiser for message/newsletter HTML bodies. It is defence in
// depth only: rendered HTML must also live inside a sandboxed iframe, so even a
// bypass cannot execute script or reach the app.
const MAX_HTML_LENGTH = 100_000;
const DANGEROUS_TAGS = "script|iframe|object|embed|link|meta|base|form|input|textarea|select|button";

function sanitizeMessageHtml(value) {
  let html = String(value == null ? "" : value);
  if (!html) {
    return "";
  }
  if (html.length > MAX_HTML_LENGTH) {
    html = html.slice(0, MAX_HTML_LENGTH);
  }
  const paired = new RegExp(`<\\s*(${DANGEROUS_TAGS})\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi");
  const selfClosing = new RegExp(`<\\s*(${DANGEROUS_TAGS})\\b[^>]*\\/?>`, "gi");
  return html
    .replace(paired, "")
    .replace(selfClosing, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

module.exports = {
  MAX_HTML_LENGTH,
  sanitizeMessageHtml
};
