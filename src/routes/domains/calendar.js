const { createApiRouter } = require("../../lib/create-api-router");
const { parsePaginationParams } = require("../../lib/pagination");
const {
  findCalendarMonth,
  findHoliday,
  loadHolidays,
  loadReferenceSlice
} = require("../../services/document-slices");
const { createEntityNotFound } = require("./shared");

const router = createApiRouter();

router.get("/months", async (request, response) => {
  const items = await loadReferenceSlice("calendarMonths");
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(Array.isArray(items) ? items : [], { offset, limit });
});

router.get("/months/:monthId", async (request, response) => {
  const month = await findCalendarMonth(request.params.monthId);
  if (!month) {
    throw createEntityNotFound("calendar-month", request.params.monthId);
  }

  response.apiSuccess(month);
});

router.get("/holidays", async (request, response) => {
  const kind = String(request.query.kind || "all").trim().toLowerCase();
  const holidays = await loadHolidays(kind);
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(Array.isArray(holidays) ? holidays : [], { offset, limit });
});

router.get("/holidays/:holidayId", async (request, response) => {
  const holiday = await findHoliday(request.params.holidayId);
  if (!holiday) {
    throw createEntityNotFound("holiday", request.params.holidayId);
  }

  response.apiSuccess(holiday);
});

module.exports = router;
