const { createNotFoundError } = require("../lib/http-errors");
const { sanitizeRequestUrl } = require("../lib/request-url");

function apiNotFoundHandler(request, _response, next) {
  next(createNotFoundError(
    "route_not_found",
    `Unknown API route '${request.method} ${sanitizeRequestUrl(request.originalUrl)}'.`
  ));
}

module.exports = {
  apiNotFoundHandler
};