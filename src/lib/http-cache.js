const crypto = require("node:crypto");

function buildWeakEtag(body) {
  const digest = crypto.createHash("sha1").update(body).digest("hex");
  return `W/"${digest}"`;
}

function normalizeIncomingEtag(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function etagMatches(ifNoneMatchHeader, etag) {
  const candidates = normalizeIncomingEtag(ifNoneMatchHeader);
  if (!candidates.length || !etag) {
    return false;
  }

  return candidates.some((candidate) => candidate === "*" || candidate === etag);
}

module.exports = {
  buildWeakEtag,
  etagMatches
};
