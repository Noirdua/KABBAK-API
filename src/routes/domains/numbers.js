const { createApiRouter } = require("../../lib/create-api-router");
const { findNumberEntry, loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("numbers"));
});

router.get("/:value", async (request, response) => {
  const entry = await findNumberEntry(request.params.value);
  if (!entry) {
    throw createEntityNotFound("number", request.params.value);
  }

  response.apiSuccess(entry);
});

module.exports = router;
