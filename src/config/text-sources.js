const fs = require("fs");
const path = require("path");

const {
  sourceTextDataRoot,
  generatedTextSourceRegistryPath,
  textLibraryRegistryPath
} = require("./paths");

const baseTextSourceDefinitions = [];

function normalizeDocumentId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getTextSourceDocumentKey(sourceId) {
  const normalized = normalizeDocumentId(sourceId);
  return normalized ? `textSource:${normalized}` : "";
}

function getTextReferenceDocumentKey(referenceId) {
  const normalized = normalizeDocumentId(referenceId);
  return normalized ? `textReference:${normalized}` : "";
}

function getTextLexiconDocumentKey(referenceId) {
  const normalized = normalizeDocumentId(referenceId);
  return normalized ? `textLexicon:${normalized}` : "";
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    console.warn(`[text-sources] Failed to read ${registryPath}: ${error.message}`);
    return null;
  }
}

function normalizeSourceDefinition(source, defaultFormat) {
  return {
    id: normalizeDocumentId(source?.id),
    filePath: path.join(sourceTextDataRoot, String(source?.fileName || `${source?.id}.json`)),
    format: String(source?.format || defaultFormat).trim(),
    title: String(source?.title || "").trim(),
    shortTitle: String(source?.shortTitle || source?.title || "").trim(),
    description: String(source?.description || "").trim(),
    tradition: String(source?.tradition || "").trim(),
    language: String(source?.language || "").trim(),
    script: String(source?.script || "").trim(),
    workLabel: String(source?.workLabel || "Text").trim(),
    sectionLabel: String(source?.sectionLabel || "Chapter").trim(),
    verseLabel: String(source?.verseLabel || "Verse").trim(),
    referenceIds: Array.isArray(source?.referenceIds) ? source.referenceIds.map(normalizeDocumentId).filter(Boolean) : []
  };
}

// Curated documents that already live in source/data/text, registered by library.json.
function loadLibraryTextSourceDefinitions() {
  const parsed = readRegistry(textLibraryRegistryPath);
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  return sources
    .map((source) => normalizeSourceDefinition(source, "structured-json"))
    .filter((source) => source.id && source.title);
}

function normalizeReferenceDefinition(reference) {
  return {
    id: normalizeDocumentId(reference?.id),
    filePath: path.join(sourceTextDataRoot, String(reference?.fileName || `${reference?.id}.json`)),
    title: String(reference?.title || "").trim(),
    description: String(reference?.description || "").trim(),
    kind: String(reference?.kind || "dictionary").trim(),
    keyScheme: String(reference?.keyScheme || "word").trim()
  };
}

function loadLibraryTextReferenceDefinitions() {
  const parsed = readRegistry(textLibraryRegistryPath);
  const references = Array.isArray(parsed?.references) ? parsed.references : [];
  return references
    .map((reference) => normalizeReferenceDefinition(reference))
    .filter((reference) => reference.id && reference.title);
}

// Documents produced by the importer from imports/text and source/imports/text.
function loadGeneratedTextSourceDefinitions() {
  const parsed = readRegistry(generatedTextSourceRegistryPath);
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  return sources
    .map((source) => normalizeSourceDefinition(source, "structured-json"))
    .filter((source) => source.id && source.title);
}

function dedupeById(definitions) {
  const seen = new Set();
  return definitions.filter((definition) => {
    if (seen.has(definition.id)) {
      console.warn(`[text-sources] Ignoring duplicate text source id '${definition.id}'.`);
      return false;
    }
    seen.add(definition.id);
    return true;
  });
}

function getBaseTextSourceDefinitions() {
  return dedupeById([...baseTextSourceDefinitions, ...loadLibraryTextSourceDefinitions()]);
}

function getTextSourceDefinitions() {
  return dedupeById([...getBaseTextSourceDefinitions(), ...loadGeneratedTextSourceDefinitions()]);
}

function getTextReferenceDefinitions() {
  return dedupeById(loadLibraryTextReferenceDefinitions());
}

module.exports = {
  getBaseTextSourceDefinitions,
  getTextSourceDefinitions,
  getTextReferenceDefinitions,
  normalizeDocumentId,
  getTextSourceDocumentKey,
  getTextReferenceDocumentKey,
  getTextLexiconDocumentKey
};