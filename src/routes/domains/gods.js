const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedCandidates
} = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.gods || {});
});

router.get("/:groupId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const gods = magickDataset?.grouped?.gods || {};
  const groupId = String(request.params.groupId || "").trim();
  const value = gods?.[groupId]
    || gods?.pantheons?.[groupId]
    || gods?.gods?.[groupId]
    || gods?.byPath?.[groupId]
    || findByNormalizedCandidates(gods?.pantheons, groupId, (entry) => [entry?.id, entry?.slug, entry?.key, entry?.name])
    || findByNormalizedCandidates(gods?.gods, groupId, (entry) => [entry?.id, entry?.slug, entry?.key, entry?.name])
    || null;
  if (!value) {
    throw createEntityNotFound("god-group", request.params.groupId);
  }

  response.apiSuccess(value);
});

module.exports = router;