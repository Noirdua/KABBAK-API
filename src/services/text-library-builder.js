const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const {
  getTextSourceDefinitions,
  getTextReferenceDefinitions
} = require("../config/text-sources");

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function buildVerseReference(rawReference, workTitle, sectionNumber, verseNumber) {
  return normalizeWhitespace(rawReference) || `${workTitle} ${sectionNumber}:${verseNumber}`;
}

function normalizeStructuredToken(token, tokenIndex) {
  if (!token || typeof token !== "object") {
    return null;
  }

  const gloss = normalizeWhitespace(token.gloss);
  const original = normalizeWhitespace(token.original);
  const strongs = [...new Set(
    (Array.isArray(token.strongs) ? token.strongs : [])
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean)
  )];

  if (!gloss && !original && !strongs.length) {
    return null;
  }

  return {
    index: toPositiveInteger(token.index, tokenIndex + 1),
    ...(gloss ? { gloss } : {}),
    ...(original ? { original } : {}),
    ...(strongs.length ? { strongs } : {})
  };
}

function createLegacyToken(entry, tokenIndex) {
  const rawStrongs = Array.isArray(entry) ? entry[2] : [];
  const gloss = normalizeWhitespace(Array.isArray(entry) ? entry[0] : "");
  const original = normalizeWhitespace(Array.isArray(entry) ? entry[1] : "");
  const strongs = [...new Set(
    (Array.isArray(rawStrongs) ? rawStrongs : [])
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean)
  )];

  if (!gloss && !original && !strongs.length) {
    return null;
  }

  return {
    index: tokenIndex + 1,
    ...(gloss ? { gloss } : {}),
    ...(original ? { original } : {}),
    ...(strongs.length ? { strongs } : {})
  };
}

function createStructuredVerse({ id, number, reference, text, originalText, tokens, metadata }) {
  const normalizedTokens = (Array.isArray(tokens) ? tokens : [])
    .map((token, tokenIndex) => normalizeStructuredToken(token, tokenIndex))
    .filter(Boolean);
  const normalizedText = normalizeWhitespace(text) || buildTokenGloss(normalizedTokens);
  if (!normalizedText && !normalizedTokens.length) {
    return null;
  }

  const normalizedOriginalText = normalizeWhitespace(originalText);
  const hasMetadata = metadata && typeof metadata === "object" && Object.keys(metadata).length;

  return {
    id: String(id || number || "").trim() || String(number || "1"),
    ...(Number.isFinite(Number(number)) ? { number: Number(number) } : {}),
    reference: normalizeWhitespace(reference),
    text: normalizedText,
    ...(normalizedOriginalText ? { originalText: normalizedOriginalText } : {}),
    ...(normalizedTokens.length ? { tokens: normalizedTokens } : {}),
    ...(hasMetadata ? { metadata } : {})
  };
}

function buildTokenGloss(tokens) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((token) => token?.gloss || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function createSectionRecord({ id, number, label, title, verses, metadata }) {
  const normalizedVerses = (Array.isArray(verses) ? verses : []).filter(Boolean);
  if (!normalizedVerses.length) {
    return null;
  }

  const hasMetadata = metadata && typeof metadata === "object" && Object.keys(metadata).length;

  return {
    id,
    number,
    label,
    title,
    verseCount: normalizedVerses.length,
    verses: normalizedVerses,
    ...(hasMetadata ? { metadata } : {})
  };
}

function createWorkRecord({ id, title, shortTitle, order, sections, metadata }) {
  const normalizedSections = (Array.isArray(sections) ? sections : []).filter(Boolean);
  if (!normalizedSections.length) {
    return null;
  }

  const hasMetadata = metadata && typeof metadata === "object" && Object.keys(metadata).length;

  return {
    id,
    title,
    shortTitle: shortTitle || title,
    order,
    sectionCount: normalizedSections.length,
    verseCount: normalizedSections.reduce((sum, section) => sum + Number(section?.verseCount || 0), 0),
    sections: normalizedSections,
    ...(hasMetadata ? { metadata } : {})
  };
}

function buildSourceStats(works) {
  const normalizedWorks = Array.isArray(works) ? works : [];
  return {
    workCount: normalizedWorks.length,
    sectionCount: normalizedWorks.reduce((sum, work) => sum + Number(work?.sectionCount || 0), 0),
    verseCount: normalizedWorks.reduce((sum, work) => sum + Number(work?.verseCount || 0), 0)
  };
}

function buildSourceMetadata(rawSource, extraMetadata = {}) {
  return {
    ...(rawSource?.last_modified ? { lastModified: normalizeWhitespace(rawSource.last_modified) } : {}),
    ...(rawSource?.version != null ? { version: rawSource.version } : {}),
    ...(rawSource?.subtitle ? { subtitle: normalizeWhitespace(rawSource.subtitle) } : {}),
    ...(rawSource?.full_subtitle ? { fullSubtitle: normalizeWhitespace(rawSource.full_subtitle) } : {}),
    ...(rawSource?.lds_slug ? { slug: normalizeWhitespace(rawSource.lds_slug) } : {}),
    ...extraMetadata
  };
}

function hasTokenAnnotations(works) {
  return (Array.isArray(works) ? works : []).some((work) =>
    (Array.isArray(work?.sections) ? work.sections : []).some((section) =>
      (Array.isArray(section?.verses) ? section.verses : []).some((verse) => Array.isArray(verse?.tokens) && verse.tokens.length)
    )
  );
}

function finalizeSource(definition, rawSource, works, extraMetadata = {}) {
  const normalizedWorks = (Array.isArray(works) ? works : []).filter(Boolean);
  const title = normalizeWhitespace(rawSource?.title) || definition.title;
  const description = definition.description || normalizeWhitespace(rawSource?.subtitle) || "";

  return {
    id: definition.id,
    title,
    shortTitle: definition.shortTitle || title,
    description,
    tradition: definition.tradition || "",
    language: definition.language || "",
    script: definition.script || "",
    workLabel: definition.workLabel || "Book",
    sectionLabel: definition.sectionLabel || "Chapter",
    verseLabel: definition.verseLabel || "Verse",
    features: {
      hasTokenAnnotations: hasTokenAnnotations(normalizedWorks),
      referenceIds: Array.isArray(definition.referenceIds) ? definition.referenceIds : []
    },
    metadata: buildSourceMetadata(rawSource, extraMetadata),
    stats: buildSourceStats(normalizedWorks),
    works: normalizedWorks
  };
}

function buildCatalogSource(source) {
  return {
    id: source.id,
    title: source.title,
    shortTitle: source.shortTitle,
    description: source.description,
    tradition: source.tradition,
    language: source.language,
    script: source.script,
    workLabel: source.workLabel,
    sectionLabel: source.sectionLabel,
    verseLabel: source.verseLabel,
    features: source.features,
    metadata: source.metadata,
    stats: source.stats,
    works: (Array.isArray(source.works) ? source.works : []).map((work) => ({
      id: work.id,
      title: work.title,
      shortTitle: work.shortTitle,
      order: work.order,
      sectionCount: work.sectionCount,
      verseCount: work.verseCount,
      sections: (Array.isArray(work.sections) ? work.sections : []).map((section) => ({
        id: section.id,
        number: section.number,
        label: section.label,
        title: section.title,
        verseCount: section.verseCount
      }))
    }))
  };
}

function buildReferenceSummary(reference, sources) {
  const sourceIds = (Array.isArray(sources) ? sources : [])
    .filter((source) => Array.isArray(source?.features?.referenceIds) && source.features.referenceIds.includes(reference.id))
    .map((source) => source.id);

  return {
    id: reference.id,
    title: reference.title,
    description: reference.description,
    kind: reference.kind,
    keyScheme: reference.keyScheme,
    entryCount: reference.entryCount,
    sourceIds
  };
}

function normalizeStructuredJsonSource(definition, rawSource) {
  const works = (Array.isArray(rawSource?.works) ? rawSource.works : []).map((work, workIndex) => {
    const workTitle = normalizeWhitespace(work?.title) || `Work ${workIndex + 1}`;
    const workShortTitle = normalizeWhitespace(work?.shortTitle) || workTitle;
    const sections = (Array.isArray(work?.sections) ? work.sections : []).map((section, sectionIndex) => {
      const sectionNumber = toPositiveInteger(section?.number, sectionIndex + 1);
      const sectionLabel = normalizeWhitespace(section?.label) || `${definition.sectionLabel} ${sectionNumber}`;
      const sectionTitle = normalizeWhitespace(section?.title) || sectionLabel;
      const verses = (Array.isArray(section?.verses) ? section.verses : []).map((verse, verseIndex) => {
        const verseNumber = verse?.number ?? verse?.verse ?? verseIndex + 1;
        return createStructuredVerse({
          id: verse?.id,
          number: verseNumber,
          reference: verse?.reference || buildVerseReference("", workTitle, sectionNumber, verseNumber),
          text: verse?.text,
          originalText: verse?.originalText,
          tokens: verse?.tokens,
          metadata: verse?.metadata
        });
      }).filter(Boolean);

      return createSectionRecord({
        id: String(section?.id || sectionNumber),
        number: sectionNumber,
        label: sectionLabel,
        title: sectionTitle,
        verses,
        metadata: section?.metadata
      });
    }).filter(Boolean);

    return createWorkRecord({
      id: String(work?.id || slugify(workShortTitle) || `work-${workIndex + 1}`),
      title: workTitle,
      shortTitle: workShortTitle,
      order: toPositiveInteger(work?.order, workIndex + 1),
      sections,
      metadata: work?.metadata
    });
  }).filter(Boolean);

  const extraMetadata = {
    ...((rawSource?.metadata && typeof rawSource.metadata === "object") ? rawSource.metadata : {}),
    ...(rawSource?.schemaVersion != null ? { schemaVersion: rawSource.schemaVersion } : {}),
    ...(rawSource?.type ? { sourceType: normalizeWhitespace(rawSource.type) } : {})
  };

  return finalizeSource(definition, rawSource, works, extraMetadata);
}

function normalizeTokenizedBooksSource(definition, rawSource) {
  const works = Object.entries(rawSource && typeof rawSource === "object" ? rawSource : {}).map(([workKey, rawSections], workIndex) => {
    const workTitle = normalizeWhitespace(workKey);
    if (!workTitle) {
      return null;
    }

    const sections = Object.entries(rawSections && typeof rawSections === "object" ? rawSections : {}).map(([sectionKey, rawVerses]) => {
      const sectionNumber = toPositiveInteger(sectionKey, 1);
      const verses = Object.entries(rawVerses && typeof rawVerses === "object" ? rawVerses : {}).map(([verseKey, rawTokens]) => {
        const verseNumber = toPositiveInteger(verseKey, 1);
        const tokens = (Array.isArray(rawTokens) ? rawTokens : [])
          .map((entry, tokenIndex) => createLegacyToken(entry, tokenIndex))
          .filter(Boolean);

        return createStructuredVerse({
          id: verseNumber,
          number: verseNumber,
          reference: `${workTitle} ${sectionNumber}:${verseNumber}`,
          tokens
        });
      }).filter(Boolean)
        .sort((left, right) => Number(left.number || 0) - Number(right.number || 0));

      return createSectionRecord({
        id: String(sectionNumber),
        number: sectionNumber,
        label: `${definition.sectionLabel || "Chapter"} ${sectionNumber}`,
        title: `${workTitle} ${sectionNumber}`,
        verses
      });
    }).filter(Boolean)
      .sort((left, right) => Number(left.number || 0) - Number(right.number || 0));

    return createWorkRecord({
      id: slugify(workTitle) || `work-${workIndex + 1}`,
      title: workTitle,
      shortTitle: workTitle,
      order: workIndex + 1,
      sections
    });
  }).filter(Boolean);

  return finalizeSource(definition, {}, works);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.substring(1) : raw;
  return JSON.parse(stripped);
}

async function buildTextSource(definition) {
  if (definition.format === "structured-json") {
    const rawSource = await readJson(definition.filePath);
    return normalizeStructuredJsonSource(definition, rawSource);
  }

  if (definition.format === "tokenized-books") {
    const rawSource = await readJson(definition.filePath);
    return normalizeTokenizedBooksSource(definition, rawSource);
  }

  if (definition.format === "works-directory") {
    return await buildWorksDirectorySource(definition);
  }

  throw new Error(`Unsupported text source format '${definition.format}' for ${definition.id}.`);
}

async function buildWorksDirectorySource(definition) {
  const dir = definition.filePath;
  if (!fsSync.existsSync(dir)) {
    throw new Error(`Works directory not found for '${definition.id}': ${dir}`);
  }

  const entries = fsSync.readdirSync(dir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name)
    .sort();

  if (!jsonFiles.length) {
    throw new Error(`No JSON files found in works directory for '${definition.id}': ${dir}`);
  }

  const works = [];
  for (const fileName of jsonFiles) {
    const filePath = path.join(dir, fileName);
    const raw = await readJson(filePath);
    const partial = normalizeStructuredJsonSource(definition, raw);
    if (Array.isArray(partial.works)) {
      for (const work of partial.works) {
        works.push(work);
      }
    }
    raw.works = null;
    raw.useOfRaw = null;
  }

  return {
    ...normalizeStructuredJsonSource(definition, { works: [] }),
    works
  };
}

async function buildTextReference(definition) {
  const entries = await readJson(definition.filePath);
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    kind: definition.kind,
    keyScheme: definition.keyScheme,
    entryCount: Object.keys(entries && typeof entries === "object" ? entries : {}).length,
    entries: entries && typeof entries === "object" ? entries : {}
  };
}

async function buildTextLibrarySnapshot() {
  const generatedAt = new Date().toISOString();
  const textSourceDefinitions = getTextSourceDefinitions();
  const textReferenceDefinitions = getTextReferenceDefinitions();
  // Tokenized interlinear sources key their tokens by Strong's numbers, so only
  // strongs-keyed references are candidates for the default link.
  const strongsReferenceIds = textReferenceDefinitions
    .filter((reference) => reference.keyScheme === "strongs")
    .map((reference) => reference.id);
  const sourceEntries = [];
  for (const definition of textSourceDefinitions) {
    try {
      const source = await buildTextSource(definition);
      // Interlinear sources are useless without a reference to look their tokens
      // up against, so wire any annotated source to the strongs reference(s) by default.
      if (source?.features?.hasTokenAnnotations && !source.features.referenceIds.length) {
        source.features.referenceIds = [...strongsReferenceIds];
      }
      sourceEntries.push([definition.id, source]);
    } catch (error) {
      console.error(`[text-library] Failed to build text source '${definition.id}': ${error.message}`);
      sourceEntries.push([definition.id, null]);
    }
  }
  const sources = sourceEntries
    .map(([, source]) => source)
    .filter(Boolean);

  const referenceEntries = [];
  for (const definition of textReferenceDefinitions) {
    try {
      referenceEntries.push([definition.id, await buildTextReference(definition)]);
    } catch (error) {
      console.error(`[text-library] Failed to build reference '${definition.id}': ${error.message}`);
      referenceEntries.push([definition.id, null]);
    }
  }
  const references = referenceEntries
    .map(([, reference]) => reference)
    .filter(Boolean);

  return {
    catalog: {
      meta: {
        generatedAt,
        sourceCount: sources.length,
        referenceCount: references.length,
        verseCount: sources.reduce((sum, source) => sum + Number(source?.stats?.verseCount || 0), 0)
      },
      sources: sources.map((source) => buildCatalogSource(source)),
      references: references.map((reference) => buildReferenceSummary(reference, sources))
    },
    sources: Object.fromEntries(sourceEntries),
    references: Object.fromEntries(referenceEntries)
  };
}

module.exports = {
  buildTextLibrarySnapshot
};