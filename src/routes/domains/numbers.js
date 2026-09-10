const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.numbers || {});
});

router.get("/:value", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const entries = Array.isArray(magickDataset?.grouped?.numbers?.entries) ? magickDataset.grouped.numbers.entries : [];
  const value = Number(request.params.value);
  const entry = entries.find((item) => Number(item?.value) === value) || null;
  if (!entry) {
    throw createEntityNotFound("number", request.params.value);
  }

  response.apiSuccess(entry);
});

module.exports = router;