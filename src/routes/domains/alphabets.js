const { createApiRouter } = require("../../lib/create-api-router");
const { loadAlphabets } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadAlphabets());
});

router.get("/:scriptId", async (request, response) => {
  const alphabets = await loadAlphabets();
  const scriptId = String(request.params.scriptId || "").trim();
  const value = alphabets?.[scriptId] || null;
  if (!value) {
    throw createEntityNotFound("alphabet-script", request.params.scriptId);
  }

  response.apiSuccess(value);
});

module.exports = router;
