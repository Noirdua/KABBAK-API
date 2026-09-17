const { createApiRouter } = require("../../lib/create-api-router");
const { loadReferenceData } = require("../../services/data-loader");
const { parsePaginationParams } = require("../../lib/pagination");
const { getNatalChart } = require("../../services/natal-service");
const {
  createEntityNotFound,
  findByNormalizedId,
  flattenDecans
} = require("./shared");

const router = createApiRouter();

router.get("/natal", async (request, response) => {
  const chart = await getNatalChart(request.query);
  response.apiSuccess(chart);
});

router.get("/planets", async (request, response) => {
  const referenceData = await loadReferenceData();
  const items = Object.values(referenceData.planets || {});
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(items, { offset, limit });
});

router.get("/planets/:planetId", async (request, response) => {
  const referenceData = await loadReferenceData();
  const planet = referenceData.planets?.[request.params.planetId] || null;
  if (!planet) {
    throw createEntityNotFound("planet", request.params.planetId);
  }

  response.apiSuccess(planet);
});

router.get("/signs", async (request, response) => {
  const referenceData = await loadReferenceData();
  const items = Array.isArray(referenceData.signs) ? referenceData.signs : [];
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(items, { offset, limit });
});

router.get("/signs/:signId", async (request, response) => {
  const referenceData = await loadReferenceData();
  const sign = findByNormalizedId(referenceData.signs, request.params.signId, (entry) => entry?.id);
  if (!sign) {
    throw createEntityNotFound("sign", request.params.signId);
  }

  response.apiSuccess(sign);
});

router.get("/decans", async (request, response) => {
  const referenceData = await loadReferenceData();
  const decans = flattenDecans(referenceData.decansBySign);
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(decans, { offset, limit });
});

router.get("/decans/:decanId", async (request, response) => {
  const referenceData = await loadReferenceData();
  const decans = flattenDecans(referenceData.decansBySign);
  const decan = findByNormalizedId(decans, request.params.decanId, (entry) => entry?.id);
  if (!decan) {
    throw createEntityNotFound("decan", request.params.decanId);
  }

  response.apiSuccess(decan);
});

module.exports = router;