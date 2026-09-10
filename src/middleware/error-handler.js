const { sanitizeRequestUrl } = require("../lib/request-url");

function getResponseStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 ? status : 500;
}

function normalizeApiError(error) {
  if (error?.type === "entity.parse.failed") {
    return {
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON."
    };
  }

  if (error?.type === "entity.too.large") {
    return {
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large."
    };
  }

  const status = getResponseStatus(error);
  const isClientError = status >= 400 && status < 500;

  return {
    status,
    code: String(error?.code || (isClientError ? "bad_request" : "internal_error")),
    message: isClientError
      ? String(error?.message || "The request could not be processed.")
      : "The API could not complete the request.",
    details: isClientError && error?.details !== undefined ? error.details : undefined
  };
}

function createApiErrorHandler({ logger = console } = {}) {
  return function apiErrorHandler(error, request, response, next) {
    if (response.headersSent) {
      next(error);
      return;
    }

    const normalized = normalizeApiError(error);
    const requestId = response.locals?.requestId || request.id || "unknown";

    if (normalized.status >= 500) {
      logger.error(`[api] ${request.method} ${sanitizeRequestUrl(request.originalUrl)} failed (requestId=${requestId}): ${error?.message || normalized.message}`);
    }

    const payload = {
      error: normalized.code,
      message: normalized.message,
      requestId
    };

    if (normalized.details !== undefined) {
      payload.details = normalized.details;
    }

    response.status(normalized.status).json(payload);
  };
}

module.exports = {
  createApiErrorHandler,
  getResponseStatus
};