function normalizeGreekKoineEntries(entries) {
  const source = Array.isArray(entries) ? entries : [];
  return source.map((entry, entryIndex) => {
    const position = Number.isFinite(Number(entry?.index))
      ? Math.trunc(Number(entry.index))
      : entryIndex + 1;

    return {
      numerology: position,
      ...entry
    };
  });
}

function normalizeAlphabets(alphabets) {
  const source = alphabets && typeof alphabets === "object" ? alphabets : {};
  return {
    ...source,
    greek: normalizeGreekKoineEntries(source.greek)
  };
}

function normalizeMagickDataset(dataset) {
  const source = dataset && typeof dataset === "object" ? dataset : {};
  const grouped = source.grouped && typeof source.grouped === "object" ? source.grouped : {};
  const normalizedAlphabets = normalizeAlphabets(grouped.alphabets);

  return {
    ...source,
    grouped: {
      ...grouped,
      alphabets: normalizedAlphabets
    }
  };
}

module.exports = {
  normalizeAlphabets,
  normalizeMagickDataset
};