const { loadGematriaWordIndex, loadAnagramWordIndex } = require("./data-loader");
const { computeSimpleOrdinalGematria, computeSyllableValue } = require("./word-service");
const { createHttpError } = require("../lib/http-errors");

function normalizeAnagramText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function toSignature(value) {
  return [...normalizeAnagramText(value)].sort().join("");
}

function parseAnagramText(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    throw createHttpError(400, "invalid_anagram_text", "Query parameter 'text' is required.");
  }

  const normalized = normalizeAnagramText(text);
  if (!normalized) {
    throw createHttpError(400, "invalid_anagram_text", "Query parameter 'text' must contain letters A-Z.");
  }

  return {
    text,
    normalized,
    signature: toSignature(text)
  };
}

async function findWordAnagrams(rawText) {
  const parsed = parseAnagramText(rawText);
  const [gematriaWordIndex, anagramWordIndex] = await Promise.all([
    loadGematriaWordIndex(),
    loadAnagramWordIndex()
  ]);

  const entries = Array.isArray(gematriaWordIndex?.entries) ? gematriaWordIndex.entries : [];
  const signatureMatches = Array.isArray(anagramWordIndex?.signatures?.[parsed.signature])
    ? anagramWordIndex.signatures[parsed.signature]
    : [];

  const matches = signatureMatches
    .map((entryIndex) => {
      const normalizedIndex = Number(entryIndex);
      const entry = entries[normalizedIndex];
      const word = String(Array.isArray(entry) ? entry[0] : "").trim();
      if (!Number.isInteger(normalizedIndex) || !word) {
        return null;
      }

      const normalizedWord = normalizeAnagramText(word);
      if (!normalizedWord || normalizedWord === parsed.normalized) {
        return null;
      }

      const definition = String((Array.isArray(entry) ? entry[1] : "") || "").trim();
      const etymology = String((Array.isArray(entry) ? entry[2] : "") || "").trim();
      return {
        word,
        gematriaValue: computeSimpleOrdinalGematria(word),
        syllableValue: computeSyllableValue(word),
        ...(definition ? { definition } : {}),
        ...(etymology ? { etymology } : {})
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.word.localeCompare(right.word));

  return {
    text: parsed.text,
    normalized: parsed.normalized,
    signature: parsed.signature,
    letterCount: parsed.normalized.length,
    count: matches.length,
    matches,
    meta: anagramWordIndex?.meta && typeof anagramWordIndex.meta === "object"
      ? {
          indexedWordCount: Number(anagramWordIndex.meta.indexedWordCount || 0),
          signatureCount: Number(anagramWordIndex.meta.signatureCount || 0)
        }
      : undefined
  };
}

module.exports = {
  findWordAnagrams,
  normalizeAnagramText,
  parseAnagramText
};