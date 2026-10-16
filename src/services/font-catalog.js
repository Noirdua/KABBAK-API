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
