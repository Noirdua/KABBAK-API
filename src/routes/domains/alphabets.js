const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickDataset } = require("../../services/data-loader");
const { createEntityNotFound } = require("./shared");
const { normalizeAlphabets } = require("../../lib/normalize-alphabets");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  const magickDataset = await loadMagickDataset();
  response.apiSuccess(normalizeAlphabets(magickDataset?.grouped?.alphabets || {}));
});

router.get("/:scriptId", async (request, response) => {
  const magickDataset = await loadMagickDataset();
  const alphabets = normalizeAlphabets(magickDataset?.grouped?.alphabets || {});
  const scriptId = String(request.params.scriptId || "").trim();
  const value = alphabets?.[scriptId] || null;
  if (!value) {
    throw createEntityNotFound("alphabet-script", request.params.scriptId);
  }

  response.apiSuccess(value);
});

module.exports = router;