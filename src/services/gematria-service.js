const { loadGematriaWordIndex, loadHebrewDictionary, loadGreekDictionary } = require("./data-loader");
const { computeSimpleOrdinalGematria, computeSyllableValue } = require("./word-service");
const {
  HEBREW_METHODS,
  GREEK_METHODS,
  computeGematria,
  defaultMethodForLanguage,
  isHebrewScript,
  isGreekScript,
  isValidMethod,
  normalizeHebrewText,
  normalizeGreekText
} = require("../lib/script-gematria");
const { createHttpError } = require("../lib/http-errors");

const DICTIONARY_LANGUAGES = new Set(["hebrew", "greek"]);
const dictionaryIndexCache = new Map();

function dictionaryMatch(entry, language, method, word) {
  const isHebrew = language === "hebrew";
  const transliteration = String(entry?.[2] || "").trim();
  const lemma = isHebrew ? String(entry?.[1] || "").trim() : "";
  const grammar = isHebrew ? "" : String(entry?.[3] || "").trim();
  const definition = String(entry?.[isHebrew ? 3 : 4] || "").trim();
  const gematriaValue = computeGematria(word, language, method);
  return {
    word,
    gematriaValue,
    ...(transliteration ? { transliteration } : {}),
    ...(lemma && lemma !== word ? { lemma } : {}),
    ...(grammar ? { grammar } : {}),
    ...(definition ? { definition } : {})
  };
}

function buildDictionaryIndex(language, method, dictionary) {
  const isHebrew = language === "hebrew";
  const entries = Array.isArray(dictionary?.entries) ? dictionary.entries : [];
  const byValue = new Map();
  let indexedWordCount = 0;
  for (const entry of entries) {
    const rawWord = isHebrew ? String(entry?.[0] || "") : String(entry?.[1] || entry?.[0] || "");
    const word = (isHebrew ? normalizeHebrewText(rawWord) : normalizeGreekText(rawWord)).trim();
    if (!word) continue;
    if (isHebrew ? !isHebrewScript(word) : !isGreekScript(word)) continue;
    indexedWordCount += 1;
    const match = dictionaryMatch(entry, language, method, word);
    const bucket = byValue.get(match.gematriaValue);
    if (bucket) {
      bucket.push(match);
    } else {
      byValue.set(match.gematriaValue, [match]);
    }
  }
  for (const bucket of byValue.values()) {
    bucket.sort((left, right) => left.word.length - right.word.length || left.word.localeCompare(right.word));
  }
  return {
    byValue,
    indexedWordCount,
    source: String(dictionary?.meta?.source || ""),
    sourceWordCount: Number(dictionary?.meta?.sourceWordCount || entries.length || 0)
  };
}

async function getDictionaryIndex(language, method) {
  const key = `${language}:${method}`;
  if (!dictionaryIndexCache.has(key)) {
    const dictionary = language === "hebrew" ? await loadHebrewDictionary() : await loadGreekDictionary();
    dictionaryIndexCache.set(key, buildDictionaryIndex(language, method, dictionary));
  }
  return dictionaryIndexCache.get(key);
}

function warmDictionaryIndexes() {
  const jobs = [
    ...HEBREW_METHODS.map((method) => getDictionaryIndex("hebrew", method)),
    ...GREEK_METHODS.map((method) => getDictionaryIndex("greek", method))
  ];
  return Promise.all(jobs).catch(() => {});
}

function normalizeLanguage(rawLanguage, rawScript) {
  const raw = String(rawLanguage || rawScript || "").trim().toLowerCase();
  if (!raw || raw === "english" || raw === "en") {
    return "english";
  }
  if (raw === "hebrew" || raw === "he" || raw === "hbo") {
    return "hebrew";
  }
  if (raw === "greek" || raw === "grc" || raw === "el") {
    return "greek";
  }
  throw createHttpError(
    400,
    "invalid_gematria_language",
    `Unknown language '${raw}'. Use english, hebrew, or greek.`
  );
}

function sanitizeCipherEntries(index) {
  return (Array.isArray(index?.ciphers) ? index.ciphers : [])
    .map((entry, indexValue) => {
      const id = String(entry?.[0] || "").trim();
      const name = String(entry?.[1] || "").trim();
      const description = String(entry?.[2] || "").trim();
      if (!id || !name) {
        return null;
      }

      return {
        index: indexValue,
        id,
        name,
        description
      };
    })
    .filter(Boolean);
}

function sanitizeMatchEntries(index) {
  return Array.isArray(index?.entries) ? index.entries : [];
}

function parseGematriaValue(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) {
    throw createHttpError(400, "invalid_gematria_value", "Query parameter 'value' is required.");
  }

  const numeric = Number(trimmed);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw createHttpError(400, "invalid_gematria_value", "Query parameter 'value' must be a non-negative integer.");
  }

  return numeric;
}

function parseGematriaCipherFilter(rawValue, cipherEntries) {
  const rawTokens = Array.isArray(rawValue)
    ? rawValue.flatMap((value) => String(value ?? "").split(","))
    : String(rawValue ?? "").split(",");

  const requestedCipherIds = rawTokens
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (!requestedCipherIds.length) {
    return null;
  }

  const requestedCipherIdSet = new Set(requestedCipherIds);
  const availableCipherIdSet = new Set(cipherEntries.map((entry) => entry.id));
  const invalidCipherIds = [...requestedCipherIdSet].filter((cipherId) => !availableCipherIdSet.has(cipherId));
  if (invalidCipherIds.length) {
    throw createHttpError(
      400,
      "invalid_gematria_ciphers",
      `Unknown gematria cipher id${invalidCipherIds.length === 1 ? "" : "s"}: ${invalidCipherIds.join(", ")}.`
    );
  }

  return requestedCipherIdSet;
}

// Hebrew/Greek reverse lookup: value every dictionary entry (Strong's Hebrew /
// Thayer's Greek) in its own script and return the words matching the value.
async function findDictionaryWordsByValue(language, value, method) {
  const index = await getDictionaryIndex(language, method);
  const matches = index.byValue.get(value) || [];

  return {
    value,
    language,
    method,
    count: matches.length,
    matches,
    ciphers: [],
    meta: {
      language,
      method,
      source: index.source,
      sourceWordCount: index.sourceWordCount,
      indexedWordCount: index.indexedWordCount,
      matchedCount: matches.length
    }
  };
}

async function findWordsByGematriaValue(rawValue, rawCipherFilter, rawLanguage, rawScript, rawMethod) {
  const value = parseGematriaValue(rawValue);
  const language = normalizeLanguage(rawLanguage, rawScript);
  if (DICTIONARY_LANGUAGES.has(language)) {
    const requestedMethod = String(rawMethod || "").trim().toLowerCase();
    if (!isValidMethod(language, requestedMethod)) {
      throw createHttpError(
        400,
        "invalid_gematria_method",
        `Unknown ${language} method '${requestedMethod}'.`
      );
    }
    const method = requestedMethod || defaultMethodForLanguage(language);
    return findDictionaryWordsByValue(language, value, method);
  }

  const index = await loadGematriaWordIndex();
  const cipherEntries = sanitizeCipherEntries(index);
  const requestedCipherIdSet = parseGematriaCipherFilter(rawCipherFilter, cipherEntries);
  const wordEntries = sanitizeMatchEntries(index);
  const cipherByIndex = new Map(cipherEntries.map((entry) => [entry.index, entry]));
  const rawMatches = Array.isArray(index?.values?.[String(value)]) ? index.values[String(value)] : [];

  const matchedCipherCounts = new Map();
  const matches = rawMatches
    .map((match) => {
      const entryIndex = Number(match?.[0]);
      const wordEntry = wordEntries[entryIndex];
      if (!Number.isInteger(entryIndex) || !Array.isArray(wordEntry) || !String(wordEntry[0] || "").trim()) {
        return null;
      }

      const ciphers = (Array.isArray(match?.[1]) ? match[1] : [])
        .map((cipherIndex) => cipherByIndex.get(Number(cipherIndex)))
        .filter((cipher) => !requestedCipherIdSet || requestedCipherIdSet.has(cipher.id))
        .filter(Boolean);

      if (!ciphers.length) {
        return null;
      }

      ciphers.forEach((cipher) => {
        matchedCipherCounts.set(cipher.id, (matchedCipherCounts.get(cipher.id) || 0) + 1);
      });

      const word = String(wordEntry[0]).trim();
      const definition = String(wordEntry?.[1] || "").trim();
      const etymology = String(wordEntry?.[2] || "").trim();
      return {
        word,
        gematriaValue: computeSimpleOrdinalGematria(word),
        syllableValue: computeSyllableValue(word),
        ...(definition ? { definition } : {}),
        ...(etymology ? { etymology } : {}),
        ciphers: ciphers.map((cipher) => ({
          id: cipher.id,
          name: cipher.name,
          ...(cipher.description ? { description: cipher.description } : {})
        }))
      };
    })
    .filter(Boolean);

  const ciphers = cipherEntries
    .filter((cipher) => matchedCipherCounts.has(cipher.id))
    .map((cipher) => ({
      id: cipher.id,
      name: cipher.name,
      ...(cipher.description ? { description: cipher.description } : {}),
      count: matchedCipherCounts.get(cipher.id) || 0
    }))
    .sort((left, right) => {
      const countDelta = Number(right.count || 0) - Number(left.count || 0);
      if (countDelta !== 0) {
        return countDelta;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    value,
    language: "english",
    count: matches.length,
    cipherCount: ciphers.length,
    filters: requestedCipherIdSet
      ? {
          ciphers: cipherEntries
            .map((cipher) => cipher.id)
            .filter((cipherId) => requestedCipherIdSet.has(cipherId))
        }
      : undefined,
    matches,
    ciphers,
    meta: {
      language: "english",
      ...(index?.meta && typeof index.meta === "object"
        ? {
            indexedWordCount: Number(index.meta.indexedWordCount || 0),
            sourceWordCount: Number(index.meta.sourceWordCount || 0)
          }
        : {})
    }
  };
}

async function calculateGematriaText(rawText, rawLanguage, rawMethod) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    throw createHttpError(400, "invalid_gematria_text", "Query parameter 'text' is required.");
  }
  const language = normalizeLanguage(rawLanguage, null);
  if (language === "english") {
    throw createHttpError(
      400,
      "invalid_gematria_language",
      "English gematria uses ciphers; pass language=hebrew or language=greek."
    );
  }
  const requestedMethod = String(rawMethod || "").trim().toLowerCase();
  if (!isValidMethod(language, requestedMethod)) {
    throw createHttpError(400, "invalid_gematria_method", `Unknown ${language} method '${requestedMethod}'.`);
  }
  const method = requestedMethod || defaultMethodForLanguage(language);
  return {
    text,
    language,
    method,
    value: computeGematria(text, language, method)
  };
}

module.exports = {
  findWordsByGematriaValue,
  calculateGematriaText,
  parseGematriaValue,
  warmDictionaryIndexes
};