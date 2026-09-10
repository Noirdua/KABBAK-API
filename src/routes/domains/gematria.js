const { createApiRouter } = require("../../lib/create-api-router");
const { findWordsByGematriaValue } = require("../../services/gematria-service");
const { parsePaginationParams, paginateResults } = require("../../lib/pagination");

const router = createApiRouter();

router.get("/words", async (request, response) => {
  const result = await findWordsByGematriaValue(request.query.value, request.query.ciphers);
  const { offset, limit } = parsePaginationParams(request.query);
  const { total, count, results: matches } = paginateResults(result.matches, { offset, limit });

  response.apiSuccess(
    {
      matches,
      ciphers: result.ciphers,
      value: result.value
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
