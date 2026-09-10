const { createApiRouter } = require("../lib/create-api-router");

const {
  listQuizCategories,
  listQuizTemplates,
  pullQuizQuestion
} = require("../services/quiz-service");

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