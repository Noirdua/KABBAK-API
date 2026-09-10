(function () {
  const MAJOR_CARDS = [
    {
      number: 0,
      name: "The Fool",
      summary: "Open-hearted beginnings, leap of faith, and the sacred unknown.",
      upright: "Fresh starts, trust in the path, and inspired spontaneity.",
      reversed: "Recklessness, fear of risk, or resistance to a needed new beginning.",
      keywords: ["beginnings", "faith", "innocence", "freedom", "journey"],
      relations: ["Element: Air", "Hebrew Letter: Aleph"]
    },
    {
      number: 1,
      name: "The Magus",
      summary: "Focused will and conscious manifestation through aligned tools.",
      upright: "Skill, initiative, concentration, and transforming intent into action.",
      reversed: "Scattered power, manipulation, or blocked self-belief.",
      keywords: ["will", "manifestation", "focus", "skill", "agency"],
      relations: ["Planet: Mercury", "Hebrew Letter: Beth"]
    },
    {
      number: 2,
      name: "The High Priestess",
      summary: "Inner knowing, sacred silence, and intuitive perception.",
      upright: "Intuition, subtle insight, patience, and hidden wisdom.",
      reversed: "Disconnection from inner voice or confusion around truth.",
      keywords: ["intuition", "mystery", "stillness", "inner-voice", "receptivity"],
      relations: ["Planet: Luna", "Hebrew Letter: Gimel"]
    },
    {
      number: 3,
      name: "The Empress",
      summary: "Creative abundance, nurture, and embodied growth.",
      upright: "Fertility, care, beauty, comfort, and creative flourishing.",
      reversed: "Creative drought, overgiving, or neglecting self-nourishment.",
      keywords: ["abundance", "creation", "nurture", "beauty", "growth"],
      relations: ["Planet: Venus", "Hebrew Letter: Daleth"]
    },
    {
      number: 4,
      name: "The Emperor",
      summary: "Structure, authority, and stable leadership.",
      upright: "Order, discipline, protection, and strategic direction.",
      reversed: "Rigidity, domination, or weak boundaries.",
      keywords: ["structure", "authority", "stability", "leadership", "boundaries"],
      relations: ["Zodiac: Aries", "Hebrew Letter: He"]
    },
    {
      number: 5,
      name: "The Hierophant",
      summary: "Tradition, spiritual instruction, and shared values.",
      upright: "Learning from lineage, ritual, ethics, and mentorship.",
      reversed: "Dogma, rebellion without grounding, or spiritual stagnation.",
      keywords: ["tradition", "teaching", "ritual", "ethics", "lineage"],
      relations: ["Zodiac: Taurus", "Hebrew Letter: Vav"]
    },
    {
      number: 6,
      name: "The Lovers",
      summary: "Union, alignment, and value-centered choices.",
      upright: "Harmony, connection, and conscious commitment.",
      reversed: "Misalignment, indecision, or disconnection in relationship.",
      keywords: ["union", "choice", "alignment", "connection", "values"],
      relations: ["Zodiac: Gemini", "Hebrew Letter: Zayin"]
    },
    {
      number: 7,
      name: "The Chariot",
      summary: "Directed momentum and mastery through discipline.",
      upright: "Determination, movement, and victory through control.",
      reversed: "Loss of direction, conflict of will, or stalled progress.",
      keywords: ["drive", "control", "momentum", "victory", "direction"],
      relations: ["Zodiac: Cancer", "Hebrew Letter: Cheth"]
    },
    {
      number: 8,
      name: "Lust",
      summary: "Courageous life-force, passionate integrity, and heart-led power.",
      upright: "Vitality, confidence, and wholehearted creative expression.",
      reversed: "Self-doubt, depletion, or misdirected desire.",
      keywords: ["vitality", "passion", "courage", "magnetism", "heart-power"],
      relations: ["Zodiac: Leo", "Hebrew Letter: Teth"]
    },
    {
      number: 9,
      name: "The Hermit",
      summary: "Inner pilgrimage, discernment, and sacred solitude.",
      upright: "Reflection, guidance, and deepening wisdom.",
      reversed: "Isolation, avoidance, or overanalysis.",
      keywords: ["solitude", "wisdom", "search", "reflection", "discernment"],
      relations: ["Zodiac: Virgo", "Hebrew Letter: Yod"]
    },
    {
      number: 10,
      name: "Fortune",
      summary: "Cycles, timing, and turning points guided by greater rhythms.",
      upright: "Opportunity, momentum, and fated change.",
      reversed: "Resistance to cycles, delay, or repeating old patterns.",
      keywords: ["cycles", "timing", "change", "destiny", "turning-point"],
      relations: ["Planet: Jupiter", "Hebrew Letter: Kaph"]
    },
    {
      number: 11,
      name: "Justice",
      summary: "Balance, accountability, and clear consequence.",
      upright: "Fairness, truth, and ethical alignment.",
      reversed: "Bias, denial, or avoidance of responsibility.",
      keywords: ["balance", "truth", "accountability", "law", "clarity"],
      relations: ["Zodiac: Libra", "Hebrew Letter: Lamed"]
    },
    {
      number: 12,
      name: "The Hanged Man",
      summary: "Sacred pause, surrender, and transformed perspective.",
      upright: "Release, contemplation, and spiritual reframing.",
      reversed: "Stagnation, martyrdom, or refusing to let go.",
      keywords: ["surrender", "pause", "perspective", "suspension", "release"],
      relations: ["Element: Water", "Hebrew Letter: Mem"]
    },
    {
      number: 13,
      name: "Death",
      summary: "Endings that clear space for rebirth and renewal.",
      upright: "Transformation, completion, and deep release.",
      reversed: "Clinging, fear of change, or prolonged transition.",
      keywords: ["transformation", "ending", "renewal", "release", "rebirth"],
      relations: ["Zodiac: Scorpio", "Hebrew Letter: Nun"]
    },
    {
      number: 14,
      name: "Art",
      summary: "Alchemy, integration, and harmonizing opposites.",
      upright: "Balance through blending, refinement, and patience.",
      reversed: "Imbalance, excess, or fragmented energies.",
      keywords: ["alchemy", "integration", "balance", "blending", "refinement"],
      relations: ["Zodiac: Sagittarius", "Hebrew Letter: Samekh"]
    },
    {
      number: 15,
      name: "The Devil",
      summary: "Attachment, shadow desire, and material entanglement.",
      upright: "Confronting bondage, ambition, and raw instinct.",
      reversed: "Liberation, breaking chains, or denial of shadow.",
      keywords: ["attachment", "shadow", "instinct", "temptation", "bondage"],
      relations: ["Zodiac: Capricorn", "Hebrew Letter: Ayin"]
    },
    {
      number: 16,
      name: "The Tower",
      summary: "Sudden revelation that dismantles false structures.",
      upright: "Shock, breakthrough, and necessary collapse.",
      reversed: "Delayed upheaval, denial, or internal crisis.",
      keywords: ["upheaval", "revelation", "breakthrough", "collapse", "truth"],
      relations: ["Planet: Mars", "Hebrew Letter: Pe"]
    },
    {
      number: 17,
      name: "The Star",
      summary: "Healing hope, guidance, and spiritual renewal.",
      upright: "Inspiration, serenity, and trust in the future.",
      reversed: "Discouragement, doubt, or loss of faith.",
      keywords: ["hope", "healing", "guidance", "renewal", "faith"],
      relations: ["Zodiac: Aquarius", "Hebrew Letter: Tzaddi"]
    },
    {
      number: 18,
      name: "The Moon",
      summary: "Dream, uncertainty, and passage through the subconscious.",
      upright: "Intuition, mystery, and emotional depth.",
      reversed: "Confusion clearing, projection, or fear illusions.",
      keywords: ["dream", "mystery", "intuition", "subconscious", "illusion"],
      relations: ["Zodiac: Pisces", "Hebrew Letter: Qoph"]
    },
    {
      number: 19,
      name: "The Sun",
      summary: "Radiance, confidence, and vital life affirmation.",
      upright: "Joy, clarity, success, and openness.",
      reversed: "Temporary clouding, ego glare, or delayed confidence.",
      keywords: ["joy", "clarity", "vitality", "success", "radiance"],
      relations: ["Planet: Sol", "Hebrew Letter: Resh"]
    },
    {
      number: 20,
      name: "Aeon",
      summary: "Awakening call, reckoning, and soul-level renewal.",
      upright: "Judgment, liberation, and answering purpose.",
      reversed: "Self-judgment, hesitation, or resistance to calling.",
      keywords: ["awakening", "reckoning", "calling", "renewal", "release"],
      relations: ["Element: Fire", "Hebrew Letter: Shin"]
    },
    {
      number: 21,
      name: "Universe",
      summary: "Completion, integration, and embodied wholeness.",
      upright: "Fulfillment, mastery, and successful closure.",
      reversed: "Incomplete cycle, loose ends, or delayed completion.",
      keywords: ["completion", "wholeness", "integration", "mastery", "closure"],
      relations: ["Planet: Saturn", "Hebrew Letter: Tav"]
    }
  ];

  const SUITS = ["Cups", "Wands", "Swords", "Disks"];
  const NUMBER_RANKS = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const COURT_RANKS = ["Knight", "Queen", "Prince", "Princess"];

  const SUIT_INFO = {
    cups: {
      element: "Water",
      domain: "emotion, intuition, relationship",
      keywords: ["emotion", "intuition", "connection"]
    },
    wands: {
      element: "Fire",
      domain: "will, creativity, drive",
      keywords: ["will", "drive", "inspiration"]
    },
    swords: {
      element: "Air",
      domain: "mind, truth, communication",
      keywords: ["mind", "truth", "clarity"]
    },
    disks: {
      element: "Earth",
      domain: "body, craft, material life",
      keywords: ["resources", "craft", "stability"]
    }
  };

  const RANK_INFO = {
    ace: {
      number: 1,
      upright: "Seed-force, pure potential, and concentrated essence.",
      reversed: "Blocked potential, delay, or difficulty beginning.",
      keywords: ["seed", "potential", "spark"]
    },
    two: {
      number: 2,
      upright: "Polarity seeking balance, exchange, and response.",
      reversed: "Imbalance, friction, or uncertain choices.",
      keywords: ["duality", "balance", "exchange"]
    },
    three: {
      number: 3,
      upright: "Initial growth, expansion, and expression.",
      reversed: "Scattered growth or stalled development.",
      keywords: ["growth", "expansion", "expression"]
    },
    four: {
      number: 4,
      upright: "Structure, boundaries, and stabilizing form.",
      reversed: "Rigidity, inertia, or unstable foundations.",
      keywords: ["structure", "stability", "foundation"]
    },
    five: {
      number: 5,
      upright: "Challenge, disruption, and catalytic conflict.",
      reversed: "Lingering tension or fear of needed change.",
      keywords: ["challenge", "conflict", "change"]
    },
    six: {
      number: 6,
      upright: "Rebalancing, harmony, and restorative flow.",
      reversed: "Partial recovery or unresolved imbalance.",
      keywords: ["harmony", "repair", "flow"]
    },
    seven: {
      number: 7,
      upright: "Testing, strategy, and spiritual/mental refinement.",
      reversed: "Doubt, overdefense, or poor strategy.",
      keywords: ["test", "strategy", "refinement"]
    },
    eight: {
      number: 8,
      upright: "Adjustment, movement, and disciplined power.",
      reversed: "Restriction, frustration, or scattered effort.",
      keywords: ["movement", "discipline", "adjustment"]
    },
    nine: {
      number: 9,
      upright: "Intensity, culmination, and mature force.",
      reversed: "Excess, overload, or unresolved pressure.",
      keywords: ["culmination", "intensity", "maturity"]
    },
    ten: {
      number: 10,
      upright: "Completion, overflow, and transition into a new cycle.",
      reversed: "Overextension, depletion, or difficulty releasing.",
      keywords: ["completion", "threshold", "transition"]
    }
  };

  const COURT_INFO = {
    knight: {
      role: "active catalyst and questing force",
      elementalFace: "Fire of",
      upright: "Bold pursuit, direct action, and forward momentum.",
      reversed: "Impulsiveness, burnout, or unfocused drive.",
      keywords: ["action", "drive", "initiative"]
    },
    queen: {
      role: "magnetic vessel and emotional intelligence",
      elementalFace: "Water of",
      upright: "Receptive mastery, mature feeling, and embodied wisdom.",
      reversed: "Withholding, moodiness, or passive control.",
      keywords: ["receptivity", "maturity", "depth"]
    },
    prince: {
      role: "strategic mediator and organizing mind",
      elementalFace: "Air of",
      upright: "Insight, communication, and adaptive coordination.",
      reversed: "Overthinking, detachment, or mixed signals.",
      keywords: ["strategy", "communication", "adaptability"]
    },
    princess: {
      role: "manifesting ground and practical seed-force",
      elementalFace: "Earth of",
      upright: "Practical growth, devotion, and tangible follow-through.",
      reversed: "Stagnation, timidity, or blocked growth.",
      keywords: ["manifestation", "grounding", "devotion"]
    }
  };

  const MAJOR_ALIASES = {
    magician: "magus",
    strength: "lust",
    "wheel of fortune": "fortune",
    temperance: "art",
    judgement: "aeon",
    judgment: "aeon",
    world: "universe",
    adjustment: "justice"
  };

  const MINOR_SUIT_ALIASES = {
    pentacles: "disks",
    pentacle: "disks",
    coins: "disks",
    disks: "disks"
  };

  const MINOR_NUMERAL_ALIASES = {
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

  const MONTH_NAME_BY_NUMBER = {
    1: "January",
    2: "February",
    3: "March",
    4: "April",
    5: "May",
    6: "June",
    7: "July",
    8: "August",
    9: "September",
    10: "October",
    11: "November",
    12: "December"
  };

  const MONTH_ID_BY_NUMBER = {
    1: "january",
    2: "february",
    3: "march",
    4: "april",
    5: "may",
    6: "june",
    7: "july",
    8: "august",
    9: "september",
    10: "october",
    11: "november",
    12: "december"
  };

  const COURT_DECAN_WINDOWS = {
    "Knight of Wands": ["scorpio-3", "sagittarius-1", "sagittarius-2"],
    "Queen of Disks": ["sagittarius-3", "capricorn-1", "capricorn-2"],
    "Prince of Swords": ["capricorn-3", "aquarius-1", "aquarius-2"],
    "Knight of Cups": ["aquarius-3", "pisces-1", "pisces-2"],
    "Queen of Wands": ["pisces-3", "aries-1", "aries-2"],
    "Prince of Disks": ["aries-3", "taurus-1", "taurus-2"],
    "Knight of Swords": ["taurus-3", "gemini-1", "gemini-2"],
    "Queen of Cups": ["gemini-3", "cancer-1", "cancer-2"],
    "Prince of Wands": ["cancer-3", "leo-1", "leo-2"],
    "Knight of Disks": ["leo-3", "virgo-1", "virgo-2"],
    "Queen of Swords": ["virgo-3", "libra-1", "libra-2"],
    "Prince of Cups": ["libra-3", "scorpio-1", "scorpio-2"]
  };

  const COURT_SIGN_WINDOWS = {
    "Princess of Wands": ["cancer", "leo", "virgo"],
    "Princess of Cups": ["libra", "scorpio", "sagittarius"],
    "Princess of Swords": ["capricorn", "aquarius", "pisces"],
    "Princess of Disks": ["aries", "taurus", "gemini"]
  };

  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const MAJOR_HEBREW_LETTER_ID_BY_CARD = {
    fool: "alef",
    magus: "bet",
    "high priestess": "gimel",
    empress: "dalet",
    emperor: "he",
    hierophant: "vav",
    lovers: "zayin",
    chariot: "het",
    lust: "tet",
    hermit: "yod",
    fortune: "kaf",
    justice: "lamed",
    "hanged man": "mem",
    death: "nun",
    art: "samekh",
    devil: "ayin",
    tower: "pe",
    star: "tsadi",
    moon: "qof",
    sun: "resh",
    aeon: "shin",
    universe: "tav"
  };

  const HEBREW_LETTER_ALIASES = {
    aleph: "alef",
    alef: "alef",
    beth: "bet",
    bet: "bet",
    gimel: "gimel",
    daleth: "dalet",
    dalet: "dalet",
    he: "he",
    vav: "vav",
    zayin: "zayin",
    cheth: "het",
    chet: "het",
    het: "het",
    teth: "tet",
    tet: "tet",
    yod: "yod",
    kaph: "kaf",
    kaf: "kaf",
    lamed: "lamed",
    mem: "mem",
    nun: "nun",
    samekh: "samekh",
    ayin: "ayin",
    pe: "pe",
    tzaddi: "tsadi",
    tzadi: "tsadi",
    tsadi: "tsadi",
    qoph: "qof",
    qof: "qof",
    resh: "resh",
    shin: "shin",
    tav: "tav"
  };

  const createTarotDatabaseHelpers = window.TarotDatabaseBuilders?.createTarotDatabaseHelpers;
  const createTarotDatabaseAssembly = window.TarotDatabaseAssembly?.createTarotDatabaseAssembly;
  if (typeof createTarotDatabaseHelpers !== "function" || typeof createTarotDatabaseAssembly !== "function") {
    throw new Error("TarotDatabaseBuilders and TarotDatabaseAssembly modules must load before tarot-database.js");
  }

  const tarotDatabaseBuilders = createTarotDatabaseHelpers({
    majorCards: MAJOR_CARDS,
    suits: SUITS,
    numberRanks: NUMBER_RANKS,
    courtRanks: COURT_RANKS,
    suitInfo: SUIT_INFO,
    rankInfo: RANK_INFO,
    courtInfo: COURT_INFO,
    courtDecanWindows: COURT_DECAN_WINDOWS,
    courtSignWindows: COURT_SIGN_WINDOWS,
    majorAliases: MAJOR_ALIASES,
    minorNumeralAliases: MINOR_NUMERAL_ALIASES,
    monthNameByNumber: MONTH_NAME_BY_NUMBER,
    monthIdByNumber: MONTH_ID_BY_NUMBER,
    monthShort: MONTH_SHORT,
    hebrewLetterAliases: HEBREW_LETTER_ALIASES
  });

  const tarotDatabaseAssembly = createTarotDatabaseAssembly({
    getTarotDbConfig: tarotDatabaseBuilders.getTarotDbConfig,
    canonicalCardName: tarotDatabaseBuilders.canonicalCardName,
    formatMonthDayLabel: tarotDatabaseBuilders.formatMonthDayLabel,
    applyMeaningText: tarotDatabaseBuilders.applyMeaningText,
    buildDecanMetadata: tarotDatabaseBuilders.buildDecanMetadata,
    listMonthNumbersBetween: tarotDatabaseBuilders.listMonthNumbersBetween,
    buildHebrewLetterLookup: tarotDatabaseBuilders.buildHebrewLetterLookup,
    createRelation: tarotDatabaseBuilders.createRelation,
    parseLegacyRelation: tarotDatabaseBuilders.parseLegacyRelation,
    buildHebrewLetterRelation: tarotDatabaseBuilders.buildHebrewLetterRelation,
    buildMajorDynamicRelations: tarotDatabaseBuilders.buildMajorDynamicRelations,
    buildMinorDecanRelations: tarotDatabaseBuilders.buildMinorDecanRelations,
    monthNameByNumber: MONTH_NAME_BY_NUMBER,
    monthIdByNumber: MONTH_ID_BY_NUMBER,
    majorHebrewLetterIdByCard: MAJOR_HEBREW_LETTER_ID_BY_CARD
  });

  function getTarotDbConfig(referenceData) {
    return tarotDatabaseBuilders.getTarotDbConfig(referenceData);
  }

  function normalizeCardName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^the\s+/, "")
      .replace(/\s+/g, " ");
  }

  function canonicalCardName(value) {
    return tarotDatabaseBuilders.canonicalCardName(value);
  }

  function formatMonthDayLabel(date) {
    return tarotDatabaseBuilders.formatMonthDayLabel(date);
  }

  function applyMeaningText(cards, referenceData) {
    return tarotDatabaseBuilders.applyMeaningText(cards, referenceData);
  }

  function listMonthNumbersBetween(start, end) {
    return tarotDatabaseBuilders.listMonthNumbersBetween(start, end);
  }

  function buildDecanMetadata(decan, sign) {
    return tarotDatabaseBuilders.buildDecanMetadata(decan, sign);
  }

  function buildHebrewLetterLookup(magickDataset) {
    return tarotDatabaseBuilders.buildHebrewLetterLookup(magickDataset);
  }

  function normalizeRelationId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "unknown";
  }

  function createRelation(type, id, label, data = null) {
    return tarotDatabaseBuilders.createRelation(type, id, label, data);
  }

  function parseLegacyRelation(text) {
    return tarotDatabaseBuilders.parseLegacyRelation(text);
  }

  function buildHebrewLetterRelation(hebrewLetterId, hebrewLookup) {
    return tarotDatabaseBuilders.buildHebrewLetterRelation(hebrewLetterId, hebrewLookup);
  }

  function buildMajorDynamicRelations(referenceData) {
    return tarotDatabaseBuilders.buildMajorDynamicRelations(referenceData);
  }

  function buildMinorDecanRelations(referenceData) {
    return tarotDatabaseBuilders.buildMinorDecanRelations(referenceData);
  }

  function buildMajorCards(referenceData, magickDataset) {
    return tarotDatabaseAssembly.buildMajorCards(referenceData, magickDataset);
  }

  function buildNumberMinorCards(referenceData) {
    return tarotDatabaseAssembly.buildNumberMinorCards(referenceData);
  }

  function buildCourtMinorCards(referenceData) {
    return tarotDatabaseAssembly.buildCourtMinorCards(referenceData);
  }

  function buildTarotDatabase(referenceData, magickDataset = null) {
    return tarotDatabaseAssembly.buildTarotDatabase(referenceData, magickDataset);
  }

  window.TarotCardDatabase = {
    buildTarotDatabase
  };
})();
