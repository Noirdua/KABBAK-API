const { createApiRouter } = require("../../lib/create-api-router");
const { findWordsByGematriaValue, calculateGematriaText } = require("../../services/gematria-service");
const { methodOptionsForLanguage } = require("../../lib/script-gematria");
const { parsePaginationParams, paginateResults } = require("../../lib/pagination");

const router = createApiRouter();

router.get("/methods", async (request, response) => {
  response.apiSuccess({
    hebrew: methodOptionsForLanguage("hebrew"),
    greek: methodOptionsForLanguage("greek")
  });
});

router.get("/calculate", async (request, response) => {
  const result = await calculateGematriaText(
    request.query.text,
    request.query.language,
    request.query.method
  );
  response.apiSuccess(result);
});

router.get("/words", async (request, response) => {
  const result = await findWordsByGematriaValue(
    request.query.value,
    request.query.ciphers,
    request.query.language,
    request.query.script,
    request.query.method
  );
  const { offset, limit } = parsePaginationParams(request.query);
  const { total, count, results: matches } = paginateResults(result.matches, { offset, limit });

  response.apiSuccess(
    {
      matches,
      ciphers: result.ciphers,
      value: result.value,
      language: result.language,
      ...(result.method ? { method: result.method } : {})
    },
    {
      total,
      offset,
      limit,
      count,
      ...result.meta
    }
  );
});

module.exports = router;
