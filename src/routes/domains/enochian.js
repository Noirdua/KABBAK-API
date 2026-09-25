const { createApiRouter } = require("../../lib/create-api-router");
const { loadMagickSlice } = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  response.apiSuccess(await loadMagickSlice("enochian"));
});

router.get("/:groupId", async (request, response) => {
  const enochian = await loadMagickSlice("enochian");
  const groupId = String(request.params.groupId || "").trim();
  const value = enochian?.[groupId] || null;
  if (!value) {
    throw createEntityNotFound("enochian-group", request.params.groupId);
  }

  response.apiSuccess(value);
});

module.exports = router;
