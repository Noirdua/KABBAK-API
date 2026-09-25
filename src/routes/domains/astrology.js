const { createApiRouter } = require("../../lib/create-api-router");
const { parsePaginationParams } = require("../../lib/pagination");
const { getNatalChart } = require("../../services/natal-service");
const {
  findDecan,
  findSign,
  loadFlattenedDecans,
  loadReferenceSlice
} = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/natal", async (request, response) => {
  const chart = await getNatalChart(request.query);
  response.apiSuccess(chart);
});

router.get("/planets", async (request, response) => {
  const planets = await loadReferenceSlice("planets");
  const items = Object.values(planets || {});
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(items, { offset, limit });
});

router.get("/planets/:planetId", async (request, response) => {
  const planets = await loadReferenceSlice("planets");
  const planet = planets?.[request.params.planetId] || null;
  if (!planet) {
    throw createEntityNotFound("planet", request.params.planetId);
  }

  response.apiSuccess(planet);
});

router.get("/signs", async (request, response) => {
  const items = await loadReferenceSlice("signs");
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(Array.isArray(items) ? items : [], { offset, limit });
});

router.get("/signs/:signId", async (request, response) => {
  const sign = await findSign(request.params.signId);
  if (!sign) {
    throw createEntityNotFound("sign", request.params.signId);
  }

  response.apiSuccess(sign);
});

router.get("/decans", async (request, response) => {
  const decans = await loadFlattenedDecans();
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(decans, { offset, limit });
});

router.get("/decans/:decanId", async (request, response) => {
  const decan = await findDecan(request.params.decanId);
  if (!decan) {
    throw createEntityNotFound("decan", request.params.decanId);
  }

  response.apiSuccess(decan);
});

module.exports = router;
