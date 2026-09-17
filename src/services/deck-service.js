const fs = require("fs");
const path = require("path");
const {
  loadDeckRegistry,
  loadDeckManifest
} = require("./data-loader");
const { assetRoot } = require("../config/paths");
const { createHttpError } = require("../lib/http-errors");
const { toTitleCase } = require("../lib/string-utils");

const DEFAULT_DECK_ID = "ceremonial-magick";

const trumpNumberByCanonicalName = {
  fool: 0,
  magus: 1,
  magician: 1,
  "high priestess": 2,
  empress: 3,
  emperor: 4,
  hierophant: 5,
  lovers: 6,
  chariot: 7,
  lust: 8,
  strength: 8,
  hermit: 9,
  fortune: 10,
  "wheel of fortune": 10,
  justice: 11,
  "hanged man": 12,
  death: 13,
  art: 14,
  temperance: 14,
  devil: 15,
  tower: 16,
  star: 17,
  moon: 18,
  sun: 19,
  aeon: 20,
  judgement: 20,
  judgment: 20,
  universe: 21,
  world: 21
};

const pipValueByToken = {
  ace: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10
};

const rankWordByPipValue = {
  1: "Ace",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
  9: "Nine",
  10: "Ten"
};

const trumpRomanToNumber = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
  XXI: 21
};

const suitSearchAliasesById = {
  wands: ["wands"],
  cups: ["cups"],
  swords: ["swords"],
  disks: ["disks", "pentacles", "coins"]
};

const defaultPipRankOrder = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

function canonicalMajorName(cardName) {
  return String(cardName || "")
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}

function normalizeDeckId(deckId, sources = {}) {
  const normalized = String(deckId || "").trim().toLowerCase();
  if (sources[normalized]) {
    return normalized;
  }
  if (sources[DEFAULT_DECK_ID]) {
    return DEFAULT_DECK_ID;
  }
  return Object.keys(sources)[0] || DEFAULT_DECK_ID;
}

function normalizeTrumpNumber(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 21) {
    return null;
  }
  return parsed;
}

function parseTrumpNumberKey(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    return normalizeTrumpNumber(Number(normalized));
  }
  if (Object.prototype.hasOwnProperty.call(trumpRomanToNumber, normalized)) {
    return normalizeTrumpNumber(trumpRomanToNumber[normalized]);
  }
  return null;
}

function normalizeSuitId(suitInput) {
  const suit = String(suitInput || "").trim().toLowerCase();
  return suit === "pentacles" ? "disks" : suit;
}

function parseMinorCard(cardName) {
  const match = String(cardName || "")
    .trim()
    .match(/^(ace|two|three|four|five|six|seven|eight|nine|ten|knight|queen|prince|princess|king|page|[2-9]|10)\s+of\s+(cups|wands|swords|pentacles|disks)$/i);
  if (!match) {
    return null;
  }

  const rankToken = String(match[1] || "").toLowerCase();
  const suitId = normalizeSuitId(match[2]);
  const pipValue = pipValueByToken[rankToken] ?? null;

  if (Number.isFinite(pipValue)) {
    const rankWord = rankWordByPipValue[pipValue] || "";
    return { suitId, pipValue, court: "", rankWord, rankKey: rankWord.toLowerCase() };
  }

  const courtWord = toTitleCase(rankToken);
  if (!courtWord) {
    return null;
  }
  return { suitId, pipValue: null, court: rankToken, rankWord: courtWord, rankKey: rankToken };
}

function canonicalMinorName(cardName) {
  const parsedMinor = parseMinorCard(cardName);
  if (!parsedMinor) {
    return "";
  }
  return `${String(parsedMinor.rankKey || "").trim().toLowerCase()} of ${parsedMinor.suitId}`;
}

function applyTemplate(template, variables) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, token) => {
    const value = variables[token];
    return value == null ? "" : String(value);
  });
}

function isRemoteAssetPath(pathValue) {
  return /^(https?:)?\/\//i.test(String(pathValue || ""));
}

function toDeckAssetPath(manifest, relativeOrAbsolutePath) {
  const normalizedPath = String(relativeOrAbsolutePath || "").trim();
  if (!normalizedPath) {
    return "";
  }
  if (isRemoteAssetPath(normalizedPath) || normalizedPath.startsWith("/")) {
    return normalizedPath;
  }
  return `${manifest.basePath}/${normalizedPath.replace(/^\.\//, "")}`;
}

function resolveDeckCardBackPath(manifest) {
  if (!manifest) {
    return null;
  }
  const explicitCardBack = String(manifest.cardBack || "").trim();
  if (explicitCardBack) {
    return toDeckAssetPath(manifest, explicitCardBack) || null;
  }
  const detectedCardBack = String(manifest.cardBackPath || "").trim();
  if (detectedCardBack) {
    return toDeckAssetPath(manifest, detectedCardBack) || null;
  }
  return null;
}

function resolveDeckThumbnailPath(manifest, relativePath) {
  if (!manifest || !manifest.thumbnails || manifest.thumbnails === false) {
    return null;
  }

  const normalizedPath = String(relativePath || "").trim().replace(/^\.\//, "");
  if (!normalizedPath || isRemoteAssetPath(normalizedPath) || normalizedPath.startsWith("/")) {
    return null;
  }

  return toDeckAssetPath(manifest, `${manifest.thumbnails.root}/${normalizedPath}`) || null;
}

function getRankOrder(minorRule, fallbackRankOrder = []) {
  const explicitRankOrder = Array.isArray(minorRule?.rankOrder) ? minorRule.rankOrder : [];
  const rankOrderSource = explicitRankOrder.length ? explicitRankOrder : fallbackRankOrder;
  return rankOrderSource.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function getRankIndex(minorRule, parsedMinor, fallbackRankOrder = []) {
  if (!minorRule || !parsedMinor) {
    return null;
  }
  const lowerRankWord = String(parsedMinor.rankWord || "").toLowerCase();
  const lowerRankKey = String(parsedMinor.rankKey || "").toLowerCase();

  const indexByKey = minorRule.rankIndexByKey;
  if (indexByKey && typeof indexByKey === "object") {
    const mapped = Number(indexByKey[lowerRankKey]);
    if (Number.isInteger(mapped) && mapped >= 0) {
      return mapped;
    }
  }

  const rankOrder = getRankOrder(minorRule, fallbackRankOrder);
  for (let i = 0; i < rankOrder.length; i += 1) {
    const candidate = String(rankOrder[i] || "").toLowerCase();
    if (candidate && (candidate === lowerRankWord || candidate === lowerRankKey)) {
      return i;
    }
  }
  return null;
}

function resolveMinorNumberTemplateGroup(groupRule, parsedMinor, fallbackRankOrder = []) {
  if (!groupRule || typeof groupRule !== "object") {
    return null;
  }

  const rankIndex = getRankIndex(groupRule, parsedMinor, fallbackRankOrder);
  if (!Number.isInteger(rankIndex) || rankIndex < 0) {
    return null;
  }

  const suitBaseRaw = Number(groupRule?.suitBase?.[parsedMinor.suitId]);
  if (!Number.isFinite(suitBaseRaw)) {
    return null;
  }

  const numberPad = Number.isInteger(groupRule.numberPad) ? groupRule.numberPad : 2;
  const cardNumber = String(suitBaseRaw + rankIndex).padStart(numberPad, "0");
  const template = String(groupRule.template || "{number}.png");

  return applyTemplate(template, {
    number: cardNumber,
    suitId: parsedMinor.suitId,
    rank: parsedMinor.rankWord,
    rankKey: parsedMinor.rankKey,
    index: rankIndex
  });
}

function normalizeCardFiles(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  const single = String(value || "").trim();
  return single ? [single] : [];
}

function resolveMajorFiles(manifest, canonicalName) {
  const majorRule = manifest?.majors;
  if (!majorRule || typeof majorRule !== "object") {
    return [];
  }
  if (majorRule.mode === "canonical-map") {
    const cards = majorRule.cards || {};
    return normalizeCardFiles(cards[canonicalName]);
  }

  const trumpNo = trumpNumberByCanonicalName[canonicalName];
  if (!Number.isInteger(trumpNo) || trumpNo < 0 || trumpNo > 21) {
    return [];
  }

  if (majorRule.mode === "trump-map") {
    const cards = majorRule.cards || {};
    return normalizeCardFiles(cards[String(trumpNo)] ?? cards[trumpNo]);
  }

  if (majorRule.mode === "trump-template") {
    const numberPad = Number.isInteger(majorRule.numberPad) ? majorRule.numberPad : 2;
    const template = String(majorRule.template || "{number}.png");
    const number = String(trumpNo).padStart(numberPad, "0");
    return normalizeCardFiles(applyTemplate(template, { trump: trumpNo, number }));
  }
  return [];
}

function resolveMinorFile(manifest, parsedMinor) {
  const minorRule = manifest?.minors;
  if (!minorRule || typeof minorRule !== "object") {
    return null;
  }

  if (minorRule.mode === "file-map") {
    const key = `${String(parsedMinor.rankKey || "").trim().toLowerCase()} of ${parsedMinor.suitId}`;
    const files = normalizeCardFiles(minorRule.cards?.[key] || minorRule.cards?.[`${parsedMinor.suitId}:${parsedMinor.rankKey}`]);
    return files[0] || null;
  }

  if (minorRule.mode === "split-number-template") {
    if (Number.isFinite(parsedMinor.pipValue)) {
      return resolveMinorNumberTemplateGroup(minorRule.smalls, parsedMinor, defaultPipRankOrder);
    }
    return resolveMinorNumberTemplateGroup(minorRule.courts, parsedMinor);
  }

  const rankIndex = getRankIndex(minorRule, parsedMinor);
  if (!Number.isInteger(rankIndex) || rankIndex < 0) {
    return null;
  }

  if (minorRule.mode === "suit-base-and-rank-order") {
    const suitBaseRaw = Number(minorRule?.suitBase?.[parsedMinor.suitId]);
    if (!Number.isFinite(suitBaseRaw)) {
      return null;
    }
    const numberPad = Number.isInteger(minorRule.numberPad) ? minorRule.numberPad : 2;
    const cardNumber = String(suitBaseRaw + rankIndex).padStart(numberPad, "0");
    const suitWord = String(minorRule?.suitLabel?.[parsedMinor.suitId] || toTitleCase(parsedMinor.suitId));
    const template = String(minorRule.template || "{number}_{rank} {suit}.webp");
    return applyTemplate(template, {
      number: cardNumber,
      rank: parsedMinor.rankWord,
      rankKey: parsedMinor.rankKey,
      suit: suitWord,
      suitId: parsedMinor.suitId,
      index: rankIndex + 1
    });
  }

  if (minorRule.mode === "suit-prefix-and-rank-order") {
    const suitPrefix = minorRule?.suitPrefix?.[parsedMinor.suitId];
    if (!suitPrefix) {
      return null;
    }
    const indexStart = Number.isInteger(minorRule.indexStart) ? minorRule.indexStart : 1;
    const indexPad = Number.isInteger(minorRule.indexPad) ? minorRule.indexPad : 2;
    const suitIndex = String(indexStart + rankIndex).padStart(indexPad, "0");
    const template = String(minorRule.template || "{suit}{index}.png");
    return applyTemplate(template, {
      suit: suitPrefix,
      suitId: parsedMinor.suitId,
      index: suitIndex,
      rank: parsedMinor.rankWord,
      rankKey: parsedMinor.rankKey
    });
  }

  if (minorRule.mode === "suit-base-number-template") {
    const suitBaseRaw = Number(minorRule?.suitBase?.[parsedMinor.suitId]);
    if (!Number.isFinite(suitBaseRaw)) {
      return null;
    }
    const numberPad = Number.isInteger(minorRule.numberPad) ? minorRule.numberPad : 2;
    const cardNumber = String(suitBaseRaw + rankIndex).padStart(numberPad, "0");
    const template = String(minorRule.template || "{number}.png");
    return applyTemplate(template, {
      number: cardNumber,
      suitId: parsedMinor.suitId,
      rank: parsedMinor.rankWord,
      rankKey: parsedMinor.rankKey,
      index: rankIndex
    });
  }

  return null;
}

function resolveIChingCardFiles(manifest, cardName) {
  const hexagrams = manifest?.hexagrams && typeof manifest.hexagrams === "object" ? manifest.hexagrams : {};
  const names = manifest?.hexagramNames && typeof manifest.hexagramNames === "object" ? manifest.hexagramNames : {};
  const target = String(cardName || "").trim().toLowerCase();
  if (!target) {
    return [];
  }
  const numberMatch = target.match(/^(?:hexagram[\s#_-]*)?(\d{1,2})(?:\D|$)/)
    || target.match(/^(?:hexagram|hex)[\s#_-]*(\d{1,2})$/);
  const key = numberMatch
    ? String(Number(numberMatch[1]))
    : Object.keys(names).find((candidate) => String(names[candidate] || "").trim().toLowerCase() === target);
  if (!key) {
    return [];
  }
  const file = hexagrams[key];
  return file ? normalizeCardFiles(file) : [];
}

const PLAYING_RANK_IDS = {
  ace: "ace", a: "ace", 1: "ace",
  two: "two", 2: "two",
  three: "three", 3: "three",
  four: "four", 4: "four",
  five: "five", 5: "five",
  six: "six", 6: "six",
  seven: "seven", 7: "seven",
  eight: "eight", 8: "eight",
  nine: "nine", 9: "nine",
  ten: "ten", 10: "ten",
  jack: "jack", j: "jack", knave: "jack",
  queen: "queen", q: "queen",
  king: "king", k: "king"
};

const PLAYING_SUIT_IDS = {
  hearts: "hearts", heart: "hearts",
  diamonds: "diamonds", diamond: "diamonds",
  clubs: "clubs", club: "clubs", clover: "clubs", clovers: "clubs",
  spades: "spades", spade: "spades"
};

function parsePlayingCard(cardName) {
  const match = String(cardName || "")
    .trim()
    .match(/^(ace|two|three|four|five|six|seven|eight|nine|ten|jack|queen|king|knave|[2-9]|10|a|j|q|k)\s+of\s+(hearts?|diamonds?|clubs?|clovers?|spades?)$/i);
  if (!match) {
    return null;
  }
  const rankId = PLAYING_RANK_IDS[String(match[1] || "").toLowerCase()] || "";
  const suitId = PLAYING_SUIT_IDS[String(match[2] || "").toLowerCase()] || "";
  if (!rankId || !suitId) {
    return null;
  }
  return { rankId, suitId, key: `${rankId} of ${suitId}` };
}

function resolvePlayingCardFiles(manifest, cardName) {
  const cards = manifest?.cards && typeof manifest.cards === "object" ? manifest.cards : {};
  const parsed = parsePlayingCard(cardName);
  if (!parsed) {
    if (/joker/i.test(String(cardName || ""))) {
      const direct = cards.joker ?? cards.jokers ?? cards["joker-1"] ?? cards.joker1;
      if (direct != null) return normalizeCardFiles(direct);
      const entry = Object.entries(cards).find(([name]) => /joker/i.test(String(name)));
      return entry ? normalizeCardFiles(entry[1]) : [];
    }
    return [];
  }
  const file = cards[parsed.key]
    || Object.entries(cards).find(([key]) => String(key || "").trim().toLowerCase() === parsed.key)?.[1];
  return file ? normalizeCardFiles(file) : [];
}

function resolveCardRelativePaths(manifest, cardName) {
  if (!manifest) {
    return [];
  }
  const system = String(manifest.system || "").trim().toLowerCase();
  if (system === "iching") {
    return resolveIChingCardFiles(manifest, cardName);
  }
  if (system === "playing-cards") {
    return resolvePlayingCardFiles(manifest, cardName);
  }
  const canonical = canonicalMajorName(cardName);
  const majorFiles = resolveMajorFiles(manifest, canonical);
  if (majorFiles.length) {
    return majorFiles;
  }
  const parsedMinor = parseMinorCard(cardName);
  if (!parsedMinor) {
    return [];
  }
  const minorFile = resolveMinorFile(manifest, parsedMinor);
  return minorFile ? [minorFile] : [];
}

async function getDeckSources() {
  const registry = await loadDeckRegistry();
  const deckList = Array.isArray(registry?.decks) ? registry.decks : [];
  return Object.fromEntries(deckList.map((entry) => [String(entry.id || "").trim().toLowerCase(), entry]));
}

async function resolveDeck(deckId) {
  const sources = await getDeckSources();
  const resolvedDeckId = normalizeDeckId(deckId, sources);
  const source = sources[resolvedDeckId] || null;
  const manifest = source ? await loadDeckManifest(resolvedDeckId) : null;
  return { resolvedDeckId, source, manifest };
}

function applySuitNameOverrides(manifest, displayName) {
  const overrides = manifest?.suitNameOverrides;
  if (!overrides || typeof overrides !== "object") {
    return displayName;
  }
  let next = String(displayName || "");
  const pairs = [
    ["wands", overrides.wands],
    ["cups", overrides.cups],
    ["swords", overrides.swords],
    ["disks", overrides.disks || overrides.pentacles],
    ["pentacles", overrides.pentacles || overrides.disks]
  ];
  pairs.forEach(([from, to]) => {
    const custom = String(to || "").trim();
    if (!custom) {
      return;
    }
    next = next.replace(new RegExp(`of ${from}\\b`, "ig"), `of ${custom}`);
  });
  return next;
}

// Court cards can be renamed deck-wide (Page → Princess, Knight → Prince…).
function applyCourtNameOverrides(manifest, displayName) {
  const overrides = manifest?.courtNameOverrides;
  if (!overrides || typeof overrides !== "object") {
    return displayName;
  }
  let next = String(displayName || "");
  [["page", overrides.page], ["knight", overrides.knight], ["queen", overrides.queen], ["king", overrides.king]]
    .forEach(([rank, to]) => {
      const custom = String(to || "").trim();
      if (!custom) {
        return;
      }
      next = next.replace(new RegExp(`^${rank}\\b`, "i"), custom);
    });
  return next;
}

function resolveDisplayNameWithDeck(manifest, cardName, trumpNumber) {
  const fallbackName = String(cardName || "").trim();
  if (!manifest) {
    return fallbackName;
  }

  const system = String(manifest.system || "").trim().toLowerCase();
  if (system === "iching") {
    const names = manifest.hexagramNames && typeof manifest.hexagramNames === "object" ? manifest.hexagramNames : {};
    const target = fallbackName.toLowerCase();
    const numberMatch = target.match(/^(?:hexagram|hex)?[\s#_-]*(\d{1,2})$/);
    const key = numberMatch
      ? String(Number(numberMatch[1]))
      : Object.keys(names).find((candidate) => String(names[candidate] || "").trim().toLowerCase() === target);
    return key ? String(names[key] || `Hexagram ${key}`) : (fallbackName || "Hexagram");
  }

  if (system === "playing-cards") {
    const parsed = parsePlayingCard(fallbackName);
    if (!parsed) {
      return fallbackName;
    }
    const rankOverrides = manifest?.rankNameOverrides && typeof manifest.rankNameOverrides === "object"
      ? manifest.rankNameOverrides
      : {};
    const suitOverrides = manifest?.suitNameOverrides && typeof manifest.suitNameOverrides === "object"
      ? manifest.suitNameOverrides
      : {};
    const rankLabel = String(rankOverrides[parsed.rankId] || "").trim() || toTitleCase(parsed.rankId);
    const suitLabel = String(suitOverrides[parsed.suitId] || "").trim() || toTitleCase(parsed.suitId);
    return `${rankLabel} of ${suitLabel}`;
  }

  let resolvedTrumpNumber = normalizeTrumpNumber(trumpNumber);
  if (!Number.isInteger(resolvedTrumpNumber)) {
    const canonical = canonicalMajorName(cardName);
    resolvedTrumpNumber = normalizeTrumpNumber(trumpNumberByCanonicalName[canonical]);
  }

  if (Number.isInteger(resolvedTrumpNumber)) {
    const byTrump = manifest?.majorNameOverridesByTrump?.[resolvedTrumpNumber];
    if (byTrump) {
      return byTrump;
    }
  }

  const minorKey = canonicalMinorName(cardName);
  const minorOverride = manifest?.minorNameOverrides?.[minorKey];
  if (minorOverride) {
    return minorOverride;
  }

  return applyCourtNameOverrides(manifest, applySuitNameOverrides(manifest, fallbackName));
}

function walkImageFiles(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return acc;
  }
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkImageFiles(fullPath, acc);
      return;
    }
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name)) {
      acc.push(fullPath);
    }
  });
  return acc;
}

async function listDeckAssets(deckId) {
  const { resolvedDeckId, manifest } = await resolveDeck(deckId);
  const basePath = String(manifest?.basePath || "")
    .replace(/^asset\//i, "")
    .replace(/^\/+/, "");
  const folder = path.join(assetRoot, ...basePath.split("/").filter(Boolean));
  const files = walkImageFiles(folder);
  const assets = files.map((filePath) => {
    const relative = path.relative(assetRoot, filePath).split(path.sep).join("/");
    return {
      assetPath: relative,
      urlPath: `assets/${relative}`
    };
  });
  return {
    deckId: resolvedDeckId,
    name: manifest?.name || resolvedDeckId,
    count: assets.length,
    assets
  };
}

async function listAllDeckAssets() {
  const options = await listDeckOptions();
  const decks = [];
  for (const deck of options.decks || []) {
    decks.push(await listDeckAssets(deck.id));
  }
  return {
    count: decks.reduce((sum, deck) => sum + Number(deck.count || 0), 0),
    decks
  };
}

async function listDeckOptions() {
  const registry = await loadDeckRegistry();
  const decks = Array.isArray(registry?.decks) ? registry.decks : [];
  const options = await Promise.all(decks.map(async (deck) => {
    const manifest = await loadDeckManifest(deck.id);
    const name = manifest?.name || deck.name || deck.id;
    return {
      id: deck.id,
      name,
      label: name,
      system: String(manifest?.system || deck?.system || "tarot").trim().toLowerCase() || "tarot"
    };
  }));
  return { count: options.length, decks: options };
}

async function resolveDeckCard(query = {}) {
  const { resolvedDeckId, manifest } = await resolveDeck(query.deckId);
  if (!manifest) {
    return null;
  }

  const cardName = String(query.cardName || query.name || "").trim();
  if (!cardName) {
    throw createHttpError(400, "invalid_card_name", "Card name is required.");
  }

  const variant = String(query.variant || "full").trim().toLowerCase() === "thumbnail" ? "thumbnail" : "full";
  const relativePaths = resolveCardRelativePaths(manifest, cardName);
  if (!relativePaths.length) {
    return {
      deckId: resolvedDeckId,
      cardName,
      variant,
      found: false
    };
  }

  const primaryRelativePath = relativePaths[0];
  const assetPath = variant === "thumbnail"
    ? (resolveDeckThumbnailPath(manifest, primaryRelativePath) || `${manifest.basePath}/${primaryRelativePath}`)
    : `${manifest.basePath}/${primaryRelativePath}`;

  const variants = relativePaths.map((relativePath, variantIndex) => ({
    variantIndex,
    relativePath,
    assetPath: encodeURI(
      variant === "thumbnail"
        ? (resolveDeckThumbnailPath(manifest, relativePath) || `${manifest.basePath}/${relativePath}`)
        : `${manifest.basePath}/${relativePath}`
    )
  }));

  return {
    deckId: resolvedDeckId,
    cardName,
    variant,
    found: true,
    relativePath: primaryRelativePath,
    assetPath: encodeURI(assetPath),
    variants,
    displayName: resolveDisplayNameWithDeck(manifest, cardName, query.trumpNumber)
  };
}

async function resolveDeckBack(query = {}) {
  const { resolvedDeckId, manifest } = await resolveDeck(query.deckId);
  if (!manifest) {
    return null;
  }

  const variant = String(query.variant || "full").trim().toLowerCase() === "thumbnail" ? "thumbnail" : "full";
  const relativeBackPath = String(manifest?.cardBack || manifest?.cardBackPath || "").trim();
  const assetPath = variant === "thumbnail"
    ? (resolveDeckThumbnailPath(manifest, relativeBackPath) || resolveDeckCardBackPath(manifest))
    : resolveDeckCardBackPath(manifest);

  return {
    deckId: resolvedDeckId,
    variant,
    found: Boolean(assetPath),
    assetPath: assetPath ? encodeURI(assetPath) : null
  };
}

async function getDeckCardSearchAliases(query = {}) {
  const { resolvedDeckId, manifest } = await resolveDeck(query.deckId);
  if (!manifest) {
    return null;
  }

  const fallbackName = String(query.cardName || query.name || "").trim();
  if (!fallbackName) {
    throw createHttpError(400, "invalid_card_name", "Card name is required.");
  }

  const aliases = new Set();
  aliases.add(fallbackName);

  const displayName = String(resolveDisplayNameWithDeck(manifest, fallbackName, query.trumpNumber) || "").trim();
  if (displayName) {
    aliases.add(displayName);
  }

  const canonicalMajor = canonicalMajorName(fallbackName);
  const resolvedTrumpNumber = Number.isInteger(normalizeTrumpNumber(query.trumpNumber))
    ? normalizeTrumpNumber(query.trumpNumber)
    : normalizeTrumpNumber(trumpNumberByCanonicalName[canonicalMajor]);

  if (Number.isInteger(resolvedTrumpNumber)) {
    aliases.add(canonicalMajor);
    aliases.add(`the ${canonicalMajor}`);
    aliases.add(`trump ${resolvedTrumpNumber}`);
  }

  const parsedMinor = parseMinorCard(fallbackName);
  if (parsedMinor) {
    const suitAliases = suitSearchAliasesById[parsedMinor.suitId] || [parsedMinor.suitId];
    suitAliases.forEach((suitAlias) => {
      aliases.add(`${parsedMinor.rankKey} of ${suitAlias}`);
      if (Number.isInteger(parsedMinor.pipValue)) {
        aliases.add(`${parsedMinor.pipValue} of ${suitAlias}`);
      }
    });
  }

  return {
    deckId: resolvedDeckId,
    cardName: fallbackName,
    aliases: Array.from(aliases)
  };
}

module.exports = {
  listDeckOptions,
  listDeckAssets,
  listAllDeckAssets,
  resolveDeckCard,
  resolveDeckBack,
  getDeckCardSearchAliases
};