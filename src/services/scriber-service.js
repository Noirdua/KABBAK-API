const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  scriberRoot,
  MAX_SCRIBER_DOCUMENTS,
  MAX_SCRIBER_TITLE_LENGTH,
  MAX_SCRIBER_TEXT_LENGTH
} = require("../config/scriber-storage");

const SHARED_WORKSPACE_ID = "shared";

class ScriberStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScriberStorageError";
    this.code = code;
  }
}

function resolveRootPath(options = {}) {
  return String(options.rootPath || options.scriberRoot || scriberRoot || "").trim();
}

function resolveMaxDocuments(options = {}) {
  const numericValue = Number(options.maxDocuments);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return MAX_SCRIBER_DOCUMENTS;
}

function normalizeWorkspaceId(workspaceId) {
  const normalized = String(workspaceId || "").trim();
  if (!normalized) {
    throw new ScriberStorageError("invalid_workspace", "A workspace id is required.");
  }
  return normalized;
}

function getWorkspaceFileName(workspaceId) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const safePart = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "workspace";
  const hashPart = crypto.createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8);
  return `workspace-${safePart}-${hashPart}.json`;
}

function getWorkspaceFilePath(workspaceId, options = {}) {
  return path.join(resolveRootPath(options), getWorkspaceFileName(workspaceId));
}

function readWorkspace(workspaceId, options = {}) {
  const filePath = getWorkspaceFilePath(workspaceId, options);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.documents)) {
      return parsed.documents;
    }
  } catch (_error) {
    if (_error.code !== "ENOENT") {
      throw new ScriberStorageError("workspace_unreadable", "The Scriber workspace could not be read.");
    }
  }
  return [];
}

function writeWorkspace(workspaceId, documents, options = {}) {
  const filePath = getWorkspaceFilePath(workspaceId, options);
  const payload = {
    workspaceId,
    updatedAt: new Date().toISOString(),
    documents
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function normalizeTitle(value) {
  return String(value ?? "").trim().slice(0, MAX_SCRIBER_TITLE_LENGTH);
}

function normalizeText(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length > MAX_SCRIBER_TEXT_LENGTH) {
    throw new ScriberStorageError(
      "text_too_long",
      `Scriber text is limited to ${MAX_SCRIBER_TEXT_LENGTH} characters.`
    );
  }
  return text;
}

function normalizeDocument(raw, options = {}) {
  const maxDocuments = resolveMaxDocuments(options);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScriberStorageError("invalid_document", "A Scriber document must be an object.");
  }
  const title = normalizeTitle(raw.title);
  const text = normalizeText(raw.text);
  const existingId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : new Date().toISOString();
  return { title, text, existingId, createdAt, maxDocuments };
}

function summarizeDocument(document) {
  const text = String(document?.text || "");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    wordCount: words,
    excerpt
  };
}

function getWorkspaceIdFromAuth(auth) {
  const clientId = String(auth?.clientId || "").trim();
  return clientId || SHARED_WORKSPACE_ID;
}

function listScriberDocuments(workspaceId, options = {}) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const documents = readWorkspace(normalized, options);
  return documents
    .map(summarizeDocument)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

function getScriberDocument(workspaceId, documentId, options = {}) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const normalizedId = String(documentId || "").trim();
  const documents = readWorkspace(normalized, options);
  const document = documents.find((entry) => entry.id === normalizedId) || null;
  return document ? { ...document } : null;
}

function createScriberDocument(workspaceId, body, options = {}) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const { title, text, createdAt, maxDocuments } = normalizeDocument(body, options);
  const documents = readWorkspace(normalized, options);
  if (documents.length >= maxDocuments) {
    throw new ScriberStorageError(
      "documents_limit_reached",
      `Scriber is limited to ${maxDocuments} documents per workspace.`
    );
  }

  const nowIso = new Date().toISOString();
  const document = {
    id: crypto.randomUUID(),
    title,
    text,
    createdAt,
    updatedAt: nowIso
  };
  documents.push(document);
  writeWorkspace(normalized, documents, options);
  return { document: { ...document } };
}

function updateScriberDocument(workspaceId, documentId, body, options = {}) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const normalizedId = String(documentId || "").trim();
  const { title, text } = normalizeDocument(body, options);
  const documents = readWorkspace(normalized, options);
  const index = documents.findIndex((entry) => entry.id === normalizedId);
  if (index < 0) {
    throw new ScriberStorageError("document_not_found", "No such Scriber document.");
  }

  const updated = {
    ...documents[index],
    title,
    text,
    updatedAt: new Date().toISOString()
  };
  documents[index] = updated;
  writeWorkspace(normalized, documents, options);
  return { document: { ...updated } };
}

function deleteScriberDocument(workspaceId, documentId, options = {}) {
  const normalized = normalizeWorkspaceId(workspaceId);
  const normalizedId = String(documentId || "").trim();
  const documents = readWorkspace(normalized, options);
  const next = documents.filter((entry) => entry.id !== normalizedId);
  const removed = next.length !== documents.length;
  if (removed) {
    writeWorkspace(normalized, next, options);
  }
  return { removed, count: next.length };
}

module.exports = {
  SHARED_WORKSPACE_ID,
  ScriberStorageError,
  createScriberDocument,
  deleteScriberDocument,
  getScriberDocument,
  getWorkspaceIdFromAuth,
  listScriberDocuments,
  updateScriberDocument
};
