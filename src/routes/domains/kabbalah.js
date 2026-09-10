const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

function getKabbalahTree(magickDataset) {
  return magickDataset?.grouped?.kabbalah?.["kabbalah-tree"] || {};
}

router.get("/tree", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(getKabbalahTree(magickDataset));
});

router.get("/sephiroth/:value", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const sephiroth = Array.isArray(getKabbalahTree(magickDataset)?.sephiroth)
    ? getKabbalahTree(magickDataset).sephiroth
    : [];
  const needle = String(request.params.value || "").trim().toLowerCase();
  const sephirah = sephiroth.find((entry) => String(entry?.sephiraId || "").trim().toLowerCase() === needle
    || String(entry?.name || "").trim().toLowerCase() === needle
    || String(entry?.number || "").trim() === String(request.params.value || "").trim()) || null;
  if (!sephirah) {
    throw createEntityNotFound("sephirah", request.params.value);
  }

  response.apiSuccess(sephirah);
});

router.get("/paths/:value", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const paths = Array.isArray(getKabbalahTree(magickDataset)?.paths)
    ? getKabbalahTree(magickDataset).paths
    : [];
  const needle = String(request.params.value || "").trim().toLowerCase();
  const pathEntry = paths.find((entry) => String(entry?.pathNumber || "").trim() === String(request.params.value || "").trim()
    || String(entry?.hebrewLetter?.transliteration || "").trim().toLowerCase() === needle
    || String(entry?.tarot?.card || "").trim().toLowerCase() === needle) || null;
  if (!pathEntry) {
    throw createEntityNotFound("kabbalah-path", request.params.value);
  }

  response.apiSuccess(pathEntry);
});

router.get("/cube", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.kabbalah?.cube || {});
});

module.exports = router;