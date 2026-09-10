const {
  loadReferenceData,
  loadMagickDataset
} = require("./data-loader");
const { loadTarotRuntime } = require("./browser-module-runtime");
const { createSeededRandom } = require("../lib/random");
const { toTitleCase } = require("../lib/string-utils");

const THREE_CARD_POSITIONS = [
  { pos: "past", label: "Past" },
  { pos: "present", label: "Present" },
  { pos: "future", label: "Future" }
];

const CELTIC_CROSS_POSITIONS = [
  { pos: "crown", label: "Crown" },
  { pos: "out", label: "Outcome" },
  { pos: "past", label: "Recent Past" },
  { pos: "present", label: "Present" },
  { pos: "near-fut", label: "Near Future" },
  { pos: "hope", label: "Hopes & Fears" },
  { pos: "chall", label: "Challenge" },
  { pos: "env", label: "Environment" },
  { pos: "found", label: "Foundation" },
  { pos: "self", label: "Self" }
];

const MINOR_NUMBER_WORD_BY_VALUE = {
  1: "ace",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten"
};

const ELEMENT_NAME_BY_ID = {
  water: "Water",
  fire: "Fire",
  air: "Air",
  earth: "Earth"
};

const ELEMENT_HEBREW_LETTER_BY_ID = {
  fire: "Yod",
  water: "Heh",
  air: "Vav",
  earth: "Heh"
};

const ELEMENT_HEBREW_CHAR_BY_ID = {
  fire: "י",
  water: "ה",
  air: "ו",
  earth: "ה"
};

const HEBREW_LETTER_ID_BY_TETRAGRAMMATON_LETTER = {
  yod: "yod",
  heh: "he",
  vav: "vav"
};

const ACE_ELEMENT_BY_CARD_NAME = {
  "ace of cups": "water",
  "ace of wands": "fire",
  "ace of swords": "air",
  "ace of disks": "earth"
};

const COURT_ELEMENT_BY_RANK = {
  knight: "fire",
  queen: "water",
  prince: "air",
  princess: "earth"
};

const MINOR_RANK_NUMBER_BY_NAME = {
  ace: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};

const SMALL_CARD_SIGN_BY_MODALITY_AND_SUIT = {
  cardinal: {
    wands: "aries",
    cups: "cancer",
    swords: "libra",
    disks: "capricorn"
  },
  fixed: {
    wands: "leo",
    cups: "scorpio",
    swords: "aquarius",
    disks: "taurus"
  },
  mutable: {
    wands: "sagittarius",
    cups: "pisces",
    swords: "gemini",
    disks: "virgo"
  }
};

let tarotContextCache = null;

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function cardId(card) {
  const suitPart = card?.suit ? `-${slugify(card.suit)}` : "";
  return `${slugify(card?.arcana)}${suitPart}-${slugify(card?.name)}`;
}

function normalizeTarotName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTarotCardLookupName(value) {
  const text = normalizeTarotName(value)
    .replace(/\b(pentacles?|coins?)\b/g, "disks");

  const match = text.match(/^(\d{1,2})\s+of\s+(.+)$/i);
  if (!match) {
    return text;
  }

  const numeric = Number(match[1]);
  const suit = String(match[2] || "").trim();
  const rankWord = MINOR_NUMBER_WORD_BY_VALUE[numeric];
  if (!rankWord || !suit) {
    return text;
  }

  return `${rankWord} of ${suit}`;
}

function normalizeRelationId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "unknown";
}

function relationSignature(relation) {
  return [
    String(relation?.type || "relation"),
    String(relation?.id || ""),
    String(relation?.label || "")
  ].join("|");
}

function dedupeRelations(relations) {
  const seen = new Set();
  return (Array.isArray(relations) ? relations : []).filter((relation) => {
    const signature = relationSignature(relation);
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function stripInternalRelationKeys(relations) {
  return (Array.isArray(relations) ? relations : []).map((relation) => {
    if (!relation || typeof relation !== "object") {
      return relation;
    }

    const next = { ...relation };
    delete next.__key;
    return next;
  });
}

function serializeCard(card) {
  if (!card || typeof card !== "object") {
    return null;
  }

  return {
    id: card.id,
    arcana: card.arcana,
    name: card.name,
    number: card.number,
    suit: card.suit,
    rank: card.rank,
    hebrewLetterId: card.hebrewLetterId || null,
    kabbalahPathNumber: Number.isFinite(Number(card.kabbalahPathNumber)) ? Number(card.kabbalahPathNumber) : null,
    hebrewLetter: card.hebrewLetter || null,
    summary: card.summary,
    meaning: card.meaning || null,
    meanings: card.meanings || null,
    keywords: Array.isArray(card.keywords) ? [...card.keywords] : [],
    relations: stripInternalRelationKeys(card.relations)
  };
}

function buildTypeLabel(card) {
  if (card?.arcana === "Major") {
    return typeof card?.number === "number"
      ? `Major Arcana · ${card.number}`
      : "Major Arcana";
  }

  const parts = ["Minor Arcana"];
  if (card?.rank) {
    parts.push(card.rank);
  }
  if (card?.suit) {
    parts.push(card.suit);
  }
  return parts.join(" · ");
}

function createElementRelation(card, elementId, sourceKind, sourceLabel) {
  if (!card || !elementId) {
    return null;
  }

  const elementName = ELEMENT_NAME_BY_ID[elementId] || toTitleCase(elementId);
  const hebrewLetter = ELEMENT_HEBREW_LETTER_BY_ID[elementId] || "";
  const hebrewChar = ELEMENT_HEBREW_CHAR_BY_ID[elementId] || "";

  return {
    type: "element",
    id: elementId,
    label: `${elementName}${hebrewChar ? ` (${hebrewChar})` : (hebrewLetter ? ` (${hebrewLetter})` : "")} · ${sourceLabel}`,
    data: {
      elementId,
      name: elementName,
      tarotCard: card.name,
      hebrewLetter,
      hebrewChar,
      sourceKind,
      sourceLabel,
      rank: card.rank || "",
      suit: card.suit || ""
    }
  };
}

function buildElementRelationsForCard(card, baseElementRelations = []) {
  if (!card) {
    return [];
  }

  if (card.arcana === "Major") {
    return Array.isArray(baseElementRelations) ? [...baseElementRelations] : [];
  }

  const relations = [];
  const suitKey = String(card.suit || "").trim().toLowerCase();
  const suitElementId = {
    wands: "fire",
    cups: "water",
    swords: "air",
    disks: "earth"
  }[suitKey] || "";

  if (suitElementId) {
    const suitRelation = createElementRelation(card, suitElementId, "suit", `Suit: ${card.suit}`);
    if (suitRelation) {
      relations.push(suitRelation);
    }
  }

  const rankKey = String(card.rank || "").trim().toLowerCase();
  const courtElementId = COURT_ELEMENT_BY_RANK[rankKey] || "";
  if (courtElementId) {
    const courtRelation = createElementRelation(card, courtElementId, "court", `Court: ${card.rank}`);
    if (courtRelation) {
      relations.push(courtRelation);
    }
  }

  return relations;
}

function buildTetragrammatonRelationsForCard(card) {
  if (!card) {
    return [];
  }

  const cardLookupName = normalizeTarotCardLookupName(card.name);
  const rankKey = String(card.rank || "").trim().toLowerCase();
  const elementId = ACE_ELEMENT_BY_CARD_NAME[cardLookupName] || COURT_ELEMENT_BY_RANK[rankKey] || "";
  if (!elementId) {
    return [];
  }

  const letter = ELEMENT_HEBREW_LETTER_BY_ID[elementId] || "";
  if (!letter) {
    return [];
  }

  const elementName = ELEMENT_NAME_BY_ID[elementId] || elementId;
  const letterKey = String(letter).trim().toLowerCase();
  const hebrewLetterId = HEBREW_LETTER_ID_BY_TETRAGRAMMATON_LETTER[letterKey] || "";

  return [{
    type: "tetragrammaton",
    id: `${letterKey}-${elementId}`,
    label: `${letter} · ${elementName}`,
    data: {
      letter,
      elementId,
      elementName,
      hebrewLetterId
    }
  }];
}

function getSmallCardModality(rankNumber) {
  const numeric = Number(rankNumber);
  if (!Number.isFinite(numeric) || numeric < 2 || numeric > 10) {
    return "";
  }
  if (numeric <= 4) {
    return "cardinal";
  }
  if (numeric <= 7) {
    return "fixed";
  }
  return "mutable";
}

function buildSmallCardRulershipRelation(card, referenceData) {
  if (!card || card.arcana !== "Minor") {
    return null;
  }

  const rankKey = String(card.rank || "").trim().toLowerCase();
  const rankNumber = MINOR_RANK_NUMBER_BY_NAME[rankKey];
  const modality = getSmallCardModality(rankNumber);
  if (!modality) {
    return null;
  }

  const suitKey = String(card.suit || "").trim().toLowerCase();
  const signId = SMALL_CARD_SIGN_BY_MODALITY_AND_SUIT[modality]?.[suitKey] || "";
  if (!signId) {
    return null;
  }

  const sign = (Array.isArray(referenceData?.signs) ? referenceData.signs : [])
    .find((entry) => String(entry?.id || "").trim().toLowerCase() === signId);

  return {
    type: "zodiacRulership",
    id: `${signId}-${rankKey}-${suitKey}`,
    label: `Sign type: ${toTitleCase(modality)} · ${String(sign?.symbol || "").trim()} ${String(sign?.name || toTitleCase(signId))}`.trim(),
    data: {
      signId,
      signName: String(sign?.name || toTitleCase(signId)),
      symbol: String(sign?.symbol || "").trim(),
      modality,
      rank: card.rank,
      suit: card.suit
    }
  };
}

async function buildTarotContext() {
  if (tarotContextCache) {
    return tarotContextCache;
  }

  const [referenceData, magickDataset, tarotRuntime] = await Promise.all([
    loadReferenceData(),
    loadMagickDataset(),
    loadTarotRuntime()
  ]);

  const cards = tarotRuntime.buildTarotDatabase(referenceData, magickDataset).map((card) => ({
    ...card,
    id: cardId(card),
    lookupName: normalizeTarotCardLookupName(card.name)
  }));

  const monthRefsByCardId = tarotRuntime.buildMonthReferencesByCard(referenceData, cards);
  const courtCardByDecanId = tarotRuntime.buildCourtCardByDecanId(cards);
  const cardById = new Map(cards.map((card) => [card.id, card]));

  tarotContextCache = {
    referenceData,
    magickDataset,
    tarotRuntime,
    cards,
    cardById,
    monthRefsByCardId,
    courtCardByDecanId
  };

  return tarotContextCache;
}

function serializeMonthReferences(monthRefs) {
  return (Array.isArray(monthRefs) ? monthRefs : []).map((monthRef) => ({ ...monthRef }));
}

function buildRelationsPayload(card, context) {
  const { referenceData, magickDataset, tarotRuntime, monthRefsByCardId, courtCardByDecanId } = context;
  const baseRelations = Array.isArray(card?.relations) ? stripInternalRelationKeys(card.relations) : [];
  const baseElementRelations = baseRelations.filter((relation) => relation?.type === "element");
  const elementRelations = buildElementRelationsForCard(card, baseElementRelations);
  const tetragrammatonRelations = buildTetragrammatonRelationsForCard(card);
  const zodiacRulershipRelation = buildSmallCardRulershipRelation(card, referenceData);
  const courtLinkRelations = tarotRuntime.buildSmallCardCourtLinkRelations(card, card.relations || [], courtCardByDecanId);
  const monthReferenceRelations = serializeMonthReferences(monthRefsByCardId.get(card.id) || []);
  const cubeRelations = stripInternalRelationKeys(tarotRuntime.buildCubeRelationsForCard(card, magickDataset));
  const iChingRelations = stripInternalRelationKeys(tarotRuntime.buildIChingRelationsForCard(card, referenceData));

  const combinedRelations = dedupeRelations([
    ...baseRelations,
    ...elementRelations,
    ...tetragrammatonRelations,
    ...(zodiacRulershipRelation ? [zodiacRulershipRelation] : []),
    ...stripInternalRelationKeys(courtLinkRelations),
    ...cubeRelations,
    ...iChingRelations
  ]);

  return {
    typeLabel: buildTypeLabel(card),
    base: baseRelations,
    elements: dedupeRelations(elementRelations),
    tetragrammaton: dedupeRelations(tetragrammatonRelations),
    zodiacRulership: zodiacRulershipRelation ? [zodiacRulershipRelation] : [],
    courtLinks: stripInternalRelationKeys(courtLinkRelations),
    monthReferences: monthReferenceRelations,
    cube: cubeRelations,
    iChing: iChingRelations,
    all: stripInternalRelationKeys(combinedRelations)
  };
}

async function listCards(filters = {}) {
  const context = await buildTarotContext();
  const query = normalizeTarotName(filters.query || "");
  const arcana = normalizeTarotName(filters.arcana || "");
  const suit = normalizeTarotName(filters.suit || "");

  const cards = context.cards.filter((card) => {
    if (arcana && normalizeTarotName(card.arcana) !== arcana) {
      return false;
    }

    if (suit && normalizeTarotName(card.suit) !== suit) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      card.name,
      card.arcana,
      card.suit,
      card.rank,
      card.summary,
      ...(Array.isArray(card.keywords) ? card.keywords : []),
      ...(Array.isArray(card.relations) ? card.relations.map((relation) => relation?.label || "") : [])
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });

  return cards.map((card) => serializeCard(card));
}

async function getCardById(cardIdValue) {
  const context = await buildTarotContext();
  const key = String(cardIdValue || "").trim();
  const card = context.cardById.get(key) || null;
  if (!card) {
    return null;
  }

  return {
    card: serializeCard(card),
    relations: buildRelationsPayload(card, context)
  };
}

function normalizeSpreadId(spreadId) {
  return String(spreadId || "").trim().toLowerCase() === "celtic-cross"
    ? "celtic-cross"
    : "three-card";
}

function getSpreadPositions(spreadId) {
  return normalizeSpreadId(spreadId) === "celtic-cross"
    ? CELTIC_CROSS_POSITIONS
    : THREE_CARD_POSITIONS;
}

async function listSpreads() {
  return {
    spreads: [
      {
        id: "three-card",
        label: "Three Card",
        positions: THREE_CARD_POSITIONS
      },
      {
        id: "celtic-cross",
        label: "Celtic Cross",
        positions: CELTIC_CROSS_POSITIONS
      }
    ]
  };
}

async function pullSpread(spreadId, options = {}) {
  const context = await buildTarotContext();
  const normalizedSpreadId = normalizeSpreadId(spreadId);
  const positions = getSpreadPositions(normalizedSpreadId);
  const random = options.seed ? createSeededRandom(options.seed) : Math.random;
  const shuffled = [...context.cards];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  const cards = shuffled.slice(0, positions.length);

  return {
    spreadId: normalizedSpreadId,
    seed: options.seed || null,
    cardCount: positions.length,
    positions: positions.map((position, index) => {
      const card = cards[index] || null;
      const reversed = card && options.allowReversed === true ? random() < 0.3 : false;

      return {
        position,
        reversed,
        card: card ? serializeCard(card) : null
      };
    })
  };
}

function resetTarotContextCache() {
  tarotContextCache = null;
}

module.exports = {
  listCards,
  getCardById,
  listSpreads,
  pullSpread,
  resetTarotContextCache
};