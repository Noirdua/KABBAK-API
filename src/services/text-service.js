const {
  normalizeDocumentId
} = require("../config/text-sources");
const {
  loadTextCatalog,
  loadTextSource,
  loadTextReference
} = require("./data-loader");
const { createHttpError } = require("../lib/http-errors");
const { escapeRegExp } = require("../lib/string-utils");

function getCatalogSources(catalog) {
  return Array.isArray(catalog?.sources) ? catalog.sources : [];
}

function decorateReferenceDisplay(reference) {
  if (!reference || typeof reference !== "object") {
    return reference;
  }
  if (reference.fieldConfig && typeof reference.fieldConfig === "object") {
    return reference;
  }
  let extra = null;
  try {
    extra = require("./dlc-catalog").readReferenceDisplayConfig(reference.id);
  } catch (_error) {
    extra = null;
  }
  if (!extra) {
    return reference;
  }
  return { ...reference, ...extra };
}

function getCatalogReferences(catalog) {
  return (Array.isArray(catalog?.references) ? catalog.references : []).map(decorateReferenceDisplay);
}

function normalizeLookupId(value) {
  return normalizeDocumentId(value);
}

function normalizeSearchQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function buildWholeWordMatcher(query, flags = "iu") {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(normalizedQuery)})(?=$|[^\\p{L}\\p{N}])`, flags);
}

function findWholeWordMatch(sourceText, matcher) {
  if (!matcher) {
    return null;
  }

  matcher.lastIndex = 0;
  const match = matcher.exec(String(sourceText || ""));
  if (!match) {
    return null;
  }

  const prefixLength = String(match[1] || "").length;
  const matchedText = String(match[2] || "");
  return {
    index: match.index + prefixLength,
    length: matchedText.length,
    text: matchedText
  };
}

function clampSearchLimit(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) {
    return 50;
  }

  return Math.min(Math.max(numeric, 1), 200);
}

function findById(entries, value) {
  const needle = normalizeLookupId(value);
  return (Array.isArray(entries) ? entries : []).find((entry) => normalizeLookupId(entry?.id) === needle) || null;
}

function buildVerseSearchText(verse) {
  if (verse?._searchText) {
    return verse._searchText;
  }

  const parts = [verse?.reference, verse?.text, verse?.originalText];
  (Array.isArray(verse?.tokens) ? verse.tokens : []).forEach((token) => {
    parts.push(token?.gloss, token?.original);
    (Array.isArray(token?.strongs) ? token.strongs : []).forEach((strongId) => {
      parts.push(strongId);
    });
  });

  const text = parts
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .join(" ");

  if (verse && typeof verse === "object") {
    verse._searchText = text;
  }

  return text;
}

function ensureTextSourceIndexes(sourceDocument) {
  if (!sourceDocument || typeof sourceDocument !== "object") {
    return {
      verses: [],
      referenceOccurrencesByEntryId: new Map()
    };
  }

  if (sourceDocument.__textIndexes) {
    return sourceDocument.__textIndexes;
  }

  const verses = [];
  const referenceOccurrencesByEntryId = new Map();
  const works = Array.isArray(sourceDocument.works) ? sourceDocument.works : [];

  works.forEach((work) => {
    const sections = Array.isArray(work?.sections) ? work.sections : [];
    sections.forEach((section) => {
      const sectionVerses = Array.isArray(section?.verses) ? section.verses : [];
      sectionVerses.forEach((verse) => {
        const searchText = buildVerseSearchText(verse);
        const verseRecord = {
          workId: work?.id || "",
          workTitle: work?.title || "",
          sectionId: section?.id || "",
          sectionNumber: section?.number,
          sectionLabel: section?.label || "",
          sectionTitle: section?.title || "",
          verseId: verse?.id || "",
          verseNumber: verse?.number,
          reference: verse?.reference || "",
          text: verse?.text || "",
          searchText,
          verse
        };
        verses.push(verseRecord);

        const tokens = Array.isArray(verse?.tokens) ? verse.tokens : [];
        tokens.forEach((token) => {
          const strongs = Array.isArray(token?.strongs) ? token.strongs : [];
          strongs.forEach((strongId) => {
            const entryId = String(strongId || "").trim().toUpperCase();
            if (!entryId) {
              return;
            }
            if (!referenceOccurrencesByEntryId.has(entryId)) {
              referenceOccurrencesByEntryId.set(entryId, []);
            }
            const bucket = referenceOccurrencesByEntryId.get(entryId);
            // Keep one occurrence row per verse for a Strong's id.
            if (!bucket.length || bucket[bucket.length - 1] !== verseRecord) {
              if (!bucket.includes(verseRecord)) {
                bucket.push(verseRecord);
              }
            }
          });
        });
      });
    });
  });

  sourceDocument.__textIndexes = {
    verses,
    referenceOccurrencesByEntryId
  };
  return sourceDocument.__textIndexes;
}

function buildSearchExcerpt(text, query) {
  const sourceText = String(text || "").replace(/\s+/g, " ").trim();
  if (!sourceText) {
    return "";
  }

  const matcher = buildWholeWordMatcher(normalizeSearchQuery(query), "gi");
  if (!matcher) {
    return sourceText.length > 180 ? `${sourceText.slice(0, 177).trimEnd()}...` : sourceText;
  }

  const match = findWholeWordMatch(sourceText.toLowerCase(), matcher);
  if (!match) {
    return sourceText.length > 180 ? `${sourceText.slice(0, 177).trimEnd()}...` : sourceText;
  }

  const startIndex = Math.max(0, match.index - 60);
  const endIndex = Math.min(sourceText.length, match.index + match.length + 120);
  const excerpt = sourceText.slice(startIndex, endIndex).trim();
  const prefix = startIndex > 0 ? "..." : "";
  const suffix = endIndex < sourceText.length ? "..." : "";
  return `${prefix}${excerpt}${suffix}`;
}

function getReferenceSourceIds(source) {
  const featureIds = Array.isArray(source?.features?.referenceIds) ? source.features.referenceIds : [];
  const lexiconIds = Array.isArray(source?.features?.lexiconIds) ? source.features.lexiconIds : [];
  const sourceIds = Array.isArray(source?.referenceIds) ? source.referenceIds : [];
  const ids = featureIds.length ? featureIds : (lexiconIds.length ? lexiconIds : sourceIds);
  return ids.map((entry) => normalizeLookupId(entry)).filter(Boolean);
}

function buildLexiconOccurrencePreview(verse, entryId) {
  const normalizedEntryId = String(entryId || "").trim().toUpperCase();
  const tokens = Array.isArray(verse?.tokens) ? verse.tokens : [];
  const matchIndex = tokens.findIndex((token) => (
    Array.isArray(token?.strongs)
      && token.strongs.some((strongId) => String(strongId || "").trim().toUpperCase() === normalizedEntryId)
  ));

  if (matchIndex !== -1) {
    const startIndex = Math.max(0, matchIndex - 4);
    const endIndex = Math.min(tokens.length, matchIndex + 5);
    const previewTokens = tokens
      .slice(startIndex, endIndex)
      .map((token) => ({
        text: String(token?.gloss || token?.text || token?.original || "").trim(),
        isMatch: Array.isArray(token?.strongs)
          && token.strongs.some((strongId) => String(strongId || "").trim().toUpperCase() === normalizedEntryId)
      }))
      .filter((token) => token.text);

    const snippet = previewTokens.map((token) => token.text).join(" ");

    if (snippet) {
      const prefix = startIndex > 0 ? "..." : "";
      const suffix = endIndex < tokens.length ? "..." : "";
      return {
        text: `${prefix}${snippet}${suffix}`,
        tokens: [
          ...(prefix ? [{ text: prefix, isMatch: false }] : []),
          ...previewTokens,
          ...(suffix ? [{ text: suffix, isMatch: false }] : [])
        ]
      };
    }
  }

  return {
    text: buildSearchExcerpt(verse?.text, ""),
    tokens: []
  };
}

async function getTextLibraryCatalog() {
  const catalog = await loadTextCatalog();
  if (catalog && typeof catalog === "object") {
    return {
      meta: catalog.meta && typeof catalog.meta === "object" ? catalog.meta : {},
      sources: getCatalogSources(catalog),
      references: getCatalogReferences(catalog)
    };
  }

  return {
    meta: {},
    sources: [],
    references: []
  };
}

async function getTextSourceSummary(sourceId) {
  const normalizedSourceId = normalizeLookupId(sourceId);
  if (!normalizedSourceId) {
    throw createHttpError(400, "invalid_text_source", "Text source id is required.");
  }

  const catalog = await getTextLibraryCatalog();
  const source = findById(catalog.sources, normalizedSourceId);
  if (!source) {
    throw createHttpError(404, "text_source_not_found", `Unknown text source '${sourceId}'.`);
  }

  return source;
}

function buildSectionNavigation(works, workIndex, sectionIndex) {
  const currentWork = works[workIndex] || null;
  const currentSections = Array.isArray(currentWork?.sections) ? currentWork.sections : [];
  const previousInWork = sectionIndex > 0 ? currentSections[sectionIndex - 1] : null;
  const nextInWork = sectionIndex < currentSections.length - 1 ? currentSections[sectionIndex + 1] : null;

  const previousWork = workIndex > 0 ? works[workIndex - 1] : null;
  const previousWorkSections = Array.isArray(previousWork?.sections) ? previousWork.sections : [];
  const previousAcrossWork = previousWorkSections.length ? previousWorkSections[previousWorkSections.length - 1] : null;

  const nextWork = workIndex < works.length - 1 ? works[workIndex + 1] : null;
  const nextWorkSections = Array.isArray(nextWork?.sections) ? nextWork.sections : [];
  const nextAcrossWork = nextWorkSections.length ? nextWorkSections[0] : null;

  const previousSection = previousInWork || previousAcrossWork;
  const nextSection = nextInWork || nextAcrossWork;

  return {
    previous: previousSection
      ? {
          workId: previousInWork ? currentWork.id : previousWork.id,
          sectionId: previousSection.id,
          label: previousSection.title
        }
      : null,
    next: nextSection
      ? {
          workId: nextInWork ? currentWork.id : nextWork.id,
          sectionId: nextSection.id,
          label: nextSection.title
        }
      : null
  };
}

async function getTextSection(sourceId, workId, sectionId) {
  const normalizedSourceId = normalizeLookupId(sourceId);
  const normalizedWorkId = normalizeLookupId(workId);
  const normalizedSectionId = normalizeLookupId(sectionId);

  if (!normalizedSourceId || !normalizedWorkId || !normalizedSectionId) {
    throw createHttpError(
      400,
      "invalid_text_section_request",
      "Source id, work id, and section id are required."
    );
  }

  const [catalog, sourceDocument] = await Promise.all([
    getTextLibraryCatalog(),
    loadTextSource(normalizedSourceId)
  ]);

  const sourceSummary = findById(catalog.sources, normalizedSourceId);
  if (!sourceSummary || !sourceDocument) {
    throw createHttpError(404, "text_source_not_found", `Unknown text source '${sourceId}'.`);
  }

  const works = Array.isArray(sourceDocument?.works) ? sourceDocument.works : [];
  const workIndex = works.findIndex((entry) => normalizeLookupId(entry?.id) === normalizedWorkId);
  if (workIndex === -1) {
    throw createHttpError(404, "text_work_not_found", `Unknown work '${workId}' for text source '${sourceId}'.`);
  }

  const work = works[workIndex];
  const sections = Array.isArray(work?.sections) ? work.sections : [];
  const sectionIndex = sections.findIndex((entry) => normalizeLookupId(entry?.id) === normalizedSectionId);
  if (sectionIndex === -1) {
    throw createHttpError(
      404,
      "text_section_not_found",
      `Unknown section '${sectionId}' for work '${workId}'.`
    );
  }

  const section = sections[sectionIndex];
  return {
    source: sourceSummary,
    work: {
      id: work.id,
      title: work.title,
      shortTitle: work.shortTitle,
      order: work.order,
      sectionCount: work.sectionCount,
      verseCount: work.verseCount
    },
    section: {
      id: section.id,
      number: section.number,
      label: section.label,
      title: section.title,
      verseCount: section.verseCount
    },
    navigation: buildSectionNavigation(works, workIndex, sectionIndex),
    verses: Array.isArray(section?.verses) ? section.verses : []
  };
}

async function searchTextLibrary(query, options = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw createHttpError(400, "invalid_text_search", "A search query is required.");
  }

  const limit = clampSearchLimit(options.limit);
  const normalizedSourceId = normalizeLookupId(options.sourceId);
  const normalizedWorkId = normalizeLookupId(options.workId);

  const catalog = await getTextLibraryCatalog();
  const sourceSummaries = normalizedSourceId
    ? [findById(catalog.sources, normalizedSourceId)].filter(Boolean)
    : catalog.sources;

  if (normalizedSourceId && !sourceSummaries.length) {
    throw createHttpError(404, "text_source_not_found", `Unknown text source '${options.sourceId}'.`);
  }

  if (normalizedSourceId && normalizedWorkId) {
    const works = Array.isArray(sourceSummaries[0]?.works) ? sourceSummaries[0].works : [];
    if (!findById(works, normalizedWorkId)) {
      throw createHttpError(404, "text_work_not_found", `Unknown work '${options.workId}' for text source '${options.sourceId}'.`);
    }
  }

  const matcher = buildWholeWordMatcher(normalizedQuery, "iu");
  if (!matcher) {
    return {
      query,
      normalizedQuery,
      scope: normalizedWorkId
        ? { type: "work", source: normalizedSourceId ? sourceSummaries[0] : null, workId: normalizedWorkId }
        : normalizedSourceId
          ? { type: "source", source: sourceSummaries[0] }
          : { type: "global" },
      limit,
      total: 0,
      truncated: false,
      matches: []
    };
  }

  const matches = [];
  let total = 0;
  let truncated = false;

  // Sequential source scan lets us stop early once the result window is full.
  for (const sourceSummary of sourceSummaries) {
    if (truncated) {
      break;
    }

    if (normalizedWorkId) {
      const works = Array.isArray(sourceSummary?.works) ? sourceSummary.works : [];
      const hasWork = works.some((work) => normalizeLookupId(work?.id) === normalizedWorkId);
      if (!hasWork) {
        continue;
      }
    }

    const sourceDocument = await loadTextSource(sourceSummary.id);
    const indexes = ensureTextSourceIndexes(sourceDocument);
    for (const verseRecord of indexes.verses) {
      if (normalizedWorkId && normalizeLookupId(verseRecord.workId) !== normalizedWorkId) {
        continue;
      }
      if (!findWholeWordMatch(verseRecord.searchText, matcher)) {
        continue;
      }

      total += 1;
      if (matches.length < limit) {
        matches.push({
          sourceId: sourceSummary.id,
          sourceTitle: sourceSummary.title,
          sourceShortTitle: sourceSummary.shortTitle,
          workId: verseRecord.workId,
          workTitle: verseRecord.workTitle,
          sectionId: verseRecord.sectionId,
          sectionNumber: verseRecord.sectionNumber,
          sectionLabel: verseRecord.sectionLabel,
          sectionTitle: verseRecord.sectionTitle,
          verseId: verseRecord.verseId,
          verseNumber: verseRecord.verseNumber,
          reference: verseRecord.reference,
          // Full verse text so clients can show the complete line instead of
          // the truncated search excerpt.
          text: String(verseRecord.text || ""),
          preview: buildSearchExcerpt(verseRecord.text, normalizedQuery)
        });
      } else {
        truncated = true;
        break;
      }
    }
  }

  return {
    query,
    normalizedQuery,
    scope: normalizedWorkId
      ? {
          type: "work",
          source: normalizedSourceId ? sourceSummaries[0] : null,
          workId: normalizedWorkId
        }
      : normalizedSourceId
        ? {
            type: "source",
            source: sourceSummaries[0]
          }
        : {
            type: "global"
          },
    limit,
    total,
    truncated: truncated || total > matches.length,
    matches
  };
}

async function listTextReferences() {
  const catalog = await getTextLibraryCatalog();
  return {
    count: catalog.references.length,
    references: catalog.references
  };
}

// Reference keys can be Strong's numbers ("H1"), words ("abraxas"), or terms, so
// look up entries case-insensitively and return the original key.
function findReferenceEntry(entries, entryId) {
  if (!entries || typeof entries !== "object") {
    return { key: null, entry: null };
  }

  if (Object.prototype.hasOwnProperty.call(entries, entryId)) {
    return { key: entryId, entry: entries[entryId] };
  }

  const normalized = String(entryId || "").toLowerCase();
  for (const [key, value] of Object.entries(entries)) {
    if (String(key).toLowerCase() === normalized) {
      return { key, entry: value };
    }
  }

  return { key: null, entry: null };
}

async function getTextReferenceEntry(referenceId, entryId) {
  const normalizedReferenceId = normalizeLookupId(referenceId);
  const normalizedEntryId = String(entryId || "").trim();
  if (!normalizedReferenceId || !normalizedEntryId) {
    throw createHttpError(400, "invalid_text_reference_entry", "Reference id and entry id are required.");
  }

  const [catalog, referenceDocument] = await Promise.all([
    getTextLibraryCatalog(),
    loadTextReference(normalizedReferenceId)
  ]);

  const referenceSummary = findById(catalog.references, normalizedReferenceId);
  if (!referenceSummary || !referenceDocument) {
    throw createHttpError(404, "text_reference_not_found", `Unknown reference '${referenceId}'.`);
  }

  const { key: foundKey, entry } = findReferenceEntry(referenceDocument?.entries, normalizedEntryId);
  if (!entry) {
    throw createHttpError(
      404,
      "text_reference_entry_not_found",
      `Unknown reference entry '${normalizedEntryId}' in '${referenceId}'.`
    );
  }

  return {
    reference: referenceSummary,
    entryId: foundKey || normalizedEntryId,
    entry
  };
}

async function searchTextReference(referenceId, query, options = {}) {
  const normalizedReferenceId = normalizeLookupId(referenceId);
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedReferenceId) {
    throw createHttpError(400, "invalid_text_reference_search", "Reference id is required.");
  }

  const limit = clampSearchLimit(options.limit);
  const [catalog, referenceDocument] = await Promise.all([
    getTextLibraryCatalog(),
    loadTextReference(normalizedReferenceId)
  ]);

  const referenceSummary = findById(catalog.references, normalizedReferenceId);
  if (!referenceSummary || !referenceDocument) {
    throw createHttpError(404, "text_reference_not_found", `Unknown reference '${referenceId}'.`);
  }

  const entries = referenceDocument?.entries && typeof referenceDocument.entries === "object"
    ? referenceDocument.entries
    : {};
  const matches = [];
  let total = 0;
  let truncated = false;

  for (const [key, entry] of Object.entries(entries)) {
    if (normalizedQuery && !buildReferenceEntrySearchText(key, entry).includes(normalizedQuery)) {
      continue;
    }

    total += 1;
    if (matches.length < limit) {
      matches.push({ entryId: String(key), entry });
    } else {
      truncated = true;
    }
  }

  return {
    reference: referenceSummary,
    query,
    normalizedQuery,
    limit,
    total,
    truncated: truncated || total > matches.length,
    matches
  };
}

// Concatenate the entry key with every scalar field value so a query can match
// the key, transliteration, pronunciation, or any definition/body text.
function buildReferenceEntrySearchText(entryId, entry) {
  const parts = [String(entryId || "")];
  if (entry && typeof entry === "object") {
    for (const [field, value] of Object.entries(entry)) {
      if (value == null || typeof value === "object") {
        continue;
      }
      parts.push(String(value));
    }
  }
  return parts.join(" ").toLowerCase();
}

async function getTextReferenceEntryOccurrences(referenceId, entryId, options = {}) {
  const normalizedReferenceId = normalizeLookupId(referenceId);
  const normalizedEntryId = String(entryId || "").trim();
  if (!normalizedReferenceId || !normalizedEntryId) {
    throw createHttpError(400, "invalid_text_reference_occurrences", "Reference id and entry id are required.");
  }

  const limit = clampSearchLimit(options.limit);
  const [catalog, referenceDocument] = await Promise.all([
    getTextLibraryCatalog(),
    loadTextReference(normalizedReferenceId)
  ]);

  const referenceSummary = findById(catalog.references, normalizedReferenceId);
  if (!referenceSummary || !referenceDocument) {
    throw createHttpError(404, "text_reference_not_found", `Unknown reference '${referenceId}'.`);
  }

  const { key: foundKey, entry } = findReferenceEntry(referenceDocument?.entries, normalizedEntryId);
  if (!entry) {
    throw createHttpError(
      404,
      "text_reference_entry_not_found",
      `Unknown reference entry '${normalizedEntryId}' in '${referenceId}'.`
    );
  }

  // Token annotations (Strong's) are indexed by uppercase entry id.
  const indexEntryId = String(foundKey || normalizedEntryId).toUpperCase();

  const sourceSummaries = catalog.sources.filter((source) => getReferenceSourceIds(source).includes(normalizedReferenceId));
  const matches = [];
  let total = 0;
  let truncated = false;

  for (const sourceSummary of sourceSummaries) {
    if (truncated) {
      break;
    }

    const sourceDocument = await loadTextSource(sourceSummary.id);
    const indexes = ensureTextSourceIndexes(sourceDocument);
    const occurrenceRecords = indexes.referenceOccurrencesByEntryId.get(indexEntryId) || [];
    total += occurrenceRecords.length;

    for (const verseRecord of occurrenceRecords) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const occurrencePreview = buildLexiconOccurrencePreview(verseRecord.verse, indexEntryId);
      matches.push({
        sourceId: sourceSummary.id,
        sourceTitle: sourceSummary.title,
        sourceShortTitle: sourceSummary.shortTitle,
        workId: verseRecord.workId,
        workTitle: verseRecord.workTitle,
        sectionId: verseRecord.sectionId,
        sectionNumber: verseRecord.sectionNumber,
        sectionLabel: verseRecord.sectionLabel,
        sectionTitle: verseRecord.sectionTitle,
        verseId: verseRecord.verseId,
        verseNumber: verseRecord.verseNumber,
        reference: verseRecord.reference,
        text: String(verseRecord.verse?.text || ""),
        preview: occurrencePreview.text,
        previewTokens: occurrencePreview.tokens
      });
    }
  }

  return {
    reference: referenceSummary,
    entryId: foundKey || normalizedEntryId,
    entry,
    limit,
    total,
    truncated: truncated || total > matches.length,
    matches
  };
}

async function matchTextReferenceInHaystack(referenceId, haystack, options = {}) {
  const normalizedReferenceId = normalizeLookupId(referenceId);
  if (!normalizedReferenceId) {
    throw createHttpError(400, "invalid_text_reference_match", "Reference id is required.");
  }
  const text = String(haystack || "");
  const limit = clampSearchLimit(options.limit);
  const [catalog, referenceDocument] = await Promise.all([
    getTextLibraryCatalog(),
    loadTextReference(normalizedReferenceId)
  ]);
  const referenceSummary = findById(catalog.references, normalizedReferenceId);
  if (!referenceSummary || !referenceDocument) {
    throw createHttpError(404, "text_reference_not_found", `Unknown reference '${referenceId}'.`);
  }
  const entries = referenceDocument?.entries && typeof referenceDocument.entries === "object"
    ? referenceDocument.entries
    : {};
  const candidates = Object.entries(entries)
    .map(([key, entry]) => {
      const terms = [];
      const addTerm = (value) => {
        const term = String(value || "").trim();
        if (term.length < 3) return;
        if (terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) return;
        terms.push(term);
      };
      addTerm(entry?.title || key);
      addTerm(entry?.keyword);
      addTerm(String(key || "").replace(/[-_]+/g, " "));
      const longest = terms.reduce((max, term) => (term.length > max.length ? term : max), "");
      return { key, entry, title: String(entry?.title || key).trim(), terms, longest };
    })
    .filter((item) => item.terms.length)
    .sort((left, right) => right.longest.length - left.longest.length);

  const matches = [];
  candidates.forEach((item) => {
    if (matches.length >= limit) {
      return;
    }
    const hit = item.terms.some((term) => {
      const matcher = buildWholeWordMatcher(term);
      return matcher && matcher.test(text);
    });
    if (hit) {
      matches.push({
        entryId: item.key,
        title: item.title,
        entry: item.entry
      });
    }
  });

  return {
    reference: referenceSummary,
    count: matches.length,
    matches
  };
}

module.exports = {
  getTextLibraryCatalog,
  getTextSourceSummary,
  getTextSection,
  searchTextLibrary,
  listTextReferences,
  searchTextReference,
  getTextReferenceEntry,
  getTextReferenceEntryOccurrences,
  matchTextReferenceInHaystack
};