/* dlc-validate.js — strict structural validation for a DLC item folder.
 *
 * Install and publish both refuse an item that fails validation, so a broken
 * deck/reference/text/plugin never reaches the runtime copy or the repo. The
 * validator reads the item in place and never mutates it.
 *
 * Kinds: deck, text, reference, plugin, api, gui, pack.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  REFERENCE_KINDS,
  REFERENCE_KEY_SCHEMES,
  assertSafeName,
  categoryByKind,
  readJsonIfPresent
} = require("./dlc-catalog");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"]);
const PLUGIN_ROLES = new Set(["widget", "section", "skin"]);
const MAX_REPORTED = 12;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function label(value) {
  const text = String(value == null ? "" : value).trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

// Resolve a referenced file inside the item folder, rejecting traversal and
// symlinks that escape it.
function resolveInsideFile(dir, relativePath) {
  const relative = String(relativePath || "").trim().replace(/\\/g, "/");
  if (!relative) return { ok: false, reason: "path is empty" };
  if (path.isAbsolute(relative)) return { ok: false, reason: "path is absolute" };
  const base = path.resolve(dir);
  const target = path.resolve(dir, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return { ok: false, reason: "path escapes the item folder" };
  }
  if (!fs.existsSync(target)) return { ok: false, reason: "file is missing" };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(target);
    if (real !== base && !real.startsWith(base + path.sep)) {
      return { ok: false, reason: "symlink points outside the item folder" };
    }
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    return { ok: false, reason: "path is not a file" };
  }
  return { ok: true, target };
}

function countDocumentVerses(document) {
  let sections = 0;
  let verses = 0;
  const works = Array.isArray(document?.works) ? document.works : [];
  works.forEach((work) => {
    const workSections = Array.isArray(work?.sections) ? work.sections : [];
    sections += workSections.length;
    workSections.forEach((section) => {
      verses += Array.isArray(section?.verses) ? section.verses.length : 0;
    });
  });
  return { sections, verses, works: works.length };
}

function validateReference(dir, errors, warnings) {
  const manifest = readJsonIfPresent(path.join(dir, "reference.json"));
  if (!manifest) {
    errors.push("reference.json is missing or is not valid JSON.");
    return;
  }
  if (!String(manifest.id || "").trim()) errors.push("reference.json is missing an `id`.");
  if (!String(manifest.title || "").trim()) errors.push("reference.json is missing a `title`.");
  if (manifest.kind != null && !REFERENCE_KINDS.has(String(manifest.kind).trim())) {
    errors.push(`reference.json kind '${label(manifest.kind)}' is invalid (use ${[...REFERENCE_KINDS].join(", ")}).`);
  }
  if (manifest.keyScheme != null && !REFERENCE_KEY_SCHEMES.has(String(manifest.keyScheme).trim())) {
    errors.push(`reference.json keyScheme '${label(manifest.keyScheme)}' is invalid (use ${[...REFERENCE_KEY_SCHEMES].join(", ")}).`);
  }
  if (manifest.fieldConfig != null && !isPlainObject(manifest.fieldConfig)) {
    errors.push("reference.json fieldConfig must be an object.");
  }
  if (manifest.listOrder != null && !Array.isArray(manifest.listOrder)) {
    errors.push("reference.json listOrder must be an array.");
  }
  const entriesFile = String(manifest.entriesFile || "entries.json").trim() || "entries.json";
  const resolved = resolveInsideFile(dir, entriesFile);
  if (!resolved.ok) {
    errors.push(`Entries file '${entriesFile}': ${resolved.reason}.`);
    return;
  }
  const raw = readJsonIfPresent(resolved.target);
  if (raw == null) {
    errors.push(`Entries file '${entriesFile}' is not valid JSON.`);
    return;
  }
  const entries = Array.isArray(raw)
    ? raw.reduce((acc, item, index) => {
      acc[`#${index}`] = item;
      return acc;
    }, {})
    : (isPlainObject(raw) && isPlainObject(raw.entries) ? raw.entries : raw);
  if (!isPlainObject(entries)) {
    errors.push(`Entries file '${entriesFile}' must be a JSON object of entries.`);
    return;
  }
  const keys = Object.keys(entries);
  if (!keys.length) {
    errors.push("Reference has no entries.");
    return;
  }
  let invalid = 0;
  let contentless = 0;
  keys.forEach((key) => {
    const value = entries[key];
    if (typeof value === "string") return;
    if (!isPlainObject(value)) {
      invalid += 1;
      return;
    }
    const hasContent = ["title", "keyword", "word", "term", "body", "summary", "definition", "gloss", "senses"]
      .some((field) => value[field] != null && value[field] !== "");
    if (!hasContent) contentless += 1;
  });
  if (invalid) errors.push(`${invalid} reference entr${invalid === 1 ? "y is" : "ies are"} not an object or string.`);
  if (contentless) warnings.push(`${contentless} reference entr${contentless === 1 ? "y has" : "ies have"} no title/keyword/body.`);
}

function validateText(dir, errors, warnings) {
  const manifest = readJsonIfPresent(path.join(dir, "metadata.json"))
    || readJsonIfPresent(path.join(dir, "text.json"));
  if (!manifest) {
    errors.push("metadata.json (or text.json) is missing or is not valid JSON.");
    return;
  }
  if (!String(manifest.id || "").trim()) errors.push("Text metadata is missing an `id`.");
  if (!String(manifest.title || "").trim()) errors.push("Text metadata is missing a `title`.");
  const inputPath = String(manifest?.input?.path || "").trim();
  if (!inputPath) {
    errors.push("Text metadata is missing input.path (the structured text file).");
    return;
  }
  const resolved = resolveInsideFile(dir, inputPath);
  if (!resolved.ok) {
    errors.push(`Text source '${inputPath}': ${resolved.reason}.`);
    return;
  }
  // Plain-text formats (auto-sectioned, numbered sayings, etc.) are imported
  // from .txt/.csv; only JSON formats carry a structured document.
  const isJsonSource = path.extname(resolved.target).toLowerCase() === ".json";
  if (!isJsonSource) {
    let size = 0;
    try {
      size = fs.statSync(resolved.target).size;
    } catch (_error) {
      size = 0;
    }
    if (!size) errors.push(`Text source '${inputPath}' is empty.`);
    return;
  }
  const document = readJsonIfPresent(resolved.target);
  if (!document || typeof document !== "object") {
    errors.push(`Text source '${inputPath}' is not valid JSON.`);
    return;
  }
  const { sections, verses } = countDocumentVerses(document);
  const hasStructuredContent = sections > 0
    || Array.isArray(document.works)
    || Array.isArray(document.books)
    || Array.isArray(document.sections)
    || Array.isArray(document.entries)
    || Object.keys(document).length > 0;
  const format = String(manifest?.input?.format || "").trim().toLowerCase();
  if (format === "structured-json" && !sections) {
    errors.push("Text source has no sections.");
  } else if (!hasStructuredContent) {
    errors.push("Text source JSON is empty.");
  }
  if (sections && !manifest.sectionLabel) warnings.push("Text metadata has no sectionLabel (the reader will use a default).");
}

function collectDeckFiles(cards) {
  const refs = [];
  if (!isPlainObject(cards)) return refs;
  Object.values(cards).forEach((value) => {
    if (typeof value === "string") {
      refs.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string") refs.push(item);
      });
    }
  });
  return refs;
}

function countDeckImages(dir) {
  let count = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.forEach((entry) => {
      if (entry.isDirectory()) {
        if (entry.name === "thumbs") return;
        walk(path.join(current, entry.name));
        return;
      }
      if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) count += 1;
    });
  };
  walk(dir);
  return count;
}

function validateDeck(dir, errors, warnings) {
  const manifest = readJsonIfPresent(path.join(dir, "deck.json"));
  if (!manifest) {
    errors.push("deck.json is missing or is not valid JSON.");
    return;
  }
  if (!String(manifest.id || "").trim()) errors.push("deck.json is missing an `id`.");
  const deckTitle = String(manifest.name || manifest.title || manifest.label || "").trim();
  if (!deckTitle) errors.push("deck.json is missing a `name`/`label`.");

  const majors = isPlainObject(manifest.majors) ? manifest.majors : {};
  const minors = isPlainObject(manifest.minors) ? manifest.minors : {};
  const majorsMap = isPlainObject(majors.cards) ? majors.cards : null;
  const minorsMap = isPlainObject(minors.cards) ? minors.cards : null;
  if (majors.cards != null && !majorsMap) errors.push("deck.json majors.cards must be an object.");
  if (minors.cards != null && !minorsMap) errors.push("deck.json minors.cards must be an object.");

  // Deck images can be mapped explicitly (cards maps) or derived from a template.
  const templates = [];
  [majors, minors, minors.courts, minors.smalls].forEach((part) => {
    if (isPlainObject(part) && typeof part.template === "string" && part.template.trim()) {
      templates.push(part.template.trim());
    }
  });
  const majorsMapped = Boolean(majorsMap && Object.keys(majorsMap).length) || templates.length > 0 || Boolean(majors.mode);
  const minorsMapped = Boolean(minorsMap && Object.keys(minorsMap).length) || Boolean(minors.mode);
  if (!majorsMapped && !minorsMapped) {
    errors.push("deck.json maps no cards (no majors/minors cards or template).");
  }

  const referenced = [
    ...collectDeckFiles(majorsMap),
    ...collectDeckFiles(minorsMap),
    ...(manifest.cardBack ? (Array.isArray(manifest.cardBack) ? manifest.cardBack : [manifest.cardBack]) : [])
  ];
  let missing = 0;
  let badExtension = 0;
  const seen = new Set();
  referenced.forEach((file) => {
    const name = String(file || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const resolved = resolveInsideFile(dir, name);
    if (!resolved.ok) {
      missing += 1;
      if (missing <= 3) errors.push(`deck.json references '${name}': ${resolved.reason}.`);
      return;
    }
    if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      badExtension += 1;
    }
  });
  if (missing > 3) errors.push(`…and ${missing - 3} more deck.json references are missing.`);
  if (badExtension) warnings.push(`${badExtension} deck image(s) use a non-standard extension.`);

  templates.forEach((template) => {
    if (!/\{[a-zA-Z]+\}/.test(template)) {
      warnings.push(`Deck template '${template}' has no {placeholder}.`);
    }
  });

  const images = countDeckImages(dir);
  if (!images) {
    errors.push("Deck folder contains no card images.");
  } else if (!referenced.length && !templates.length && images < 78) {
    warnings.push(`Deck has ${images} image(s) but no mapping; it may install incomplete.`);
  }

  // Only flag incompleteness for fully explicit maps; template modes expand
  // to the remaining cards at load time.
  const explicitMapped = (majorsMap ? Object.keys(majorsMap).length : 0)
    + (minorsMap ? Object.keys(minorsMap).length : 0);
  if (!templates.length && explicitMapped && explicitMapped < 78) {
    warnings.push(`Deck maps ${explicitMapped}/78 cards (incomplete decks install but stay partial).`);
  }
}

function validatePlugin(dir, kind, errors, warnings) {
  const manifest = readJsonIfPresent(path.join(dir, "manifest.json"));
  if (!manifest) {
    errors.push("manifest.json is missing or is not valid JSON.");
    return;
  }
  if (!String(manifest.id || "").trim()) errors.push("manifest.json is missing an `id`.");
  if (!String(manifest.name || manifest.title || "").trim()) errors.push("manifest.json is missing a `name`.");
  if (manifest.version != null && !String(manifest.version).trim()) {
    errors.push("manifest.json version is empty.");
  }
  if (manifest.role != null && !PLUGIN_ROLES.has(String(manifest.role).trim())) {
    errors.push(`manifest.json role '${label(manifest.role)}' is invalid (use widget, section, skin).`);
  }
  const entry = String(manifest.entry || "").trim();
  if (!entry) {
    errors.push("manifest.json is missing an `entry` script.");
  } else {
    const resolved = resolveInsideFile(dir, entry);
    if (!resolved.ok) {
      errors.push(`Entry script '${entry}': ${resolved.reason}.`);
    } else {
      const source = fs.readFileSync(resolved.target, "utf8");
      try {
        // Parse-only check: catches syntax errors without executing plugin code.
        new vm.Script(source, { filename: entry });
      } catch (error) {
        errors.push(`Entry script '${entry}' has a syntax error: ${label(error.message)}`);
      }
    }
  }
  const css = String(manifest.css || "").trim();
  if (css) {
    const resolvedCss = resolveInsideFile(dir, css);
    if (!resolvedCss.ok) errors.push(`Stylesheet '${css}': ${resolvedCss.reason}.`);
  }
  if (kind === "api" || manifest.section) {
    if (!isPlainObject(manifest.section)) {
      errors.push("Plugin declares a section but manifest.section is not an object.");
    } else {
      if (!String(manifest.section.id || "").trim()) errors.push("manifest.section is missing an `id`.");
      if (!String(manifest.section.label || "").trim()) warnings.push("manifest.section has no label.");
    }
  }
}

function validatePack(dir, errors) {
  const manifest = readJsonIfPresent(path.join(dir, "pack.json"));
  if (!manifest) {
    errors.push("pack.json is missing or is not valid JSON.");
    return;
  }
  const items = manifest.items;
  if (!Array.isArray(items) || !items.length) {
    errors.push("pack.json items must be a non-empty array.");
    return;
  }
  let bad = 0;
  items.forEach((item, index) => {
    const kind = String(item?.kind || item?.type || "").trim();
    const name = String(item?.name || "").trim();
    if (!kind || !categoryByKind(kind) || !name) {
      bad += 1;
      if (bad <= 3) errors.push(`pack.json item #${index + 1} needs a valid kind and name.`);
    }
  });
  if (bad > 3) errors.push(`…and ${bad - 3} more pack items are invalid.`);
}

function validateItemDir(kind, name, dir) {
  const errors = [];
  const warnings = [];
  let safeName = String(name || "").trim();
  try {
    safeName = assertSafeName(safeName);
  } catch (error) {
    errors.push(error.message);
    return { ok: false, kind, name: safeName, dir, errors, warnings };
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    errors.push(`'${safeName}' is not a folder in the DLC checkout.`);
    return { ok: false, kind, name: safeName, dir, errors, warnings };
  }
  const normalizedKind = kind === "gui" ? "plugin" : String(kind || "").trim();

  if (normalizedKind === "reference") validateReference(dir, errors, warnings);
  else if (normalizedKind === "text") validateText(dir, errors, warnings);
  else if (normalizedKind === "deck") validateDeck(dir, errors, warnings);
  else if (["plugin", "api"].includes(normalizedKind)) validatePlugin(dir, normalizedKind, errors, warnings);
  else if (normalizedKind === "pack") validatePack(dir, errors);
  else errors.push(`Unknown DLC kind '${label(kind)}'.`);

  return {
    ok: errors.length === 0,
    kind: normalizedKind,
    name: safeName,
    dir,
    errors,
    warnings
  };
}

function formatValidation(result) {
  const head = `'${result.name}' (${result.kind}) failed validation`;
  const errors = (result.errors || []).slice(0, MAX_REPORTED);
  const extra = (result.errors || []).length - errors.length;
  const lines = errors.map((message) => `• ${message}`);
  if (extra > 0) lines.push(`• …and ${extra} more issue(s).`);
  return `${head}: ${lines.join(" ")}`.trim();
}

function assertItemValid(kind, name, dir) {
  const result = validateItemDir(kind, name, dir);
  if (!result.ok) {
    const error = new Error(formatValidation(result));
    error.validation = result;
    throw error;
  }
  return result;
}

module.exports = {
  assertItemValid,
  formatValidation,
  validateItemDir
};
