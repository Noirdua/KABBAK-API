const { createApiRouter } = require("../lib/create-api-router");
const { createNotFoundError } = require("../lib/http-errors");
const { createStaticContentCache } = require("../middleware/static-content-cache");

const {
  loadDeckRegistry,
  loadDeckManifest
} = require("../services/data-loader");

const router = createApiRouter();

const cacheStatic = createStaticContentCache();

router.get("/decks", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const registry = await loadDeckRegistry();
  response.apiSuccess(registry);
});

router.get("/decks/:deckId/manifest", cacheStatic, async (request, response) => {
  const manifest = await loadDeckManifest(request.params.deckId);
  if (!manifest) {
    throw createNotFoundError("deck_not_found", `Unknown deck '${request.params.deckId}'.`);
  }

  response.apiSuccess(manifest);
});

module.exports = router;
