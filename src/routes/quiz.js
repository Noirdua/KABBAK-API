const { createApiRouter } = require("../lib/create-api-router");

const {
  getQuizSession,
  listQuizCategories,
  listQuizTemplates,
  pullQuizQuestion
} = require("../services/quiz-service");
const { getQuizLeaderboard } = require("../services/profile-service");

const router = createApiRouter();

router.get("/quiz/categories", async (_request, response) => {
  const categories = await listQuizCategories();
  response.apiSuccess(categories);
});

router.get("/quiz/templates", async (request, response) => {
  const templates = await listQuizTemplates({
    categoryId: request.query.categoryId
  });
  response.apiSuccess(templates);
});

// Internal leaderboard: public-directory players only, ranked by accuracy.
router.get("/quiz/leaderboard", async (request, response) => {
  const entries = getQuizLeaderboard({ limit: request.query.limit });
  response.apiSuccess({ count: entries.length, entries });
});

router.get("/quiz/session", async (request, response) => {
  const session = await getQuizSession({
    categoryId: request.query.categoryId,
    templateKey: request.query.templateKey,
    difficulty: request.query.difficulty,
    count: request.query.count,
    seed: request.query.seed,
    includeAnswer: request.query.includeAnswer
  });
  response.apiSuccess(session);
});

router.get("/quiz/questions/pull", async (request, response) => {
  const question = await pullQuizQuestion({
    categoryId: request.query.categoryId,
    templateKey: request.query.templateKey,
    difficulty: request.query.difficulty,
    seed: request.query.seed,
    includeAnswer: request.query.includeAnswer
  });
  response.apiSuccess(question);
});

module.exports = router;