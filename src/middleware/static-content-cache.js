const { etagMatches } = require("../lib/http-cache");
const { getStorageStatus } = require("../services/storage-bootstrap");

let contentVersionEtagPromise = null;

// The DB snapshot is rebuilt on every migrate:data, so its mtime is a stable
// "content version" for the server's lifetime. The ETag stays constant across
// requests (unlike the per-request requestId), so If-None-Match round-trips work.
function getContentVersionEtag() {
  if (!contentVersionEtagPromise) {
    contentVersionEtagPromise = getStorageStatus()
      .then((status) => `W/"content-${String(status?.snapshotMtimeMs || Date.now())}"`)
      .catch(() => `W/"content-${Date.now()}"`);
  }
  return contentVersionEtagPromise;
}

// Cache headers + conditional-request handling for immutable content endpoints
// (text sections, references, deck registry/manifests). Search and other
// query-driven endpoints must NOT use this.
function createStaticContentCache({ maxAgeSeconds = 3600 } = {}) {
  return async function staticContentCache(request, response, next) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return next();
    }

    const etag = await getContentVersionEtag();
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", `private, max-age=${maxAgeSeconds}, must-revalidate`);
    response.setHeader("Vary", "Authorization, x-api-key");

    if (etagMatches(request.get("if-none-match"), etag)) {
      return response.status(304).end();
    }

    next();
  };
}

module.exports = {
  createStaticContentCache
};
