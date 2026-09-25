const { createApiRouter } = require("../../lib/create-api-router");
const { findPlayingCard, loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound, resolvePlayingCardAlias } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("playing-cards"));
});

router.get("/:cardId", async (request, response) => {
  const entry = await findPlayingCard(request.params.cardId, resolvePlayingCardAlias(request.params.cardId));
  if (!entry) {
    throw createEntityNotFound("playing-card", request.params.cardId);
  }

  response.apiSuccess(entry);
});

module.exports = router;
