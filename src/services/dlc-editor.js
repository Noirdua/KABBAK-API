/* dlc-editor.js — inspect and edit DLC item files in place, and delete items.
 *
 * Editing/delete is only allowed for content that is not live (uninstalled):
 * installed decks/texts/references/plugins are refused so the runtime copy is
 * never edited behind the migration's back. Only text-like files are editable;
 * binary assets are listed but read-only.
 */
const fs = require("node:fs");
const path = require("node:path");

const { dlcRoot } = require("../config/paths");
const dlcSources = require("./dlc-sources");
const {
  assertSafeName,
  categoryByKind,
  readJsonIfPresent,
  resolveStatus
} = require("./dlc-catalog");

const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRS = new Set([".git", "node_modules", "user-data", "media", "thumbs"]);

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const ASSET_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json"
};

const TEXT_EXTENSIONS = new Set([
  ".json", ".jsonl", ".js", ".mjs", ".cjs", ".css", ".html", ".htm", ".txt", ".md",
  ".csv", ".tsv", ".xml", ".yml", ".yaml", ".svg", ".ini", ".cfg", ".toml"
]);

function itemSubdir(kind, safeName) {
  if (kind === "api") return `apis/${safeName}`;
  const category = categoryByKind(kind);
  if (!category) throw new Error(`Unknown DLC kind '${kind}'.`);
  return `${category.dir}/${safeName}`;
}

function orderedRoots(sourceId) {
  const roots = [];
  const explicit = String(sourceId || "").trim();
  if (explicit) {
    const source = dlcSources.getSource(explicit);
    if (source) roots.push(dlcSources.getSourceRoot(source));
  }
  roots.push(dlcRoot);
  for (const { root } of dlcSources.listEnabledSourceRoots()) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function resolveEditableDir(kind, name, sourceId) {
  const safeName = assertSafeName(name);
  const subdir = itemSubdir(kind, safeName);
  for (const root of orderedRoots(sourceId)) {
    const candidate = path.join(root, subdir);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { dir: candidate, root, subdir };
    }
  }
  throw new Error(`'${safeName}' is not present in a local DLC checkout. Sync or create it first.`);
}

function assertNotLive(kind, name, id) {
  const status = resolveStatus(kind, name, id);
  if (status === "installed") {
    throw new Error("This item is installed/live. Uninstall it before editing or deleting.");
  }
}

function isTextFile(fileName) {
  return TEXT_EXTENSIONS.has(path.extname(String(fileName || "")).toLowerCase());
}

function walkFiles(dir, base = "", out = []) {
  if (out.length >= MAX_FILES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return out;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (out.length >= MAX_FILES) break;
    if (entry.name.startsWith(".") && entry.name !== ".gitkeep") continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), `${base}${entry.name}/`, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = `${base}${entry.name}`;
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, entry.name)).size;
    } catch (_error) {
      size = 0;
    }
    out.push({
      path: relative,
      size,
      editable: isTextFile(entry.name) && size <= MAX_FILE_BYTES
    });
  }
  return out;
}

function listItemFiles(kind, name, sourceId, id) {
  assertNotLive(kind, name, id);
  const { dir, root, subdir } = resolveEditableDir(kind, name, sourceId);
  const files = walkFiles(dir);
  return {
    kind,
    name: assertSafeName(name),
    root: path.relative(process.cwd(), root).replace(/\\/g, "/"),
    dir: subdir,
    files,
    truncated: files.length >= MAX_FILES
  };
}

function resolveFileTarget(kind, name, filePath, sourceId) {
  const { dir, subdir } = resolveEditableDir(kind, name, sourceId);
  const relative = String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid file path.");
  }
  const target = path.resolve(dir, relative);
  const base = path.resolve(dir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("File path escapes the item folder.");
  }
  return { dir, subdir, relative, target };
}

function readItemFile(kind, name, filePath, sourceId, id) {
  assertNotLive(kind, name, id);
  const { relative, target } = resolveFileTarget(kind, name, filePath, sourceId);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`File '${relative}' was not found.`);
  }
  const size = fs.statSync(target).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(`'${relative}' is too large to edit (${size} bytes).`);
  }
  if (!isTextFile(target)) {
    return { path: relative, binary: true, editable: false, size };
  }
  return {
    path: relative,
    content: fs.readFileSync(target, "utf8"),
    binary: false,
    editable: true,
    size
  };
}

function writeItemFile(kind, name, filePath, content, sourceId, id) {
  assertNotLive(kind, name, id);
  const { relative, target } = resolveFileTarget(kind, name, filePath, sourceId);
  if (!isTextFile(target)) {
    throw new Error(`Only text-like files can be edited ('${relative}').`);
  }
  const text = String(content == null ? "" : content);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error(`Content is too large to save (${Buffer.byteLength(text, "utf8")} bytes).`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  return { path: relative, size: Buffer.byteLength(text, "utf8") };
}

function structuredDocumentToText(document) {
  const works = Array.isArray(document?.works) ? document.works : [];
  const lines = [];
  works.forEach((work) => {
    if (work?.title && works.length > 1) lines.push(String(work.title).trim());
    const sections = Array.isArray(work?.sections) ? work.sections : [];
    sections.forEach((section) => {
      if (section?.title) {
        lines.push("", String(section.title).trim(), "");
      }
      const verses = Array.isArray(section?.verses) ? section.verses : [];
      verses.forEach((verse) => {
        lines.push(String(verse?.text || "").trim());
      });
    });
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function readItemAsset(kind, name, filePath, sourceId, id) {
  assertNotLive(kind, name, id);
  const { relative, target } = resolveFileTarget(kind, name, filePath, sourceId);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`File '${relative}' was not found.`);
  }
  const size = fs.statSync(target).size;
  if (size > MAX_ASSET_BYTES) {
    throw new Error(`'${relative}' is too large to send (${size} bytes).`);
  }
  return {
    path: relative,
    buffer: fs.readFileSync(target),
    contentType: ASSET_CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream"
  };
}

function getItemDraft(kind, name, sourceId, id) {
  assertNotLive(kind, name, id);
  const { dir, subdir } = resolveEditableDir(kind, name, sourceId);

  if (kind === "reference") {
    const manifest = readJsonIfPresent(path.join(dir, "reference.json")) || {};
    const entriesFile = String(manifest.entriesFile || "entries.json").trim() || "entries.json";
    const entries = readJsonIfPresent(path.join(dir, path.basename(entriesFile))) || {};
    return { kind, name: assertSafeName(name), dir: subdir, reference: { manifest, entries } };
  }

  if (kind === "text") {
    const manifest = readJsonIfPresent(path.join(dir, "metadata.json")) || {};
    let sourceText = "";
    const sourceTxtPath = path.join(dir, "source.txt");
    if (fs.existsSync(sourceTxtPath)) {
      sourceText = fs.readFileSync(sourceTxtPath, "utf8");
    } else {
      const inputPath = String(manifest?.input?.path || "").trim();
      const document = inputPath ? readJsonIfPresent(path.join(dir, path.basename(inputPath))) : null;
      sourceText = structuredDocumentToText(document);
    }
    return { kind, name: assertSafeName(name), dir: subdir, text: { manifest, sourceText } };
  }

  if (kind === "deck") {
    const deck = readJsonIfPresent(path.join(dir, "deck.json")) || {};
    return { kind, name: assertSafeName(name), dir: subdir, deck };
  }

  const manifest = readJsonIfPresent(path.join(dir, "manifest.json")) || {};
  return { kind, name: assertSafeName(name), dir: subdir, plugin: { manifest } };
}

function deleteItem(kind, name, sourceId, id) {
  assertNotLive(kind, name, id);
  const { dir, subdir } = resolveEditableDir(kind, name, sourceId);
  fs.rmSync(dir, { recursive: true, force: true });
  return { kind, name: assertSafeName(name), dir: subdir };
}

module.exports = {
  deleteItem,
  getItemDraft,
  listItemFiles,
  readItemAsset,
  readItemFile,
  resolveEditableDir,
  writeItemFile
};
