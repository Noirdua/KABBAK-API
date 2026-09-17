"use strict";

// Classical gematria methods for Hebrew (ported from moshejs/mispar, MIT) and
// Greek isopsephy analogues, used by word lookup and reverse lookup.

const HEBREW_ALPHABET = "\u05D0\u05D1\u05D2\u05D3\u05D4\u05D5\u05D6\u05D7\u05D8\u05D9\u05DB\u05DC\u05DE\u05E0\u05E1\u05E2\u05E4\u05E6\u05E7\u05E8\u05E9\u05EA";

const HEBREW_STANDARD = {
  "\u05D0": 1, "\u05D1": 2, "\u05D2": 3, "\u05D3": 4, "\u05D4": 5,
  "\u05D5": 6, "\u05D6": 7, "\u05D7": 8, "\u05D8": 9, "\u05D9": 10,
  "\u05DB": 20, "\u05DC": 30, "\u05DE": 40, "\u05E0": 50, "\u05E1": 60,
  "\u05E2": 70, "\u05E4": 80, "\u05E6": 90, "\u05E7": 100, "\u05E8": 200,
  "\u05E9": 300, "\u05EA": 400
};

const HEBREW_FINAL_TO_BASE = {
  "\u05DA": "\u05DB", // final kaf -> kaf
  "\u05DD": "\u05DE", // final mem -> mem
  "\u05DF": "\u05E0", // final nun -> nun
  "\u05E3": "\u05E4", // final pe -> pe
  "\u05E5": "\u05E6" // final tsadi -> tsadi
};

const HEBREW_GADOL_FINALS = {
  "\u05DA": 500,
  "\u05DD": 600,
  "\u05DF": 700,
  "\u05E3": 800,
  "\u05E5": 900
};

const HEBREW_MILUI_SPELLINGS = {
  "\u05D0": "\u05D0\u05DC\u05E3",
  "\u05D1": "\u05D1\u05D9\u05EA",
  "\u05D2": "\u05D2\u05D9\u05DE\u05DC",
  "\u05D3": "\u05D3\u05DC\u05EA",
  "\u05D4": "\u05D4\u05D0",
  "\u05D5": "\u05D5\u05D0\u05D5",
  "\u05D6": "\u05D6\u05D9\u05DF",
  "\u05D7": "\u05D7\u05D9\u05EA",
  "\u05D8": "\u05D8\u05D9\u05EA",
  "\u05D9": "\u05D9\u05D5\u05D3",
  "\u05DB": "\u05DB\u05E3",
  "\u05DC": "\u05DC\u05DE\u05D3",
  "\u05DE": "\u05DE\u05DD",
  "\u05E0": "\u05E0\u05D5\u05DF",
  "\u05E1": "\u05E1\u05DE\u05DA",
  "\u05E2": "\u05E2\u05D9\u05DF",
  "\u05E4": "\u05E4\u05D4",
  "\u05E6": "\u05E6\u05D3\u05D9",
  "\u05E7": "\u05E7\u05D5\u05E3",
  "\u05E8": "\u05E8\u05D9\u05E9",
  "\u05E9": "\u05E9\u05D9\u05DF",
  "\u05EA": "\u05EA\u05D5"
};

const HEBREW_METHODS = [
  "hechrachi",
  "gadol",
  "katan",
  "siduri",
  "katan-mispari",
  "perati",
  "meshulash",
  "kidmi",
  "boneeh",
  "haakhor",
  "milui",
  "atbash",
  "albam"
];

const GREEK_METHODS = [
  "isopsephy",
  "ordinal",
  "katan",
  "katan-mispari",
  "perati",
  "meshulash",
  "kidmi",
  "boneeh",
  "haakhor"
];

const GREEK_ALPHABET = "\u03B1\u03B2\u03B3\u03B4\u03B5\u03B6\u03B7\u03B8\u03B9\u03BA\u03BB\u03BC\u03BD\u03BE\u03BF\u03C0\u03C1\u03C3\u03C4\u03C5\u03C6\u03C7\u03C8\u03C9";

const GREEK_STANDARD = {
  "\u03B1": 1, "\u03B2": 2, "\u03B3": 3, "\u03B4": 4, "\u03B5": 5,
  "\u03DD": 6, // digamma/stigma
  "\u03B6": 7, "\u03B7": 8, "\u03B8": 9, "\u03B9": 10, "\u03BA": 20,
  "\u03BB": 30, "\u03BC": 40, "\u03BD": 50, "\u03BE": 60, "\u03BF": 70,
  "\u03C0": 80, "\u03D9": 90, // koppa
  "\u03C1": 100, "\u03C3": 200, "\u03C2": 200, "\u03C4": 300, "\u03C5": 400,
  "\u03C6": 500, "\u03C7": 600, "\u03C8": 700, "\u03C9": 800,
  "\u03E1": 900 // sampi
};

const HEBREW_SCRIPT_RE = /[\u0590-\u05FF]/;
const GREEK_SCRIPT_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/;
const HEBREW_MARKS_RE = /[\u0591-\u05C7\u05BE\u05F3\u05F4]/g;

function normalizeHebrewText(value) {
  return String(value || "")
    .replace(HEBREW_MARKS_RE, "")
    .trim();
}

function normalizeGreekText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u03c2/g, "\u03C3")
    .replace(/[^a-z\u0370-\u03FF]/g, "")
    .trim();
}

function isHebrewScript(value) {
  return HEBREW_SCRIPT_RE.test(String(value || ""));
}

function isGreekScript(value) {
  return GREEK_SCRIPT_RE.test(String(value || ""));
}

function digitalRoot(value) {
  const numeric = Math.abs(Math.trunc(Number(value) || 0));
  return numeric === 0 ? 0 : 1 + ((numeric - 1) % 9);
}

function hebrewWordLetters(text) {
  const words = [];
  let current = [];
  for (const char of normalizeHebrewText(text)) {
    if (HEBREW_STANDARD[char] || HEBREW_FINAL_TO_BASE[char]) {
      current.push(char);
    } else if (/\s/.test(char)) {
      if (current.length) words.push(current);
      current = [];
    }
  }
  if (current.length) words.push(current);
  return words;
}

function greekWordLetters(text) {
  const words = [];
  let current = [];
  for (const char of normalizeGreekText(text)) {
    if (GREEK_STANDARD[char]) {
      current.push(char);
    } else if (/\s/.test(char)) {
      if (current.length) words.push(current);
      current = [];
    }
  }
  if (current.length) words.push(current);
  return words;
}

function normalizeHebrewFinal(char) {
  return HEBREW_FINAL_TO_BASE[char] || char;
}

function hebrewStandardValue(char) {
  return HEBREW_STANDARD[normalizeHebrewFinal(char)] || 0;
}

function greekValue(char) {
  return GREEK_STANDARD[char] || 0;
}

function katanValue(value) {
  let next = Number(value) || 0;
  while (next > 0 && next % 10 === 0) next /= 10;
  return next;
}

const HEBREW_KIDMI = (() => {
  const map = {};
  let running = 0;
  for (const char of HEBREW_ALPHABET) {
    running += HEBREW_STANDARD[char] || 0;
    map[char] = running;
  }
  return map;
})();

const GREEK_KIDMI = (() => {
  const map = {};
  let running = 0;
  for (const char of GREEK_ALPHABET) {
    running += GREEK_STANDARD[char] || 0;
    map[char] = running;
  }
  return map;
})();

function cipherMap(transform) {
  const map = {};
  for (let index = 0; index < 22; index += 1) {
    map[HEBREW_ALPHABET[index]] = HEBREW_ALPHABET[transform(index)];
  }
  return map;
}

const HEBREW_ATBASH = cipherMap((index) => 21 - index);
const HEBREW_ALBAM = cipherMap((index) => (index + 11) % 22);

function hebrewPerLetterValue(char, method) {
  const base = normalizeHebrewFinal(char);
  switch (method) {
    case "hechrachi":
      return hebrewStandardValue(char);
    case "gadol":
      return HEBREW_GADOL_FINALS[char] ?? hebrewStandardValue(char);
    case "katan":
      return katanValue(hebrewStandardValue(char));
    case "siduri":
      return HEBREW_ALPHABET.indexOf(base) + 1;
    case "perati": {
      const value = hebrewStandardValue(char);
      return value * value;
    }
    case "meshulash": {
      const value = hebrewStandardValue(char);
      return value * value * value;
    }
    case "kidmi":
      return HEBREW_KIDMI[base] || 0;
    case "milui": {
      const spelling = HEBREW_MILUI_SPELLINGS[base];
      if (!spelling) return 0;
      let sum = 0;
      for (const letter of spelling) sum += hebrewStandardValue(letter);
      return sum;
    }
    case "atbash":
      return hebrewStandardValue(HEBREW_ATBASH[base] || base);
    case "albam":
      return hebrewStandardValue(HEBREW_ALBAM[base] || base);
    default:
      return hebrewStandardValue(char);
  }
}

function computeHebrewGematria(value, method = "hechrachi") {
  const words = hebrewWordLetters(value);
  if (method === "katan-mispari") {
    let total = 0;
    for (const word of words) for (const char of word) total += hebrewStandardValue(char);
    return digitalRoot(total);
  }
  if (method === "boneeh") {
    let running = 0;
    let total = 0;
    for (const word of words) {
      for (const char of word) {
        running += hebrewStandardValue(char);
        total += running;
      }
    }
    return total;
  }
  if (method === "haakhor") {
    let total = 0;
    for (const word of words) {
      word.forEach((char, index) => {
        total += hebrewStandardValue(char) * (index + 1);
      });
    }
    return total;
  }
  let total = 0;
  for (const word of words) for (const char of word) total += hebrewPerLetterValue(char, method);
  return total;
}

function greekPerLetterValue(char, method) {
  switch (method) {
    case "isopsephy":
      return greekValue(char);
    case "ordinal":
      return GREEK_ALPHABET.indexOf(char) + 1;
    case "katan":
      return katanValue(greekValue(char));
    case "perati": {
      const value = greekValue(char);
      return value * value;
    }
    case "meshulash": {
      const value = greekValue(char);
      return value * value * value;
    }
    case "kidmi":
      return GREEK_KIDMI[char] || 0;
    default:
      return greekValue(char);
  }
}

function computeGreekGematria(value, method = "isopsephy") {
  const words = greekWordLetters(value);
  if (method === "katan-mispari") {
    let total = 0;
    for (const word of words) for (const char of word) total += greekValue(char);
    return digitalRoot(total);
  }
  if (method === "boneeh") {
    let running = 0;
    let total = 0;
    for (const word of words) {
      for (const char of word) {
        running += greekValue(char);
        total += running;
      }
    }
    return total;
  }
  if (method === "haakhor") {
    let total = 0;
    for (const word of words) {
      word.forEach((char, index) => {
        total += greekValue(char) * (index + 1);
      });
    }
    return total;
  }
  let total = 0;
  for (const word of words) for (const char of word) total += greekPerLetterValue(char, method);
  return total;
}

const METHOD_INFO = {
  hechrachi: { label: "Hechrachi", description: "Standard absolute values, \u05D0=1 \u2026 \u05EA=400." },
  gadol: { label: "Gadol", description: "Finals \u05DA \u05DD \u05DF \u05E3 \u05E5 count 500\u2013900." },
  katan: { label: "Katan", description: "Each letter reduced to one digit." },
  siduri: { label: "Siduri", description: "Ordinal position, \u05D0=1 \u2026 \u05EA=22." },
  "katan-mispari": { label: "Katan Mispari", description: "Digital root of the standard total." },
  perati: { label: "Perati", description: "Each letter's value squared." },
  meshulash: { label: "Meshulash", description: "Each letter's value cubed." },
  kidmi: { label: "Kidmi", description: "Cumulative value up to each letter." },
  boneeh: { label: "Bone'eh", description: "Running total re-added at every letter." },
  haakhor: { label: "Ha'akhor", description: "Value \u00D7 position within the word." },
  milui: { label: "Milui", description: "Each letter's spelled-out name." },
  atbash: { label: "Atbash", description: "Standard value after the \u05D0\u2194\u05EA cipher." },
  albam: { label: "Albam", description: "Standard value after the \u05D0\u2194\u05DC cipher." },
  isopsephy: { label: "Isopsephy", description: "Standard Greek values, \u03B1=1 \u2026 \u03C9=800." },
  ordinal: { label: "Ordinal", description: "Alphabet position, \u03B1=1 \u2026 \u03C9=24." }
};

function methodsForLanguage(language) {
  if (language === "hebrew") return HEBREW_METHODS;
  if (language === "greek") return GREEK_METHODS;
  return [];
}

function methodOptionsForLanguage(language) {
  return methodsForLanguage(language).map((id) => ({
    id,
    label: String(METHOD_INFO[id]?.label || id),
    description: String(METHOD_INFO[id]?.description || "")
  }));
}

function defaultMethodForLanguage(language) {
  return language === "greek" ? "isopsephy" : "hechrachi";
}

function isValidMethod(language, method) {
  const raw = String(method || "").trim().toLowerCase();
  if (!raw) return true;
  return methodsForLanguage(language).includes(raw);
}

function computeGematria(value, language, method) {
  const rawMethod = String(method || "").trim().toLowerCase()
    || defaultMethodForLanguage(language);
  if (language === "greek") {
    return computeGreekGematria(value, GREEK_METHODS.includes(rawMethod) ? rawMethod : "isopsephy");
  }
  return computeHebrewGematria(value, HEBREW_METHODS.includes(rawMethod) ? rawMethod : "hechrachi");
}

module.exports = {
  HEBREW_METHODS,
  GREEK_METHODS,
  HEBREW_VALUES: HEBREW_STANDARD,
  GREEK_VALUES: GREEK_STANDARD,
  HEBREW_MILUI_SPELLINGS,
  normalizeHebrewText,
  normalizeGreekText,
  isHebrewScript,
  isGreekScript,
  computeHebrewGematria,
  computeGreekGematria,
  computeGematria,
  methodsForLanguage,
  methodOptionsForLanguage,
  defaultMethodForLanguage,
  isValidMethod
};
