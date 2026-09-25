const { loadMagickDataset, loadOptionalDocument, loadReferenceData } = require("./data-loader");
const { normalizeAlphabets } = require("../lib/normalize-alphabets");

const sliceCache = new Map();
const indexCache = new WeakMap();

const MAGICK_SLICES = Object.freeze({
  alphabets: (dataset) => dataset?.grouped?.alphabets || {},
  chakras: (dataset) => dataset?.grouped?.chakras || {},
  enochian: (dataset) => dataset?.grouped?.enochian || {},
  gods: (dataset) => dataset?.grouped?.gods || {},
  kabbalah: (dataset) => dataset?.grouped?.kabbalah || {},
  numbers: (dataset) => dataset?.grouped?.numbers || {},
  "playing-cards": (dataset) => dataset?.grouped?.["playing-cards-52"] || {},
  tattvas: (dataset) => dataset?.grouped?.alchemy?.tattvas || {}
});

const REFERENCE_SLICES = Object.freeze({
  planets: (reference) => reference?.planets || {},
  signs: (reference) => (Array.isArray(reference?.signs) ? reference.signs : []),
  decansBySign: (reference) => reference?.decansBySign || {},
  calendarMonths: (reference) => (Array.isArray(reference?.calendarMonths) ? reference.calendarMonths : []),
  calendarHolidays: (reference) => (Array.isArray(reference?.calendarHolidays) ? reference.calendarHolidays : []),
  celestialHolidays: (reference) => (Array.isArray(reference?.celestialHolidays) ? reference.celestialHolidays : []),
  iChing: (reference) => reference?.iChing || {},
  sabianSymbols: (reference) => (Array.isArray(reference?.sabianSymbols) ? reference.sabianSymbols : []),
  tarotCourt: (reference) => ({
    courtDateRanges: reference?.tarotDatabase?.courtDateRanges || {},
    courtDecanWindows: reference?.tarotDatabase?.courtDecanWindows || {}
  })
});

let linkedReference = null;

function resetSliceCache() {
  sliceCache.clear();
  linkedReference = null;
}

function indexesFor(slice, build) {
  if (!slice || typeof slice !== "object") {
    return build(slice);
  }
  let indexes = indexCache.get(slice);
  if (!indexes) {
    indexes = build(slice);
    indexCache.set(slice, indexes);
  }
  return indexes;
}

function addKey(map, key, value) {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized || map.has(normalized)) {
    return;
  }
  map.set(normalized, value);
}

function storedCollection(cacheKey) {
  try {
    return require("./correspondence-store").getCollection(cacheKey);
  } catch (_error) {
    return null;
  }
}

async function loadExtractedSlice(cacheKey, documentKey, extract) {
  const fromStore = storedCollection(cacheKey);
  if (fromStore != null) {
    sliceCache.set(cacheKey, fromStore);
    return fromStore;
  }
  if (sliceCache.has(cacheKey)) {
    return sliceCache.get(cacheKey);
  }
  const persisted = loadOptionalDocument(documentKey);
  if (persisted != null) {
    sliceCache.set(cacheKey, persisted);
    return persisted;
  }
  const extracted = extract(await (cacheKey.startsWith("magick:") ? loadMagickDataset() : loadReferenceData()));
  const value = extracted == null ? {} : extracted;
  sliceCache.set(cacheKey, value);
  return value;
}

async function loadMagickSlice(name) {
  const extract = MAGICK_SLICES[name];
  if (!extract) {
    throw new Error(`Unknown magick slice '${name}'.`);
  }
  return loadExtractedSlice(`magick:${name}`, `slice:magick:${name}`, extract);
}

async function loadReferenceSlice(name) {
  const extract = REFERENCE_SLICES[name];
  if (!extract) {
    throw new Error(`Unknown reference slice '${name}'.`);
  }
  return loadExtractedSlice(`reference:${name}`, `slice:reference:${name}`, extract);
}

async function loadLinkedReference() {
  if (linkedReference) {
    return linkedReference;
  }
  const [planets, signs, decansBySign, calendarHolidays, celestialHolidays, sabianSymbols, tarotCourt] = await Promise.all([
    loadReferenceSlice("planets"),
    loadReferenceSlice("signs"),
    loadReferenceSlice("decansBySign"),
    loadReferenceSlice("calendarHolidays"),
    loadReferenceSlice("celestialHolidays"),
    loadReferenceSlice("sabianSymbols"),
    loadReferenceSlice("tarotCourt")
  ]);
  linkedReference = {
    planets: planets || {},
    signs: Array.isArray(signs) ? signs : [],
    decansBySign: decansBySign || {},
    calendarHolidays: Array.isArray(calendarHolidays) ? calendarHolidays : [],
    celestialHolidays: Array.isArray(celestialHolidays) ? celestialHolidays : [],
    sabianSymbols: Array.isArray(sabianSymbols) ? sabianSymbols : [],
    tarotDatabase: tarotCourt || {}
  };
  return linkedReference;
}

async function warmDocumentSlices() {
  const names = [
    ...Object.keys(MAGICK_SLICES).map((name) => loadMagickSlice(name)),
    ...Object.keys(REFERENCE_SLICES).map((name) => loadReferenceSlice(name))
  ];
  await Promise.all(names);
}

let alphabetCache = { source: null, value: null };

async function loadAlphabets() {
  const raw = await loadMagickSlice("alphabets");
  if (alphabetCache.source === raw) {
    return alphabetCache.value;
  }
  const value = normalizeAlphabets(raw || {});
  alphabetCache = { source: raw, value };
  return value;
}

function kabbalahIndexes(kabbalah) {
  return indexesFor(kabbalah, (source) => {
    const tree = source?.["kabbalah-tree"] || {};
    const sephiroth = new Map();
    const paths = new Map();
    for (const entry of Array.isArray(tree.sephiroth) ? tree.sephiroth : []) {
      addKey(sephiroth, entry?.sephiraId, entry);
      addKey(sephiroth, entry?.name, entry);
      addKey(sephiroth, entry?.number, entry);
    }
    for (const entry of Array.isArray(tree.paths) ? tree.paths : []) {
      addKey(paths, entry?.pathNumber, entry);
      addKey(paths, entry?.hebrewLetter?.transliteration, entry);
      addKey(paths, entry?.tarot?.card, entry);
    }
    return { tree, sephiroth, paths };
  });
}

async function loadKabbalahTree() {
  const kabbalah = await loadMagickSlice("kabbalah");
  return kabbalahIndexes(kabbalah).tree;
}

async function findSephirah(value) {
  const kabbalah = await loadMagickSlice("kabbalah");
  return kabbalahIndexes(kabbalah).sephiroth.get(String(value || "").trim().toLowerCase()) || null;
}

async function findKabbalahPath(value) {
  const kabbalah = await loadMagickSlice("kabbalah");
  return kabbalahIndexes(kabbalah).paths.get(String(value || "").trim().toLowerCase()) || null;
}

async function loadKabbalahCube() {
  const kabbalah = await loadMagickSlice("kabbalah");
  return kabbalah?.cube || {};
}

function listIndexes(items, keyFns) {
  return indexesFor(items, (source) => {
    const byKey = new Map();
    for (const entry of Array.isArray(source) ? source : []) {
      for (const keyFn of keyFns) {
        const raw = keyFn(entry);
        const keys = Array.isArray(raw) ? raw : [raw];
        for (const key of keys) {
          addKey(byKey, key, entry);
        }
      }
    }
    return byKey;
  });
}

async function findSign(signId) {
  const signs = await loadReferenceSlice("signs");
  return listIndexes(signs, [(entry) => entry?.id]).get(String(signId || "").trim().toLowerCase()) || null;
}

async function loadFlattenedDecans() {
  const decansBySign = await loadReferenceSlice("decansBySign");
  return indexesFor(decansBySign, (source) => (
    Object.values(source && typeof source === "object" ? source : {})
      .flat()
      .sort((left, right) => {
        const signCompare = String(left?.signId || "").localeCompare(String(right?.signId || ""));
        if (signCompare !== 0) {
          return signCompare;
        }
        return Number(left?.index || 0) - Number(right?.index || 0);
      })
  ));
}

async function findDecan(decanId) {
  const decans = await loadFlattenedDecans();
  return listIndexes(decans, [(entry) => entry?.id]).get(String(decanId || "").trim().toLowerCase()) || null;
}

async function findCalendarMonth(monthId) {
  const months = await loadReferenceSlice("calendarMonths");
  return listIndexes(months, [(entry) => entry?.id]).get(String(monthId || "").trim().toLowerCase()) || null;
}

async function loadHolidays(kind = "all") {
  const normalized = String(kind || "all").trim().toLowerCase();
  if (normalized === "celestial") {
    return loadReferenceSlice("celestialHolidays");
  }
  if (normalized === "calendar") {
    return loadReferenceSlice("calendarHolidays");
  }
  if (sliceCache.has("reference:holidays")) {
    return sliceCache.get("reference:holidays");
  }
  const [celestial, calendar] = await Promise.all([
    loadReferenceSlice("celestialHolidays"),
    loadReferenceSlice("calendarHolidays")
  ]);
  const combined = [...(Array.isArray(celestial) ? celestial : []), ...(Array.isArray(calendar) ? calendar : [])];
  sliceCache.set("reference:holidays", combined);
  return combined;
}

async function findHoliday(holidayId) {
  const holidays = await loadHolidays("all");
  return listIndexes(holidays, [(entry) => entry?.id]).get(String(holidayId || "").trim().toLowerCase()) || null;
}

function ichingIndexes(iching) {
  return indexesFor(iching, (source) => {
    const hexagrams = new Map();
    const trigrams = new Map();
    for (const entry of Array.isArray(source?.hexagrams) ? source.hexagrams : []) {
      const number = Number(entry?.number);
      if (Number.isFinite(number) && !hexagrams.has(number)) {
        hexagrams.set(number, entry);
      }
    }
    for (const entry of Array.isArray(source?.trigrams) ? source.trigrams : []) {
      addKey(trigrams, entry?.name, entry);
    }
    return { hexagrams, trigrams };
  });
}

async function findHexagram(number) {
  const iching = await loadReferenceSlice("iChing");
  return ichingIndexes(iching).hexagrams.get(Number(number)) || null;
}

async function findTrigram(name) {
  const iching = await loadReferenceSlice("iChing");
  return ichingIndexes(iching).trigrams.get(String(name || "").trim().toLowerCase()) || null;
}

async function findNumberEntry(value) {
  const numbers = await loadMagickSlice("numbers");
  const entries = Array.isArray(numbers?.entries) ? numbers.entries : [];
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return listIndexes(entries, [(entry) => {
    const entryValue = Number(entry?.value);
    return Number.isFinite(entryValue) ? String(entryValue) : "";
  }]).get(String(numeric)) || null;
}

function chakraCandidates(entry) {
  return [entry?.id, entry?.name, entry?.name?.en, entry?.name?.roman];
}

async function findChakra(chakraId) {
  const chakraData = await loadMagickSlice("chakras");
  const direct = chakraData?.[chakraId] || chakraData?.[String(chakraId || "").trim().toLowerCase()];
  if (direct) {
    return direct;
  }
  const entries = Array.isArray(chakraData?.entries)
    ? chakraData.entries
    : (Array.isArray(chakraData) ? chakraData : []);
  return listIndexes(entries, [chakraCandidates]).get(String(chakraId || "").trim().toLowerCase()) || null;
}

function godCandidates(entry) {
  return [entry?.id, entry?.slug, entry?.key, entry?.name];
}

async function findGodGroup(groupId) {
  const gods = await loadMagickSlice("gods");
  const key = String(groupId || "").trim();
  const direct = gods?.[key] || gods?.pantheons?.[key] || gods?.gods?.[key] || gods?.byPath?.[key];
  if (direct) {
    return direct;
  }
  const needle = key.toLowerCase();
  return listIndexes(gods?.pantheons, [godCandidates]).get(needle)
    || listIndexes(gods?.gods, [godCandidates]).get(needle)
    || null;
}

function playingCardEntries(playingCardsData) {
  if (Array.isArray(playingCardsData)) {
    return playingCardsData;
  }
  return Array.isArray(playingCardsData?.entries) ? playingCardsData.entries : [];
}

function playingCardCandidates(item) {
  return [
    item?.id,
    `${item?.rankLabel} of ${item?.suitLabel}`,
    `${item?.rank} of ${item?.suit}`,
    item?.tarotCard
  ];
}

async function findPlayingCard(cardId, canonicalId = "") {
  const playingCardsData = await loadMagickSlice("playing-cards");
  const entries = playingCardEntries(playingCardsData);
  const byId = listIndexes(entries, [(item) => item?.id]);
  const byCandidate = listIndexes(entries, [playingCardCandidates]);
  return byId.get(String(canonicalId || cardId || "").trim().toLowerCase())
    || byCandidate.get(String(cardId || "").trim().toLowerCase())
    || null;
}

function tattvaName(entry) {
  if (!entry) {
    return "";
  }
  if (typeof entry.name === "string") {
    return entry.name;
  }
  return entry.name?.en || "";
}

function listTattvas(source) {
  if (Array.isArray(source)) {
    return source;
  }
  if (source && typeof source === "object") {
    return Object.values(source);
  }
  return [];
}

async function findTattva(tattvaId) {
  const tattvas = await loadMagickSlice("tattvas");
  const key = String(tattvaId || "").trim();
  const direct = tattvas?.[key] || tattvas?.[key.toLowerCase()];
  if (direct) {
    return direct;
  }
  return listIndexes(listTattvas(tattvas), [(entry) => [
    entry?.id,
    tattvaName(entry),
    entry?.sanskrit,
    String(tattvaName(entry) || "").replace(/\s+/g, "-"),
    String(tattvaName(entry) || "").replace(/\s+of\s+/gi, "-of-")
  ]]).get(key.toLowerCase()) || null;
}

module.exports = {
  findCalendarMonth,
  findChakra,
  findDecan,
  findGodGroup,
  findHexagram,
  findHoliday,
  findKabbalahPath,
  findNumberEntry,
  findPlayingCard,
  findSephirah,
  findSign,
  findTattva,
  findTrigram,
  loadAlphabets,
  loadFlattenedDecans,
  loadHolidays,
  loadKabbalahCube,
  loadKabbalahTree,
  loadLinkedReference,
  loadMagickSlice,
  loadReferenceSlice,
  resetSliceCache,
  warmDocumentSlices
};
