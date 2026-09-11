const { createApiRouter } = require("../lib/create-api-router");
const { buildWeakEtag, etagMatches } = require("../lib/http-cache");
const { serviceVersion } = require("../config/service");
const { getStorageStatus } = require("../services/storage-bootstrap");

const {
  loadReferenceData,
  loadMagickManifest,
  loadMagickDataset
} = require("../services/data-loader");
const { normalizeMagickDataset } = require("../lib/normalize-alphabets");

const router = createApiRouter();

const bootstrapPayloadCache = {
  referenceData: null,
  magickManifest: null,
  magickDataset: null,
  snapshotMtimeMs: 0
};

async function getCachedJsonPayload(cacheKey, loader) {
  try {
    const status = await getStorageStatus();
    const currentMtime = status?.snapshotMtimeMs || 0;
    if (bootstrapPayloadCache[cacheKey] && bootstrapPayloadCache.snapshotMtimeMs === currentMtime) {
      return bootstrapPayloadCache[cacheKey];
    }
    // Bust if mtime changed (e.g. after migrate:data without restart)
    if (currentMtime !== bootstrapPayloadCache.snapshotMtimeMs) {
      bootstrapPayloadCache.referenceData = null;
      bootstrapPayloadCache.magickManifest = null;
      bootstrapPayloadCache.magickDataset = null;
      bootstrapPayloadCache.snapshotMtimeMs = currentMtime;
    }
  } catch {}

  const value = await loader();
  const body = JSON.stringify(value);
  const payload = {
    body,
    etag: buildWeakEtag(body)
  };
  bootstrapPayloadCache[cacheKey] = payload;
  // snapshotMtimeMs already updated on bust or initial
  if (!bootstrapPayloadCache.snapshotMtimeMs) {
    try {
      const s = await getStorageStatus({ force: true });
      bootstrapPayloadCache.snapshotMtimeMs = s?.snapshotMtimeMs || 0;
    } catch {}
  }
  return payload;
}

// Bootstrap snapshots only change on migrate:data, so they are safe to cache for
// a while. Emit an ETag and honour If-None-Match to skip re-sending the body.
function sendCachedBootstrap(request, response, payload) {
  response.setHeader("ETag", payload.etag);
  response.setHeader("Cache-Control", "private, max-age=86400, must-revalidate");
  response.setHeader("Vary", "Authorization, x-api-key");

  if (etagMatches(request.get("if-none-match"), payload.etag)) {
    response.status(304).end();
    return;
  }

  const meta = {
    requestId: response.locals?.requestId || request.id || "",
    version: serviceVersion
  };
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.send(`{"data":${payload.body},"meta":${JSON.stringify(meta)}}`);
}

router.get("/bootstrap/reference-data", async (request, response) => {
  const payload = await getCachedJsonPayload("referenceData", loadReferenceData);
  sendCachedBootstrap(request, response, payload);
});

router.get("/bootstrap/magick-manifest", async (request, response) => {
  const payload = await getCachedJsonPayload("magickManifest", loadMagickManifest);
  sendCachedBootstrap(request, response, payload);
});

router.get("/bootstrap/magick-dataset", async (request, response) => {
  const payload = await getCachedJsonPayload("magickDataset", async () => (
    normalizeMagickDataset(await loadMagickDataset())
  ));
  sendCachedBootstrap(request, response, payload);
});

module.exports = router;
