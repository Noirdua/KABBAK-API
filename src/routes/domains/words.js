const { createApiRouter } = require("../../lib/create-api-router");
const { findWordAnagrams } = require("../../services/anagram-service");
const { findWordExact, findWordsByPrefix } = require("../../services/word-service");
const { findDictionaryTranslations } = require("../../services/foreign-dictionary-service");
const { parsePaginationParams, paginateResults } = require("../../lib/pagination");

const router = createApiRouter();

router.get("/anagrams", async (request, response) => {
  const result = await findWordAnagrams(request.query.text);
  const { offset, limit } = parsePaginationParams(request.query);
  const { total, count, results: matches } = paginateResults(result.matches, { offset, limit });

  response.apiSuccess(
    {
      matches,
      text: result.text,
      normalized: result.normalized,
      signature: result.signature,
      letterCount: result.letterCount
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

router.get("/lookup", async (request, response) => {
  const result = await findWordExact(request.query.word);
  response.apiSuccess(result);
});

router.get("/prefix", async (request, response) => {
  const result = await findWordsByPrefix(request.query.prefix);
  const { offset, limit } = parsePaginationParams(request.query);
  const { total, count, results: matches } = paginateResults(result.matches, { offset, limit });

  response.apiSuccess(
    {
      matches,
      prefix: result.prefix,
      normalized: result.normalized,
      hasWildcard: result.hasWildcard
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

router.get("/translate", async (request, response) => {
  const result = await findDictionaryTranslations(request.query.text, request.query);
  response.apiSuccess(result);
});

module.exports = router;
