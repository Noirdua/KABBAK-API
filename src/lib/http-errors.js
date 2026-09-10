function createHttpError(status, code, message, details) {
  const error = new Error(String(message || "The request could not be processed."));
  error.status = Number.isInteger(Number(status)) ? Number(status) : 500;
  error.code = String(code || (error.status >= 500 ? "internal_error" : "bad_request"));
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function createNotFoundError(code, message, details) {
  return createHttpError(404, code || "not_found", message || "The requested resource was not found.", details);
}

module.exports = {
  createHttpError,
  createNotFoundError
};