const crypto = require("node:crypto");
const { sendSuccess, sendPaginated } = require("../lib/api-response");
const { serviceVersion } = require("../config/service");

function resolveRequestId(request) {
  const incomingRequestId = String(request.get("x-request-id") || "").trim();
  return incomingRequestId || crypto.randomUUID();
}

function attachRequestContext(request, response, next) {
  const requestId = resolveRequestId(request);
  request.id = requestId;
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);

  // Attach standardized response helpers for future-proof API shape
  response.apiSuccess = (data, meta = {}) => {
    const fullMeta = { requestId, version: serviceVersion, ...meta };
    sendSuccess(response, data, fullMeta);
  };

  response.apiPaginated = (items, pagination, extraMeta = {}) => {
    const fullMeta = { requestId, version: serviceVersion, ...extraMeta };
    sendPaginated(response, items, pagination, fullMeta);
  };

  next();
}

module.exports = {
  attachRequestContext
};
