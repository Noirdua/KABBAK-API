const { createApiRouter } = require("../../lib/create-api-router");
const { loadReferenceData } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedId
} = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const referenceData = await loadReferenceData();
  response.apiSuccess(referenceData.iChing || {});
});

router.get("/hexagrams/:number", async (request, response) => {
  const referenceData = await loadReferenceData();
  const target = Number(request.params.number);
  const hexagram = (Array.isArray(referenceData.iChing?.hexagrams) ? referenceData.iChing.hexagrams : [])
    .find((entry) => Number(entry?.number) === target) || null;
  if (!hexagram) {
    throw createEntityNotFound("hexagram", request.params.number);
  }

  response.apiSuccess(hexagram);
});

router.get("/trigrams/:name", async (request, response) => {
  const referenceData = await loadReferenceData();
  const trigram = findByNormalizedId(referenceData.iChing?.trigrams, request.params.name, (entry) => entry?.name);
  if (!trigram) {
    throw createEntityNotFound("trigram", request.params.name);
  }

  response.apiSuccess(trigram);
});

module.exports = router;