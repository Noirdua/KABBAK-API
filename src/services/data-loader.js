const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { databasePath } = require("../config/paths");
const {
  getTextSourceDocumentKey,
  getTextReferenceDocumentKey,
  getTextLexiconDocumentKey
} = require("../config/text-sources");

function normalizeCatalogSource(source) {
  if (!source || typeof source !== "object") {
    return source;
  }

  const features = source.features && typeof source.features === "object" ? { ...source.features } : {};
  const referenceIds = Array.isArray(features.referenceIds) ? features.referenceIds.filter(Boolean) : [];
  const lexiconIds = Array.isArray(features.lexiconIds) ? features.lexiconIds.filter(Boolean) : [];
  if (!referenceIds.length && lexiconIds.length) {
    features.referenceIds = [...lexiconIds];
  }

  return { ...source, features };
}

function normalizeCatalogReference(reference) {
  if (!reference || typeof reference !== "object") {
    return reference;
  }

  const id = String(reference.id || "").trim();
  return {
    ...reference,
    kind: String(reference.kind || "lexicon").trim() || "lexicon",
    keyScheme: String(reference.keyScheme || (id.toLowerCase() === "strongs" ? "strongs" : "word")).trim()
  };
}

function normalizeTextCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") {
    return catalog;
  }

  const sources = (Array.isArray(catalog.sources) ? catalog.sources : []).map(normalizeCatalogSource);
  let references = Array.isArray(catalog.references) ? catalog.references.map(normalizeCatalogReference) : [];
  if (!references.length && Array.isArray(catalog.lexicons)) {
    references = catalog.lexicons.map(normalizeCatalogReference);
  }

  return {
    ...catalog,
    sources,
    references,
    meta: {
      ...(catalog.meta && typeof catalog.meta === "object" ? catalog.meta : {}),
      sourceCount: sources.length,
      referenceCount: references.length
    }
  };
}

function normalizeTextReferenceDocument(document) {
  if (!document || typeof document !== "object") {
    return document;
  }

  const id = String(document.id || "").trim();
  return {
    ...document,
    kind: String(document.kind || "lexicon").trim() || "lexicon",
    keyScheme: String(document.keyScheme || (id.toLowerCase() === "strongs" ? "strongs" : "word")).trim()
  };
}

function resolveDatabasePath() {
  const markerPath = databasePath + ".active";
  try {
    const activePath = fs.readFileSync(markerPath, "utf8").trim();
    if (activePath && fs.existsSync(activePath)) {
      return activePath;
    }
  } catch {}

  return databasePath;
}

const cache = {
  referenceData: null,
  magickManifest: null,
  magickDataset: null,
  deckRegistry: null,
  gematriaWordIndex: null,
  anagramWordIndex: null,
  dictionaryEnglish: null,
  dictionaryHebrew: null,
  dictionaryGreek: null,
  textCatalog: null,
  textSourceById: new Map(),
  textReferenceById: new Map(),
  deckManifestById: new Map()
};

const TEXT_SOURCE_CACHE_MAX = 8;

let database = null;
let readDocumentStatement = null;
let readDeckManifestStatement = null;

function createStorageAvailabilityError(key) {
  const error = new Error(`Required document '${key}' is missing from the storage snapshot.`);
  error.status = 503;
  error.code = "storage_unavailable";
  return error;
}

function ensureDatabase() {
  if (database) {
    return database;
  }

  const resolvedPath = resolveDatabasePath();

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`SQLite database not found at ${resolvedPath}. Run npm run migrate:data before starting the API.`);
  }

  database = new DatabaseSync(resolvedPath, { readOnly: true });
  readDocumentStatement = database.prepare("SELECT json FROM documents WHERE key = ? LIMIT 1");
  readDeckManifestStatement = database.prepare("SELECT json FROM deck_manifests WHERE deck_id = ? LIMIT 1");
  return database;
}

function readDocument(key) {
  ensureDatabase();
  const row = readDocumentStatement.get(String(key || ""));
  return row?.json ? JSON.parse(row.json) : null;
}

function loadOptionalDocument(key) {
  try {
    return readDocument(key);
  } catch (_error) {
    return null;
  }
}

function openReadOnlyDatabase() {
  const resolvedPath = resolveDatabasePath();
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }
  return new DatabaseSync(resolvedPath, { readOnly: true });
}

function rememberTextSource(key, value) {
  if (cache.textSourceById.has(key)) {
    cache.textSourceById.delete(key);
  }
  cache.textSourceById.set(key, value);
  while (cache.textSourceById.size > TEXT_SOURCE_CACHE_MAX) {
    const oldest = cache.textSourceById.keys().next().value;
    cache.textSourceById.delete(oldest);
  }
}

function readRequiredDocument(key) {
  const document = readDocument(key);
  if (document == null) {
    throw createStorageAvailabilityError(key);
  }

  return document;
}

function readDeckManifest(deckId) {
  ensureDatabase();
  const row = readDeckManifestStatement.get(String(deckId || "").trim().toLowerCase());
  return row?.json ? JSON.parse(row.json) : null;
}

async function loadMagickManifest() {
  if (!cache.magickManifest) {
    cache.magickManifest = readRequiredDocument("magickManifest");
  }

  return cache.magickManifest;
}

async function loadMagickDataset() {
  if (!cache.magickDataset) {
    cache.magickDataset = readRequiredDocument("magickDataset");
  }

  return cache.magickDataset;
}

async function loadReferenceData() {
  if (!cache.referenceData) {
    cache.referenceData = readRequiredDocument("referenceData");
  }

  return cache.referenceData;
}

async function loadDeckRegistry() {
  if (!cache.deckRegistry) {
    cache.deckRegistry = readRequiredDocument("deckRegistry");
  }

  return cache.deckRegistry;
}

async function loadGematriaWordIndex() {
  if (!cache.gematriaWordIndex) {
    cache.gematriaWordIndex = readRequiredDocument("gematriaWordIndex");
  }

  return cache.gematriaWordIndex;
}

async function loadAnagramWordIndex() {
  if (!cache.anagramWordIndex) {
    cache.anagramWordIndex = readRequiredDocument("anagramWordIndex");
  }

  return cache.anagramWordIndex;
}

async function loadEnglishDictionary() {
  if (cache.dictionaryEnglish === null) {
    cache.dictionaryEnglish = readDocument("dictionaryEnglish");
  }

  return cache.dictionaryEnglish;
}

async function loadHebrewDictionary() {
  if (cache.dictionaryHebrew === null) {
    cache.dictionaryHebrew = readDocument("dictionaryHebrew");
  }

  return cache.dictionaryHebrew;
}

async function loadGreekDictionary() {
  if (cache.dictionaryGreek === null) {
    cache.dictionaryGreek = readDocument("dictionaryGreek");
  }

  return cache.dictionaryGreek;
}

async function loadTextCatalog() {
  if (!cache.textCatalog) {
    cache.textCatalog = normalizeTextCatalog(readRequiredDocument("textCatalog"));
  }

  return cache.textCatalog;
}

async function loadTextSource(sourceId) {
  const key = String(getTextSourceDocumentKey(sourceId) || "").trim();
  if (!key) {
    return null;
  }

  if (cache.textSourceById.has(key)) {
    const cached = cache.textSourceById.get(key);
    rememberTextSource(key, cached);
    return cached;
  }

  rememberTextSource(key, readDocument(key));
  return cache.textSourceById.get(key);
}

async function loadTextReference(referenceId) {
  const key = String(getTextReferenceDocumentKey(referenceId) || "").trim();
  if (!key) {
    return null;
  }

  if (!cache.textReferenceById.has(key)) {
    const legacyKey = String(getTextLexiconDocumentKey(referenceId) || "").trim();
    const document = readDocument(key) || (legacyKey ? readDocument(legacyKey) : null);
    cache.textReferenceById.set(key, normalizeTextReferenceDocument(document));
  }

  return cache.textReferenceById.get(key);
}

async function loadDeckManifest(deckId) {
  const key = String(deckId || "").trim().toLowerCase();
  if (!key) {
    return null;
  }

  if (!cache.deckManifestById.has(key)) {
    cache.deckManifestById.set(key, readDeckManifest(key));
  }

  return cache.deckManifestById.get(key);
}

process.once("exit", () => {
  if (database) {
    database.close();
  }
});

function resetCaches() {
  if (database) {
    try {
      database.close();
    } catch (_error) {}
  }
  database = null;
  readDocumentStatement = null;
  readDeckManifestStatement = null;

  cache.referenceData = null;
  cache.magickManifest = null;
  cache.magickDataset = null;
  cache.deckRegistry = null;
  cache.gematriaWordIndex = null;
  cache.anagramWordIndex = null;
  cache.dictionaryEnglish = null;
  cache.dictionaryHebrew = null;
  cache.dictionaryGreek = null;
  cache.textCatalog = null;
  cache.textSourceById.clear();
  cache.textReferenceById.clear();
  cache.deckManifestById.clear();
}

function checkDatabaseConnectivity() {
  try {
    ensureDatabase();
    readDocumentStatement.get("referenceData");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  loadReferenceData,
  loadMagickManifest,
  loadMagickDataset,
  loadDeckRegistry,
  loadGematriaWordIndex,
  loadAnagramWordIndex,
  loadEnglishDictionary,
  loadHebrewDictionary,
  loadGreekDictionary,
  loadTextCatalog,
  loadTextSource,
  loadTextReference,
  loadDeckManifest,
  loadOptionalDocument,
  openReadOnlyDatabase,
  checkDatabaseConnectivity,
  resetCaches
};
