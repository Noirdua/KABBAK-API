function parsePaginationParams(query = {}) {
  const offset = Math.max(0, Number.parseInt(String(query.offset || "0"), 10) || 0);
  const limit = Math.min(Math.max(1, Number.parseInt(String(query.limit || "100"), 10) || 100), 500);
  return { offset, limit };
}

/**
 * Internal pagination slicer.
 * Prefer using response.apiPaginated() in routes for the standard envelope.
 */
function paginateResults(items, { offset = 0, limit = 100 } = {}) {
  const total = Array.isArray(items) ? items.length : 0;
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  const results = Array.isArray(items) ? items.slice(safeOffset, safeOffset + safeLimit) : [];
  return {
    total,
    offset: safeOffset,
    limit: safeLimit,
    count: results.length,
    results
  };
}

module.exports = {
  paginateResults,
  parsePaginationParams
};
