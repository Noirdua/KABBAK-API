const { createApiRouter } = require("../lib/create-api-router");
const { createStaticContentCache } = require("../middleware/static-content-cache");

const {
  getTextLibraryCatalog,
  getTextSourceSummary,
  getTextSection,
  searchTextLibrary,
  listTextReferences,
  searchTextReference,
  getTextReferenceEntry,
  getTextReferenceEntryOccurrences
} = require("../services/text-service");

const router = createApiRouter();

// Immutable content (rebuilds only on migrate:data) is safe to cache. Search
// endpoints are query-driven and stay uncached.
const cacheStatic = createStaticContentCache();

router.get("/texts", cacheStatic, async (_request, response) => {
  const catalog = await getTextLibraryCatalog();
  response.apiSuccess(catalog);
});

router.get("/texts/search", async (request, response) => {
  const results = await searchTextLibrary(request.query.q, {
    limit: request.query.limit,
    sourceId: request.query.sourceId || request.query.source,
    workId: request.query.workId || request.query.work
  });
  response.apiSuccess(results);
});

router.get("/texts/references", cacheStatic, async (_request, response) => {
  const refs = await listTextReferences();
  response.apiSuccess(refs);
});

router.get("/texts/references/:referenceId/search", async (request, response) => {
  const results = await searchTextReference(request.params.referenceId, request.query.q, {
    limit: request.query.limit
  });
  response.apiSuccess(results);
});

router.get("/texts/references/:referenceId/entries/:entryId", cacheStatic, async (request, response) => {
  const entry = await getTextReferenceEntry(request.params.referenceId, request.params.entryId);
  response.apiSuccess(entry);
});

router.get("/texts/references/:referenceId/entries/:entryId/occurrences", cacheStatic, async (request, response) => {
  const occ = await getTextReferenceEntryOccurrences(
    request.params.referenceId,
    request.params.entryId,
    { limit: request.query.limit }
  );
  response.apiSuccess(occ);
});

router.get("/texts/:sourceId/search", async (request, response) => {
  const results = await searchTextLibrary(request.query.q, {
    sourceId: request.params.sourceId,
    workId: request.query.workId || request.query.work,
    limit: request.query.limit
  });
  response.apiSuccess(results);
});

router.get("/texts/:sourceId", cacheStatic, async (request, response) => {
  const summary = await getTextSourceSummary(request.params.sourceId);
  response.apiSuccess(summary);
});

router.get("/texts/:sourceId/works/:workId/sections/:sectionId", cacheStatic, async (request, response) => {
  const section = await getTextSection(
    request.params.sourceId,
    request.params.workId,
    request.params.sectionId
  );
  response.apiSuccess(section);
});

module.exports = router;
