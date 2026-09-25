const { createApiRouter } = require("../../lib/create-api-router");
const { findChakra, loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("chakras"));
});

router.get("/:chakraId", async (request, response) => {
  const chakra = await findChakra(request.params.chakraId);
  if (!chakra) {
    throw createEntityNotFound("chakra", request.params.chakraId);
  }

  response.apiSuccess(chakra);
});

module.exports = router;
