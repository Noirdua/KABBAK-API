const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const {
  sourceTextDataRoot,
  generatedTextSourceRegistryPath,
  textLibraryRegistryPath
} = require("../config/paths");

const { normalizeDocumentId } = require("../config/text-sources");

const REGISTRY_SCHEMA = 2;
const STRONGS_KEY_PATTERN = /^[HG]\d+$/i;
const REFERENCE_ENTRY_FIELDS = ["title", "definition", "body", "text", "description", "entry", "gloss", "lemma", "xlit", "pron"];

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Sample the first entries rather than the whole document; these files are large.
function sampleValues(document, limit = 12) {
  return Object.keys(document).slice(0, limit).map((key) => ({ key, value: document[key] }));
}

function looksLikeStrongsReference(document) {
  const sample = sampleValues(document);
  if (sample.length < 3) return false;
  const keyed = sample.filter((entry) => STRONGS_KEY_PATTERN.test(entry.key)).length;
  const objectValues = sample.filter((entry) => isPlainObject(entry.value)).length;
  return keyed / sample.length >= 0.8 && objectValues === sample.length;
}

function looksLikeKeyedReference(document) {
  const sample = sampleValues(document);
  if (sample.length < 3) return false;
  const objectValues = sample.filter((entry) => isPlainObject(entry.value));
  if (objectValues.length !== sample.length) return false;
  return sample.some((entry) => (
    REFERENCE_ENTRY_FIELDS.some((field) => {
      const value = entry.value?.[field];
      return value !== undefined && String(value).trim();
    })
  ));
}

function looksLikeTokenizedBooks(document) {
  const sample = sampleValues(document, 4);
  if (!sample.length) return false;
  return sample.every(({ value }) => {
    if (!isPlainObject(value)) return false;
    const chapters = Object.values(value).slice(0, 3);
    if (!chapters.length) return false;
    return chapters.every((chapter) => {
      if (!isPlainObject(chapter)) return false;
      return Object.values(chapter).slice(0, 3).every((verse) => Array.isArray(verse));
    });
  });
}

function classifyDocument(document) {
  if (!isPlainObject(document)) return null;
  if (document.type === "structured-text-source" || Array.isArray(document.works)) {
    return { kind: "source", format: "structured-json" };
  }
  if (looksLikeStrongsReference(document)) return { kind: "reference", keyScheme: "strongs" };
  if (looksLikeKeyedReference(document)) return { kind: "reference", keyScheme: "word" };
  if (looksLikeTokenizedBooks(document)) return { kind: "source", format: "tokenized-books" };
  return null;
}

function describeSource(fileName, document, format) {
  const baseName = fileName.replace(/\.json$/i, "");
  const title = normalizeWhitespace(document?.title) || baseName;
  const metadata = isPlainObject(document?.metadata) ? document.metadata : {};
  return {
    id: normalizeDocumentId(baseName),
    fileName,
    format,
    title,
    shortTitle: normalizeWhitespace(document?.shortTitle) || title,
    description: normalizeWhitespace(document?.description || metadata.subtitle),
    tradition: normalizeWhitespace(metadata.tradition),
    language: normalizeWhitespace(metadata.language) || "English",
    script: normalizeWhitespace(metadata.script) || "Latin",
    workLabel: normalizeWhitespace(metadata.workLabel) || "Book",
    sectionLabel: normalizeWhitespace(metadata.sectionLabel) || "Chapter",
    verseLabel: normalizeWhitespace(metadata.verseLabel) || "Verse",
    referenceIds: []
  };
}

function describeReference(fileName, document, keyScheme) {
  const baseName = fileName.replace(/\.json$/i, "");
  if (keyScheme === "strongs") {
    return {
      id: "strongs",
      fileName,
      title: "Strong's Concordance",
      description: "Strong's Hebrew and Greek dictionary entries keyed by Strong's number.",
      kind: "lexicon",
      keyScheme
    };
  }
  return {
    id: normalizeDocumentId(baseName),
    fileName,
    title: baseName.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    description: "",
    kind: "dictionary",
    keyScheme
  };
}

// Hand-edited fields always win, so a rescan never overwrites curated metadata.
function mergeEntry(existing, detected) {
  if (!existing) return detected;
  const merged = { ...detected };
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.fileName = detected.fileName;
  return merged;
}

async function readGeneratedFileNames() {
  if (!fsSync.existsSync(generatedTextSourceRegistryPath)) return new Set();
  try {
    const parsed = await readJson(generatedTextSourceRegistryPath);
    const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
    return new Set(sources.map((source) => String(source?.fileName || `${source?.id}.json`).toLowerCase()));
  } catch {
    return new Set();
  }
}

async function readExistingRegistry() {
  if (!fsSync.existsSync(textLibraryRegistryPath)) return { sources: [], references: [] };
  try {
    const parsed = await readJson(textLibraryRegistryPath);
    return {
      sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
      references: Array.isArray(parsed?.references) ? parsed.references : []
    };
  } catch (error) {
    console.warn(`[text-library] Could not read library.json, rebuilding it: ${error.message}`);
    return { sources: [], references: [] };
  }
}

async function scanTextLibrary() {
  if (!fsSync.existsSync(sourceTextDataRoot)) {
    return { sources: [], references: [], skipped: [] };
  }

  const existing = await readExistingRegistry();
  const existingSourceByFile = new Map(existing.sources.map((entry) => [String(entry?.fileName || "").toLowerCase(), entry]));
  const existingReferenceByFile = new Map(existing.references.map((entry) => [String(entry?.fileName || "").toLowerCase(), entry]));
  const generatedFileNames = await readGeneratedFileNames();
  const libraryFileName = path.basename(textLibraryRegistryPath).toLowerCase();

  const sources = [];
  const references = [];
  const skipped = [];

  const entries = await fs.readdir(sourceTextDataRoot, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const key = entry.name.toLowerCase();
    if (key === libraryFileName || generatedFileNames.has(key)) continue;

    let document;
    try {
      document = await readJson(path.join(sourceTextDataRoot, entry.name));
    } catch (error) {
      skipped.push({ fileName: entry.name, reason: `unreadable JSON (${error.message})` });
      continue;
    }

    const classification = classifyDocument(document);
    if (!classification) {
      skipped.push({ fileName: entry.name, reason: "unrecognized shape" });
      continue;
    }

    if (classification.kind === "reference") {
      references.push(mergeEntry(
        existingReferenceByFile.get(key),
        describeReference(entry.name, document, classification.keyScheme)
      ));
    } else {
      sources.push(mergeEntry(existingSourceByFile.get(key), describeSource(entry.name, document, classification.format)));
    }
  }

  // Interlinear sources are useless without a reference to look their tokens up
  // against, so link any tokenized-books source to the strongs reference(s) by
  // default. Sources that already declare referenceIds keep their explicit links.
  const strongsReferenceIds = references
    .filter((reference) => reference.keyScheme === "strongs")
    .map((reference) => reference.id);
  for (const source of sources) {
    if (source.format === "tokenized-books" && !source.referenceIds.length) {
      source.referenceIds = [...strongsReferenceIds];
    }
  }

  sources.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  references.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return { sources, references, skipped };
}

async function writeTextLibraryRegistry({ sources, references }) {
  const registry = {
    schemaVersion: REGISTRY_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceCount: sources.length,
    referenceCount: references.length,
    sources,
    references
  };
  await fs.mkdir(sourceTextDataRoot, { recursive: true });
  await fs.writeFile(textLibraryRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

async function refreshTextLibraryRegistry() {
  const scan = await scanTextLibrary();
  await writeTextLibraryRegistry(scan);
  return scan;
}

module.exports = {
  classifyDocument,
  refreshTextLibraryRegistry,
  scanTextLibrary,
  writeTextLibraryRegistry
};
