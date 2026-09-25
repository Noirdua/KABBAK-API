const { createApiRouter } = require("../../lib/create-api-router");
const { findGodGroup, loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("gods"));
});

router.get("/:groupId", async (request, response) => {
  const value = await findGodGroup(request.params.groupId);
  if (!value) {
    throw createEntityNotFound("god-group", request.params.groupId);
  }

  response.apiSuccess(value);
});

module.exports = router;
