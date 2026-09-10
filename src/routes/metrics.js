const { createApiRouter } = require("../lib/create-api-router");
const { serviceName, serviceVersion } = require("../config/service");
const { getRequestMetricsSnapshot } = require("../services/request-metrics");

const router = createApiRouter();

router.get("/metrics", (_request, response) => {
  response.setHeader("cache-control", "no-store");
  response.apiSuccess({
    service: serviceName,
    version: serviceVersion,
    ...getRequestMetricsSnapshot()
  });
});

module.exports = router;