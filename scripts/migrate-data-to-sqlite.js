const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
const {
  sourceRoot,
  sourceDataRoot,
  sourceAssetRoot,
  sourceDecksRoot,
  sourceGeneratedTextRoot,
  generatedTextSourceRegistryPath,
  decksImportRoot,
  dlcRoot,
  textImportRoot,
  sourceTextDataRoot,
  sourceRuntimeAppRoot,
  storageRoot,
  storageConfigRoot,
  databasePath,
  dataRoot,
  assetRoot,
  decksRoot,
  deckRegistryPath,
  managedApiClientsPath,
  runtimeRoot,
  runtimeAppRoot
} = require("../src/config/paths");
const {
  getTextSourceDocumentKey,
  getTextReferenceDocumentKey,
  getTextSourceDefinitions
} = require("../src/config/text-sources");
const {
  buildTextLibrarySnapshot
} = require("../src/services/text-library-builder");
const {
  importTextSources,
  importReferenceSources
} = require("../src/services/text-importer");
const {
  refreshTextLibraryRegistry
} = require("../src/services/text-library-registry");

const apiRoot = path.resolve(__dirname, "..");
const sourceDeckRegistryPath = path.join(sourceDecksRoot, "decks.json");
const deckCardBackCandidates = ["back.webp", "back.png", "back.jpg", "back.jpeg", "back.avif", "back.gif"];
const suitIds = ["wands", "cups", "swords", "disks"];
const defaultPipRankOrder = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const runtimeFiles = [
  "tarot-database-builders.js",
  "tarot-database-assembly.js",
  "tarot-database.js",
  "ui-tarot-relations.js",
  "quiz-plugin-helpers.js",
  "quiz-connections.js"
];

const migrateStartedAtMs = Date.now();

function elapsedSeconds() {
  return ((Date.now() - migrateStartedAtMs) / 1000).toFixed(1);
}

function logStep(message) {
  console.log(`[${elapsedSeconds()}s] ${message}`);
}

const TAROT_TRUMP_NUMBER_BY_NAME = {
  "the fool": 0,
  fool: 0,
  "the magus": 1,
  magus: 1,
  magician: 1,
  "the high priestess": 2,
  "high priestess": 2,
  "the empress": 3,
  empress: 3,
  "the emperor": 4,
  emperor: 4,
  "the hierophant": 5,
  hierophant: 5,
  "the lovers": 6,
  lovers: 6,
  "the chariot": 7,
  chariot: 7,
  strength: 8,
  lust: 8,
  "the hermit": 9,
  hermit: 9,
  fortune: 10,
  "wheel of fortune": 10,
  justice: 11,
  "the hanged man": 12,
  "hanged man": 12,
  death: 13,
  temperance: 14,
  art: 14,
  "the devil": 15,
  devil: 15,
  "the tower": 16,
  tower: 16,
  "the star": 17,
  star: 17,
  "the moon": 18,
  moon: 18,
  "the sun": 19,
  sun: 19,
  aeon: 20,
  judgement: 20,
  judgment: 20,
  universe: 21,
  world: 21,
  "the world": 21
};

const HEBREW_BY_TRUMP_NUMBER = {
  0: { hebrewLetterId: "alef", kabbalahPathNumber: 11 },
  1: { hebrewLetterId: "bet", kabbalahPathNumber: 12 },
  2: { hebrewLetterId: "gimel", kabbalahPathNumber: 13 },
  3: { hebrewLetterId: "dalet", kabbalahPathNumber: 14 },
  4: { hebrewLetterId: "he", kabbalahPathNumber: 15 },
  5: { hebrewLetterId: "vav", kabbalahPathNumber: 16 },
  6: { hebrewLetterId: "zayin", kabbalahPathNumber: 17 },
  7: { hebrewLetterId: "het", kabbalahPathNumber: 18 },
  8: { hebrewLetterId: "tet", kabbalahPathNumber: 19 },
  9: { hebrewLetterId: "yod", kabbalahPathNumber: 20 },
  10: { hebrewLetterId: "kaf", kabbalahPathNumber: 21 },
  11: { hebrewLetterId: "lamed", kabbalahPathNumber: 22 },
  12: { hebrewLetterId: "mem", kabbalahPathNumber: 23 },
  13: { hebrewLetterId: "nun", kabbalahPathNumber: 24 },
  14: { hebrewLetterId: "samekh", kabbalahPathNumber: 25 },
  15: { hebrewLetterId: "ayin", kabbalahPathNumber: 26 },
  16: { hebrewLetterId: "pe", kabbalahPathNumber: 27 },
  17: { hebrewLetterId: "tsadi", kabbalahPathNumber: 28 },
  18: { hebrewLetterId: "qof", kabbalahPathNumber: 29 },
  19: { hebrewLetterId: "resh", kabbalahPathNumber: 30 },
  20: { hebrewLetterId: "shin", kabbalahPathNumber: 31 },
  21: { hebrewLetterId: "tav", kabbalahPathNumber: 32 }
};

const ICHING_PLANET_BY_PLANET_ID = {
  sol: "Sun",
  luna: "Moon",
  mercury: "Mercury",
  venus: "Venus",
  mars: "Mars",
  jupiter: "Jupiter",
  saturn: "Saturn",
  earth: "Earth",
  uranus: "Uranus",
  neptune: "Neptune",
  pluto: "Pluto"
};

function normalizeTarotName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveTarotTrumpNumber(cardName) {
  const key = normalizeTarotName(cardName);
  if (!key) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(TAROT_TRUMP_NUMBER_BY_NAME, key)) {
    return TAROT_TRUMP_NUMBER_BY_NAME[key];
  }

  const withoutLeadingThe = key.replace(/^the\s+/, "");
  return Object.prototype.hasOwnProperty.call(TAROT_TRUMP_NUMBER_BY_NAME, withoutLeadingThe)
    ? TAROT_TRUMP_NUMBER_BY_NAME[withoutLeadingThe]
    : null;
}

function groupDecansBySign(decans) {
  const map = {};
  for (const decan of Array.isArray(decans) ? decans : []) {
    if (!map[decan.signId]) {
      map[decan.signId] = [];
    }
    map[decan.signId].push(decan);
  }

  Object.keys(map).forEach((signId) => {
    map[signId].sort((left, right) => Number(left.index) - Number(right.index));
  });

  return map;
}

function buildObjectPath(target, pathParts, value) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

function enrichAssociation(associations) {
  if (!associations || typeof associations !== "object") {
    return associations;
  }

  const next = { ...associations };
  if (next.tarotCard) {
    const trumpNumber = resolveTarotTrumpNumber(next.tarotCard);
    if (trumpNumber != null) {
      if (!Number.isFinite(Number(next.tarotTrumpNumber))) {
        next.tarotTrumpNumber = trumpNumber;
      }

      const hebrew = HEBREW_BY_TRUMP_NUMBER[trumpNumber];
      if (hebrew) {
        if (!next.hebrewLetterId) {
          next.hebrewLetterId = hebrew.hebrewLetterId;
        }
        if (!Number.isFinite(Number(next.kabbalahPathNumber))) {
          next.kabbalahPathNumber = hebrew.kabbalahPathNumber;
        }
      }
    }
  }

  const planetId = String(next.planetId || "").trim().toLowerCase();
  if (!next.iChingPlanetaryInfluence && planetId) {
    const influence = ICHING_PLANET_BY_PLANET_ID[planetId];
    if (influence) {
      next.iChingPlanetaryInfluence = influence;
    }
  }

  return next;
}

function enrichCalendarMonth(month) {
  const events = Array.isArray(month?.events)
    ? month.events.map((event) => ({
        ...event,
        associations: enrichAssociation(event?.associations)
      }))
    : [];

  return {
    ...month,
    associations: enrichAssociation(month?.associations),
    events
  };
}

function enrichHoliday(holiday) {
  return {
    ...holiday,
    associations: enrichAssociation(holiday?.associations)
  };
}

function canonicalMinorName(cardName) {
  const match = String(cardName || "")
    .trim()
    .match(/^(ace|two|three|four|five|six|seven|eight|nine|ten|knight|queen|prince|princess|king|page|[2-9]|10)\s+of\s+(cups|wands|swords|pentacles|disks)$/i);

  if (!match) {
    return "";
  }

  const rankToken = String(match[1] || "").trim().toLowerCase();
  const suitId = String(match[2] || "").trim().toLowerCase() === "pentacles"
    ? "disks"
    : String(match[2] || "").trim().toLowerCase();

  const pipValue = {
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
  }[rankToken] ?? null;

  const rankKey = Number.isFinite(pipValue)
    ? ({ 1: "ace", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" }[pipValue] || rankToken)
    : rankToken;

  return `${rankKey} of ${suitId}`;
}

function parseTrumpNumberKey(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 21 ? parsed : null;
  }

  const romans = {
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

  return Object.prototype.hasOwnProperty.call(romans, normalized)
    ? romans[normalized]
    : null;
}

function normalizeThumbnailConfig(rawConfig, fallbackRoot = "") {
  if (rawConfig === false) {
    return false;
  }

  if (!rawConfig || typeof rawConfig !== "object") {
    const root = String(fallbackRoot || "").trim();
    if (!root) {
      return null;
    }

    return {
      root,
      width: 240,
      height: 360,
      fit: "inside",
      quality: 82
    };
  }

  const root = String(rawConfig.root || fallbackRoot || "thumbs").trim();
  if (!root) {
    return null;
  }

  return {
    root,
    width: Number.isInteger(Number(rawConfig.width)) && Number(rawConfig.width) > 0 ? Number(rawConfig.width) : 240,
    height: Number.isInteger(Number(rawConfig.height)) && Number(rawConfig.height) > 0 ? Number(rawConfig.height) : 360,
    fit: String(rawConfig.fit || "inside").trim() || "inside",
    quality: Number.isInteger(Number(rawConfig.quality)) && Number(rawConfig.quality) >= 1 && Number(rawConfig.quality) <= 100
      ? Number(rawConfig.quality)
      : 82
  };
}

function normalizeDeckManifest(source, rawManifest) {
  if (!rawManifest || typeof rawManifest !== "object") {
    return null;
  }

  const rawMajorNameOverridesByTrump = rawManifest.majorNameOverridesByTrump;
  const majorNameOverridesByTrump = {};
  if (rawMajorNameOverridesByTrump && typeof rawMajorNameOverridesByTrump === "object") {
    Object.entries(rawMajorNameOverridesByTrump).forEach(([rawKey, rawValue]) => {
      const trumpNumber = parseTrumpNumberKey(rawKey);
      const value = String(rawValue || "").trim();
      if (Number.isInteger(trumpNumber) && value) {
        majorNameOverridesByTrump[trumpNumber] = value;
      }
    });
  }

  const rawMinorNameOverrides = rawManifest.minorNameOverrides;
  const minorNameOverrides = {};
  if (rawMinorNameOverrides && typeof rawMinorNameOverrides === "object") {
    Object.entries(rawMinorNameOverrides).forEach(([rawKey, rawValue]) => {
      const key = canonicalMinorName(rawKey);
      const value = String(rawValue || "").trim();
      if (key && value) {
        minorNameOverrides[key] = value;
      }
    });
  }

  return {
    ...rawManifest,
    id: source.id,
    name: String(rawManifest.name || rawManifest.label || source.name || source.label || source.id),
    basePath: String(source.basePath || "").replace(/\/$/, ""),
    cardBack: String(rawManifest.cardBack || "").trim(),
    cardBackPath: String(source.cardBackPath || "").trim(),
    thumbnails: normalizeThumbnailConfig(rawManifest.thumbnails, source.thumbnailRoot),
    minorNameOverrides,
    majorNameOverridesByTrump
  };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const sanitized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(sanitized);
}

async function buildMagickManifest() {
  return readJson(path.join(sourceDataRoot, "MANIFEST.json"));
}

async function buildMagickDataset() {
  const manifest = await buildMagickManifest();
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  const entries = await Promise.all(
    jsonFiles.map(async (relativePath) => {
      const data = await readJson(path.join(sourceDataRoot, relativePath));
      return [relativePath, data];
    })
  );

  const grouped = {};
  entries.forEach(([relativePath, data]) => {
    const noExtensionPath = relativePath.replace(/\.json$/i, "");
    const pathParts = noExtensionPath.split("/").filter(Boolean);
    if (!pathParts.length) {
      return;
    }
    buildObjectPath(grouped, pathParts, data);
  });

  return {
    manifest,
    grouped,
    files: Object.fromEntries(entries)
  };
}

async function buildReferenceData() {
  const [
    planetsJson,
    signsJson,
    decansJson,
    sabianJson,
    planetScienceJson,
    gematriaCiphersJson,
    iChingJson,
    calendarMonthsJson,
    celestialHolidaysJson,
    calendarHolidaysJson,
    astronomyCyclesJson,
    tarotDatabaseJson,
    hebrewCalendarJson,
    islamicCalendarJson,
    wheelOfYearJson
  ] = await Promise.all([
    readJson(path.join(sourceDataRoot, "planetary-correspondences.json")),
    readJson(path.join(sourceDataRoot, "signs.json")),
    readJson(path.join(sourceDataRoot, "decans.json")),
    readJson(path.join(sourceDataRoot, "sabian-symbols.json")),
    readJson(path.join(sourceDataRoot, "planet-science.json")),
    readJson(path.join(sourceDataRoot, "gematria-ciphers.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "i-ching.json")),
    readJson(path.join(sourceDataRoot, "calendar-months.json")),
    readJson(path.join(sourceDataRoot, "celestial-holidays.json")),
    readJson(path.join(sourceDataRoot, "calendar-holidays.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "astronomy-cycles.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "tarot-database.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "hebrew-calendar.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "islamic-calendar.json")).catch(() => ({})),
    readJson(path.join(sourceDataRoot, "wheel-of-year.json")).catch(() => ({}))
  ]);

  const tarotDatabase = tarotDatabaseJson && typeof tarotDatabaseJson === "object"
    ? tarotDatabaseJson
    : {};
  const sourceMeanings = tarotDatabase.meanings && typeof tarotDatabase.meanings === "object"
    ? tarotDatabase.meanings
    : {};
  if (!sourceMeanings.majorByTrumpNumber || typeof sourceMeanings.majorByTrumpNumber !== "object") {
    sourceMeanings.majorByTrumpNumber = {};
  }
  const existingByCardName = sourceMeanings.byCardName && typeof sourceMeanings.byCardName === "object"
    ? sourceMeanings.byCardName
    : {};
  sourceMeanings.byCardName = existingByCardName;
  tarotDatabase.meanings = sourceMeanings;

  return {
    planets: planetsJson.planets || {},
    signs: signsJson.signs || [],
    decansBySign: groupDecansBySign(decansJson.decans || []),
    sabianSymbols: Array.isArray(sabianJson?.symbols) ? sabianJson.symbols : [],
    planetScience: Array.isArray(planetScienceJson?.planets) ? planetScienceJson.planets : [],
    gematriaCiphers: gematriaCiphersJson && typeof gematriaCiphersJson === "object" ? gematriaCiphersJson : {},
    iChing: {
      trigrams: Array.isArray(iChingJson?.trigrams) ? iChingJson.trigrams : [],
      hexagrams: Array.isArray(iChingJson?.hexagrams) ? iChingJson.hexagrams : [],
      correspondences: {
        meta: iChingJson?.correspondences?.meta && typeof iChingJson.correspondences.meta === "object"
          ? iChingJson.correspondences.meta
          : {},
        tarotToTrigram: Array.isArray(iChingJson?.correspondences?.tarotToTrigram)
          ? iChingJson.correspondences.tarotToTrigram
          : []
      }
    },
    calendarMonths: Array.isArray(calendarMonthsJson?.months)
      ? calendarMonthsJson.months.map((month) => enrichCalendarMonth(month))
      : [],
    celestialHolidays: Array.isArray(celestialHolidaysJson?.holidays)
      ? celestialHolidaysJson.holidays.map((holiday) => enrichHoliday(holiday))
      : [],
    calendarHolidays: Array.isArray(calendarHolidaysJson?.holidays)
      ? calendarHolidaysJson.holidays.map((holiday) => enrichHoliday(holiday))
      : [],
    astronomyCycles: astronomyCyclesJson && typeof astronomyCyclesJson === "object" ? astronomyCyclesJson : {},
    tarotDatabase,
    hebrewCalendar: hebrewCalendarJson && typeof hebrewCalendarJson === "object" ? hebrewCalendarJson : {},
    islamicCalendar: islamicCalendarJson && typeof islamicCalendarJson === "object" ? islamicCalendarJson : {},
    wheelOfYear: wheelOfYearJson && typeof wheelOfYearJson === "object" ? wheelOfYearJson : {}
  };
}

function normalizeIndexWord(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function computeCipherValue(word, cipherDefinition, baseAlphabet) {
  const values = Array.isArray(cipherDefinition?.values) ? cipherDefinition.values : [];
  let total = 0;
  [...String(word || "")].forEach((char) => {
    const position = baseAlphabet.indexOf(char) + 1;
    if (position < 1) {
      return;
    }
    const raw = Number(values[Math.min(position, values.length) - 1]);
    total += Number.isFinite(raw) ? raw : 0;
  });
  return total;
}

// When no curated gematria-words-index.json ships, derive the word index from
// the text library so dictionary and anagram lookups still work out of the box.
async function buildDerivedWordIndex(textLibrarySnapshot) {
  const gematriaCiphersJson = await readJson(path.join(sourceDataRoot, "gematria-ciphers.json")).catch(() => null);
  const baseAlphabet = String(gematriaCiphersJson?.baseAlphabet || "abcdefghijklmnopqrstuvwxyz");
  const cipherDefinitions = Array.isArray(gematriaCiphersJson?.ciphers)
    ? gematriaCiphersJson.ciphers
    : [];

  const dictionaryJson = await readJson(path.join(sourceDataRoot, "dictionary-english.json")).catch(() => null);
  const dictionaryMap = new Map();
  (Array.isArray(dictionaryJson?.entries) ? dictionaryJson.entries : []).forEach((entry) => {
    const word = String(entry?.[0] || "").trim();
    if (word) {
      dictionaryMap.set(word, {
        definition: String(entry?.[1] || "").trim(),
        etymology: String(entry?.[2] || "").trim(),
        synonyms: Array.isArray(entry?.[3])
          ? entry[3].map((value) => String(value || "").trim()).filter(Boolean)
          : []
      });
    }
  });

  const counts = new Map();
  let sourceWordCount = 0;

  const sources = textLibrarySnapshot?.sources && typeof textLibrarySnapshot.sources === "object"
    ? textLibrarySnapshot.sources
    : {};
  Object.values(sources).forEach((source) => {
    const works = Array.isArray(source?.works) ? source.works : [];
    works.forEach((work) => {
      const sections = Array.isArray(work?.sections) ? work.sections : [];
      sections.forEach((section) => {
        const verses = Array.isArray(section?.verses) ? section.verses : [];
        verses.forEach((verse) => {
          const text = String(verse?.text || "");
          text.split(/[^a-zA-Z\u00c0-\u024f']+/).forEach((rawWord) => {
            const word = normalizeIndexWord(rawWord);
            if (!word) {
              return;
            }
            sourceWordCount += 1;
            counts.set(word, (counts.get(word) || 0) + 1);
          });
        });
      });
    });
  });

  let definitionCount = 0;
  let etymologyCount = 0;
  let synonymCount = 0;
  const entries = [...counts.keys()]
    .sort()
    .map((word) => {
      const dictionary = dictionaryMap.get(word) || null;
      const definition = dictionary?.definition || "";
      const etymology = dictionary?.etymology || "";
      const synonyms = Array.isArray(dictionary?.synonyms) ? dictionary.synonyms.slice(0, 12) : [];
      if (definition) {
        definitionCount += 1;
      }
      if (etymology) {
        etymologyCount += 1;
      }
      if (synonyms.length) {
        synonymCount += 1;
      }
      return [word, definition, etymology, synonyms];
    });

  const ciphers = cipherDefinitions
    .map((cipher) => [String(cipher?.id || ""), String(cipher?.name || ""), String(cipher?.description || "")])
    .filter((entry) => entry[0] && entry[1]);

  const values = {};
  entries.forEach((entry, entryIndex) => {
    const byValue = new Map();
    ciphers.forEach((_cipherEntry, cipherIndex) => {
      const value = computeCipherValue(entry[0], cipherDefinitions[cipherIndex], baseAlphabet);
      if (!byValue.has(value)) {
        byValue.set(value, []);
      }
      byValue.get(value).push(cipherIndex);
    });
    byValue.forEach((cipherIndexes, value) => {
      const key = String(value);
      if (!values[key]) {
        values[key] = [];
      }
      values[key].push([entryIndex, cipherIndexes]);
    });
  });

  return {
    meta: {
      derivedFromTextLibrary: true,
      generatedAt: new Date().toISOString(),
      indexedWordCount: entries.length,
      sourceWordCount,
      definitionCount,
      etymologyCount,
      synonymCount
    },
    entries,
    ciphers,
    values
  };
}

async function buildGematriaWordIndex(textLibrarySnapshot) {
  const gematriaWordIndexJson = await readJson(path.join(sourceDataRoot, "gematria-words-index.json")).catch(() => ({}));
  const hasEntries = gematriaWordIndexJson
    && typeof gematriaWordIndexJson === "object"
    && Array.isArray(gematriaWordIndexJson.entries)
    && gematriaWordIndexJson.entries.length > 0;
  if (hasEntries) {
    return gematriaWordIndexJson;
  }
  return buildDerivedWordIndex(textLibrarySnapshot || {});
}

function normalizeDeckRegistryId(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveDeckRegistryIdFromFolderName(folderName) {
  return String(folderName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function applyTemplate(template, variables) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, token) => {
    const value = variables[token];
    return value == null ? "" : String(value);
  });
}

function shouldIgnoreDeckDirectory(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return normalized.startsWith("_")
    || normalized.startsWith(".")
    || normalized === "template"
    || normalized === "templates"
    || normalized === "example"
    || normalized === "examples";
}

function resolveRegistryThumbnailRoot(rawManifest) {
  if (rawManifest?.thumbnails === false) {
    return "";
  }

  const configuredRoot = String(rawManifest?.thumbnails?.root || "").trim();
  return configuredRoot || "thumbs";
}

async function detectDeckCardBackPath(deckRoot) {
  for (const candidate of deckCardBackCandidates) {
    try {
      const stats = await fs.stat(path.join(deckRoot, candidate));
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates and keep checking.
    }
  }

  return "";
}

async function discoverDeckRegistryEntries() {
  const entries = await fs.readdir(sourceDecksRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !shouldIgnoreDeckDirectory(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const discoveredDecks = [];
  const seenDeckIds = new Set();

  for (const directory of directories) {
    const folderName = String(directory.name || "").trim();
    const deckRoot = path.join(sourceDecksRoot, folderName);
    const manifestFilePath = path.join(deckRoot, "deck.json");

    let rawManifest;
    try {
      rawManifest = await readJson(manifestFilePath);
    } catch {
      continue;
    }

    const deckId = normalizeDeckRegistryId(rawManifest?.id) || deriveDeckRegistryIdFromFolderName(folderName);
    if (!deckId || seenDeckIds.has(deckId)) {
      continue;
    }

    seenDeckIds.add(deckId);

    const entry = {
      id: deckId,
      name: String(rawManifest?.name || rawManifest?.label || folderName || deckId).trim() || deckId,
      basePath: `asset/tarot deck/${folderName}`,
      manifestPath: `asset/tarot deck/${folderName}/deck.json`
    };

    const thumbnailRoot = resolveRegistryThumbnailRoot(rawManifest);
    if (thumbnailRoot) {
      entry.thumbnailRoot = thumbnailRoot;
    }

    const detectedCardBackPath = await detectDeckCardBackPath(deckRoot);
    if (detectedCardBackPath) {
      entry.cardBackPath = detectedCardBackPath;
    }

    discoveredDecks.push(entry);
  }

  return discoveredDecks;
}

function getFitMode(value) {
  const fitMode = String(value || "inside").trim().toLowerCase();
  return ["contain", "cover", "fill", "inside", "outside"].includes(fitMode)
    ? fitMode
    : "inside";
}

function getRankOrderEntries(rule, fallbackRankOrder = []) {
  const explicitRankOrder = Array.isArray(rule?.rankOrder) ? rule.rankOrder : [];
  const sourceRankOrder = explicitRankOrder.length ? explicitRankOrder : fallbackRankOrder;
  return sourceRankOrder.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function listMajorRelativePaths(manifest) {
  const majorRule = manifest?.majors;
  if (!majorRule || typeof majorRule !== "object") {
    return [];
  }

  if (majorRule.mode === "canonical-map" || majorRule.mode === "trump-map") {
    const relativePaths = new Set();
    Object.values(majorRule.cards || {}).forEach((value) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          const relativePath = String(entry || "").trim();
          if (relativePath) {
            relativePaths.add(relativePath);
          }
        });
        return;
      }
      const relativePath = String(value || "").trim();
      if (relativePath) {
        relativePaths.add(relativePath);
      }
    });
    return Array.from(relativePaths);
  }

  if (majorRule.mode === "trump-template") {
    const numberPad = Number.isInteger(majorRule.numberPad) ? majorRule.numberPad : 2;
    const template = String(majorRule.template || "{number}.png");
    return Array.from({ length: 22 }, (_entry, trumpNumber) => applyTemplate(template, {
      trump: trumpNumber,
      number: String(trumpNumber).padStart(numberPad, "0")
    }));
  }

  return [];
}

function listSplitNumberTemplateGroupPaths(groupRule, fallbackRankOrder = []) {
  if (!groupRule || typeof groupRule !== "object") {
    return [];
  }

  const rankOrder = getRankOrderEntries(groupRule, fallbackRankOrder);
  const numberPad = Number.isInteger(groupRule.numberPad) ? groupRule.numberPad : 2;
  const template = String(groupRule.template || "{number}.png");
  const relativePaths = [];

  suitIds.forEach((suitId) => {
    const suitBase = Number(groupRule?.suitBase?.[suitId]);
    if (!Number.isFinite(suitBase)) {
      return;
    }

    rankOrder.forEach((rank, rankIndex) => {
      relativePaths.push(applyTemplate(template, {
        number: String(suitBase + rankIndex).padStart(numberPad, "0"),
        suitId,
        rank,
        rankKey: String(rank || "").trim().toLowerCase(),
        index: rankIndex
      }));
    });
  });

  return relativePaths;
}

function listMinorRelativePaths(manifest) {
  const minorRule = manifest?.minors;
  if (!minorRule || typeof minorRule !== "object") {
    return [];
  }

  if (minorRule.mode === "split-number-template") {
    return [
      ...listSplitNumberTemplateGroupPaths(minorRule.smalls, defaultPipRankOrder),
      ...listSplitNumberTemplateGroupPaths(minorRule.courts)
    ];
  }

  const rankOrder = getRankOrderEntries(minorRule);
  if (!rankOrder.length) {
    return [];
  }

  if (minorRule.mode === "suit-base-and-rank-order" || minorRule.mode === "suit-base-number-template") {
    const numberPad = Number.isInteger(minorRule.numberPad) ? minorRule.numberPad : 2;
    const template = String(minorRule.template || "{number}.png");
    const relativePaths = [];

    suitIds.forEach((suitId) => {
      const suitBase = Number(minorRule?.suitBase?.[suitId]);
      if (!Number.isFinite(suitBase)) {
        return;
      }

      rankOrder.forEach((rank, rankIndex) => {
        relativePaths.push(applyTemplate(template, {
          number: String(suitBase + rankIndex).padStart(numberPad, "0"),
          suitId,
          suit: String(minorRule?.suitLabel?.[suitId] || suitId).trim(),
          rank,
          rankKey: String(rank || "").trim().toLowerCase(),
          index: minorRule.mode === "suit-base-and-rank-order" ? rankIndex + 1 : rankIndex
        }));
      });
    });

    return relativePaths;
  }

  if (minorRule.mode === "suit-prefix-and-rank-order") {
    const indexStart = Number.isInteger(minorRule.indexStart) ? minorRule.indexStart : 1;
    const indexPad = Number.isInteger(minorRule.indexPad) ? minorRule.indexPad : 2;
    const template = String(minorRule.template || "{suit}{index}.png");
    const relativePaths = [];

    suitIds.forEach((suitId) => {
      const suitPrefix = String(minorRule?.suitPrefix?.[suitId] || "").trim();
      if (!suitPrefix) {
        return;
      }

      rankOrder.forEach((rank, rankIndex) => {
        relativePaths.push(applyTemplate(template, {
          suit: suitPrefix,
          suitId,
          index: String(indexStart + rankIndex).padStart(indexPad, "0"),
          rank,
          rankKey: String(rank || "").trim().toLowerCase()
        }));
      });
    });

    return relativePaths;
  }

  return [];
}

function listDeckAssetRelativePaths(manifest) {
  const relativePaths = new Set();

  listMajorRelativePaths(manifest).forEach((relativePath) => {
    if (relativePath) {
      relativePaths.add(relativePath.replace(/^\.\//, ""));
    }
  });

  listMinorRelativePaths(manifest).forEach((relativePath) => {
    if (relativePath) {
      relativePaths.add(relativePath.replace(/^\.\//, ""));
    }
  });

  // I Ching decks map 64 hexagrams instead of majors/minors.
  if (manifest?.hexagrams && typeof manifest.hexagrams === "object") {
    Object.values(manifest.hexagrams).forEach((value) => {
      (Array.isArray(value) ? value : [value]).forEach((entry) => {
        const relativePath = String(entry || "").trim();
        if (relativePath) {
          relativePaths.add(relativePath.replace(/^\.\//, ""));
        }
      });
    });
  }

  const cardBackPath = String(manifest?.cardBack || manifest?.cardBackPath || "").trim().replace(/^\.\//, "");
  if (cardBackPath) {
    relativePaths.add(cardBackPath);
  }

  return Array.from(relativePaths);
}

async function getLatestDependencyMtimeMs(filePaths) {
  let latestMtimeMs = 0;

  for (const filePath of filePaths) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stats.mtimeMs;
      }
    } catch {
      // Ignore missing optional dependency files.
    }
  }

  return latestMtimeMs;
}

function resolveThumbConcurrency() {
  const fromEnv = Number(process.env.KABBAK_THUMB_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return Math.min(8, fromEnv);
  }
  const cpus = Number(os.availableParallelism?.() || os.cpus()?.length || 1);
  return Math.max(1, Math.min(4, cpus > 2 ? cpus - 1 : cpus));
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const width = Math.max(1, Number(limit) || 1);
  await Promise.all(Array.from({ length: Math.min(width, queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  }));
}

async function writeThumbnailImage(sourcePath, thumbPath, thumbnailConfig) {
  let pipeline = sharp(sourcePath, { animated: false, failOn: "none" }).resize({
    width: Number(thumbnailConfig.width) || 240,
    height: Number(thumbnailConfig.height) || 360,
    fit: getFitMode(thumbnailConfig.fit),
    withoutEnlargement: true
  });

  const extension = path.extname(thumbPath).toLowerCase();
  const quality = Number.isInteger(Number(thumbnailConfig.quality)) ? Number(thumbnailConfig.quality) : 78;
  if (extension === ".jpg" || extension === ".jpeg") {
    pipeline = pipeline.jpeg({ quality, mozjpeg: false });
  } else if (extension === ".png") {
    pipeline = pipeline.png({ compressionLevel: 3, adaptiveFiltering: false, palette: false });
  } else if (extension === ".webp") {
    pipeline = pipeline.webp({ quality });
  } else if (extension === ".avif") {
    pipeline = pipeline.avif({ quality });
  }

  await fs.mkdir(path.dirname(thumbPath), { recursive: true });
  await pipeline.toFile(thumbPath);
}

async function mirrorThumbToStorage(thumbPath) {
  const relative = path.relative(sourceDecksRoot, thumbPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  const dest = path.join(decksRoot, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(thumbPath, dest);
}

function logThumbJob(logger, patch) {
  logger.log(JSON.stringify({
    event: "kabbak_job",
    job: "thumbs",
    label: "Thumbnails",
    ...patch
  }));
}

async function ensureDeckThumbnails(deckRegistry, logger = console) {
  const deckEntries = Array.isArray(deckRegistry?.decks) ? deckRegistry.decks : [];
  let generatedThumbCount = 0;
  let scannedCount = 0;
  let totalAssets = 0;
  const missingByDeck = new Map();
  const missingPathsByDeck = new Map();
  const concurrency = resolveThumbConcurrency();
  const jobStartedAtMs = Date.now();
  let lastProgressLogAtMs = 0;

  logThumbJob(logger, {
    state: "running",
    done: 0,
    total: 0,
    generated: 0,
    message: `Generating deck thumbnails (${concurrency} at a time)…`
  });

  for (const deckEntry of deckEntries) {
    const relativeManifestPath = String(deckEntry?.manifestPath || "")
      .replace(/^asset\/tarot deck\//i, "")
      .replace(/\//g, path.sep);
    if (!relativeManifestPath) {
      continue;
    }

    const manifestFilePath = path.join(sourceDecksRoot, relativeManifestPath);
    const rawManifest = await readJson(manifestFilePath).catch(() => null);
    const manifest = normalizeDeckManifest(deckEntry, rawManifest);
    if (!manifest?.thumbnails || manifest.thumbnails === false) {
      continue;
    }

    const deckRelativeRoot = String(deckEntry.basePath || "")
      .replace(/^asset\/tarot deck\//i, "")
      .replace(/\//g, path.sep);
    if (!deckRelativeRoot) {
      continue;
    }

    const deckRoot = path.join(sourceDecksRoot, deckRelativeRoot);
    const thumbnailRoot = path.join(deckRoot, String(manifest.thumbnails.root || "thumbs").replace(/\//g, path.sep));
    const assetRelativePaths = listDeckAssetRelativePaths(manifest);

    totalAssets += assetRelativePaths.length;
    logger.log(`[thumbs] '${manifest.id}' — ${assetRelativePaths.length} card asset(s).`);
    let generatedForDeck = 0;
    const deckStartedAtMs = Date.now();

    await mapLimit(assetRelativePaths, concurrency, async (assetRelativePath) => {
      const normalizedRelativePath = String(assetRelativePath || "").trim().replace(/^\.\//, "");
      if (!normalizedRelativePath) {
        return;
      }

      const sourcePath = path.join(deckRoot, normalizedRelativePath.replace(/\//g, path.sep));
      const thumbPath = path.join(thumbnailRoot, normalizedRelativePath.replace(/\//g, path.sep));

      let sourceStats;
      try {
        sourceStats = await fs.stat(sourcePath);
      } catch {
        const count = missingByDeck.get(manifest.id) || 0;
        missingByDeck.set(manifest.id, count + 1);
        const missingPaths = missingPathsByDeck.get(manifest.id) || [];
        missingPaths.push(normalizedRelativePath);
        missingPathsByDeck.set(manifest.id, missingPaths);
        scannedCount += 1;
        return;
      }

      const latestDependencyMtimeMs = await getLatestDependencyMtimeMs([sourcePath, manifestFilePath]);
      let thumbIsCurrent = false;
      try {
        const thumbStats = await fs.stat(thumbPath);
        thumbIsCurrent = thumbStats.mtimeMs >= latestDependencyMtimeMs && thumbStats.size > 0;
      } catch {
        thumbIsCurrent = false;
      }

      if (thumbIsCurrent || !sourceStats.isFile()) {
        scannedCount += 1;
        return;
      }

      await writeThumbnailImage(sourcePath, thumbPath, manifest.thumbnails);
      await mirrorThumbToStorage(thumbPath);
      generatedThumbCount += 1;
      generatedForDeck += 1;
      scannedCount += 1;
      const nowMs = Date.now();
      if (generatedForDeck === 1 || generatedForDeck % 10 === 0 || nowMs - lastProgressLogAtMs >= 4000) {
        lastProgressLogAtMs = nowMs;
        logThumbJob(logger, {
          state: "running",
          deck: manifest.id,
          current: manifest.id,
          done: scannedCount,
          total: Math.max(totalAssets, scannedCount),
          generated: generatedThumbCount,
          message: `${manifest.id}: ${generatedForDeck}/${assetRelativePaths.length} new thumbs`
        });
      }
    });

    if (generatedForDeck > 0) {
      logger.log(`[thumbs] '${manifest.id}' generated ${generatedForDeck} thumbnail(s) in ${((Date.now() - deckStartedAtMs) / 1000).toFixed(1)}s.`);
    }
  }

  logThumbJob(logger, {
    state: generatedThumbCount > 0 ? "done" : "done",
    done: scannedCount,
    total: totalAssets,
    generated: generatedThumbCount,
    message: generatedThumbCount > 0
      ? `Generated ${generatedThumbCount} thumbnail(s) in ${((Date.now() - jobStartedAtMs) / 1000).toFixed(1)}s.`
      : "Thumbnails already up to date."
  });
  if (generatedThumbCount > 0) {
    logger.log(`[thumbs] Generated ${generatedThumbCount} deck thumbnail${generatedThumbCount === 1 ? "" : "s"}.`);
  }

  if (missingByDeck.size > 0) {
    const lines = [...missingByDeck.entries()].map(([id, count]) => {
      const missingPaths = missingPathsByDeck.get(id) || [];
      const shown = missingPaths.slice(0, 8).join(", ");
      const extra = missingPaths.length > 8 ? `, and ${missingPaths.length - 8} more` : "";
      return `'${id}': ${count} missing (${shown}${extra})`;
    });
    logger.warn(`[thumbs] Missing source assets — ${lines.join("; ")}.`);
  }

  return generatedThumbCount;
}

function normalizeAnagramWord(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function toAnagramSignature(value) {
  return [...normalizeAnagramWord(value)].sort().join("");
}

function buildAnagramWordIndex(gematriaWordIndex) {
  const entries = Array.isArray(gematriaWordIndex?.entries) ? gematriaWordIndex.entries : [];
  const signatures = {};
  let indexedWordCount = 0;

  entries.forEach((entry, entryIndex) => {
    const word = Array.isArray(entry) ? entry[0] : "";
    const signature = toAnagramSignature(word);
    if (!signature) {
      return;
    }

    indexedWordCount += 1;
    if (!Array.isArray(signatures[signature])) {
      signatures[signature] = [];
    }
    signatures[signature].push(entryIndex);
  });

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceWordCount: Number(gematriaWordIndex?.meta?.sourceWordCount || entries.length),
      indexedWordCount,
      signatureCount: Object.keys(signatures).length
    },
    signatures
  };
}

function resolveDeckManifestPath(deckEntry) {
  const relativePath = String(deckEntry?.manifestPath || "")
    .replace(/^asset\/tarot deck\//i, "")
    .replace(/\//g, path.sep);
  return relativePath ? path.join(sourceDecksRoot, relativePath) : "";
}

async function buildDeckRegistry() {
  const explicitRegistry = await readJson(sourceDeckRegistryPath).catch(() => ({}));
  const explicitDecks = Array.isArray(explicitRegistry?.decks) ? explicitRegistry.decks : [];
  const discoveredDecks = await discoverDeckRegistryEntries();

  const mergedDecks = [];
  const seenDeckIds = new Set();

  for (const deckEntry of explicitDecks) {
    const deckId = normalizeDeckRegistryId(deckEntry?.id);
    if (!deckId || seenDeckIds.has(deckId)) {
      continue;
    }

    // Drop entries left behind by an uninstalled deck instead of advertising them.
    const manifestPath = resolveDeckManifestPath(deckEntry);
    if (!manifestPath || !await pathExists(manifestPath)) {
      console.warn(`[decks] Dropping '${deckId}' from the registry — deck folder is no longer present.`);
      continue;
    }

    seenDeckIds.add(deckId);
    mergedDecks.push({
      ...deckEntry,
      id: deckId,
      name: String(deckEntry?.name || deckEntry?.label || deckId).trim() || deckId
    });
  }

  discoveredDecks.forEach((deckEntry) => {
    if (seenDeckIds.has(deckEntry.id)) {
      return;
    }

    seenDeckIds.add(deckEntry.id);
    mergedDecks.push(deckEntry);
  });

  return {
    ...explicitRegistry,
    decks: mergedDecks
  };
}

async function buildDeckManifests(deckRegistry) {
  const deckEntries = Array.isArray(deckRegistry?.decks) ? deckRegistry.decks : [];
  const manifestResults = await Promise.all(deckEntries.map(async (deckEntry) => {
    const manifestPath = resolveDeckManifestPath(deckEntry);
    try {
      const rawManifest = await readJson(manifestPath);
      return [String(deckEntry.id || "").trim().toLowerCase(), normalizeDeckManifest(deckEntry, rawManifest)];
    } catch (error) {
      if (error?.code === "ENOENT") {
        console.warn(`[decks] Skipping '${deckEntry.id}' — deck manifest not found at ${manifestPath}`);
        return null;
      }
      throw error;
    }
  }));

  return Object.fromEntries(manifestResults.filter((entry) => entry && entry[0] && entry[1]));
}

async function syncFile(sourcePath, destPath) {
  let copyNeeded = true;
  try {
    const [sourceStats, destStats] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(destPath)
    ]);
    copyNeeded = sourceStats.mtimeMs > destStats.mtimeMs || sourceStats.size !== destStats.size;
  } catch {
    copyNeeded = true;
  }

  if (copyNeeded) {
    await fs.copyFile(sourcePath, destPath);
  }
}

// Copy a source directory into a destination directory, skipping files that are
// unchanged (same size, and no newer mtime) and removing files that no longer
// exist in the source. This makes migrate:data cheap when only one item changed.
async function syncDirectory(sourceRoot, destRoot) {
  await fs.mkdir(destRoot, { recursive: true });

  async function walk(currentSource, currentDest) {
    const sourceEntries = await fs.readdir(currentSource, { withFileTypes: true });
    const destEntries = await fs.readdir(currentDest, { withFileTypes: true }).catch(() => []);
    const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

    for (const entry of destEntries) {
      if (!sourceNames.has(entry.name)) {
        await fs.rm(path.join(currentDest, entry.name), { recursive: true, force: true });
      }
    }

    for (const entry of sourceEntries) {
      const sourcePath = path.join(currentSource, entry.name);
      const destPath = path.join(currentDest, entry.name);

      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await walk(sourcePath, destPath);
        continue;
      }

      if (entry.isFile()) {
        await syncFile(sourcePath, destPath);
      }
    }
  }

  await walk(sourceRoot, destRoot);
}

async function copyInputsToStorage() {
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.mkdir(storageConfigRoot, { recursive: true });
  await fs.mkdir(runtimeAppRoot, { recursive: true });

  logStep(`Syncing data snapshot from ${sourceDataRoot}...`);
  await syncDirectory(sourceDataRoot, dataRoot);

  // sourceDecksRoot (source/assets/tarot deck) lives inside sourceAssetRoot, so the
  // assets sync below already includes the deck images and thumbnails.
  logStep(`Syncing assets (images and tarot decks) from ${sourceAssetRoot}...`);
  await syncDirectory(sourceAssetRoot, assetRoot);

  logStep("Syncing runtime scripts...");
  await Promise.all(runtimeFiles.map((fileName) => syncFile(
    path.join(sourceRuntimeAppRoot, fileName),
    path.join(runtimeAppRoot, fileName)
  )));

  try {
    await fs.access(managedApiClientsPath);
  } catch {
    await fs.writeFile(managedApiClientsPath, "[]\n", "utf8");
  }
}

function writeDatabase({
  magickManifest,
  magickDataset,
  referenceData,
  gematriaWordIndex,
  anagramWordIndex,
  dictionaryEnglish,
  dictionaryHebrew,
  dictionaryGreek,
  deckRegistry,
  deckManifests,
  textLibrarySnapshot
}, dbPath = null) {
  const targetPath = dbPath || databasePath;
  const database = new DatabaseSync(targetPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deck_manifests (
      deck_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec("DELETE FROM documents;");
  database.exec("DELETE FROM deck_manifests;");

  const timestamp = new Date().toISOString();
  const writeDocument = database.prepare("INSERT INTO documents (key, json, updated_at) VALUES (?, ?, ?)");
  writeDocument.run("magickManifest", JSON.stringify(magickManifest), timestamp);
  writeDocument.run("magickDataset", JSON.stringify(magickDataset), timestamp);
  writeDocument.run("referenceData", JSON.stringify(referenceData), timestamp);
  writeDocument.run("gematriaWordIndex", JSON.stringify(gematriaWordIndex), timestamp);
  writeDocument.run("anagramWordIndex", JSON.stringify(anagramWordIndex), timestamp);
  writeDocument.run("deckRegistry", JSON.stringify(deckRegistry), timestamp);
  writeDocument.run("textCatalog", JSON.stringify(textLibrarySnapshot.catalog), timestamp);
  if (dictionaryEnglish) {
    writeDocument.run("dictionaryEnglish", JSON.stringify(dictionaryEnglish), timestamp);
  }
  if (dictionaryHebrew) {
    writeDocument.run("dictionaryHebrew", JSON.stringify(dictionaryHebrew), timestamp);
  }
  if (dictionaryGreek) {
    writeDocument.run("dictionaryGreek", JSON.stringify(dictionaryGreek), timestamp);
  }

  const magickGrouped = magickDataset?.grouped || {};
  const documentSlices = {
    "slice:magick:alphabets": magickGrouped.alphabets || {},
    "slice:magick:chakras": magickGrouped.chakras || {},
    "slice:magick:enochian": magickGrouped.enochian || {},
    "slice:magick:gods": magickGrouped.gods || {},
    "slice:magick:kabbalah": magickGrouped.kabbalah || {},
    "slice:magick:numbers": magickGrouped.numbers || {},
    "slice:magick:playing-cards": magickGrouped["playing-cards-52"] || {},
    "slice:magick:tattvas": magickGrouped.alchemy?.tattvas || {},
    "slice:reference:planets": referenceData?.planets || {},
    "slice:reference:signs": referenceData?.signs || [],
    "slice:reference:decansBySign": referenceData?.decansBySign || {},
    "slice:reference:calendarMonths": referenceData?.calendarMonths || [],
    "slice:reference:calendarHolidays": referenceData?.calendarHolidays || [],
    "slice:reference:celestialHolidays": referenceData?.celestialHolidays || [],
    "slice:reference:iChing": referenceData?.iChing || {}
  };
  for (const [sliceKey, sliceValue] of Object.entries(documentSlices)) {
    writeDocument.run(sliceKey, JSON.stringify(sliceValue), timestamp);
  }

  Object.entries(textLibrarySnapshot.sources || {}).forEach(([sourceId, sourceDocument]) => {
    writeDocument.run(getTextSourceDocumentKey(sourceId), JSON.stringify(sourceDocument), timestamp);
  });

  Object.entries(textLibrarySnapshot.references || {}).forEach(([referenceId, referenceDocument]) => {
    writeDocument.run(getTextReferenceDocumentKey(referenceId), JSON.stringify(referenceDocument), timestamp);
  });

  const writeDeckManifest = database.prepare("INSERT INTO deck_manifests (deck_id, json, updated_at) VALUES (?, ?, ?)");
  Object.entries(deckManifests).forEach(([deckId, manifest]) => {
    writeDeckManifest.run(deckId, JSON.stringify(manifest), timestamp);
  });

  try {
    const { writeCorrespondenceTables } = require("../src/services/correspondence-store");
    const counts = writeCorrespondenceTables(database, {
      magickDataset,
      referenceData,
      stamp: timestamp
    });
    console.log(`[migrate] Correspondence index: ${counts.entities} entities, ${counts.relations} relations.`);
  } catch (error) {
    console.warn(`[migrate] Correspondence index skipped: ${error && error.message ? error.message : error}`);
  }

  database.close();
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseMigrateArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((value) => String(value).startsWith("--")));
  return {
    thumbsOnly: flags.has("--thumbs-only"),
    skipThumbs: flags.has("--skip-thumbs") || !flags.has("--thumbs"),
    inlineThumbs: flags.has("--thumbs")
  };
}

async function runThumbnailsOnly(logger = console) {
  await fs.mkdir(sourceDecksRoot, { recursive: true });
  const deckRegistry = await buildDeckRegistry();
  logger.log(`[thumbs] Generating thumbnails for ${Array.isArray(deckRegistry.decks) ? deckRegistry.decks.length : 0} deck(s).`);
  await ensureDeckThumbnails(deckRegistry, logger);
}

async function main() {
  const options = parseMigrateArgs();
  if (options.thumbsOnly) {
    await runThumbnailsOnly(console);
    return;
  }

  console.log(`Migrating KABBAK data from ${sourceRoot}`);

  // The deck directory is populated by DLC installs and is gitignored, so it does
  // not exist on a fresh clone. Create it so deck discovery and registry writing
  // work with zero installed decks.
  await fs.mkdir(sourceDecksRoot, { recursive: true });

  // Register curated documents already sitting in source/data/text before importing drops,
  // so the importer can detect id collisions against them.
  const libraryScan = await refreshTextLibraryRegistry();
  console.log(`[text-library] Registered ${libraryScan.sources.length} curated source(s) and ${libraryScan.references.length} reference(s).`);
  for (const skippedFile of libraryScan.skipped) {
    console.warn(`[text-library] Skipped ${skippedFile.fileName}: ${skippedFile.reason}.`);
  }

  const importedTextSummary = await importTextSources();
  if (importedTextSummary.importedCount) {
    console.log(`Imported ${importedTextSummary.importedCount} text source${importedTextSummary.importedCount === 1 ? "" : "s"} into canonical JSON.`);
  }

  const importedReferenceSummary = await importReferenceSources();
  if (importedReferenceSummary.importedCount) {
    console.log(`Imported ${importedReferenceSummary.importedCount} reference${importedReferenceSummary.importedCount === 1 ? "" : "s"} into canonical JSON.`);
  }

  // Copy any deck folders from imports/decks/ into source for discovery
  let deckImportEntries = [];
  try {
    deckImportEntries = await fs.readdir(decksImportRoot, { withFileTypes: true });
  } catch (_error) {
    // No deck imports found — that's fine.
  }

  for (const entry of deckImportEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const importPath = path.join(decksImportRoot, entry.name);
    const targetPath = path.join(sourceDecksRoot, entry.name);
    if (!await pathExists(path.join(importPath, "deck.json"))) continue;
    // Remove any previous copy first so files that were renamed or dropped in a
    // deck update don't linger and end up flagged as missing assets.
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(importPath, targetPath, { recursive: true, force: true });
    console.log(`[decks] Copied imported deck '${entry.name}' to source.`);
    await fs.rm(importPath, { recursive: true, force: true });
    console.log(`[decks] Removed imported deck '${entry.name}' from imports.`);
  }

  // Clean up processed text files from imports/text/ — generated JSON remains in source/
  let textImportEntries = [];
  try {
    textImportEntries = await fs.readdir(textImportRoot, { withFileTypes: true });
  } catch (_error) {}

  for (const entry of textImportEntries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      if (entry.name === ".gitkeep" || entry.name === "README.md") continue;
      const textPath = path.join(textImportRoot, entry.name);
      await fs.rm(textPath, { force: true });
      console.log(`[texts] Removed synced text '${entry.name}' from imports.`);
    }

  logStep("Discovering deck registry...");
  const deckRegistry = await buildDeckRegistry();
  logStep(`Discovered ${Array.isArray(deckRegistry.decks) ? deckRegistry.decks.length : 0} deck(s).`);
  logStep("Building deck manifests...");
  const deckManifests = await buildDeckManifests(deckRegistry);
  logStep(`Built ${Object.keys(deckManifests).length} deck manifest(s).`);
  const serializedDeckRegistry = `${JSON.stringify(deckRegistry, null, 2)}\n`;

  await fs.writeFile(sourceDeckRegistryPath, serializedDeckRegistry, "utf8");
  logStep("Copying inputs to storage...");
  await copyInputsToStorage();

  logStep("Building data snapshots (manifest, dataset, reference data, gematria, text library)...");
  const [magickManifest, magickDataset, referenceData, textLibrarySnapshot] = await Promise.all([
    buildMagickManifest(),
    buildMagickDataset(),
    buildReferenceData(),
    buildTextLibrarySnapshot()
  ]);
  const gematriaWordIndex = await buildGematriaWordIndex(textLibrarySnapshot);
  const anagramWordIndex = buildAnagramWordIndex(gematriaWordIndex);

  logStep("Loading dictionaries (English, Hebrew, Greek)...");
  const [dictionaryEnglish, dictionaryHebrew, dictionaryGreek] = await Promise.all([
    readJson(path.join(sourceDataRoot, "dictionary-english.json")).catch(() => null),
    readJson(path.join(sourceDataRoot, "dictionary-hebrew.json")).catch(() => null),
    readJson(path.join(sourceDataRoot, "dictionary-greek.json")).catch(() => null)
  ]);
  const describeDictionary = (dictionary) => dictionary
    ? `${Array.isArray(dictionary.entries) ? dictionary.entries.length : 0} entries`
    : "missing";
  console.log(`  english: ${describeDictionary(dictionaryEnglish)}, hebrew: ${describeDictionary(dictionaryHebrew)}, greek: ${describeDictionary(dictionaryGreek)}`);

  await fs.writeFile(sourceDeckRegistryPath, serializedDeckRegistry, "utf8");
  await fs.writeFile(deckRegistryPath, serializedDeckRegistry, "utf8");

  const ts = Date.now();
  const activeDbPath = databasePath + "." + ts;

  logStep("Writing SQLite database...");
  writeDatabase({
    magickManifest,
    magickDataset,
    referenceData,
    gematriaWordIndex,
    anagramWordIndex,
    dictionaryEnglish,
    dictionaryHebrew,
    dictionaryGreek,
    deckRegistry,
    deckManifests,
    textLibrarySnapshot
  }, activeDbPath);

  // Atomically set the active database pointer
  const activeDbMarkerPath = databasePath + ".active";
  await fs.writeFile(activeDbMarkerPath, activeDbPath, "utf8");

  // Clean up old database files (keep only the active one)
  const dbDir = path.dirname(databasePath);
  const dbBase = path.basename(databasePath);
  try {
    const dirEntries = await fs.readdir(dbDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isFile()) continue;
      if (entry.name === path.basename(activeDbPath)) continue;
      if (entry.name === path.basename(activeDbMarkerPath)) continue;
      if (entry.name.startsWith(dbBase + ".") && entry.name !== dbBase) {
        try { await fs.rm(path.join(dbDir, entry.name), { force: true }); } catch {}
      }
    }
  } catch {}

  console.log(`Wrote SQLite database to ${activeDbPath}`);
  console.log(`Copied data snapshot to ${dataRoot}`);
  console.log(`Copied tarot deck assets to ${decksRoot}`);
  console.log(`Copied runtime scripts to ${runtimeAppRoot}`);

  if (options.inlineThumbs && !options.skipThumbs) {
    logStep("Generating deck thumbnails...");
    await ensureDeckThumbnails(deckRegistry, console);
  } else {
    console.log("[thumbs] Skipping inline thumbnail generation (run with --thumbs, or let the API generate them in the background).");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});