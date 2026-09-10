const { loadGematriaWordIndex } = require("./data-loader");
const { computeSimpleOrdinalGematria, computeSyllableValue } = require("./word-service");
const { createHttpError } = require("../lib/http-errors");

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

async function findWordsByGematriaValue(rawValue, rawCipherFilter) {
  const value = parseGematriaValue(rawValue);
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
    meta: index?.meta && typeof index.meta === "object"
      ? {
          indexedWordCount: Number(index.meta.indexedWordCount || 0),
          sourceWordCount: Number(index.meta.sourceWordCount || 0)
        }
      : undefined
  };
}

module.exports = {
  findWordsByGematriaValue,
  parseGematriaValue
};