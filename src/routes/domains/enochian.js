const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.enochian || {});
});

router.get("/:groupId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const enochian = magickDataset?.grouped?.enochian || {};
  const groupId = String(request.params.groupId || "").trim();
  const value = enochian?.[groupId] || null;
  if (!value) {
    throw createEntityNotFound("enochian-group", request.params.groupId);
  }

  response.apiSuccess(value);
});

module.exports = router;