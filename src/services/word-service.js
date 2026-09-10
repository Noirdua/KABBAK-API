const { loadGematriaWordIndex } = require("./data-loader");
const { createHttpError } = require("../lib/http-errors");
const { escapeRegExp } = require("../lib/string-utils");

function normalizeWordLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function normalizeWordLookupPattern(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z*?]/g, "")
    .replace(/\*+/g, "*");
}

function buildWildcardRegex(pattern) {
  const tokens = [...String(pattern || "")].map((char) => {
    if (char === "*") {
      return ".*";
    }

    if (char === "?") {
      return ".";
    }

    return escapeRegExp(char);
  });

  return new RegExp(`^${tokens.join("")}$`);
}

function computeSimpleOrdinalGematria(value) {
  const normalized = normalizeWordLookupText(value);
  return [...normalized].reduce((total, char) => total + (char.charCodeAt(0) - 96), 0);
}

function computeSyllableValue(value) {
  const normalized = normalizeWordLookupText(value);
  if (!normalized) {
    return 0;
  }

  if (normalized.length <= 3) {
    return 1;
  }

  const simplified = normalized
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/i, "")
    .replace(/^y/i, "");
  const groups = simplified.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function toWordMatchPayload(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    word: entry.word,
    gematriaValue: Number(entry.gematriaValue || 0),
    syllableValue: Number(entry.syllableValue || 0),
    ...(entry.definition ? { definition: entry.definition } : {}),
    ...(entry.etymology ? { etymology: entry.etymology } : {}),
    ...(Array.isArray(entry.synonyms) && entry.synonyms.length ? { synonyms: entry.synonyms } : {})
  };
}

function parseWordPrefix(rawValue) {
  const prefix = String(rawValue ?? "").trim();
  if (!prefix) {
    throw createHttpError(400, "invalid_word_prefix", "Query parameter 'prefix' is required.");
  }

  const normalized = normalizeWordLookupPattern(prefix);
  const normalizedLetters = normalizeWordLookupText(prefix);
  if (!normalizedLetters) {
    throw createHttpError(400, "invalid_word_prefix", "Query parameter 'prefix' must contain letters A-Z, with optional * and ? wildcards.");
  }

  const hasWildcard = normalized.includes("*") || normalized.includes("?");
  const wildcardRegex = hasWildcard
    ? buildWildcardRegex(normalized)
    : null;

  return {
    prefix,
    normalized,
    hasWildcard,
    wildcardRegex
  };
}

let preparedIndexRef = null;
let preparedEntries = [];

async function getPreparedWordEntries() {
  const index = await loadGematriaWordIndex();
  if (preparedIndexRef !== null && index === preparedIndexRef) {
    return {
      index,
      entries: preparedEntries
    };
  }

  const rawEntries = Array.isArray(index?.entries) ? index.entries : [];
  preparedEntries = rawEntries
    .map((entry) => {
      const word = String(Array.isArray(entry) ? entry[0] : "").trim();
      if (!word) {
        return null;
      }

      const normalizedWord = normalizeWordLookupText(word);
      if (!normalizedWord) {
        return null;
      }

      const definition = String((Array.isArray(entry) ? entry[1] : "") || "").trim();
      const etymology = String((Array.isArray(entry) ? entry[2] : "") || "").trim();
      const synonyms = Array.isArray(entry?.[3])
        ? entry[3].map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      return {
        word,
        normalizedWord,
        gematriaValue: computeSimpleOrdinalGematria(normalizedWord),
        syllableValue: computeSyllableValue(normalizedWord),
        ...(definition ? { definition } : {}),
        ...(etymology ? { etymology } : {}),
        ...(synonyms.length ? { synonyms } : {})
      };
    })
    .filter(Boolean);
  preparedIndexRef = index;

  return {
    index,
    entries: preparedEntries
  };
}

async function findWordExact(rawWord) {
  const word = String(rawWord ?? "").trim();
  const normalized = normalizeWordLookupText(word);
  if (!normalized) {
    throw createHttpError(400, "invalid_word", "Query parameter 'word' must contain letters A-Z.");
  }

  const { index, entries } = await getPreparedWordEntries();
  const entry = entries.find((candidate) => candidate.normalizedWord === normalized) || null;
  return {
    word,
    normalized,
    match: entry ? toWordMatchPayload(entry) : null,
    meta: index?.meta && typeof index.meta === "object"
      ? {
          indexedWordCount: Number(index.meta.indexedWordCount || 0),
          sourceWordCount: Number(index.meta.sourceWordCount || 0)
        }
      : undefined
  };
}

async function findWordsByPrefix(rawPrefix) {
  const parsed = parseWordPrefix(rawPrefix);
  const { index, entries } = await getPreparedWordEntries();

  const matches = entries
    .filter((entry) => (
      parsed.hasWildcard
        ? parsed.wildcardRegex.test(entry.normalizedWord)
        : entry.normalizedWord.startsWith(parsed.normalized)
    ))
    .map((entry) => toWordMatchPayload(entry))
    .sort((left, right) => left.word.localeCompare(right.word));

  return {
    prefix: parsed.prefix,
    normalized: parsed.normalized,
    hasWildcard: parsed.hasWildcard,
    count: matches.length,
    matches,
    meta: index?.meta && typeof index.meta === "object"
      ? {
          indexedWordCount: Number(index.meta.indexedWordCount || 0),
          sourceWordCount: Number(index.meta.sourceWordCount || 0)
        }
      : undefined
  };
}

module.exports = {
  computeSimpleOrdinalGematria,
  computeSyllableValue,
  findWordExact,
  findWordsByPrefix,
  normalizeWordLookupText,
  parseWordPrefix,
  toWordMatchPayload
};