const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const {
  sourceTextDataRoot,
  sourceTextImportRoot,
  sourceGeneratedTextRoot,
  generatedTextSourceRegistryPath,
  textImportRoot,
  referencesImportRoot,
  textLibraryRegistryPath
} = require("../config/paths");
const {
  getBaseTextSourceDefinitions
} = require("../config/text-sources");

const SUPPORTED_IMPORT_FORMATS = new Set([
  "auto-sectioned-text",
  "custom-text",
  "numbered-aphorisms-text",
  "numbered-chapter-prose-text",
  "headed-prose-text",
  "roman-verse-text",
  "quran-verse-table",
  "structured-json",
  "chaptered-books",
  "sections",
  "tokenized-books",
  "titled-prose-json"
]);

const FORMAT_CHOICES = [
  { id: "auto-sectioned-text", label: "Auto" },
  { id: "custom-text", label: "Custom patterns" },
  { id: "numbered-aphorisms-text", label: "Numbered verses (1. / 00.)" },
  { id: "numbered-chapter-prose-text", label: "Numbered chapters" },
  { id: "headed-prose-text", label: "Brace headings {Book}{Ch}" },
  { id: "roman-verse-text", label: "Roman verses (I:1.)" },
  { id: "quran-verse-table", label: "Quran verse table (JSON)" },
  { id: "structured-json", label: "Structured JSON" },
  { id: "chaptered-books", label: "Chaptered books JSON" },
  { id: "sections", label: "Sections JSON" },
  { id: "tokenized-books", label: "Tokenized books JSON" },
  { id: "titled-prose-json", label: "Titled prose JSON" }
];

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripInlineMarkup(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
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

function normalizeDocumentId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function buildVerseReference(rawReference, workTitle, sectionNumber, verseNumber) {
  return normalizeWhitespace(rawReference) || `${workTitle} ${sectionNumber}:${verseNumber}`;
}

function normalizeTokenStrongIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean)
  )];
}

function buildTokenGloss(tokens) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((token) => token?.gloss || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizeStructuredToken(token, tokenIndex) {
  if (!token || typeof token !== "object") {
    return null;
  }

  const gloss = normalizeWhitespace(token.gloss);
  const original = normalizeWhitespace(token.original);
  const strongs = normalizeTokenStrongIds(token.strongs);
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
  const gloss = normalizeWhitespace(Array.isArray(entry) ? entry[0] : "");
  const original = normalizeWhitespace(Array.isArray(entry) ? entry[1] : "");
  const strongs = normalizeTokenStrongIds(Array.isArray(entry) ? entry[2] : []);
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

function createSectionRecord({ id, number, label, title, verses, metadata }) {
  const normalizedVerses = (Array.isArray(verses) ? verses : []).filter(Boolean);
  if (!normalizedVerses.length) {
    return null;
  }

  const hasMetadata = metadata && typeof metadata === "object" && Object.keys(metadata).length;
  return {
    id: String(id || number || "").trim() || String(number || "1"),
    ...(Number.isFinite(Number(number)) ? { number: Number(number) } : {}),
    label: normalizeWhitespace(label),
    title: normalizeWhitespace(title),
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
    id: String(id || slugify(title) || "work-1"),
    title: normalizeWhitespace(title),
    shortTitle: normalizeWhitespace(shortTitle) || normalizeWhitespace(title),
    order: toPositiveInteger(order, 1),
    sectionCount: normalizedSections.length,
    verseCount: normalizedSections.reduce((sum, section) => sum + Number(section?.verseCount || 0), 0),
    sections: normalizedSections,
    ...(hasMetadata ? { metadata } : {})
  };
}

function splitTextLines(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "")
    .split("\n");
}

function collectParagraphs(lines, options = {}) {
  const ignoredLinePatterns = Array.isArray(options.ignoredLinePatterns) ? options.ignoredLinePatterns : [];
  const paragraphs = [];
  let current = [];

  function flush() {
    if (!current.length) {
      return;
    }

    const paragraph = normalizeWhitespace(current.join(" "));
    if (paragraph) {
      paragraphs.push(paragraph);
    }
    current = [];
  }

  (Array.isArray(lines) ? lines : []).forEach((line) => {
    const trimmed = normalizeWhitespace(line);
    if (!trimmed) {
      flush();
      return;
    }

    if (/^\[\d+\]$/.test(trimmed) || ignoredLinePatterns.some((pattern) => pattern.test(trimmed))) {
      flush();
      return;
    }

    current.push(trimmed);
  });

  flush();
  return paragraphs;
}

function splitSentenceLikePassages(rawText, options = {}) {
  const normalizedText = normalizeWhitespace(rawText);
  if (!normalizedText) {
    return [];
  }

  const maxSentences = toPositiveInteger(options.maxSentences, 5);
  const maxLength = toPositiveInteger(options.maxLength, 900);
  const sentences = normalizedText.match(/[^.!?]+(?:[.!?]+["']*)?|.+$/g) || [normalizedText];
  const passages = [];
  let current = [];

  function flush() {
    const paragraph = normalizeWhitespace(current.join(" "));
    if (paragraph) {
      passages.push(paragraph);
    }
    current = [];
  }

  sentences.forEach((sentence) => {
    const trimmed = normalizeWhitespace(sentence);
    if (!trimmed) {
      return;
    }

    const nextPassage = normalizeWhitespace([...current, trimmed].join(" "));
    if (current.length && (current.length >= maxSentences || nextPassage.length > maxLength)) {
      flush();
    }

    current.push(trimmed);
  });

  flush();
  return passages;
}

function collectProsePassages(rawText) {
  const paragraphs = collectParagraphs(splitTextLines(rawText));
  if (paragraphs.length > 1) {
    return paragraphs;
  }

  return splitSentenceLikePassages(rawText);
}

function normalizeStoryTitle(value, fallback) {
  const normalized = String(value || "")
    .replace(/\s*Brothers Grimm\s*(?:&rarr;|&#8594;|→)?\s*$/i, "")
    .replace(/&rarr;|&#8594;|→/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}

function buildCanonicalMetadata(rawSource, manifestMetadata = {}, extraMetadata = {}) {
  return {
    ...(rawSource?.last_modified ? { lastModified: normalizeWhitespace(rawSource.last_modified) } : {}),
    ...(rawSource?.version != null ? { version: rawSource.version } : {}),
    ...(rawSource?.subtitle ? { subtitle: normalizeWhitespace(rawSource.subtitle) } : {}),
    ...(rawSource?.full_subtitle ? { fullSubtitle: normalizeWhitespace(rawSource.full_subtitle) } : {}),
    ...(rawSource?.lds_slug ? { slug: normalizeWhitespace(rawSource.lds_slug) } : {}),
    ...((manifestMetadata && typeof manifestMetadata === "object") ? manifestMetadata : {}),
    ...extraMetadata
  };
}

function buildCanonicalDocument(manifest, rawSource, works, extraMetadata = {}) {
  const normalizedWorks = (Array.isArray(works) ? works : []).filter(Boolean);
  const title = normalizeWhitespace(manifest.title || rawSource?.title || manifest.id);
  const shortTitle = normalizeWhitespace(manifest.shortTitle || rawSource?.shortTitle || title);

  return {
    schemaVersion: 1,
    type: "structured-text-source",
    title,
    shortTitle,
    metadata: buildCanonicalMetadata(rawSource, manifest.metadata, extraMetadata),
    works: normalizedWorks
  };
}

function normalizeStructuredWorks(rawWorks, manifest) {
  return (Array.isArray(rawWorks) ? rawWorks : []).map((work, workIndex) => {
    const workTitle = normalizeWhitespace(work?.title) || `Work ${workIndex + 1}`;
    const workShortTitle = normalizeWhitespace(work?.shortTitle) || workTitle;
    const sections = (Array.isArray(work?.sections) ? work.sections : []).map((section, sectionIndex) => {
      const sectionNumber = toPositiveInteger(section?.number, sectionIndex + 1);
      const sectionLabel = normalizeWhitespace(section?.label) || `${manifest.sectionLabel} ${sectionNumber}`;
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
        id: section?.id || sectionNumber,
        number: sectionNumber,
        label: sectionLabel,
        title: sectionTitle,
        verses,
        metadata: section?.metadata
      });
    }).filter(Boolean);

    return createWorkRecord({
      id: work?.id || slugify(workShortTitle) || `work-${workIndex + 1}`,
      title: workTitle,
      shortTitle: workShortTitle,
      order: toPositiveInteger(work?.order, workIndex + 1),
      sections,
      metadata: work?.metadata
    });
  }).filter(Boolean);
}

function convertStructuredJsonSource(manifest, rawSource) {
  const works = normalizeStructuredWorks(rawSource?.works, manifest);
  const extraMetadata = {
    ...(rawSource?.schemaVersion != null ? { importedSchemaVersion: rawSource.schemaVersion } : {}),
    ...(rawSource?.type ? { importedType: normalizeWhitespace(rawSource.type) } : {})
  };
  return buildCanonicalDocument(manifest, rawSource, works, extraMetadata);
}

function convertChapteredBooksSource(manifest, rawSource) {
  const books = Array.isArray(rawSource?.books) ? rawSource.books : [];
  const omittedSupplementCount = books.reduce(
    (sum, book) => sum + (Array.isArray(book?.facsimiles) ? book.facsimiles.length : 0),
    0
  );

  const works = books.map((book, workIndex) => {
    const workTitle = normalizeWhitespace(book?.full_title) || normalizeWhitespace(book?.book) || `Work ${workIndex + 1}`;
    const workShortTitle = normalizeWhitespace(book?.book) || workTitle;
    const sections = (Array.isArray(book?.chapters) ? book.chapters : []).map((chapter, chapterIndex) => {
      const sectionNumber = toPositiveInteger(chapter?.chapter, chapterIndex + 1);
      const verses = (Array.isArray(chapter?.verses) ? chapter.verses : []).map((verse, verseIndex) => {
        const verseNumber = toPositiveInteger(verse?.verse, verseIndex + 1);
        return createStructuredVerse({
          id: verseNumber,
          number: verseNumber,
          reference: buildVerseReference(verse?.reference, workTitle, sectionNumber, verseNumber),
          text: verse?.text
        });
      }).filter(Boolean);

      return createSectionRecord({
        id: sectionNumber,
        number: sectionNumber,
        label: `${manifest.sectionLabel} ${sectionNumber}`,
        title: normalizeWhitespace(chapter?.reference) || `${workTitle} ${manifest.sectionLabel} ${sectionNumber}`,
        verses
      });
    }).filter(Boolean);

    return createWorkRecord({
      id: slugify(book?.lds_slug || workShortTitle || workTitle) || `work-${workIndex + 1}`,
      title: workTitle,
      shortTitle: workShortTitle,
      order: workIndex + 1,
      sections
    });
  }).filter(Boolean);

  return buildCanonicalDocument(manifest, rawSource, works, omittedSupplementCount ? { omittedSupplementCount } : {});
}

function convertSectionsSource(manifest, rawSource) {
  const workTitle = normalizeWhitespace(manifest.title || rawSource?.title || manifest.id);
  const sections = (Array.isArray(rawSource?.sections) ? rawSource.sections : []).map((section, sectionIndex) => {
    const sectionNumber = toPositiveInteger(section?.section, sectionIndex + 1);
    const verses = (Array.isArray(section?.verses) ? section.verses : []).map((verse, verseIndex) => {
      const verseNumber = toPositiveInteger(verse?.verse, verseIndex + 1);
      return createStructuredVerse({
        id: verseNumber,
        number: verseNumber,
        reference: buildVerseReference(verse?.reference, workTitle, sectionNumber, verseNumber),
        text: verse?.text
      });
    }).filter(Boolean);

    return createSectionRecord({
      id: sectionNumber,
      number: sectionNumber,
      label: `${manifest.sectionLabel} ${sectionNumber}`,
      title: normalizeWhitespace(section?.reference) || `${workTitle} ${manifest.sectionLabel} ${sectionNumber}`,
      verses
    });
  }).filter(Boolean);

  const work = createWorkRecord({
    id: slugify(manifest.shortTitle || manifest.title || manifest.id) || manifest.id,
    title: workTitle,
    shortTitle: manifest.shortTitle || workTitle,
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, rawSource, work ? [work] : []);
}

function convertTokenizedBooksSource(manifest, rawSource) {
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
        id: sectionNumber,
        number: sectionNumber,
        label: `${manifest.sectionLabel} ${sectionNumber}`,
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

  return buildCanonicalDocument(manifest, rawSource, works);
}

function convertTitledProseJsonSource(manifest, rawSource) {
  const entries = Array.isArray(rawSource) ? rawSource : [];
  const workTitle = manifest.title || "Collected Text";
  const sections = entries.map((entry, entryIndex) => {
    const title = normalizeStoryTitle(entry?.title, `${manifest.sectionLabel} ${entryIndex + 1}`);
    const passages = collectProsePassages(entry?.text);
    const verses = passages.map((paragraph, paragraphIndex) => createStructuredVerse({
      id: paragraphIndex + 1,
      number: paragraphIndex + 1,
      reference: `${title} ${paragraphIndex + 1}`,
      text: paragraph
    })).filter(Boolean);

    return createSectionRecord({
      id: slugify(title) || `section-${entryIndex + 1}`,
      number: entryIndex + 1,
      label: `${entryIndex + 1} · ${title}`,
      title,
      verses,
      metadata: {
        ...(entry?.url ? { sourceUrl: normalizeWhitespace(entry.url) } : {}),
        sourceIndex: entryIndex + 1
      }
    });
  }).filter(Boolean);

  const work = createWorkRecord({
    id: slugify(workTitle) || manifest.id,
    title: workTitle,
    shortTitle: manifest.shortTitle || workTitle,
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : [], {
    importedEntryCount: sections.length
  });
}

function convertQuranVerseTableSource(manifest, rawSource) {
  const table = (Array.isArray(rawSource) ? rawSource : []).find((entry) => entry?.type === "table" && entry?.name === "versesimple");
  const rows = Array.isArray(table?.data) ? table.data : [];
  const sectionsByChapter = new Map();

  rows.forEach((row, rowIndex) => {
    const chapterNumber = toPositiveInteger(row?.chapter, rowIndex + 1);
    const verseValue = Number.parseInt(row?.verse, 10);
    const verseNumber = Number.isInteger(verseValue) ? verseValue : rowIndex + 1;
    const english = normalizeWhitespace(stripInlineMarkup(row?.english));
    const arabic = normalizeWhitespace(row?.arabic);
    if (!english && !arabic) {
      return;
    }

    if (!sectionsByChapter.has(chapterNumber)) {
      sectionsByChapter.set(chapterNumber, []);
    }

    sectionsByChapter.get(chapterNumber).push(createStructuredVerse({
      id: verseNumber,
      number: verseNumber,
      reference: `${manifest.title || "Quran"} ${chapterNumber}:${verseNumber}`,
      text: english || arabic,
      originalText: arabic,
      metadata: row?.id ? { sourceRowId: String(row.id) } : undefined
    }));
  });

  const sections = [...sectionsByChapter.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([chapterNumber, verses]) => createSectionRecord({
      id: chapterNumber,
      number: chapterNumber,
      label: `${manifest.sectionLabel} ${chapterNumber}`,
      title: `${manifest.title || "Quran"} ${manifest.sectionLabel} ${chapterNumber}`,
      verses
    }))
    .filter(Boolean);

  const work = createWorkRecord({
    id: slugify(manifest.title || "quran") || manifest.id,
    title: manifest.title || "Quran",
    shortTitle: manifest.shortTitle || manifest.title || "Quran",
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, rawSource, work ? [work] : [], table?.name ? { tableName: table.name } : {});
}

function convertNumberedAphorismsTextSource(manifest, rawText) {
  const lines = splitTextLines(rawText);
  const verses = [];
  let currentKey = "";
  let currentTextParts = [];

  function flushCurrent() {
    const text = normalizeWhitespace(currentTextParts.join(" "));
    if (!text || !currentKey) {
      currentKey = "";
      currentTextParts = [];
      return;
    }

    const verseNumber = /^\d+$/.test(currentKey) ? Number(currentKey) : 0;
    verses.push(createStructuredVerse({
      id: /^\d+$/.test(currentKey) ? currentKey : slugify(currentKey) || "preface",
      number: verseNumber,
      reference: `${manifest.title || manifest.id} ${currentKey}`,
      text
    }));

    currentKey = "";
    currentTextParts = [];
  }

  lines.forEach((line) => {
    const trimmed = normalizeWhitespace(line);
    if (!trimmed) {
      return;
    }

    const match = trimmed.match(/^([A-Z]|\d+)\.\s*(.*)$/);
    if (match) {
      flushCurrent();
      currentKey = match[1];
      currentTextParts = [match[2]];
      return;
    }

    if (currentKey) {
      currentTextParts.push(trimmed);
    }
  });

  flushCurrent();

  const section = createSectionRecord({
    id: 1,
    number: 1,
    label: manifest.title || manifest.id,
    title: manifest.title || manifest.id,
    verses
  });

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections: section ? [section] : []
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

function convertRomanVerseTextSource(manifest, rawText) {
  const lines = splitTextLines(rawText);
  const sectionOrder = [];
  const versesBySection = new Map();

  lines.forEach((line) => {
    const trimmed = normalizeWhitespace(line);
    const match = trimmed.match(/^([IVXLC]+):(\d+)\.\s*(.*)$/i);
    if (!match) {
      return;
    }

    const sectionId = String(match[1]).toUpperCase();
    const verseNumber = Number.parseInt(match[2], 10);
    if (!versesBySection.has(sectionId)) {
      sectionOrder.push(sectionId);
      versesBySection.set(sectionId, []);
    }

    versesBySection.get(sectionId).push(createStructuredVerse({
      id: verseNumber,
      number: verseNumber,
      reference: `${sectionId}:${verseNumber}`,
      text: match[3]
    }));
  });

  const sections = sectionOrder.map((sectionId, index) => createSectionRecord({
    id: sectionId.toLowerCase(),
    number: index + 1,
    label: `${manifest.sectionLabel} ${sectionId}`,
    title: `${manifest.title || manifest.id} ${manifest.sectionLabel} ${sectionId}`,
    verses: versesBySection.get(sectionId)
  })).filter(Boolean);

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

function convertNumberedChapterProseTextSource(manifest, rawText) {
  const lines = splitTextLines(rawText);
  const sections = [];
  let lineIndex = 0;

  function skipBlankLines() {
    while (lineIndex < lines.length && !normalizeWhitespace(lines[lineIndex])) {
      lineIndex += 1;
    }
  }

  while (lineIndex < lines.length) {
    const chapterLine = normalizeWhitespace(lines[lineIndex]);
    if (!/^\d+$/.test(chapterLine)) {
      lineIndex += 1;
      continue;
    }

    const chapterNumber = Number.parseInt(chapterLine, 10);
    lineIndex += 1;
    skipBlankLines();

    if (normalizeWhitespace(lines[lineIndex])) {
      lineIndex += 1;
    }

    skipBlankLines();
    const rawTitle = normalizeWhitespace(lines[lineIndex]);
    const title = rawTitle || `${manifest.sectionLabel} ${chapterNumber}`;
    if (rawTitle) {
      lineIndex += 1;
    }

    const bodyLines = [];
    while (lineIndex < lines.length && !/^\d+$/.test(normalizeWhitespace(lines[lineIndex]))) {
      bodyLines.push(lines[lineIndex]);
      lineIndex += 1;
    }

    const paragraphs = collectParagraphs(bodyLines, {
      ignoredLinePatterns: [/^ΚΕΦΑΛΗ\b/i]
    });
    const verses = paragraphs.map((paragraph, paragraphIndex) => createStructuredVerse({
      id: paragraphIndex + 1,
      number: paragraphIndex + 1,
      reference: `${manifest.sectionLabel} ${chapterNumber}:${paragraphIndex + 1}`,
      text: paragraph
    })).filter(Boolean);

    sections.push(createSectionRecord({
      id: chapterNumber,
      number: chapterNumber,
      label: `${chapterNumber} · ${title}`,
      title,
      verses
    }));
  }

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

function convertHeadedProseTextSource(manifest, rawText) {
  const lines = splitTextLines(rawText);
  const sections = [];
  let lineIndex = 0;
  let sectionNumber = 0;

  function skipBlankLines() {
    while (lineIndex < lines.length && !normalizeWhitespace(lines[lineIndex])) {
      lineIndex += 1;
    }
  }

  while (lineIndex < lines.length) {
    const headingLine = normalizeWhitespace(lines[lineIndex]);
    if (!/^\{[^}]+\}\{[^}]+\}$/.test(headingLine)) {
      lineIndex += 1;
      continue;
    }

    lineIndex += 1;
    skipBlankLines();

    const rawTitle = normalizeWhitespace(lines[lineIndex]);
    const title = rawTitle || `${manifest.sectionLabel} ${sectionNumber + 1}`;
    if (rawTitle) {
      lineIndex += 1;
    }

    const bodyLines = [];
    while (lineIndex < lines.length && !/^\{[^}]+\}\{[^}]+\}$/.test(normalizeWhitespace(lines[lineIndex]))) {
      bodyLines.push(lines[lineIndex]);
      lineIndex += 1;
    }

    const paragraphs = collectParagraphs(bodyLines);
    sectionNumber += 1;
    const verses = paragraphs.map((paragraph, paragraphIndex) => createStructuredVerse({
      id: paragraphIndex + 1,
      number: paragraphIndex + 1,
      reference: `${manifest.sectionLabel} ${sectionNumber}:${paragraphIndex + 1}`,
      text: paragraph
    })).filter(Boolean);

    sections.push(createSectionRecord({
      id: slugify(title) || `section-${sectionNumber}`,
      number: sectionNumber,
      label: `${sectionNumber} · ${title}`,
      title,
      verses
    }));
  }

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

function convertAutoSectionedTextSource(manifest, rawText) {
  const headerSkipCount = Number(manifest.headerSkipCount || manifest.headerLines || 0);
  const lines = splitTextLines(rawText);
  const strippedLines = lines.slice(headerSkipCount);
  const stripPatterns = Array.isArray(manifest.stripMatching) ? manifest.stripMatching : [];

  function shouldStrip(line) {
    const trimmed = normalizeWhitespace(line);
    if (!trimmed) return false;
    return stripPatterns.some((pattern) => trimmed.includes(String(pattern)));
  }

  // Group lines into blocks separated by blank lines
  const blocks = [];
  let current = [];
  for (const line of strippedLines) {
    const trimmed = normalizeWhitespace(line);
    if (!trimmed && current.length > 0) {
      blocks.push([...current]);
      current = [];
      continue;
    }
    if (!trimmed) continue;
    if (shouldStrip(line)) continue;
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push([...current]);
  }

  // Classify each block as heading or prose
  // Heading heuristic: short block (1-3 lines), no end punctuation, no line starts with lowercase or digit
  function isHeadingBlock(block) {
    if (block.length > 3) return false;
    const text = normalizeWhitespace(block.join(" "));
    if (text.length > 120) return false;
    if (/[.?!;:)]$/.test(text)) return false;
    if (/^[a-z\d]/.test(text)) return false;
    return true;
  }

  // Build sections: headings group subsequent prose blocks
  const sections = [];
  let currentHeading = null;
  let currentParagraphs = [];

  function flushSection() {
    if (!currentHeading && !currentParagraphs.length) return;
    const heading = currentHeading || (manifest.title || manifest.sectionLabel || "Section") + " " + (sections.length + 1);
    const merged = [];
    let buf = "";
    for (const p of currentParagraphs) {
      const text = normalizeWhitespace(p.join(" "));
      buf = buf ? buf + " " + text : text;
      const endsWithPunct = /[.?!)]\s*$/.test(text);
      if (endsWithPunct || buf.length > 300) {
        merged.push(buf);
        buf = "";
      }
    }
    if (buf) merged.push(buf);
    if (!merged.length) merged.push(normalizeWhitespace(currentParagraphs[0]?.join(" ") || ""));

    sections.push({
      heading,
      paragraphs: merged
    });
    currentHeading = null;
    currentParagraphs = [];
  }

  for (const block of blocks) {
    if (isHeadingBlock(block)) {
      flushSection();
      currentHeading = normalizeWhitespace(block.join(" "));
    } else {
      currentParagraphs.push(block);
    }
  }
  flushSection();

  let sectionNumber = 0;
  const sectionRecords = sections.map((sec) => {
    sectionNumber += 1;
    const verses = sec.paragraphs
      .filter(Boolean)
      .map((text, vi) => createStructuredVerse({
        id: vi + 1,
        number: vi + 1,
        reference: sec.heading + ":" + (vi + 1),
        text: normalizeWhitespace(text)
      }))
      .filter(Boolean);

    return createSectionRecord({
      id: slugify(sec.heading) || "section-" + sectionNumber,
      number: sectionNumber,
      label: sectionNumber + " · " + sec.heading,
      title: sec.heading,
      verses
    });
  });

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections: sectionRecords
  });

  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const sanitized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(sanitized);
}

async function readText(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function normalizeManifest(manifest, manifestPath) {
  const id = normalizeDocumentId(manifest?.id);
  if (!id) {
    throw new Error(`Missing required text import id in ${manifestPath}`);
  }

  const inputPathValue = String(manifest?.input?.path || "").trim();
  if (!inputPathValue) {
    throw new Error(`Missing required input.path in ${manifestPath}`);
  }

  const inputFormat = normalizeDocumentId(manifest?.input?.format);
  if (!SUPPORTED_IMPORT_FORMATS.has(inputFormat)) {
    throw new Error(`Unsupported text import format '${manifest?.input?.format}' in ${manifestPath}`);
  }

  const fileNameCandidate = String(manifest?.output?.fileName || manifest?.outputFileName || `${id}.json`).trim();
  const fileName = path.basename(fileNameCandidate);
  if (!fileName.toLowerCase().endsWith(".json")) {
    throw new Error(`Text import output file must end in .json in ${manifestPath}`);
  }

  return {
    id,
    title: normalizeWhitespace(manifest?.title),
    shortTitle: normalizeWhitespace(manifest?.shortTitle),
    description: normalizeWhitespace(manifest?.description),
    tradition: normalizeWhitespace(manifest?.tradition),
    language: normalizeWhitespace(manifest?.language),
    script: normalizeWhitespace(manifest?.script),
    workLabel: normalizeWhitespace(manifest?.workLabel) || "Text",
    sectionLabel: normalizeWhitespace(manifest?.sectionLabel) || "Chapter",
    verseLabel: normalizeWhitespace(manifest?.verseLabel) || "Verse",
    referenceIds: Array.isArray(manifest?.referenceIds) ? manifest.referenceIds.map((value) => normalizeDocumentId(value)).filter(Boolean) : [],
    metadata: manifest?.metadata && typeof manifest.metadata === "object" ? manifest.metadata : {},
    enabled: manifest?.enabled !== false,
    inputFormat,
    inputPath: path.resolve(path.dirname(manifestPath), inputPathValue),
    manifestPath,
    fileName
  };
}

function buildGeneratedSourceEntry(manifest, document) {
  return {
    id: manifest.id,
    fileName: manifest.fileName,
    title: manifest.title || normalizeWhitespace(document?.title) || manifest.id,
    shortTitle: manifest.shortTitle || normalizeWhitespace(document?.shortTitle) || manifest.title || manifest.id,
    description: manifest.description,
    tradition: manifest.tradition,
    language: manifest.language,
    script: manifest.script,
    workLabel: manifest.workLabel,
    sectionLabel: manifest.sectionLabel,
    verseLabel: manifest.verseLabel,
    referenceIds: manifest.referenceIds
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readGeneratedSourceRegistry() {
  if (!await pathExists(generatedTextSourceRegistryPath)) {
    return null;
  }

  const raw = await fs.readFile(generatedTextSourceRegistryPath, "utf8");
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function shouldIgnoreImportFolder(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized.startsWith(".")
    || normalized.startsWith("_")
    || normalized === "template"
    || normalized === "templates"
    || normalized === "example"
    || normalized === "examples";
}

async function resolveExistingCanonicalImportPath(fileName) {
  const normalizedFileName = path.basename(String(fileName || ""));
  if (!normalizedFileName) {
    return "";
  }

  const candidatePaths = [
    path.join(sourceTextDataRoot, normalizedFileName),
    path.join(sourceGeneratedTextRoot, normalizedFileName)
  ];

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return "";
}

async function collectManifestPaths(rootPath) {
  if (!await pathExists(rootPath)) {
    return [];
  }

  // metadata.json is the universal manifest name; text.json is the legacy one.
  // When a folder carries both, prefer metadata.json.
  const manifestByDir = new Map();

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldIgnoreImportFolder(entry.name)) {
          continue;
        }

        await walk(path.join(currentPath, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (lowerName !== "metadata.json" && lowerName !== "text.json") {
        continue;
      }

      const filePath = path.join(currentPath, entry.name);
      const dirPath = path.dirname(filePath);
      const existing = manifestByDir.get(dirPath);
      if (!existing || lowerName === "metadata.json") {
        manifestByDir.set(dirPath, filePath);
      }
    }
  }

  await walk(rootPath);
  return [...manifestByDir.values()].sort((left, right) => left.localeCompare(right));
}

async function buildCanonicalDocumentFromManifest(manifest) {
  if (manifest.inputFormat === "structured-json") {
    return convertStructuredJsonSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "chaptered-books") {
    return convertChapteredBooksSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "sections") {
    return convertSectionsSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "titled-prose-json") {
    return convertTitledProseJsonSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "tokenized-books") {
    return convertTokenizedBooksSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "quran-verse-table") {
    return convertQuranVerseTableSource(manifest, await readJson(manifest.inputPath));
  }

  if (manifest.inputFormat === "numbered-aphorisms-text") {
    return convertNumberedAphorismsTextSource(manifest, await readText(manifest.inputPath));
  }

  if (manifest.inputFormat === "roman-verse-text") {
    return convertRomanVerseTextSource(manifest, await readText(manifest.inputPath));
  }

  if (manifest.inputFormat === "numbered-chapter-prose-text") {
    return convertNumberedChapterProseTextSource(manifest, await readText(manifest.inputPath));
  }

  if (manifest.inputFormat === "headed-prose-text") {
    return convertHeadedProseTextSource(manifest, await readText(manifest.inputPath));
  }

  if (manifest.inputFormat === "auto-sectioned-text") {
    return convertAutoSectionedTextSource(manifest, await readText(manifest.inputPath));
  }

  throw new Error(`Unsupported text import format '${manifest.inputFormat}' for ${manifest.id}`);
}

function mergePreviousGeneratedSources(previousSources, newSources, reimportIds) {
  const merged = [...previousSources.filter((s) => !reimportIds.has(s.id))];
  for (const source of newSources) {
    const idx = merged.findIndex((s) => s.id === source.id);
    if (idx >= 0) merged[idx] = source;
    else merged.push(source);
  }
  return merged;
}

async function importTextSources() {
  const baseIds = new Set(getBaseTextSourceDefinitions().map((definition) => normalizeDocumentId(definition.id)));
  const baseFileNames = new Set(getBaseTextSourceDefinitions().map((definition) => path.basename(definition.filePath).toLowerCase()));
  const manifestPaths = await collectManifestPaths(sourceTextImportRoot);
  const manifests = [];
  const seenImportIds = new Set();
  const seenImportFileNames = new Set();

  for (const manifestPath of manifestPaths) {
    const manifest = normalizeManifest(await readJson(manifestPath), manifestPath);
    if (!manifest.enabled) {
      continue;
    }

    if (baseIds.has(manifest.id)) {
      throw new Error(`Imported text source id '${manifest.id}' conflicts with a built-in source.`);
    }

    if (seenImportIds.has(manifest.id)) {
      throw new Error(`Duplicate imported text source id '${manifest.id}' found under ${sourceTextImportRoot}`);
    }

    if (baseFileNames.has(manifest.fileName.toLowerCase())) {
      throw new Error(`Imported text source output '${manifest.fileName}' conflicts with a built-in text JSON file.`);
    }

    if (seenImportFileNames.has(manifest.fileName.toLowerCase())) {
      throw new Error(`Duplicate imported text source output file '${manifest.fileName}' found under ${sourceTextImportRoot}`);
    }

    if (!await pathExists(manifest.inputPath)) {
      const existingCanonicalPath = await resolveExistingCanonicalImportPath(manifest.fileName);
      if (!existingCanonicalPath) {
        console.warn(`[text-importer] Input not found for '${manifest.id}', skipping. (Expected: ${manifest.inputPath})`);
        continue;
      }

      manifest.existingCanonicalPath = existingCanonicalPath;
    }

    seenImportIds.add(manifest.id);
    seenImportFileNames.add(manifest.fileName.toLowerCase());
    manifests.push(manifest);
  }

  // Companion manifests without .txt: scan for .manifest.json files that
  // reference a content file (e.g. DLC-installed structured-json texts).
  // These skip the .txt parsing step — the data file is already canonical JSON.
  const textDropDir = textImportRoot;
  if (await pathExists(textDropDir)) {
    const dropEntries = await fs.readdir(textDropDir, { withFileTypes: true });
    for (const entry of dropEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".manifest.json")) continue;
      const fallbackId = normalizeDocumentId(entry.name.replace(/\.manifest\.json$/i, ""));
      if (!fallbackId) continue;

      let manifest;
      try {
        manifest = await readJson(path.join(textDropDir, entry.name));
      } catch { continue; }
      if (!manifest || typeof manifest !== "object") continue;

      // Prefer the manifest's explicit id (e.g. "kjv") over the folder name so
      // the generated source id stays stable across renames.
      const manifestId = normalizeDocumentId(manifest.id || entry.name.replace(/\.manifest\.json$/i, ""));
      if (!manifestId || seenImportIds.has(manifestId)) continue;

      const inputPath = String(manifest?.input?.path || "").trim();
      if (!inputPath) continue;
      let resolvedContentPath = path.resolve(textDropDir, inputPath);
      if (!resolvedContentPath.startsWith(path.resolve(textDropDir) + path.sep)) continue;

      // If the file at input.path doesn't exist, try the manifest basename with the same extension
      if (!await pathExists(resolvedContentPath)) {
        const ext = path.extname(inputPath);
        const fallbackName = entry.name.replace(/\.manifest\.json$/i, "") + ext;
        const fallbackPath = path.resolve(textDropDir, fallbackName);
        if (fallbackPath.startsWith(path.resolve(textDropDir) + path.sep) && await pathExists(fallbackPath)) {
          resolvedContentPath = fallbackPath;
        } else {
          continue;
        }
      }

      if (resolvedContentPath.toLowerCase().endsWith(".json")) {
        seenImportIds.add(manifestId);
        seenImportFileNames.add(manifestId + ".json");

        manifests.push({
          id: manifestId,
          title: manifest.title || manifestId.replace(/[-_]/g, " "),
          shortTitle: manifest.shortTitle || "",
          description: manifest.description || "",
          fileName: manifestId + ".json",
          inputFormat: manifest?.input?.format || "structured-json",
          inputPath: resolvedContentPath,
          inputEncoding: "utf8",
          sourceLabel: manifest.title || manifestId,
          sourceShortLabel: manifest.title || manifestId,
          tradition: manifest.tradition || "",
          language: manifest.language || "English",
          script: manifest.script || "Latin",
          workLabel: manifest.workLabel || "Book",
          sectionLabel: manifest.sectionLabel || "Chapter",
          verseLabel: manifest.verseLabel || "Verse",
          referenceIds: Array.isArray(manifest.referenceIds) ? manifest.referenceIds : []
        });
        continue;
      }

      if (resolvedContentPath.toLowerCase().endsWith(".txt")) {
        seenImportIds.add(manifestId);
        seenImportFileNames.add(manifestId + ".json");

        manifests.push({
          id: manifestId,
          title: manifest.title || manifestId.replace(/[-_]/g, " "),
          shortTitle: manifest.shortTitle || "",
          description: manifest.description || "",
          fileName: manifestId + ".json",
          inputFormat: manifest?.input?.format || "auto-sectioned-text",
          inputPath: resolvedContentPath,
          inputEncoding: manifest?.input?.encoding || "utf8",
          sourceLabel: manifest.title || manifestId,
          sourceShortLabel: manifest.title || manifestId,
          tradition: manifest.tradition || "",
          language: manifest.language || "English",
          script: manifest.script || "Latin",
          workLabel: manifest.workLabel || "Text",
          sectionLabel: manifest.sectionLabel || "Section",
          verseLabel: manifest.verseLabel || "Passage",
          referenceIds: Array.isArray(manifest.referenceIds) ? manifest.referenceIds : []
        });
      }
    }
  }

  // Auto-discover: scan imports/text/ folder for .txt files, create manifests for any without one
  if (await pathExists(textDropDir)) {
    const dropEntries = await fs.readdir(textDropDir, { withFileTypes: true });
    for (const entry of dropEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".txt")) continue;
      const dropId = normalizeDocumentId(entry.name.replace(/\.txt$/i, ""));
      if (!dropId || seenImportIds.has(dropId) || baseIds.has(dropId)) continue;

      const title = entry.name.replace(/\.txt$/i, "").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
      seenImportIds.add(dropId);
      seenImportFileNames.add(dropId + ".json");

      // Companion manifest: TEXT/my-book.txt can have TEXT/my-book.manifest.json
      let companion = {};
      const companionPath = path.join(textDropDir, entry.name.replace(/\.txt$/i, ".manifest.json"));
      if (await pathExists(companionPath)) {
        try {
          companion = await readJson(companionPath);
        } catch (_error) {
          console.warn(`[text-importer] Could not parse companion manifest for '${entry.name}'.`);
        }
      }

      manifests.push({
        id: dropId,
        title: companion.title || title,
        shortTitle: companion.shortTitle || (title.length > 40 ? title.slice(0, 37) + "..." : title),
        description: companion.description || "",
        fileName: dropId + ".json",
        inputFormat: companion.format || "auto-sectioned-text",
        inputPath: path.join(textDropDir, entry.name),
        inputEncoding: companion.inputEncoding || "utf8",
        sourceLabel: companion.sourceLabel || title,
        sourceShortLabel: companion.sourceShortLabel || title,
        tradition: companion.tradition || "",
        language: companion.language || "English",
        script: companion.script || "Latin",
        workLabel: companion.workLabel || "Text",
        sectionLabel: companion.sectionLabel || "Section",
        verseLabel: companion.verseLabel || "Passage",
        headerSkipCount: Number(companion.headerSkipCount || 0),
        stripMatching: Array.isArray(companion.stripMatching) ? companion.stripMatching : [],
        metadata: {
          ...(companion.metadata || {}),
          ...(companion.workKey ? { workKey: companion.workKey } : {}),
          ...(companion.translator ? { translator: companion.translator } : {})
        },
        enabled: true
      });
    }
  }

  for (const manifest of manifests) {
    if (manifest.existingCanonicalPath) {
      manifest.existingCanonicalDocument = await readJson(manifest.existingCanonicalPath);
    }
  }

  const previousRegistry = await readGeneratedSourceRegistry();
  const previousGeneratedSources = Array.isArray(previousRegistry?.sources) ? previousRegistry.sources : [];

  const reimportIds = new Set(manifests.map((m) => m.id));
  for (const source of previousGeneratedSources) {
    if (!reimportIds.has(source.id)) continue;
    const previousFileName = path.basename(String(source?.fileName || `${source?.id}.json`));
    const previousFilePath = path.join(sourceTextDataRoot, previousFileName);
    await fs.rm(previousFilePath, { force: true });
  }

  await fs.rm(sourceGeneratedTextRoot, { recursive: true, force: true });
  await fs.mkdir(sourceGeneratedTextRoot, { recursive: true });

  const sources = [];
  for (const manifest of manifests) {
    const document = manifest.existingCanonicalDocument || await buildCanonicalDocumentFromManifest(manifest);
    const filePath = path.join(sourceTextDataRoot, manifest.fileName);
    await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    sources.push(buildGeneratedSourceEntry(manifest, document));
  }

  const mergedSources = mergePreviousGeneratedSources(previousGeneratedSources, sources, reimportIds);
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCount: mergedSources.length,
    sources: mergedSources
  };

  await fs.writeFile(generatedTextSourceRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  return {
    importedCount: sources.length,
    sources
  };
}

async function readJsonIfPresent(filePath) {
  if (!fsSync.existsSync(filePath)) return null;
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

// References (lexicons, dictionaries, encyclopedias) are keyed-entry lookups, not
// readable works, so they skip the text pipeline. Each staged folder ships a
// reference.json manifest plus an entries file; importing copies the entries into
// source/data/text/<id>.json and registers the definition in library.json.
async function importReferenceSources() {
  if (!fsSync.existsSync(referencesImportRoot)) {
    return { importedCount: 0, references: [] };
  }

  const entries = await fs.readdir(referencesImportRoot, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const references = [];
  for (const folder of folders) {
    const folderPath = path.join(referencesImportRoot, folder.name);
    const manifest = await readJsonIfPresent(path.join(folderPath, "reference.json"));
    const id = normalizeDocumentId(manifest?.id);
    if (!id) {
      console.warn(`[references] Skipping '${folder.name}' — missing reference.json or id.`);
      continue;
    }

    const entriesFile = String(manifest?.entriesFile || "entries.json").trim();
    const entriesPath = path.join(folderPath, path.basename(entriesFile));
    if (!fsSync.existsSync(entriesPath)) {
      console.warn(`[references] Skipping '${folder.name}' — entries file not found (${entriesFile}).`);
      continue;
    }

    const targetFileName = `${id}.json`;
    await fs.copyFile(entriesPath, path.join(sourceTextDataRoot, targetFileName));

    references.push({
      id,
      fileName: targetFileName,
      title: normalizeWhitespace(manifest?.title) || folder.name,
      description: normalizeWhitespace(manifest?.description),
      kind: String(manifest?.kind || "dictionary").trim(),
      keyScheme: String(manifest?.keyScheme || "word").trim()
    });

    await fs.rm(folderPath, { recursive: true, force: true });
  }

  if (references.length) {
    await registerReferenceDefinitions(references);
  }

  return { importedCount: references.length, references };
}

async function registerReferenceDefinitions(imported) {
  const registry = await readJsonIfPresent(textLibraryRegistryPath) || { sources: [], references: [] };
  const existing = Array.isArray(registry.references) ? registry.references : [];
  const byId = new Map(existing.map((entry) => [normalizeDocumentId(entry?.id), entry]));
  for (const reference of imported) {
    byId.set(reference.id, reference);
  }
  registry.references = [...byId.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  registry.referenceCount = registry.references.length;
  await fs.mkdir(sourceTextDataRoot, { recursive: true });
  await fs.writeFile(textLibraryRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function detectTextFormat(rawText) {
  const text = String(rawText || "");
  const trimmed = text.trim();
  if (!trimmed) {
    return "auto-sectioned-text";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.works) || parsed.type === "structured-text-source") {
          return "structured-json";
        }
        if (Array.isArray(parsed.sections)) {
          return "sections";
        }
        if (parsed.books || parsed.chapters) {
          return "chaptered-books";
        }
        return "structured-json";
      }
    } catch (_error) {}
  }

  const nonempty = text.split(/\r?\n/).map((line) => normalizeWhitespace(line)).filter(Boolean);
  if (!nonempty.length) {
    return "auto-sectioned-text";
  }
  const headed = nonempty.filter((line) => /^\{[^}]+\}\{[^}]+\}$/.test(line)).length;
  if (headed >= 2) {
    return "headed-prose-text";
  }
  const romanVerses = nonempty.filter((line) => /^[IVXLC]+:\d+\.\s+\S/i.test(line)).length;
  if (romanVerses >= 3) {
    return "roman-verse-text";
  }
  const loneNumbers = nonempty.filter((line) => /^\d+$/.test(line)).length;
  if (loneNumbers >= 3 && loneNumbers / nonempty.length >= 0.04) {
    return "numbered-chapter-prose-text";
  }
  const numberedStart = nonempty.filter((line) => /^\d+[\.)]\s+\S/.test(line)).length;
  if (numberedStart >= 5) {
    return "numbered-aphorisms-text";
  }
  return "auto-sectioned-text";
}

function buildPreviewManifest(input = {}) {
  const title = normalizeWhitespace(input.title) || "Untitled text";
  const id = normalizeDocumentId(input.id || slugify(title) || "untitled-text");
  return {
    id,
    title,
    shortTitle: normalizeWhitespace(input.shortTitle) || title,
    description: normalizeWhitespace(input.description),
    inputFormat: String(input.format || "auto-sectioned-text"),
    headerSkipCount: Number(input.headerSkipCount || 0),
    stripMatching: Array.isArray(input.stripMatching) ? input.stripMatching : [],
    workLabel: normalizeWhitespace(input.workLabel) || "Text",
    sectionLabel: normalizeWhitespace(input.sectionLabel) || "Section",
    verseLabel: normalizeWhitespace(input.verseLabel) || "Passage",
    language: normalizeWhitespace(input.language) || "English",
    script: normalizeWhitespace(input.script) || "Latin",
    tradition: normalizeWhitespace(input.tradition),
    metadata: {}
  };
}

function compileCustomRegex(pattern, label) {
  const raw = String(pattern || "").trim();
  if (!raw) {
    return null;
  }
  try {
    return new RegExp(raw);
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression.`);
  }
}

function convertCustomTextSource(manifest, rawText, rules = {}) {
  const skip = Math.max(0, Number(rules.headerSkipCount) || 0);
  const allLines = String(rawText || "").split(/\r?\n/);
  const lines = skip ? allLines.slice(skip) : allLines;
  const headingRe = compileCustomRegex(rules.headingPattern, "Heading pattern");
  const verseRe = compileCustomRegex(rules.versePattern, "Verse pattern");
  const mode = String(rules.split || "blank-line").trim() || "blank-line";

  const sections = [];
  let currentTitle = manifest.title || `${manifest.sectionLabel || "Section"} 1`;
  let currentVerses = [];
  let buffer = [];

  function pushVerse(text, number) {
    const verse = createStructuredVerse({
      id: currentVerses.length + 1,
      number: Number.isFinite(Number(number)) ? Number(number) : currentVerses.length + 1,
      reference: `${currentTitle}:${currentVerses.length + 1}`,
      text
    });
    if (verse) {
      currentVerses.push(verse);
    }
  }

  function flushBuffer() {
    const text = buffer.join("\n").replace(/^\s+|\s+$/g, "");
    buffer = [];
    if (text) {
      pushVerse(text);
    }
  }

  function flushSection() {
    flushBuffer();
    const section = createSectionRecord({
      id: sections.length + 1,
      number: sections.length + 1,
      label: currentTitle,
      title: currentTitle,
      verses: currentVerses
    });
    if (section) {
      sections.push(section);
    }
    currentVerses = [];
  }

  lines.forEach((line) => {
    const headingMatch = headingRe ? line.match(headingRe) : null;
    if (headingMatch) {
      flushSection();
      currentTitle = normalizeWhitespace(headingMatch[1] || headingMatch[0]) || `${manifest.sectionLabel || "Section"} ${sections.length + 1}`;
      return;
    }
    const verseMatch = verseRe ? line.match(verseRe) : null;
    if (verseMatch) {
      flushBuffer();
      const number = verseMatch[1] && /^\d+$/.test(verseMatch[1]) ? verseMatch[1] : undefined;
      const text = normalizeWhitespace(verseMatch[2] || verseMatch[1] || line);
      if (text) {
        pushVerse(text, number);
      }
      return;
    }
    if (mode === "line") {
      if (normalizeWhitespace(line)) {
        pushVerse(normalizeWhitespace(line));
      }
      return;
    }
    if (!normalizeWhitespace(line) && mode === "blank-line") {
      flushBuffer();
      return;
    }
    buffer.push(line);
  });
  flushSection();

  const work = createWorkRecord({
    id: slugify(manifest.title || manifest.id) || manifest.id,
    title: manifest.title || manifest.id,
    shortTitle: manifest.shortTitle || manifest.title || manifest.id,
    order: 1,
    sections
  });
  return buildCanonicalDocument(manifest, {}, work ? [work] : []);
}

function parseTextWithFormat(manifest, rawText, format, rules = {}) {
  if (format === "quran-verse-table") {
    let parsed = rawText;
    try {
      parsed = JSON.parse(String(rawText || "[]"));
    } catch (_error) {
      throw new Error("Quran verse table needs JSON with a versesimple table, not plain prose.");
    }
    return convertQuranVerseTableSource(manifest, parsed);
  }
  if (format === "custom-text") {
    return convertCustomTextSource(manifest, rawText, rules);
  }
  if (format === "structured-json" || format === "sections" || format === "chaptered-books" || format === "titled-prose-json" || format === "tokenized-books") {
    const parsed = JSON.parse(String(rawText || "{}"));
    if (format === "sections") {
      return convertSectionsSource(manifest, parsed);
    }
    if (format === "chaptered-books") {
      return convertChapteredBooksSource(manifest, parsed);
    }
    if (format === "titled-prose-json") {
      return convertTitledProseJsonSource(manifest, parsed);
    }
    if (format === "tokenized-books") {
      return convertTokenizedBooksSource(manifest, parsed);
    }
    return convertStructuredJsonSource(manifest, parsed);
  }
  if (format === "numbered-aphorisms-text") {
    return convertNumberedAphorismsTextSource(manifest, rawText);
  }
  if (format === "roman-verse-text") {
    return convertRomanVerseTextSource(manifest, rawText);
  }
  if (format === "numbered-chapter-prose-text") {
    return convertNumberedChapterProseTextSource(manifest, rawText);
  }
  if (format === "headed-prose-text") {
    return convertHeadedProseTextSource(manifest, rawText);
  }
  return convertAutoSectionedTextSource(manifest, rawText);
}

function slimPreviewDocument(document) {
  const works = (Array.isArray(document?.works) ? document.works : []).map((work) => ({
    id: work.id,
    title: work.title,
    sections: (Array.isArray(work.sections) ? work.sections : []).map((section) => ({
      id: section.id,
      number: section.number,
      title: section.title || section.label,
      verses: (Array.isArray(section.verses) ? section.verses : []).map((verse) => ({
        number: verse.number,
        text: verse.text
      }))
    }))
  }));
  const sectionCount = works.reduce((sum, work) => sum + work.sections.length, 0);
  const verseCount = works.reduce((sum, work) => (
    sum + work.sections.reduce((inner, section) => inner + section.verses.length, 0)
  ), 0);
  return {
    title: document?.title || "",
    shortTitle: document?.shortTitle || "",
    works,
    stats: {
      works: works.length,
      sections: sectionCount,
      verses: verseCount
    }
  };
}

function extractLooseBlocks(rawText, slimDoc, format) {
  const kind = String(format || "");
  if (kind.includes("json") || kind === "sections" || kind === "chaptered-books" || kind === "tokenized-books") {
    return [];
  }
  const capturedVerses = [];
  const capturedTitles = new Set();
  (Array.isArray(slimDoc?.works) ? slimDoc.works : []).forEach((work) => {
    (Array.isArray(work.sections) ? work.sections : []).forEach((section) => {
      const title = normalizeWhitespace(section.title);
      if (title) {
        capturedTitles.add(title);
      }
      (Array.isArray(section.verses) ? section.verses : []).forEach((verse) => {
        capturedVerses.push(normalizeWhitespace(verse.text));
      });
    });
  });

  const capturedBlob = capturedVerses.join("\n");

  function stripDetectedPrefix(line) {
    return normalizeWhitespace(line)
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^[IVXLC]+:\d+\.\s+/i, "")
      .replace(/^[A-Z]\.\s+/, "");
  }

  function lineCaptured(line) {
    const needle = normalizeWhitespace(line);
    if (!needle) {
      return false;
    }
    if (capturedTitles.has(needle)) {
      return true;
    }
    const stripped = stripDetectedPrefix(needle) || needle;
    if (capturedBlob.includes(stripped) || capturedBlob.includes(needle)) {
      return true;
    }
    return capturedVerses.some((entry) => {
      if (!entry) {
        return false;
      }
      return stripped === entry || needle === entry;
    });
  }

  const loose = [];
  let current = [];
  function flush() {
    const text = current.join("\n").replace(/^\s+|\s+$/g, "");
    if (text) {
      loose.push(text);
    }
    current = [];
  }

  String(rawText || "").split(/\r?\n/).forEach((line) => {
    if (!normalizeWhitespace(line)) {
      if (current.length) {
        current.push(line);
      }
      return;
    }
    if (lineCaptured(line)) {
      flush();
      return;
    }
    current.push(line);
  });
  flush();
  return loose;
}

function previewTextImport(input = {}) {
  const rawText = String(input.text || "");
  if (!rawText.trim()) {
    throw new Error("Paste or upload some text first.");
  }
  const filename = String(input.filename || "").trim();
  const guessedFormat = detectTextFormat(rawText);
  const explicitFormat = Boolean(String(input.format || "").trim());
  const format = String(input.format || guessedFormat || "auto-sectioned-text").trim();
  const guessedTitle = normalizeWhitespace(input.title)
    || filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    || "Untitled text";
  const manifest = buildPreviewManifest({
    ...input,
    title: guessedTitle,
    format,
    id: input.id || slugify(guessedTitle)
  });
  const customRules = input.customRules && typeof input.customRules === "object" ? input.customRules : {};

  let document;
  let usedFormat = format;
  let warning = "";
  try {
    document = parseTextWithFormat(manifest, rawText, format, customRules);
  } catch (error) {
    if (explicitFormat && format !== "auto-sectioned-text") {
      warning = error.message || `No passages matched ${format}.`;
      document = buildCanonicalDocument(manifest, {}, []);
    } else if (format === "auto-sectioned-text") {
      throw error;
    } else {
      usedFormat = "auto-sectioned-text";
      warning = `${error.message || "Format failed."} Fell back to Auto.`;
      document = convertAutoSectionedTextSource({ ...manifest, inputFormat: usedFormat }, rawText);
    }
  }

  const slim = slimPreviewDocument(document);
  if (!slim.stats.verses && explicitFormat) {
    warning = warning || `No passages matched ${usedFormat}. Try Custom patterns or another format.`;
  } else if (!slim.stats.verses) {
    throw new Error("Could not find any passages in that file. Try another format or add blank lines between sections.");
  }

  return {
    guessedFormat,
    format: usedFormat,
    formats: FORMAT_CHOICES,
    warning,
    id: manifest.id,
    title: manifest.title,
    shortTitle: manifest.shortTitle,
    description: manifest.description,
    language: manifest.language,
    script: manifest.script,
    tradition: manifest.tradition,
    workLabel: manifest.workLabel,
    sectionLabel: manifest.sectionLabel,
    verseLabel: manifest.verseLabel,
    document: slim,
    stats: slim.stats,
    looseText: extractLooseBlocks(rawText, slim, usedFormat)
  };
}

module.exports = {
  SUPPORTED_IMPORT_FORMATS: [...SUPPORTED_IMPORT_FORMATS],
  detectTextFormat,
  importTextSources,
  importReferenceSources,
  previewTextImport,
  slugify
};