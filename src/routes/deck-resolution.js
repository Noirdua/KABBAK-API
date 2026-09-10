const { createApiRouter } = require("../lib/create-api-router");
const { createNotFoundError } = require("../lib/http-errors");
const { createStaticContentCache } = require("../middleware/static-content-cache");

const {
  listDeckOptions,
  listAllDeckAssets,
  resolveDeckCard,
  resolveDeckBack,
  getDeckCardSearchAliases
} = require("../services/deck-service");

const router = createApiRouter();

const cacheStatic = createStaticContentCache();

function assertDeckResult(result, deckId) {
  if (result !== null && result !== undefined) {
    return result;
  }

  throw createNotFoundError("deck_not_found", `Unknown deck '${deckId}'.`);
}

router.get("/decks/options", cacheStatic, async (_request, response) => {
  const options = await listDeckOptions();
  response.apiSuccess(options);
});

router.get("/decks/assets", cacheStatic, async (_request, response) => {
  const assets = await listAllDeckAssets();
  response.apiSuccess(assets);
});

router.get("/decks/:deckId/cards/resolve", cacheStatic, async (request, response) => {
  const result = await resolveDeckCard({
    deckId: request.params.deckId,
    cardName: request.query.name,
    variant: request.query.variant,
    trumpNumber: request.query.trumpNumber
  });

  response.apiSuccess(assertDeckResult(result, request.params.deckId));
});

router.get("/decks/:deckId/back", cacheStatic, async (request, response) => {
  const result = await resolveDeckBack({
    deckId: request.params.deckId,
    variant: request.query.variant
  });

  response.apiSuccess(assertDeckResult(result, request.params.deckId));
});

router.get("/decks/:deckId/cards/search-aliases", cacheStatic, async (request, response) => {
  const result = await getDeckCardSearchAliases({
    deckId: request.params.deckId,
    cardName: request.query.name,
    trumpNumber: request.query.trumpNumber
  });

  response.apiSuccess(assertDeckResult(result, request.params.deckId));
});

module.exports = router;
