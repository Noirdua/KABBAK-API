/* deck-preview.js — read-only deck image preview for non-installed DLC decks.
 *
 * Serves images without installing: reads the working copy when it is present,
 * otherwise falls back to `git show HEAD:<path>` so sparse/partial checkouts
 * work. Nothing is written and the deck never becomes "installed".
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { dlcRoot } = require("../config/paths");
const dlcSources = require("./dlc-sources");
const { assertSafeName } = require("./dlc-catalog");

const IMAGE_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml"
};

function isImage(fileName) {
  return Boolean(IMAGE_CONTENT_TYPES[path.extname(String(fileName || "")).toLowerCase()]);
}

function resolveSource(sourceId) {
  const explicit = String(sourceId || "").trim();
  if (explicit) {
    const source = dlcSources.getSource(explicit);
    if (!source) throw new Error(`Unknown DLC source '${explicit}'.`);
    return source;
  }
  const sources = dlcSources.listSources().filter((source) => source.enabled !== false);
  return sources.find((source) => String(source.url || "").trim())
    || dlcSources.getPrimarySource()
    || sources[0]
    || null;
}

function safeRelativeAssetPath(value) {
  const relative = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative) throw new Error("A file path is required.");
  if (path.isAbsolute(relative)) throw new Error("Invalid file path.");
  if (relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid file path.");
  }
  return relative;
}

function gitOutput(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Resolve the deck folder. A local copy (workspace or any enabled checkout
// working dir) wins; otherwise fall back to the source checkout at HEAD so
// non-materialized/remote decks still preview.
function resolveDeckLocation(name, sourceId) {
  const safeName = assertSafeName(name);
  const source = resolveSource(sourceId);

  const roots = [];
  if (source) roots.push(dlcSources.getSourceRoot(source));
  if (!roots.includes(dlcRoot)) roots.push(dlcRoot);
  dlcSources.listEnabledSourceRoots().forEach((entry) => {
    if (!roots.includes(entry.root)) roots.push(entry.root);
  });

  for (const root of roots) {
    const dir = path.join(root, "decks", safeName);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return { source, root, safeName, relDir: `decks/${safeName}`, working: dir, local: true };
    }
  }

  if (!source) throw new Error("No DLC repository is configured.");
  const root = dlcSources.getSourceRoot(source);
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error(`'${source.name}' has no git checkout.`);
  }
  return { source, root, safeName, relDir: `decks/${safeName}`, working: path.join(root, "decks", safeName), local: false };
}

function readDeckManifest(root, relDir, working) {
  const workingManifest = path.join(working, "deck.json");
  if (fs.existsSync(workingManifest)) {
    try {
      return JSON.parse(fs.readFileSync(workingManifest, "utf8"));
    } catch (_error) {
      return null;
    }
  }
  try {
    const buffer = execFileSync("git", ["-c", "core.pager=cat", "show", `HEAD:${relDir}/deck.json`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return JSON.parse(buffer.toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Map file path -> intended card label from the deck manifest (explicit maps).
function buildDeckLabelMap(manifest) {
  const map = new Map();
  const add = (file, label) => {
    if (!file || !label) return;
    (Array.isArray(file) ? file : [file]).forEach((entry) => map.set(String(entry), label));
  };
  const majors = manifest?.majors?.cards;
  if (majors && typeof majors === "object") {
    Object.entries(majors).forEach(([trump, file]) => add(file, `Major ${trump}`));
  }
  const minors = manifest?.minors?.cards;
  if (minors && typeof minors === "object") {
    Object.entries(minors).forEach(([key, file]) => add(file, titleCase(key)));
  }
  if (manifest?.cardBack) add(manifest.cardBack, "Card back");
  return map;
}

function listDeckImages(name, sourceId) {
  const { root, safeName, relDir, working } = resolveDeckLocation(name, sourceId);
  let files = [];
  let materialized = false;

  if (fs.existsSync(working) && fs.statSync(working).isDirectory()) {
    materialized = true;
    const walk = (current, base) => {
      fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
        if (entry.name.startsWith(".") || entry.name === "thumbs") return;
        if (entry.isDirectory()) {
          walk(path.join(current, entry.name), `${base}${entry.name}/`);
          return;
        }
        if (entry.isFile() && isImage(entry.name)) files.push(`${base}${entry.name}`);
      });
    };
    walk(working, "");
  } else {
    const output = gitOutput(["ls-tree", "-r", "--name-only", "HEAD", "--", relDir], root);
    files = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${relDir}/`) && isImage(line))
      .map((line) => line.slice(relDir.length + 1))
      .filter((line) => !line.split("/").some((segment) => segment.startsWith(".") || segment === "thumbs"));
  }

  files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  const manifest = readDeckManifest(root, relDir, working);
  const labels = buildDeckLabelMap(manifest);
  return {
    name: safeName,
    title: String(manifest?.name || manifest?.title || safeName).trim() || safeName,
    materialized,
    count: files.length,
    images: files.map((relative) => ({
      path: relative,
      name: path.basename(relative),
      label: labels.get(relative) || ""
    }))
  };
}

function readDeckImage(name, filePath, sourceId) {
  const { root, relDir, working } = resolveDeckLocation(name, sourceId);
  const relative = safeRelativeAssetPath(filePath);
  if (!isImage(relative)) throw new Error("Not an image file.");
  const extension = path.extname(relative).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension] || "application/octet-stream";

  const workingFile = path.join(working, relative);
  const base = path.resolve(working);
  const resolved = path.resolve(workingFile);
  if (resolved === base || resolved.startsWith(base + path.sep)) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return { path: relative, contentType, buffer: fs.readFileSync(resolved) };
    }
  }

  const gitPath = `${relDir}/${relative}`;
  try {
    const buffer = execFileSync("git", ["-c", "core.pager=cat", "show", `HEAD:${gitPath}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { path: relative, contentType, buffer };
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    throw new Error(`Could not read '${relative}' from the repository.${stderr ? ` ${stderr}` : ""}`);
  }
}

module.exports = {
  listDeckImages,
  readDeckImage
};
