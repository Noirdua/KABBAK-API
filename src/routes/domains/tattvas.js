const { createApiRouter } = require("../../lib/create-api-router");
const { findTattva, loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("tattvas"));
});

router.get("/:tattvaId", async (request, response) => {
  const tattva = await findTattva(request.params.tattvaId);
  if (!tattva) {
    throw createEntityNotFound("tattva", request.params.tattvaId);
  }

  response.apiSuccess(tattva);
});

module.exports = router;
