const { createApiRouter } = require("../../lib/create-api-router");
const {
  findKabbalahPath,
  findSephirah,
  loadKabbalahCube,
  loadKabbalahTree
} = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/tree", async (_request, response) => {
  response.apiSuccess(await loadKabbalahTree());
});

router.get("/sephiroth/:value", async (request, response) => {
  const sephirah = await findSephirah(request.params.value);
  if (!sephirah) {
    throw createEntityNotFound("sephirah", request.params.value);
  }

  response.apiSuccess(sephirah);
});

router.get("/paths/:value", async (request, response) => {
  const pathEntry = await findKabbalahPath(request.params.value);
  if (!pathEntry) {
    throw createEntityNotFound("kabbalah-path", request.params.value);
  }

  response.apiSuccess(pathEntry);
});

router.get("/cube", async (_request, response) => {
  response.apiSuccess(await loadKabbalahCube());
});

module.exports = router;
