const { createNotFoundError } = require("../../lib/http-errors");
const { parsePaginationParams, paginateResults } = require("../../lib/pagination");

function paginateList(items, query = {}) {
  const { offset, limit } = parsePaginationParams(query);
  return paginateResults(items, { offset, limit });
}

function flattenDecans(decansBySign) {
  return Object.values(decansBySign && typeof decansBySign === "object" ? decansBySign : {})
    .flat()
    .sort((left, right) => {
      const signCompare = String(left?.signId || "").localeCompare(String(right?.signId || ""));
      if (signCompare !== 0) {
        return signCompare;
      }

      return Number(left?.index || 0) - Number(right?.index || 0);
    });
}

function findByNormalizedId(entries, value, idSelector) {
  const needle = String(value || "").trim().toLowerCase();
  return (Array.isArray(entries) ? entries : []).find((entry) => {
    const id = typeof idSelector === "function" ? idSelector(entry) : entry?.id;
    return String(id || "").trim().toLowerCase() === needle;
  }) || null;
}

function findByNormalizedCandidates(entries, value, candidateSelector) {
  const needle = String(value || "").trim().toLowerCase();
  return (Array.isArray(entries) ? entries : []).find((entry) => {
    const candidates = typeof candidateSelector === "function" ? candidateSelector(entry) : [];
    return candidates.some((candidate) => String(candidate || "").trim().toLowerCase() === needle);
  }) || null;
}

function resolvePlayingCardAlias(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const compact = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (/^(A|[2-9]|10|J|Q|K)(H|D|C|S)$/.test(compact)) {
    return compact;
  }

  const match = raw.toLowerCase().match(/^(ace|two|three|four|five|six|seven|eight|nine|ten|jack|queen|king)[\s-]+of[\s-]+(hearts|diamonds|clubs|spades)$/);
  if (!match) {
    return null;
  }

  const rankMap = {
    ace: "A",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    jack: "J",
    queen: "Q",
    king: "K"
  };
  const suitMap = {
    hearts: "H",
    diamonds: "D",
    clubs: "C",
    spades: "S"
  };

  return `${rankMap[match[1]]}${suitMap[match[2]]}`;
}

function createEntityNotFound(entity, value) {
  return createNotFoundError(
    `${entity}_not_found`,
    `Unknown ${String(entity || "resource").replace(/-/g, " ")} '${value}'.`
  );
}

module.exports = {
  createEntityNotFound,
  findByNormalizedCandidates,
  findByNormalizedId,
  flattenDecans,
  paginateList,
  resolvePlayingCardAlias
};