const { createApiRouter } = require("../../lib/create-api-router");
const {
  findHexagram,
  findTrigram,
  loadReferenceSlice
} = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadReferenceSlice("iChing"));
});

router.get("/hexagrams/:number", async (request, response) => {
  const hexagram = await findHexagram(request.params.number);
  if (!hexagram) {
    throw createEntityNotFound("hexagram", request.params.number);
  }

  response.apiSuccess(hexagram);
});

router.get("/trigrams/:name", async (request, response) => {
  const trigram = await findTrigram(request.params.name);
  if (!trigram) {
    throw createEntityNotFound("trigram", request.params.name);
  }

  response.apiSuccess(trigram);
});

module.exports = router;
