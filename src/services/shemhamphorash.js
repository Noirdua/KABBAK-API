const fs = require("fs");
const path = require("path");

const { sourceDataRoot } = require("../config/paths");

const ZODIAC_SIGN_IDS = Object.freeze([
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces"
]);

const HEBREW_ROMAN = Object.freeze({
  "א": "A",
  "ב": "B",
  "ג": "G",
  "ד": "D",
  "ה": "H",
  "ו": "V",
  "ז": "Z",
  "ח": "Ch",
  "ט": "T",
  "י": "Y",
  "כ": "K",
  "ך": "K",
  "ל": "L",
  "מ": "M",
  "ם": "M",
  "נ": "N",
  "ן": "N",
  "ס": "S",
  "ע": "O",
  "פ": "P",
  "ף": "P",
  "צ": "Tz",
  "ץ": "Tz",
  "ק": "Q",
  "ר": "R",
  "ש": "Sh",
  "ת": "Th"
});

const ENOCHIAN_SIGN_ALIASES = Object.freeze({
  pesces: "pisces",
  pisces: "pisces"
});

const ELEMENT_IDS = new Set(["fire", "air", "water", "earth", "spirit"]);

function slug(value) {
  return String(value ?? "").trim().toLowerCase();
}

function readSourceJson(relativePath) {
  const filePath = path.join(sourceDataRoot, relativePath);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function loadShemhamphorashDataset() {
  return readSourceJson(path.join("kabbalah", "shemhamphorash.json"));
}

function romanizeHebrew(text) {
  return Array.from(String(text || "")).map((char) => HEBREW_ROMAN[char] || char).join("");
}

function splitShem(hebrewName) {
  const letters = Array.from(String(hebrewName || "").trim());
  const tail = letters.slice(-2).join("");
  const suffix = tail === "יה" ? "iah" : (tail === "אל" ? "el" : "");
  const shemLetters = suffix ? letters.slice(0, -2) : letters;
  return {
    he: shemLetters.join(""),
    roman: romanizeHebrew(shemLetters.join("")),
    suffix,
    suffixHe: suffix ? tail : ""
  };
}

function parseCitation(citation) {
  const text = String(citation || "").trim();
  const match = text.match(/^([A-Za-z]+)\s+(\d+):(\d+(?:-\d+)?)$/);
  if (!match) {
    return { citation: text, book: "", chapter: null, verse: "" };
  }
  return {
    citation: text,
    book: slug(match[1]),
    chapter: Number(match[1] && match[2]),
    verse: match[3]
  };
}

function choirForNumber(choirs, number) {
  return (Array.isArray(choirs) ? choirs : []).find((choir) => (
    number >= Number(choir?.from) && number <= Number(choir?.to)
  )) || null;
}

function normalizeDecans(decans) {
  if (Array.isArray(decans)) {
    return decans;
  }
  if (Array.isArray(decans?.decans)) {
    return decans.decans;
  }
  if (decans && typeof decans === "object") {
    return Object.values(decans).flat().filter((entry) => entry && typeof entry === "object" && entry.id);
  }
  return [];
}

function normalizeSigns(signs) {
  if (Array.isArray(signs)) {
    return signs;
  }
  if (Array.isArray(signs?.signs)) {
    return signs.signs;
  }
  return [];
}

function placementForNumber(number, signs, decans) {
  const index = Number(number) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= 72) {
    return null;
  }
  const start = index * 5;
  const signId = ZODIAC_SIGN_IDS[Math.floor(start / 30)] || "";
  const degreeStart = start % 30;
  const degreeEnd = degreeStart + 5;
  const decanIndex = Math.floor(degreeStart / 10) + 1;
  const decanId = signId ? `${signId}-${decanIndex}` : "";
  const sign = normalizeSigns(signs).find((entry) => slug(entry?.id) === signId) || null;
  const decan = normalizeDecans(decans).find((entry) => slug(entry?.id) === decanId) || null;
  return {
    signId,
    signName: String(sign?.name || ""),
    degreeStart,
    degreeEnd,
    decanId,
    decanIndex,
    half: degreeStart % 10 < 5 ? 1 : 2,
    element: slug(sign?.element),
    planetId: slug(decan?.rulerPlanetId),
    tarotMinorArcana: String(decan?.tarotMinorArcana || ""),
    tarotMajorArcana: String(sign?.tarot?.majorArcana || "")
  };
}

function enochianLinks(letters, tablets, signId, element) {
  const signLetters = [];
  const elementLetters = [];
  Object.values(letters && typeof letters === "object" ? letters : {}).forEach((letter) => {
    const id = String(letter?.id || "").trim();
    if (!id) {
      return;
    }
    const token = slug(letter["planet/element"]);
    const sign = ENOCHIAN_SIGN_ALIASES[token] || (ZODIAC_SIGN_IDS.includes(token) ? token : "");
    if (sign && sign === signId) {
      signLetters.push(id);
      return;
    }
    if (ELEMENT_IDS.has(token) && token === element) {
      elementLetters.push(id);
    }
  });
  const tabletId = tablets && typeof tablets === "object" && tablets[element]?.id
    ? String(tablets[element].id)
    : (tablets && tablets[element] ? element : "");
  return {
    signLetterIds: signLetters,
    elementLetterIds: elementLetters,
    tabletId: slug(tabletId)
  };
}

function angelAliases(angel) {
  const names = [
    angel?.id,
    angel?.number,
    String(angel?.number || "").padStart(2, "0"),
    angel?.name?.en,
    angel?.name?.reuchlin,
    angel?.name?.he
  ];
  return [...new Set(names.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function buildAngel(raw, context) {
  const number = Number(raw?.number);
  const he = String(raw?.he || "").trim();
  const en = String(raw?.en || "").trim();
  const reuchlin = String(raw?.reuchlin || "").trim();
  const shem = splitShem(he);
  const choir = choirForNumber(context.choirs, number);
  const placement = placementForNumber(number, context.signs, context.decans);
  const links = enochianLinks(context.letters, context.tablets, placement?.signId, placement?.element);
  const id = String(number).padStart(2, "0");
  const angel = {
    id,
    number,
    name: {
      en,
      he,
      ...(reuchlin && reuchlin !== en ? { reuchlin } : {})
    },
    shem: {
      he: shem.he,
      roman: shem.roman,
      suffix: shem.suffix,
      suffixHe: shem.suffixHe
    },
    choirId: choir?.id || "",
    choir: choir ? {
      id: choir.id,
      name: choir.name,
      ...(choir.angelicOrderId ? { angelicOrderId: choir.angelicOrderId } : {})
    } : null,
    psalm: parseCitation(raw?.psalm),
    quinance: placement ? {
      signId: placement.signId,
      signName: placement.signName,
      degreeStart: placement.degreeStart,
      degreeEnd: placement.degreeEnd,
      decanId: placement.decanId,
      decanIndex: placement.decanIndex,
      half: placement.half
    } : null,
    element: placement?.element || "",
    planetId: placement?.planetId || "",
    tarot: {
      minorArcana: placement?.tarotMinorArcana || "",
      majorArcana: placement?.tarotMajorArcana || ""
    },
    enochianLetterIds: [...links.signLetterIds, ...links.elementLetterIds],
    enochian: {
      signLetterIds: links.signLetterIds,
      elementLetterIds: links.elementLetterIds,
      ...(links.tabletId ? { tabletId: links.tabletId } : {})
    }
  };
  angel.relations = describeAngelRelations(angel);
  return angel;
}

function describeAngelRelations(angel) {
  const relations = [];
  const push = (relation, kind, id, label) => {
    const target = slug(id);
    if (!target) {
      return;
    }
    relations.push({ relation, kind, id: target, label: String(label || target) });
  };
  push("of-sign", "sign", angel.quinance?.signId, angel.quinance?.signName || angel.quinance?.signId);
  push("of-decan", "decan", angel.quinance?.decanId, angel.quinance?.decanId);
  push("tarot", "tarot-card", angel.tarot?.minorArcana, angel.tarot?.minorArcana);
  push("tarot", "tarot-card", angel.tarot?.majorArcana, angel.tarot?.majorArcana);
  push("ruled-by", "planet", angel.planetId, angel.planetId);
  push("choir", "shem-choir", angel.choirId, angel.choir?.name || angel.choirId);
  push("angelic-order", "angelic-order", angel.choir?.angelicOrderId, angel.choir?.name);
  push("element", "element", angel.element, angel.element);
  (angel.enochian?.signLetterIds || []).forEach((letterId) => {
    push("enochian", "enochian-letter", letterId, `${letterId} · ${angel.quinance?.signName || angel.quinance?.signId || ""}`.trim());
  });
  (angel.enochian?.elementLetterIds || []).forEach((letterId) => {
    push("enochian", "enochian-letter", letterId, `${letterId} · ${angel.element}`.trim());
  });
  push("enochian-tablet", "enochian-tablet", angel.enochian?.tabletId, angel.enochian?.tabletId);
  return relations;
}

function buildShemCatalog({
  dataset = null,
  signs = null,
  decans = null,
  letters = null,
  tablets = null
} = {}) {
  const source = dataset && typeof dataset === "object" ? dataset : loadShemhamphorashDataset();
  const context = {
    choirs: Array.isArray(source.choirs) ? source.choirs : [],
    signs: signs == null ? readSourceJson("signs.json") : signs,
    decans: decans == null ? readSourceJson("decans.json") : decans,
    letters: letters == null ? readSourceJson(path.join("enochian", "letters.json")) : letters,
    tablets: tablets == null ? readSourceJson(path.join("enochian", "tablets.json")) : tablets
  };
  const angels = (Array.isArray(source.angels) ? source.angels : [])
    .map((raw) => buildAngel(raw, context))
    .filter((angel) => Number.isInteger(angel.number))
    .sort((left, right) => left.number - right.number);
  return {
    meta: source.meta || {},
    choirs: context.choirs,
    angels
  };
}

function findShemAngel(angels, value) {
  const needle = slug(value);
  if (!needle) {
    return null;
  }
  const list = Array.isArray(angels) ? angels : [];
  const numeric = Number(value);
  if (Number.isInteger(numeric)) {
    const byNumber = list.find((angel) => angel.number === numeric);
    if (byNumber) {
      return byNumber;
    }
  }
  return list.find((angel) => angelAliases(angel).some((alias) => slug(alias) === needle)) || null;
}

function filterShemAngels(angels, query = {}) {
  const sign = slug(query.sign);
  const decan = slug(query.decan);
  const tarot = slug(query.tarot);
  const planet = slug(query.planet);
  const choir = slug(query.choir);
  const element = slug(query.element);
  const enochian = slug(query.enochian);
  const q = slug(query.q || query.query);
  return (Array.isArray(angels) ? angels : []).filter((angel) => {
    if (sign && slug(angel.quinance?.signId) !== sign) return false;
    if (decan && slug(angel.quinance?.decanId) !== decan) return false;
    if (planet && slug(angel.planetId) !== planet) return false;
    if (choir && slug(angel.choirId) !== choir) return false;
    if (element && slug(angel.element) !== element) return false;
    if (tarot) {
      const names = [angel.tarot?.minorArcana, angel.tarot?.majorArcana].map(slug);
      if (!names.includes(tarot)) return false;
    }
    if (enochian && !(angel.enochianLetterIds || []).some((letterId) => slug(letterId) === enochian)) {
      return false;
    }
    if (q && !angelAliases(angel).some((alias) => slug(alias).includes(q)) && !String(angel.shem?.roman || "").toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

module.exports = {
  ZODIAC_SIGN_IDS,
  angelAliases,
  buildShemCatalog,
  filterShemAngels,
  findShemAngel,
  loadShemhamphorashDataset,
  placementForNumber,
  splitShem
};
