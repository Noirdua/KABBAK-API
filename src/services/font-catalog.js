"use strict";

const fs = require("fs");
const path = require("path");

const { fontsRoot } = require("../config/paths");
const { apiBasePath } = require("../config/service");

const FONT_EXTENSIONS = Object.freeze({
  ".ttf": Object.freeze({ format: "truetype", contentType: "font/ttf" }),
  ".otf": Object.freeze({ format: "opentype", contentType: "font/otf" }),
  ".woff": Object.freeze({ format: "woff", contentType: "font/woff" }),
  ".woff2": Object.freeze({ format: "woff2", contentType: "font/woff2" }),
  ".eot": Object.freeze({ format: "embedded-opentype", contentType: "application/vnd.ms-fontobject" })
});

const STACKS = new Set(["main", "display", "arabic", "enochian", "cjk"]);
const ROLES = new Set(["unicode", "symbol"]);

const CONTENT_TYPE_BY_EXT = Object.freeze(Object.fromEntries(
  Object.entries(FONT_EXTENSIONS).map(([extension, info]) => [extension, info.contentType])
));

function cssName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || /[^\w \-]/.test(name)) {
    return "";
  }
  return name;
}

function cssUnicodeRange(value) {
  const range = String(value || "").trim();
  if (!range || range.length > 240) {
    return "";
  }
  if (!/^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f?]{1,6})?(?:\s*,\s*U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f?]{1,6})?)*$/.test(range)) {
    return "";
  }
  return range;
}

function tokenList(values, pattern, limit = 8) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const tokens = [];
  for (const value of values) {
    const token = String(value || "").trim().toLowerCase();
    if (!pattern.test(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= limit) {
      break;
    }
  }
  return tokens;
}

function nameList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const names = [];
  for (const value of values) {
    const name = cssName(value);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeSymbols(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const groups = {};
  for (const [group, table] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,32}$/i.test(group) || !table || typeof table !== "object" || Array.isArray(table)) {
      continue;
    }
    const normalized = {};
    for (const [key, glyph] of Object.entries(table)) {
      const safeKey = String(key);
      const character = String(glyph || "");
      if (!safeKey || safeKey.length > 16 || /[\u0000-\u001f]/.test(safeKey)) {
        continue;
      }
      if (!character || character.length > 4 || /[\u0000-\u001f]/.test(character)) {
        continue;
      }
      normalized[safeKey] = character;
    }
    if (Object.keys(normalized).length) {
      groups[group] = normalized;
    }
  }
  return Object.keys(groups).length ? groups : null;
}

function resolveFontFile(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  const extension = path.extname(normalized).toLowerCase();
  const type = FONT_EXTENSIONS[extension];
  if (!type) {
    return null;
  }
  const absolute = path.resolve(fontsRoot, normalized);
  const root = path.resolve(fontsRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return null;
  }
  if (!stats.isFile()) {
    return null;
  }
  return {
    file: normalized,
    encoded: normalized.split("/").map((part) => encodeURIComponent(part)).join("/"),
    weight: 400,
    style: "normal",
    format: type.format,
    mtimeMs: stats.mtimeMs
  };
}

const SCRIPT_COVERAGE = Object.freeze([
  { script: "hebrew", stacks: ["main", "display"], aliases: ["Noto Sans Hebrew", "Noto Rashi Hebrew"], ranges: [[0x0590, 0x05FF], [0xFB1D, 0xFB4F]] },
  { script: "arabic", stacks: ["arabic"], aliases: ["Amiri", "Noto Naskh Arabic"], ranges: [[0x0600, 0x06FF]] },
  { script: "greek", stacks: ["main", "display"], aliases: ["Noto Serif"], ranges: [[0x0370, 0x03FF], [0x1F00, 0x1FFF]] },
  { script: "cjk", stacks: ["cjk"], aliases: [], ranges: [[0x3400, 0x4DBF], [0x4E00, 0x9FFF]] }
]);

const GREEK_SYMBOL_UPPER = Object.freeze({
  alpha: "A",
  beta: "B",
  gamma: "G",
  delta: "D",
  epsilon: "E",
  zeta: "Z",
  eta: "H",
  theta: "Q",
  iota: "I",
  kappa: "K",
  lambda: "L",
  mu: "M",
  nu: "N",
  xi: "X",
  omicron: "O",
  pi: "P",
  rho: "R",
  sigma: "S",
  tau: "T",
  upsilon: "U",
  phi: "F",
  chi: "C",
  psi: "Y",
  omega: "W"
});

const GREEK_SYMBOL_LOWER = Object.freeze({
  alpha: "a",
  beta: "b",
  gamma: "g",
  delta: "d",
  epsilon: "e",
  zeta: "z",
  eta: "h",
  theta: "q",
  iota: "i",
  kappa: "k",
  lambda: "l",
  mu: "m",
  nu: "n",
  xi: "x",
  omicron: "o",
  pi: "p",
  rho: "r",
  sigma: "s",
  "sigma-final": "V",
  tau: "t",
  upsilon: "u",
  phi: "f",
  chi: "c",
  psi: "y",
  omega: "w"
});

function readU16(buf, offset) {
  return buf.readUInt16BE(offset);
}

function readU32(buf, offset) {
  return buf.readUInt32BE(offset);
}

function decodeUtf16Be(buf, start, length) {
  let out = "";
  for (let offset = start; offset + 1 < start + length; offset += 2) {
    const code = buf[offset] << 8 | buf[offset + 1];
    if (code) out += String.fromCharCode(code);
  }
  return out;
}

function readNameTable(buf, offset) {
  const count = readU16(buf, offset + 2);
  const storage = offset + readU16(buf, offset + 4);
  const names = {};
  for (let index = 0; index < count; index += 1) {
    const record = offset + 6 + index * 12;
    const platform = readU16(buf, record);
    const language = readU16(buf, record + 4);
    const id = readU16(buf, record + 6);
    const length = readU16(buf, record + 8);
    const stringOffset = readU16(buf, record + 10);
    const start = storage + stringOffset;
    if (start + length > buf.length) continue;
    const value = platform === 3 || platform === 0
      ? decodeUtf16Be(buf, start, length)
      : buf.toString("latin1", start, start + length).replace(/\u0000/g, "");
    if (!names[id] || (platform === 3 && language === 0x409)) names[id] = value;
  }
  return names[16] || names[1] || "";
}

function readCmapRanges(buf, offset) {
  const ranges = [];
  const subtables = readU16(buf, offset + 2);
  for (let index = 0; index < subtables; index += 1) {
    const record = offset + 4 + index * 8;
    const platform = readU16(buf, record);
    const table = offset + readU32(buf, record + 4);
    if (table + 4 > buf.length) continue;
    const format = readU16(buf, table);
    if (format === 4 && platform === 3) {
      const segCount = readU16(buf, table + 6) / 2;
      const endBase = table + 14;
      const startBase = endBase + segCount * 2 + 2;
      for (let segment = 0; segment < segCount; segment += 1) {
        const end = readU16(buf, endBase + segment * 2);
        const start = readU16(buf, startBase + segment * 2);
        if (start !== 0xFFFF) ranges.push([start, end]);
      }
    } else if (format === 12) {
      const groups = readU32(buf, table + 12);
      for (let group = 0; group < groups; group += 1) {
        const groupOffset = table + 16 + group * 12;
        ranges.push([readU32(buf, groupOffset), readU32(buf, groupOffset + 4)]);
      }
    }
  }
  return ranges;
}

function readFontFace(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length < 12) return null;
  const tableCount = readU16(buf, 4);
  const tables = {};
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (record + 12 > buf.length) return null;
    tables[buf.toString("latin1", record, record + 4)] = readU32(buf, record + 8);
  }
  if (!Number.isInteger(tables.name) || !Number.isInteger(tables.cmap)) return null;
  return {
    family: readNameTable(buf, tables.name),
    ranges: readCmapRanges(buf, tables.cmap)
  };
}

function formatUnicodeRange(ranges) {
  return ranges
    .map(([start, end]) => start === end
      ? `U+${start.toString(16).toUpperCase().padStart(4, "0")}`
      : `U+${start.toString(16).toUpperCase().padStart(4, "0")}-${end.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(", ");
}

function hintFromPath(relativePath, family) {
  const base = path.basename(relativePath, path.extname(relativePath)).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const familyKey = String(family || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hints = ["greek", "hebrew", "arabic", "enochian", "cjk", "chinese", "han"];
  const hint = hints.find((name) => base === name || familyKey === name) || "";
  return hint === "chinese" || hint === "han" ? "cjk" : hint;
}

function countCodes(ranges, codes) {
  return codes.filter((code) => ranges.some(([start, end]) => code >= start && code <= end)).length;
}

function coveredCount(ranges, start, end) {
  return ranges.reduce((total, [from, to]) => {
    const low = Math.max(from, start);
    const high = Math.min(to, end);
    return high >= low ? total + (high - low + 1) : total;
  }, 0);
}

function scriptIsComplete(script, ranges) {
  if (script === "greek") {
    const upper = [];
    const lower = [];
    for (let code = 0x0391; code <= 0x03A9; code += 1) if (code !== 0x03A2) upper.push(code);
    for (let code = 0x03B1; code <= 0x03C9; code += 1) lower.push(code);
    return countCodes(ranges, upper) >= 18 || countCodes(ranges, lower) >= 18;
  }
  if (script === "hebrew") return coveredCount(ranges, 0x05D0, 0x05EA) >= 20;
  if (script === "arabic") return coveredCount(ranges, 0x0621, 0x064A) >= 20;
  if (script === "cjk") return coveredCount(ranges, 0x4E00, 0x9FFF) >= 100;
  return false;
}

function clipRanges(ranges, blocks) {
  const clipped = [];
  for (const [from, to] of ranges) {
    for (const [start, end] of blocks) {
      const low = Math.max(from, start);
      const high = Math.min(to, end);
      if (high >= low) clipped.push([low, high]);
    }
  }
  clipped.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const range of clipped) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range.slice());
  }
  return merged;
}

function symbolMapFor(hint) {
  if (hint === "greek") {
    return { letter: { ...GREEK_SYMBOL_UPPER }, lower: { ...GREEK_SYMBOL_LOWER } };
  }
  if (hint === "enochian") {
    const letter = {};
    for (const character of "ABCDEFGHILMNOPQRSTVXZ") letter[character] = character;
    return { letter };
  }
  return null;
}

function inferDroppedFamily(relativePath) {
  const resolved = resolveFontFile(relativePath);
  if (!resolved) return null;
  const face = readFontFace(path.join(fontsRoot, relativePath));
  const familyName = cssName(face?.family) || cssName(path.basename(relativePath, path.extname(relativePath)));
  if (!familyName) return null;
  const ranges = face?.ranges || [];
  const hint = hintFromPath(relativePath, familyName);
  const covered = SCRIPT_COVERAGE.filter((script) => scriptIsComplete(script.script, ranges));
  if (covered.length) {
    const primary = covered[0];
    const used = clipRanges(ranges, covered.flatMap((script) => script.ranges));
    const unicodeRange = formatUnicodeRange(used);
    if (!cssUnicodeRange(unicodeRange)) return null;
    return {
      id: "",
      family: familyName,
      role: "unicode",
      scripts: covered.map((script) => script.script),
      stacks: primary.stacks,
      unicodeRange,
      aliases: primary.aliases,
      files: [{ file: relativePath, weight: 400, style: "normal" }]
    };
  }
  if (hint) {
    return {
      id: "",
      family: familyName,
      role: "symbol",
      scripts: [hint],
      files: [{ file: relativePath, weight: 400, style: "normal" }],
      symbols: symbolMapFor(hint)
    };
  }
  return null;
}

function walkFontFiles(dir, prefix = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...walkFontFiles(path.join(dir, entry.name), relative));
      continue;
    }
    if (FONT_EXTENSIONS[path.extname(entry.name).toLowerCase()]) found.push(relative.replace(/\\/g, "/"));
  }
  return found;
}

function referencedFontFiles(parsed) {
  const refs = new Set();
  for (const entry of Array.isArray(parsed?.families) ? parsed.families : []) {
    for (const file of Array.isArray(entry?.files) ? entry.files : []) {
      const relative = String(file?.file || file || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
      if (relative) refs.add(relative);
    }
  }
  return refs;
}

function slugId(relativePath, seen) {
  const base = path.basename(relativePath, path.extname(relativePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "font";
  let id = base.slice(0, 40);
  let suffix = 2;
  while (seen.has(id) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
    id = `${base.slice(0, 36)}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function normalizeFamily(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const id = String(entry.id || "").trim().toLowerCase();
  const family = cssName(entry.family);
  const role = String(entry.role || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || !family || !ROLES.has(role)) {
    return null;
  }
  const files = [];
  for (const fileEntry of Array.isArray(entry.files) ? entry.files : []) {
    const resolved = resolveFontFile(fileEntry?.file || fileEntry);
    if (!resolved) {
      continue;
    }
    const weight = Number(fileEntry?.weight);
    const style = String(fileEntry?.style || "normal").trim().toLowerCase();
    resolved.weight = Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? weight : 400;
    resolved.style = style === "italic" ? "italic" : "normal";
    files.push(resolved);
  }
  if (!files.length) {
    return null;
  }
  const scripts = tokenList(entry.scripts, /^[a-z][a-z0-9-]{0,32}$/);
  const stacks = tokenList(entry.stacks, /^(?:main|display|arabic|enochian|cjk)$/).filter((stack) => STACKS.has(stack));
  const unicodeRange = role === "unicode" ? cssUnicodeRange(entry.unicodeRange) : "";
  const aliases = role === "unicode" ? nameList(entry.aliases) : [];
  const symbols = role === "symbol" ? normalizeSymbols(entry.symbols) : null;
  return {
    id,
    family,
    role,
    scripts,
    stacks: role === "unicode" ? (stacks.length ? stacks : ["main", "display"]) : [],
    unicodeRange,
    aliases,
    files,
    symbols
  };
}

function loadFontCatalog() {
  const manifestPath = path.join(fontsRoot, "fonts.json");
  let parsed = null;
  let revision = 0;
  try {
    const stats = fs.statSync(manifestPath);
    revision = stats.mtimeMs;
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    parsed = null;
  }
  const families = [];
  const seen = new Set();
  for (const entry of Array.isArray(parsed?.families) ? parsed.families : []) {
    const family = normalizeFamily(entry);
    if (!family || seen.has(family.id)) {
      continue;
    }
    seen.add(family.id);
    for (const file of family.files) {
      if (file.mtimeMs > revision) {
        revision = file.mtimeMs;
      }
    }
    families.push(family);
  }
  const referenced = referencedFontFiles(parsed);
  for (const relativePath of walkFontFiles(fontsRoot)) {
    if (referenced.has(relativePath.toLowerCase())) continue;
    const inferred = inferDroppedFamily(relativePath);
    if (!inferred) continue;
    inferred.id = slugId(relativePath, seen);
    const family = normalizeFamily(inferred);
    if (!family || seen.has(family.id)) continue;
    seen.add(family.id);
    for (const file of family.files) {
      if (file.mtimeMs > revision) revision = file.mtimeMs;
    }
    families.push(family);
  }
  const revisionId = String(Math.trunc(revision));
  return {
    revision: revisionId,
    families: families.map((family) => {
      const payload = {
        id: family.id,
        family: family.family,
        role: family.role,
        scripts: family.scripts,
        files: family.files.map((file) => ({
          file: file.file,
          url: `${apiBasePath}/assets/fonts/${file.encoded}?v=${revisionId}`,
          weight: file.weight,
          style: file.style,
          format: file.format
        }))
      };
      if (family.stacks.length) {
        payload.stacks = family.stacks;
      }
      if (family.unicodeRange) {
        payload.unicodeRange = family.unicodeRange;
      }
      if (family.aliases.length) {
        payload.aliases = family.aliases;
      }
      if (family.symbols) {
        payload.symbols = family.symbols;
      }
      return payload;
    })
  };
}

function renderFontCss(catalog = loadFontCatalog()) {
  const blocks = [];
  for (const family of catalog.families) {
    const names = family.role === "symbol"
      ? [family.family]
      : [family.family, ...(family.aliases || [])];
    for (const file of family.files) {
      for (const name of names) {
        const lines = [
          "@font-face {",
          `  font-family: "${name}";`,
          `  src: url("assets/fonts/${file.url.split("/assets/fonts/")[1]}") format("${file.format}");`,
          `  font-weight: ${file.weight};`,
          `  font-style: ${file.style};`,
          `  font-display: ${family.role === "symbol" ? "block" : "swap"};`
        ];
        if (family.unicodeRange) {
          lines.push(`  unicode-range: ${family.unicodeRange};`);
        }
        lines.push("}");
        blocks.push(lines.join("\n"));
      }
    }
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

module.exports = {
  CONTENT_TYPE_BY_EXT,
  fontsRoot,
  loadFontCatalog,
  renderFontCss
};
