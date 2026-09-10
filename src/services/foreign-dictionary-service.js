const { loadHebrewDictionary, loadGreekDictionary } = require("./data-loader");
const { createHttpError } = require("../lib/http-errors");

const HEBREW_SCRIPT_RE = /[\u0590-\u05FF]/;
const GREEK_SCRIPT_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/;

function normalizeHebrew(value) {
  return String(value || "")
    .replace(/[\u0591-\u05C7\u05BE\u05F3\u05F4]/g, "")
    .trim();
}

function normalizeGreek(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u03c2/g, "\u03c3")
    .replace(/[·]/g, "")
    .trim();
}

function resolveLimit(rawValue) {
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.min(50, Math.floor(numeric)));
  }
  return 20;
}

function sortByWordLengthThenWord(entries) {
  return entries.slice().sort((left, right) => {
    const lengthDelta = left.word.length - right.word.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }
    return left.word.localeCompare(right.word);
  });
}

async function findDictionaryTranslations(rawText, options = {}) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    throw createHttpError(400, "invalid_translation_text", "Query parameter 'text' is required.");
  }

  const hasHebrew = HEBREW_SCRIPT_RE.test(text);
  const hasGreek = GREEK_SCRIPT_RE.test(text);
  if (hasHebrew === hasGreek) {
    throw createHttpError(
      400,
      "invalid_translation_text",
      "Query parameter 'text' must contain either Hebrew or Greek letters."
    );
  }

  const limit = resolveLimit(options.limit);
  const exact = String(options.mode || "").toLowerCase() === "exact";

  function matchesQuery(entryWord, normalized) {
    if (!entryWord) return false;
    return exact ? entryWord === normalized : entryWord.startsWith(normalized);
  }

  if (hasHebrew) {
    const normalized = normalizeHebrew(text);
    const dictionary = await loadHebrewDictionary();
    const entries = Array.isArray(dictionary?.entries) ? dictionary.entries : [];
    const matches = sortByWordLengthThenWord(entries
      .filter((entry) => matchesQuery(String(entry?.[0] || ""), normalized))
      .map((entry) => ({
        word: String(entry?.[0] || ""),
        lemma: String(entry?.[1] || ""),
        transliteration: String(entry?.[2] || ""),
        definition: String(entry?.[3] || "")
      })))
      .slice(0, limit);

    return {
      script: "hebrew",
      text,
      normalized,
      count: matches.length,
      matches,
      meta: dictionary?.meta && typeof dictionary.meta === "object" ? dictionary.meta : undefined
    };
  }

  const normalized = normalizeGreek(text);
  const dictionary = await loadGreekDictionary();
  const entries = Array.isArray(dictionary?.entries) ? dictionary.entries : [];
  const matches = sortByWordLengthThenWord(entries
    .filter((entry) => matchesQuery(String(entry?.[0] || ""), normalized))
    .map((entry) => ({
      word: String(entry?.[0] || ""),
      lemma: String(entry?.[1] || ""),
      transliteration: String(entry?.[2] || ""),
      ...(entry?.[3] ? { grammar: String(entry[3]) } : {}),
      definition: String(entry?.[4] || "")
    })))
    .slice(0, limit);

  return {
    script: "greek",
    text,
    normalized,
    count: matches.length,
    matches,
    meta: dictionary?.meta && typeof dictionary.meta === "object" ? dictionary.meta : undefined
  };
}

module.exports = {
  findDictionaryTranslations,
  normalizeGreek,
  normalizeHebrew
};
