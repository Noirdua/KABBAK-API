const { createApiRouter } = require("../../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../../lib/http-errors");
const { createLogWriter } = require("../../lib/logger-utils");
const { sanitizeRequestUrl } = require("../../lib/request-url");
const {
  ScriberStorageError,
  createScriberDocument,
  deleteScriberDocument,
  getScriberDocument,
  getWorkspaceIdFromAuth,
  listScriberDocuments,
  updateScriberDocument
} = require("../../services/scriber-service");
const { resolveClientLimits } = require("../../services/api-roles");
const { readManagedApiClients } = require("../../services/api-client-registry");

const router = createApiRouter();

function getWorkspaceId(request, response) {
  const auth = response.locals?.auth || request.auth || {};
  return getWorkspaceIdFromAuth(auth);
}

let workspaceOptionsCache = {
  expiresAtMs: 0,
  value: null
};

function getWorkspaceOptions(request, response) {
  const nowMs = Date.now();
  if (workspaceOptionsCache.value && workspaceOptionsCache.expiresAtMs > nowMs) {
    return workspaceOptionsCache.value;
  }

  const auth = response.locals?.auth || request.auth || {};
  const clientId = String(auth.clientId || "").trim();
  const client = readManagedApiClients().find((entry) => entry.id === clientId) || null;
  const limits = resolveClientLimits(client);
  const options = {
    maxDocuments: limits.notes > 0 ? limits.notes : 300
  };
  workspaceOptionsCache = {
    expiresAtMs: nowMs + 5000,
    value: options
  };
  return options;
}

function getRequestBody(request) {
  if (request.body == null) {
    return {};
  }

  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw createHttpError(400, "invalid_request_body", "Request body must be a JSON object.");
  }

  return request.body;
}

function mapScriberStorageError(error) {
  if (!(error instanceof ScriberStorageError)) {
    return error;
  }

  if (error.code === "document_not_found") {
    return createNotFoundError("document_not_found", error.message);
  }
  if (error.code === "documents_limit_reached") {
    return createHttpError(409, "documents_limit_reached", error.message);
  }
  if (error.code === "text_too_long") {
    return createHttpError(413, "text_too_long", error.message);
  }

  return createHttpError(400, error.code || "invalid_scriber_request", error.message);
}

function wrapScriberHandler(handler) {
  return function scriberHandler(request, response, next) {
    try {
      const result = handler(request, response, next);
      Promise.resolve(result).catch((error) => next(mapScriberStorageError(error)));
    } catch (error) {
      next(mapScriberStorageError(error));
    }
  };
}

function emitScriberMutationAuditEvent(request, response, payload) {
  const writeLog = createLogWriter(request.app?.locals?.logger || console);
  if (!writeLog) {
    return;
  }

  const auth = response.locals?.auth || request.auth || {};
  writeLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "api_scriber_mutation",
    requestId: response.locals?.requestId || request.id || "unknown",
    method: request.method,
    path: sanitizeRequestUrl(request.originalUrl),
    actorClientId: auth.clientId || "",
    ...payload
  }));
}

router.get("/documents", wrapScriberHandler((request, response) => {
  const documents = listScriberDocuments(getWorkspaceId(request, response), getWorkspaceOptions(request, response));
  response.apiSuccess({
    count: documents.length,
    documents
  });
}));

router.get("/documents/:documentId", wrapScriberHandler((request, response) => {
  const document = getScriberDocument(
    getWorkspaceId(request, response),
    String(request.params.documentId || ""),
    getWorkspaceOptions(request, response)
  );
  if (!document) {
    throw createNotFoundError("document_not_found", "No such Scriber document.");
  }
  response.apiSuccess(document);
}));

router.post("/documents", wrapScriberHandler((request, response) => {
  const result = createScriberDocument(
    getWorkspaceId(request, response),
    getRequestBody(request),
    getWorkspaceOptions(request, response)
  );

  emitScriberMutationAuditEvent(request, response, {
    action: "create_scriber_document",
    documentId: result.document.id
  });

  response.status(201).apiSuccess(result.document);
}));

router.put("/documents/:documentId", wrapScriberHandler((request, response) => {
  const result = updateScriberDocument(
    getWorkspaceId(request, response),
    String(request.params.documentId || ""),
    getRequestBody(request),
    getWorkspaceOptions(request, response)
  );

  emitScriberMutationAuditEvent(request, response, {
    action: "update_scriber_document",
    documentId: result.document.id
  });

  response.apiSuccess(result.document);
}));

router.delete("/documents/:documentId", wrapScriberHandler((request, response) => {
  const result = deleteScriberDocument(
    getWorkspaceId(request, response),
    String(request.params.documentId || ""),
    getWorkspaceOptions(request, response)
  );

  emitScriberMutationAuditEvent(request, response, {
    action: "delete_scriber_document",
    documentId: String(request.params.documentId || ""),
    removed: result.removed
  });

  response.apiSuccess({ removed: result.removed, count: result.count });
}));

module.exports = router;
