const { createApiRouter } = require("../../lib/create-api-router");
const { createEntityNotFound } = require("./shared");
const {
  ensureCorrespondenceStore,
  getEntityRecord,
  getEntityRelations,
  listCorrespondenceKinds
} = require("../../services/correspondence-store");

const router = createApiRouter();

router.get("/", async (_request, response) => {
  await ensureCorrespondenceStore();
  response.apiSuccess({
    kinds: listCorrespondenceKinds()
  });
});

router.get("/:kind/:id", async (request, response) => {
  await ensureCorrespondenceStore();
  const kind = String(request.params.kind || "").trim().toLowerCase();
  const record = getEntityRecord(kind, request.params.id);
  if (!record) {
    throw createEntityNotFound(kind || "correspondence", request.params.id);
  }
  response.apiSuccess({
    ...record,
    relations: getEntityRelations(kind, record.id)
  });
});

module.exports = router;
