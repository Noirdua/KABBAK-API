const fs = require("node:fs");
const path = require("node:path");

const sourceDataRoot = path.resolve(__dirname, "..", "source", "data");
const rawRoot = path.join(sourceDataRoot, "dictionary", "raw");
const outputPath = path.join(sourceDataRoot, "dictionary-english.json");

const WORDSET_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const WORDSET_BASE = "https://raw.githubusercontent.com/wordset/wordset-dictionary/master/data";
const ETYMOLOGY_URL = "https://raw.githubusercontent.com/jmsv/ety-python/master/ety/data/etymologies.json";

const LANG_NAMES = {
  eng: "English", en: "English",
  ang: "Old English", enm: "Middle English",
  xno: "Anglo-Norman", fro: "Old French", frm: "Middle French", fra: "French", fre: "French",
  lat: "Latin", grc: "Ancient Greek", gre: "Greek", ell: "Greek",
  heb: "Hebrew", ara: "Arabic", egy: "Egyptian", phn: "Phoenician", syc: "Syriac", arc: "Aramaic",
  akk: "Akkadian", sum: "Sumerian",
  deu: "German", ger: "German", gmh: "Middle High German", goh: "Old High German",
  ita: "Italian", spa: "Spanish", por: "Portuguese", cat: "Catalan", ron: "Romanian", rum: "Romanian",
  nld: "Dutch", dut: "Dutch", afr: "Afrikaans", yid: "Yiddish",
  non: "Old Norse", swe: "Swedish", dan: "Danish", nor: "Norwegian",
  rus: "Russian", pol: "Polish", ces: "Czech", cze: "Czech", slk: "Slovak", ukr: "Ukrainian", bul: "Bulgarian",
  hun: "Hungarian", fin: "Finnish", est: "Estonian", lav: "Latvian", lit: "Lithuanian",
  cym: "Welsh", wel: "Welsh", gle: "Irish", gai: "Irish", sga: "Old Irish", gla: "Scottish Gaelic", gae: "Scottish Gaelic",
  sco: "Scots", cel: "Celtic",
  san: "Sanskrit", fas: "Persian", per: "Persian", hin: "Hindi", urd: "Urdu",
  tur: "Turkish", jpn: "Japanese", zho: "Chinese", chi: "Chinese", kor: "Korean", vie: "Vietnamese", tha: "Thai",
  msa: "Malay", ind: "Indonesian", swa: "Swahili", bnt: "Bantu",
  nav: "Navajo", alg: "Algonquian", tup: "Tupi", nah: "Nahuatl", que: "Quechua", epo: "Esperanto",
  pro: "Old Provençal", oci: "Occitan"
};

function normalizeWord(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function cap(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.json();
}

async function readJsonWithCache(cachePath, url) {
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch (_error) {
      // fall through and refetch
    }
  }
  const payload = await fetchJson(url);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(payload), "utf8");
  return payload;
}

function pickDefinition(wordsetEntry) {
  const meanings = Array.isArray(wordsetEntry?.meanings) ? wordsetEntry.meanings : [];
  for (const meaning of meanings) {
    const def = String(meaning?.def || "").trim();
    if (!def) {
      continue;
    }
    const part = String(meaning?.speech_part || "").trim();
    return part ? `${part} — ${def.slice(0, 200)}` : def.slice(0, 200);
  }
  return "";
}

function pickWordsetSynonyms(wordsetEntry, selfWord) {
  const seen = new Set();
  const meanings = Array.isArray(wordsetEntry?.meanings) ? wordsetEntry.meanings : [];
  meanings.forEach((meaning) => {
    (Array.isArray(meaning?.synonyms) ? meaning.synonyms : []).forEach((synonym) => {
      const key = normalizeWord(synonym);
      if (key && key !== selfWord) {
        seen.add(key);
      }
    });
  });
  return [...seen].slice(0, 12);
}

function uniqueWords(values, selfWord) {
  const seen = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const key = normalizeWord(value);
    if (key && key !== selfWord) {
      seen.add(key);
    }
  });
  return [...seen].slice(0, 12);
}

function cleanWordNetGloss(gloss) {
  return String(gloss || "")
    .replace(/;\s*".*"$/, "")
    .replace(/^"|"$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const SENSE_DIGIT_TO_TYPE = { "1": "n", "2": "v", "3": "a", "4": "r", "5": "s" };
const TYPE_TO_PART = { n: "noun", v: "verb", a: "adjective", s: "adjective", r: "adverb" };

function parseWordNetIndexSense(filePath, bestSenses) {
  if (!fs.existsSync(filePath)) {
    console.log(`  wordnet index.sense: missing (${filePath})`);
    return;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let senseLines = 0;
  raw.split("\n").forEach((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) {
      return;
    }
    const senseKey = fields[0];
    const percentIndex = senseKey.indexOf("%");
    if (percentIndex < 0) {
      return;
    }
    const lemma = senseKey.slice(0, percentIndex);
    if (!/^[a-z]+$/.test(lemma)) {
      return;
    }
    const ssType = SENSE_DIGIT_TO_TYPE[senseKey.charAt(percentIndex + 1)];
    if (!ssType) {
      return;
    }
    const candidate = {
      offset: fields[1],
      ssType,
      senseNumber: Number(fields[2]) || 0,
      tagCount: Number(fields[3]) || 0
    };
    const existing = bestSenses.get(lemma);
    if (
      !existing
      || candidate.tagCount > existing.tagCount
      || (candidate.tagCount === existing.tagCount && candidate.senseNumber < existing.senseNumber)
    ) {
      bestSenses.set(lemma, candidate);
    }
    senseLines += 1;
  });
  console.log(`  wordnet index.sense: ${senseLines} senses, ${bestSenses.size} single-word lemmas`);
}

function parseWordNetGlosses(files, glosses) {
  Object.entries(files).forEach(([ssType, filePath]) => {
    if (!fs.existsSync(filePath)) {
      console.log(`  wordnet ${ssType}: missing (${filePath})`);
      return;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("  ")) {
        return;
      }
      const separatorIndex = trimmed.indexOf(" | ");
      if (separatorIndex < 0) {
        return;
      }
      const fields = trimmed.slice(0, separatorIndex).trim().split(/\s+/);
      const gloss = cleanWordNetGloss(trimmed.slice(separatorIndex + 3));
      if (!gloss || fields.length < 4) {
        return;
      }
      const wordCount = Number(fields[3]);
      const members = [];
      if (Number.isFinite(wordCount) && wordCount > 0) {
        for (let index = 0; index < wordCount; index += 1) {
          const rawMember = String(fields[4 + index * 2] || "");
          if (!rawMember.includes("_") && /^[A-Za-z]+$/.test(rawMember)) {
            members.push(rawMember.toLowerCase());
          }
        }
      }
      glosses.set(`${fields[0]}#${ssType}`, { gloss, members });
    });
  });
}

function buildEtymology(origins, targetWord) {
  if (!Array.isArray(origins) || !origins.length) {
    return "";
  }
  const parts = [];
  const seen = new Set();
  for (const origin of origins.slice(0, 4)) {
    for (const [source, lang] of Object.entries(origin || {})) {
      const sourceText = String(source || "").trim();
      const langCode = String(lang || "").trim();
      if (!sourceText) {
        continue;
      }
      const label = LANG_NAMES[langCode] || langCode || "unknown";
      const sourceNorm = normalizeWord(sourceText);
      if (langCode === "eng" && sourceNorm === targetWord) {
        continue;
      }
      const part = sourceNorm === targetWord ? `from ${label}` : `from ${label} ${sourceText}`;
      if (seen.has(part)) {
        continue;
      }
      seen.add(part);
      parts.push(part);
      if (parts.length >= 3) {
        return parts.join("; ");
      }
    }
  }
  return parts.join("; ");
}

async function main() {
  console.log(`Building ${outputPath}`);

  const wordnetRoot = path.join(rawRoot, "wordnet");
  const bestSenses = new Map();
  parseWordNetIndexSense(path.join(wordnetRoot, "index.sense"), bestSenses);
  const glosses = new Map();
  parseWordNetGlosses({
    n: path.join(wordnetRoot, "data.noun"),
    v: path.join(wordnetRoot, "data.verb"),
    a: path.join(wordnetRoot, "data.adj"),
    s: path.join(wordnetRoot, "data.adj"),
    r: path.join(wordnetRoot, "data.adv")
  }, glosses);

  const wordnetDefs = new Map();
  const wordnetSynonyms = new Map();
  bestSenses.forEach((sense, lemma) => {
    const record = glosses.get(`${sense.offset}#${sense.ssType}`);
    const gloss = typeof record === "string" ? record : record?.gloss;
    if (gloss) {
      wordnetDefs.set(lemma, `${TYPE_TO_PART[sense.ssType]} — ${gloss}`);
    }
    const members = typeof record === "object" && record ? record.members : [];
    const synonyms = uniqueWords(members, lemma);
    if (synonyms.length) {
      wordnetSynonyms.set(lemma, synonyms);
    }
  });
  console.log(`  wordnet: ${wordnetDefs.size} primary definitions resolved`);

  const wordsetDefs = new Map();
  const wordsetSynonyms = new Map();
  let wordsetWordCount = 0;
  let wordsetDefinitionCount = 0;
  for (const letter of WORDSET_LETTERS) {
    const cachePath = path.join(rawRoot, `wordset-${letter}.json`);
    console.log(`  wordset ${letter}…`);
    const payload = await readJsonWithCache(cachePath, `${WORDSET_BASE}/${letter}.json`);
    if (!payload || typeof payload !== "object") {
      continue;
    }
    Object.entries(payload).forEach(([word, entry]) => {
      const key = normalizeWord(word);
      if (!key) {
        return;
      }
      wordsetWordCount += 1;
      const definition = pickDefinition(entry);
      if (definition && !wordsetDefs.has(key)) {
        wordsetDefs.set(key, definition);
        wordsetDefinitionCount += 1;
      }
      if (!wordsetSynonyms.has(key)) {
        const synonyms = pickWordsetSynonyms(entry, key);
        if (synonyms.length) {
          wordsetSynonyms.set(key, synonyms);
        }
      }
    });
  }
  console.log(`  wordset: ${wordsetWordCount} entries, ${wordsetDefinitionCount} definitions`);

  const etymologyCachePath = path.join(rawRoot, "etymologies.json");
  console.log("  etymologies…");
  const etymologyPayload = await readJsonWithCache(etymologyCachePath, ETYMOLOGY_URL);
  const englishEtymologies = etymologyPayload?.eng && typeof etymologyPayload.eng === "object"
    ? etymologyPayload.eng
    : {};
  const etymologies = new Map();
  let etymologyWordCount = 0;
  Object.entries(englishEtymologies).forEach(([word, origins]) => {
    const key = normalizeWord(word);
    if (!key) {
      return;
    }
    const etymology = buildEtymology(origins, key);
    if (!etymology || etymologies.has(key)) {
      return;
    }
    etymologies.set(key, etymology);
    etymologyWordCount += 1;
  });
  console.log(`  etymology: ${etymologyWordCount} words`);

  const entries = [];
  const definedWords = new Set([...wordnetDefs.keys(), ...wordsetDefs.keys()]);
  const knownWords = new Set([...definedWords, ...etymologies.keys()]);
  [...knownWords].sort().forEach((word) => {
    const definition = wordnetDefs.get(word) || wordsetDefs.get(word) || "";
    const etymology = etymologies.get(word) || "";
    const synonyms = uniqueWords([
      ...(wordnetSynonyms.get(word) || []),
      ...(wordsetSynonyms.get(word) || [])
    ], word).filter((synonym) => definedWords.has(synonym));
    if (!definition && !etymology && !synonyms.length) {
      return;
    }
    entries.push([word, definition, etymology, synonyms]);
  });

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceWordCount: entries.length,
      definitionCount: entries.filter((entry) => entry[1]).length,
      etymologyCount: entries.filter((entry) => entry[2]).length,
      synonymCount: entries.filter((entry) => Array.isArray(entry[3]) && entry[3].length).length
    },
    entries
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output), "utf8");
  console.log(`Wrote ${outputPath} (${entries.length} entries)`);
  console.log(`  with definition: ${output.meta.definitionCount}`);
  console.log(`  with etymology: ${output.meta.etymologyCount}`);
  console.log(`  with synonyms: ${output.meta.synonymCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
