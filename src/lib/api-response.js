const { paginateResults: rawPaginate } = require('./pagination');

/**
 * Sends a standardized success response.
 * All success responses use this shape for future-proofing:
 *
 * {
 *   "data": <any>,
 *   "meta": {
 *     "requestId": "...",
 *     "version": "x.y.z",
 *     "total"?: number,
 *     "offset"?: number,
 *     "limit"?: number,
 *     "count"?: number
 *   }
 * }
 */
function sendSuccess(response, data, meta = {}) {
  const payload = { data };

  const cleanMeta = {};
  // Always include core tracing/version if present
  if (meta.requestId) cleanMeta.requestId = meta.requestId;
  if (meta.version) cleanMeta.version = meta.version;
  if (typeof meta.total === 'number') cleanMeta.total = meta.total;
  if (typeof meta.offset === 'number') cleanMeta.offset = meta.offset;
  if (typeof meta.limit === 'number') cleanMeta.limit = meta.limit;
  if (typeof meta.count === 'number') cleanMeta.count = meta.count;

  // Preserve any additional meta provided by specialized endpoints (e.g. search meta)
  for (const [k, v] of Object.entries(meta)) {
    if (!(k in cleanMeta) && v !== undefined) {
      cleanMeta[k] = v;
    }
  }

  if (Object.keys(cleanMeta).length > 0) {
    payload.meta = cleanMeta;
  }

  response.json(payload);
}

/**
 * Convenience wrapper for paginated responses.
 * Uses the existing pagination logic but wraps in the standard envelope.
 */
function sendPaginated(response, items, { offset = 0, limit = 100 } = {}, extraMeta = {}) {
  const { total, count, results } = rawPaginate(items, { offset, limit });

  const meta = {
    ...extraMeta,
    total,
    offset,
    limit,
    count
  };

  sendSuccess(response, results, meta);
}

module.exports = {
  sendSuccess,
  sendPaginated
};
