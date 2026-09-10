const { createApiRouter } = require("../lib/create-api-router");

const {
  getWeekEventsForQuery,
  getNowSnapshot
} = require("../services/calendar-service");

const router = createApiRouter();

router.get("/calendar/week-events", async (request, response) => {
  const events = await getWeekEventsForQuery(request.query);
  response.apiSuccess(events);
});

router.get("/now", async (request, response) => {
  const snapshot = await getNowSnapshot(request.query);
  response.apiSuccess(snapshot);
});

module.exports = router;