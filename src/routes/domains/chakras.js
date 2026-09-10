const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedCandidates
} = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.chakras || {});
});

router.get("/:chakraId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const chakraData = magickDataset?.grouped?.chakras;
  const chakra = chakraData?.[request.params.chakraId]
    || chakraData?.[String(request.params.chakraId || "").trim().toLowerCase()]
    || findByNormalizedCandidates(
      Array.isArray(chakraData?.entries) ? chakraData.entries : (Array.isArray(chakraData) ? chakraData : []),
      request.params.chakraId,
      (entry) => [entry?.id, entry?.name, entry?.name?.en, entry?.name?.roman]
    );
  if (!chakra) {
    throw createEntityNotFound("chakra", request.params.chakraId);
  }

  response.apiSuccess(chakra);
});

module.exports = router;