const fs = require("node:fs");
const path = require("node:path");

const sourceDataRoot = path.resolve(__dirname, "..", "source", "data");
const rawRoot = path.join(sourceDataRoot, "dictionary", "raw");
const hebrewOutputPath = path.join(sourceDataRoot, "dictionary-hebrew.json");
const greekOutputPath = path.join(sourceDataRoot, "dictionary-greek.json");

const THAYER_JSONL_URL = "https://raw.githubusercontent.com/nigelmsipa/thayers-greek-lexicon-dataset/master/data/thayer_lexicon.jsonl";

function normalizeHebrew(value) {
  return String(value || "")
    .replace(/[\u0591-\u05C7\u05BE\u05F3\u05F4]/g, "")
    .trim();
}

function normalizeGreek(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u03c2/g, "\u03c3")
    .replace(/[·]/g, "")
    .trim();
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.text();
}

function cleanStrongsDefinition(entry) {
  const definition = String(entry?.strongs_def || "").trim();
  if (/^\{.*\}$/.test(definition)) {
    return "";
  }
  return definition.replace(/[{}]/g, "").replace(/\s+/g, " ").slice(0, 320);
}

function buildHebrewDictionary() {
  const strongDictPath = path.join(sourceDataRoot, "text", "strong_dict.json");
  const strongDict = JSON.parse(fs.readFileSync(strongDictPath, "utf8"));
  const byWord = new Map();
  Object.entries(strongDict).forEach(([strongsKey, entry]) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const lemma = String(entry.lemma || "").trim();
    const normalized = normalizeHebrew(lemma);
    if (!normalized) {
      return;
    }
    const definition = cleanStrongsDefinition(entry);
    const transliteration = String(entry.xlit || entry.pron || "").trim();
    if (!byWord.has(normalized)) {
      byWord.set(normalized, { lemma, transliteration, definitions: [] });
    }
    const record = byWord.get(normalized);
    if (definition && !record.definitions.includes(definition)) {
      record.definitions.push(definition);
    }
    if (!record.transliteration && transliteration) {
      record.transliteration = transliteration;
    }
  });

  const entries = [...byWord.entries()]
    .filter(([, record]) => record.definitions.length)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([word, record]) => [word, record.lemma, record.transliteration, record.definitions.join(" · ")]);
  const withTransliteration = entries.filter((entry) => entry[2]).length;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "Strong's Hebrew Dictionary",
      sourceWordCount: entries.length,
      withTransliteration
    },
    entries
  };
}

async function buildGreekDictionary() {
  const cachePath = path.join(rawRoot, "thayer_lexicon.jsonl");
  let raw = null;
  if (fs.existsSync(cachePath)) {
    raw = fs.readFileSync(cachePath, "utf8");
  } else {
    console.log(`  downloading ${THAYER_JSONL_URL}`);
    raw = await fetchText(THAYER_JSONL_URL);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, raw, "utf8");
  }

  const byWord = new Map();
  const lines = raw.split("\n");
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_error) {
      return;
    }
    const lemma = String(entry?.lemma || "").split(",")[0].trim();
    const normalized = normalizeGreek(lemma);
    if (!normalized) {
      return;
    }
    const definition = String(entry?.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 450);
    if (!definition) {
      return;
    }
    const transliteration = String(entry?.transliteration || "").trim();
    const grammar = String(entry?.grammar || "").trim();
    if (!byWord.has(normalized)) {
      byWord.set(normalized, {
        lemma,
        transliteration,
        grammar,
        definition
      });
      return;
    }
    const record = byWord.get(normalized);
    if (!record.definition.includes(definition)) {
      record.definition = `${record.definition} ${definition}`.trim().slice(0, 600);
    }
  });

  const entries = [...byWord.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([word, record]) => [word, record.lemma, record.transliteration, record.grammar, record.definition]);
  const withTransliteration = entries.filter((entry) => entry[2]).length;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "Thayer's Greek-English Lexicon (1889)",
      sourceWordCount: entries.length,
      withTransliteration
    },
    entries
  };
}

async function main() {
  console.log("Building Hebrew dictionary…");
  const hebrew = buildHebrewDictionary();
  fs.writeFileSync(hebrewOutputPath, JSON.stringify(hebrew), "utf8");
  console.log(`  wrote ${hebrewOutputPath} (${hebrew.entries.length} entries, ${hebrew.meta.withTransliteration} transliterated)`);

  console.log("Building Greek dictionary…");
  const greek = await buildGreekDictionary();
  fs.writeFileSync(greekOutputPath, JSON.stringify(greek), "utf8");
  console.log(`  wrote ${greekOutputPath} (${greek.entries.length} entries, ${greek.meta.withTransliteration} transliterated)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
