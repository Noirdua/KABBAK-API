const { createApiRouter } = require("../../lib/create-api-router");
const { loadReferenceData } = require("../../services/data-loader");
const {
  createEntityNotFound,
  findByNormalizedId
} = require("./shared");
const { parsePaginationParams } = require("../../lib/pagination");

const router = createApiRouter();

router.get("/months", async (request, response) => {
  const referenceData = await loadReferenceData();
  const items = Array.isArray(referenceData.calendarMonths) ? referenceData.calendarMonths : [];
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated(items, { offset, limit });
});

router.get("/months/:monthId", async (request, response) => {
  const referenceData = await loadReferenceData();
  const month = findByNormalizedId(referenceData.calendarMonths, request.params.monthId, (entry) => entry?.id);
  if (!month) {
    throw createEntityNotFound("calendar-month", request.params.monthId);
  }

  response.apiSuccess(month);
});

router.get("/holidays", async (request, response) => {
  const referenceData = await loadReferenceData();
  const kind = String(request.query.kind || "all").trim().toLowerCase();

  if (kind === "celestial") {
    const holidays = Array.isArray(referenceData.celestialHolidays) ? referenceData.celestialHolidays : [];
    const { offset, limit } = parsePaginationParams(request.query);
    response.apiPaginated(holidays, { offset, limit });
    return;
  }

  if (kind === "calendar") {
    const holidays = Array.isArray(referenceData.calendarHolidays) ? referenceData.calendarHolidays : [];
    const { offset, limit } = parsePaginationParams(request.query);
    response.apiPaginated(holidays, { offset, limit });
    return;
  }

  const celestial = Array.isArray(referenceData.celestialHolidays) ? referenceData.celestialHolidays : [];
  const calendar = Array.isArray(referenceData.calendarHolidays) ? referenceData.calendarHolidays : [];
  const { offset, limit } = parsePaginationParams(request.query);
  response.apiPaginated([...celestial, ...calendar], { offset, limit });
});

router.get("/holidays/:holidayId", async (request, response) => {
  const referenceData = await loadReferenceData();
  const holidays = [
    ...(Array.isArray(referenceData.celestialHolidays) ? referenceData.celestialHolidays : []),
    ...(Array.isArray(referenceData.calendarHolidays) ? referenceData.calendarHolidays : [])
  ];
  const holiday = findByNormalizedId(holidays, request.params.holidayId, (entry) => entry?.id);
  if (!holiday) {
    throw createEntityNotFound("holiday", request.params.holidayId);
  }

  response.apiSuccess(holiday);
});

module.exports = router;