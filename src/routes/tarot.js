const { createApiRouter } = require("../lib/create-api-router");
const { createNotFoundError } = require("../lib/http-errors");
const { parsePaginationParams } = require("../lib/pagination");

const {
  listCards,
  getCardById,
  listSpreads,
  pullSpread
} = require("../services/tarot-service");
const { resolveDeckCard } = require("../services/deck-service");

const router = createApiRouter();

async function requireCard(cardId) {
  const result = await getCardById(cardId);
  if (!result) {
    throw createNotFoundError("card_not_found", `Unknown tarot card '${cardId}'.`);
  }

  return result;
}

router.get("/tarot/cards", async (request, response) => {
  const cards = await listCards({
    query: request.query.q,
    arcana: request.query.arcana,
    suit: request.query.suit
  });
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(cards, { offset, limit });
});

router.get("/tarot/cards/:cardId", async (request, response) => {
  const card = await requireCard(request.params.cardId);
  response.apiSuccess(card);
});

router.get("/tarot/cards/:cardId/relations", async (request, response) => {
  const result = await requireCard(request.params.cardId);
  response.apiSuccess({
    card: {
      id: result.card.id,
      name: result.card.name,
      arcana: result.card.arcana,
      suit: result.card.suit,
      rank: result.card.rank
    },
    relations: result.relations
  });
});

router.get("/tarot/cards/:cardId/image", async (request, response) => {
  const result = await requireCard(request.params.cardId);
  const imageInfo = await resolveDeckCard({
    deckId: request.query.deckId,
    cardName: result.card.name,
    variant: request.query.variant,
    trumpNumber: result.card.number
  });
  response.apiSuccess(imageInfo);
});

router.get("/tarot/spreads", async (_request, response) => {
  const spreads = await listSpreads();
  response.apiSuccess(spreads);
});

router.get("/tarot/spreads/:spreadId/pull", async (request, response) => {
  const spread = await pullSpread(request.params.spreadId, {
    seed: request.query.seed ? String(request.query.seed) : "",
    allowReversed: String(request.query.reversed || "").trim().toLowerCase() === "true"
  });
  response.apiSuccess(spread);
});

module.exports = router;