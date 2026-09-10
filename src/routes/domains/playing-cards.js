const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedCandidates,
  findByNormalizedId,
  resolvePlayingCardAlias
} = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(magickDataset?.grouped?.["playing-cards-52"] || {});
});

router.get("/:cardId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const playingCardsData = magickDataset?.grouped?.["playing-cards-52"];
  const entries = Array.isArray(playingCardsData)
    ? playingCardsData
    : (Array.isArray(playingCardsData?.entries) ? playingCardsData.entries : []);
  const canonicalId = resolvePlayingCardAlias(request.params.cardId);
  const entry = findByNormalizedId(entries, canonicalId || request.params.cardId, (item) => item?.id)
    || findByNormalizedCandidates(entries, request.params.cardId, (item) => [
      item?.id,
      `${item?.rankLabel} of ${item?.suitLabel}`,
      `${item?.rank} of ${item?.suit}`,
      item?.tarotCard
    ]);
  if (!entry) {
    throw createEntityNotFound("playing-card", request.params.cardId);
  }

  response.apiSuccess(entry);
});

module.exports = router;