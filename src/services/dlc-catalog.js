const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  projectRoot,
  dlcRoot,
  decksImportRoot,
  textImportRoot,
  referencesImportRoot,
  sourceDecksRoot,
  sourceTextDataRoot,
  decksRoot,
  storageRoot
} = require("../config/paths");
const dlcSources = require("./dlc-sources");

const MISSING_DLC_REPO_MESSAGE = "No DLC catalog URL is configured. Set KABBAK_DLC_REPO, run `npm run dlc -- repo <url>`, or add a catalog URL in Admin → DLC.";

// Packs hold no files of their own: a pack is a curated list of other catalog
// items that install together.
const CATEGORIES = Object.freeze([
  Object.freeze({ kind: "deck", key: "decks", dir: "decks", label: "Decks" }),
  Object.freeze({ kind: "text", key: "texts", dir: "texts", label: "Texts" }),
  Object.freeze({ kind: "reference", key: "references", dir: "references", label: "References" }),
  Object.freeze({ kind: "pack", key: "packs", dir: "packs", label: "Packs" }),
  Object.freeze({ kind: "plugin", key: "plugins", dir: "plugins", label: "Plugins" }),
  Object.freeze({ kind: "api", key: "apis", dir: "apis", label: "API" })
]);

const CONTENT_KINDS = Object.freeze(["deck", "text", "reference"]);

// Plugins are frontend features installed straight out of the DLC checkout:
// a manifest.json declares the entry script and stylesheet the app loads.
const AUDIO_EXTENSIONS = Object.freeze(new Set([
  ".mp3", ".ogg", ".oga", ".wav", ".webm", ".weba", ".m4a", ".m4b", ".mp4",
  ".flac", ".aac", ".opus", ".aiff", ".aif", ".wma", ".alac", ".amr", ".wv"
]));

const PLUGIN_ASSET_EXTENSIONS = Object.freeze(new Set([
  ".js", ".mjs", ".css", ".json",
  ...AUDIO_EXTENSIONS,
  ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".html", ".htm", ".txt", ".md"
]));

// Uploads accept media plus text-ish plugin content (e.g. homepage/index.html,
// menu presets as presets.json, menu logos).
const UPLOADABLE_PLUGIN_EXTENSIONS = Object.freeze(new Set([
  ...AUDIO_EXTENSIONS,
  ".html",
  ".htm",
  ".txt",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".gif"
]));

// Reference lookup kinds: how the entries are keyed and how the UI looks them up.
const REFERENCE_KINDS = Object.freeze(new Set(["lexicon", "dictionary", "encyclopedia"]));
const REFERENCE_KEY_SCHEMES = Object.freeze(new Set(["strongs", "word", "term"]));

// Single source of truth: validating against anything else lets `dlc check` pass
// content that migrate:data will later reject.
const SUPPORTED_TEXT_FORMATS = Object.freeze(new Set(require("./text-importer").SUPPORTED_IMPORT_FORMATS));

function categoryByKind(kind) {
  if (kind === "gui") {
    return CATEGORIES.find((category) => category.kind === "plugin") || null;
  }
  return CATEGORIES.find((category) => category.kind === kind) || null;
}

function isGuiPluginManifest(manifest) {
  const kind = String(manifest?.kind || "").trim().toLowerCase();
  const role = String(manifest?.role || "").trim().toLowerCase();
  return kind === "gui" || role === "gui" || role === "skin";
}

// Catalog entries can originate from a remote manifest, so names are untrusted input.
function assertSafeName(name) {
  const value = String(name || "").trim();
  if (!value || value.startsWith(".") || value.includes("/") || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`Invalid DLC item name: '${name}'.`);
  }
  return value;
}

// Plugin ids are folder names and script ids: keep them slug-like so generated
// files, URLs, and manifest entries stay clean.
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_PLUGIN_NAME_LENGTH = 40;

function assertSafePluginName(name) {
  const value = String(name || "").trim().toLowerCase();
  if (!value || value.length > MAX_PLUGIN_NAME_LENGTH || !PLUGIN_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid plugin id '${name}'. Use ${MAX_PLUGIN_NAME_LENGTH} or fewer characters: lowercase letters, numbers, dot, dash, underscore (e.g. "my-gadget").`);
  }
  return value;
}

function fallbackId(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// The text importer writes canonical JSON into source/data/text, naming the file
// after the normalized item name for DLC drops (e.g. "book of lies.json") or
// after the manifest id for curated imports (e.g. "kjv.json"). References land in
// the same folder, named after their id. Resolve whichever candidate exists so
// install status is accurate for both cases.
function resolveInstalledSourceFileName(id, name) {
  const candidates = [];
  const normalizedId = String(id || "").trim().toLowerCase();
  const normalizedName = String(name || "").trim().toLowerCase();
  if (normalizedId) candidates.push(`${normalizedId}.json`);
  if (normalizedName && normalizedName !== normalizedId) candidates.push(`${normalizedName}.json`);

  for (const fileName of candidates) {
    if (fs.existsSync(path.join(sourceTextDataRoot, fileName))) return fileName;
  }
  return "";
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readReferenceDisplayConfig(id) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const files = [];
  const seen = new Set();
  const addFile = (filePath) => {
    const key = String(filePath || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    files.push(filePath);
  };
  addFile(path.join(dlcRoot, "references", wanted, "reference.json"));
  for (const { root } of dlcSources.listEnabledSourceRoots()) {
    addFile(path.join(root, "references", wanted, "reference.json"));
  }
  for (const filePath of files) {
    const manifest = readJsonIfPresent(filePath);
    if (!manifest || typeof manifest !== "object") continue;
    const fieldConfig = manifest.fieldConfig && typeof manifest.fieldConfig === "object" && !Array.isArray(manifest.fieldConfig)
      ? manifest.fieldConfig
      : null;
    const listOrder = Array.isArray(manifest.listOrder)
      ? manifest.listOrder.map((key) => String(key || "").trim()).filter(Boolean)
      : null;
    if (fieldConfig || listOrder) {
      return {
        ...(fieldConfig ? { fieldConfig } : {}),
        ...(listOrder ? { listOrder } : {})
      };
    }
  }
  return null;
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listContentDirs(dirPath) {
  if (!isDirectory(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
}

function getDirSize(dirPath) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files += 1;
        try {
          total += fs.statSync(fullPath).size;
        } catch {
          // Unreadable file: skip it rather than aborting the whole scan.
        }
      }
    }
  };
  walk(dirPath);
  return { size: total, files };
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "-";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

// --- Repository access -------------------------------------------------------

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || projectRoot,
    encoding: "utf8",
    stdio: options.stdio || "pipe"
  });
}

function tryGit(args, options = {}) {
  try {
    return { ok: true, output: git(args, options) || "" };
  } catch (error) {
    return { ok: false, output: "", error };
  }
}

function isRepoPresent() {
  return fs.existsSync(path.join(dlcRoot, ".git"));
}

function resolveRepoUrl() {
  const primary = dlcSources.getPrimarySource();
  if (primary?.url) return primary.url;
  const fromEnv = String(process.env.KABBAK_DLC_REPO || "").trim();
  if (fromEnv) return fromEnv;
  if (isRepoPresent()) {
    const fromRemote = tryGit(["remote", "get-url", "origin"], { cwd: dlcRoot }).output.trim();
    if (fromRemote) return fromRemote;
  }
  return "";
}

function requireRepoUrl() {
  const url = resolveRepoUrl();
  if (url) return url;
  throw new Error(MISSING_DLC_REPO_MESSAGE);
}

function resolveBranch() {
  const fromEnv = String(process.env.KABBAK_DLC_BRANCH || "").trim();
  if (fromEnv) return fromEnv;
  const primary = dlcSources.getPrimarySource();
  const detected = dlcSources.detectRemoteBranch(dlcRoot);
  if (primary?.branch && primary.branch === detected) return primary.branch;
  if (detected) return detected;
  if (primary?.branch) return primary.branch;
  return "main";
}

// Clones the catalog as a blobless, sparse checkout: metadata only, no content
// files, so `dlc list` costs a few kilobytes instead of the full library.
function ensureRepo({ log = () => {} } = {}) {
  if (isRepoPresent()) return { cloned: false, url: resolveRepoUrl() };

  const url = requireRepoUrl();
  const relativePath = path.relative(projectRoot, dlcRoot).replace(/\\/g, "/");
  fs.mkdirSync(path.dirname(dlcRoot), { recursive: true });
  if (fs.existsSync(dlcRoot) && fs.readdirSync(dlcRoot).length) {
    throw new Error(`${relativePath} already exists but is not a git checkout. Remove it and retry.`);
  }

  log(`Cloning DLC catalog from ${url} (metadata only)...`);
  git(["clone", "--filter=blob:none", "--sparse", url, relativePath], { stdio: "inherit" });
  return { cloned: true, url };
}

function isSparse() {
  return tryGit(["config", "--get", "core.sparsecheckout"], { cwd: dlcRoot }).output.trim() === "true";
}

function sparsePaths() {
  const result = tryGit(["sparse-checkout", "list"], { cwd: dlcRoot });
  if (!result.ok) return [];
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Downloads the blobs for one catalog folder. No-op when the checkout is dense.
function materialize(relativeDir, { log = () => {}, root = dlcRoot } = {}) {
  const target = path.join(root, relativeDir);
  if (isDirectory(target) && fs.readdirSync(target).length) return false;
  const sparse = tryGit(["config", "--get", "core.sparsecheckout"], { cwd: root }).output.trim() === "true";
  if (!sparse) return false;

  log(`Fetching ${relativeDir} from the DLC repository...`);
  const result = tryGit(["sparse-checkout", "add", relativeDir], { cwd: root, stdio: "inherit" });
  if (!result.ok) {
    throw new Error(`Failed to fetch '${relativeDir}': ${result.error?.message || "git sparse-checkout add failed"}`);
  }
  return true;
}

// Drops one catalog folder from the sparse checkout to reclaim disk space.
function dematerialize(relativeDir) {
  if (!isSparse()) return false;
  const remaining = sparsePaths().filter((entry) => entry !== relativeDir);
  const result = tryGit(["sparse-checkout", "set", ...remaining], { cwd: dlcRoot });
  return result.ok;
}

function listWorktreeDirtyPaths(root = dlcRoot) {
  const paths = new Set();
  const collect = (output) => {
    String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => paths.add(line));
  };
  try {
    collect(tryGit(["diff", "--name-only"], { cwd: root }).output);
    collect(tryGit(["diff", "--name-only", "--cached"], { cwd: root }).output);
    collect(tryGit(["ls-files", "--others", "--exclude-standard"], { cwd: root }).output);
  } catch (_error) {
    // Assume dirty if the worktree state can't be read.
  }
  return paths;
}

function updateRepo({ log = () => {} } = {}) {
  ensureRepo({ log });
  const branch = resolveBranch();
  log(`Updating DLC catalog (${branch})...`);
  git(["fetch", "--filter=blob:none", "origin", branch], { cwd: dlcRoot, stdio: "inherit" });
  git(["checkout", branch], { cwd: dlcRoot, stdio: "inherit" });

  // Shared pull-only update (fast-forward, or selective/rebase while keeping
  // local files). Never commits.
  dlcSources.pullCheckout(dlcRoot, branch, { log });

  const head = tryGit(["rev-parse", "--short", "HEAD"], { cwd: dlcRoot }).output.trim();
  invalidateCatalogCache();
  return head;
}

// --- Catalog -----------------------------------------------------------------

function readTextManifest(itemPath) {
  // metadata.json is the universal manifest name; text.json is the legacy one.
  return readJsonIfPresent(path.join(itemPath, "metadata.json"))
    || readJsonIfPresent(path.join(itemPath, "text.json"));
}

// Numeric dot-segment comparison so 1.10 > 1.9; falls back to plain string
// comparison for non-numeric versions.
function compareVersionStrings(a, b) {
  const rawA = String(a || "").trim().replace(/^v/i, "");
  const rawB = String(b || "").trim().replace(/^v/i, "");
  if (!rawA || !rawB) return rawA === rawB ? 0 : (rawA ? 1 : -1);
  const partsA = rawA.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const partsB = rawB.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  if (partsA.some(Number.isNaN) || partsB.some(Number.isNaN)) {
    return rawA === rawB ? 0 : (rawA > rawB ? 1 : -1);
  }
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] || 0) - (partsB[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function normalizeChangelogEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .map((entry) => ({
      version: String(entry?.version || "").trim(),
      date: String(entry?.date || "").trim(),
      notes: Array.isArray(entry?.notes)
        ? entry.notes.map((note) => String(note || "").trim()).filter(Boolean)
        : (String(entry?.notes || "").trim() ? [String(entry.notes).trim()] : [])
    }))
    .filter((entry) => entry.version);
}

function normalizePackItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const seen = new Set();
  const items = [];
  for (const raw of rawItems) {
    const entry = typeof raw === "string" ? { name: raw } : raw;
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    const kind = CONTENT_KINDS.includes(entry?.type) ? entry.type : "";
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(kind ? { type: kind, name } : { name });
  }
  return items;
}

function gitShowJson(root, relativePath) {
  const posix = String(relativePath || "").replace(/\\/g, "/");
  if (!posix) return null;
  const result = tryGit(["show", `HEAD:${posix}`], { cwd: root });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.output);
  } catch {
    return null;
  }
}

function listGitTreeDirs(root, categoryDir) {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  const result = tryGit(["ls-tree", "-d", "--name-only", `HEAD:${categoryDir}`], { cwd: root });
  if (!result.ok) return [];
  return result.output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && !name.startsWith(".") && !name.startsWith("_"));
}

function describeLocalItem(category, name, root = dlcRoot) {
  const itemPath = path.join(root, category.dir, name);
  if (!isDirectory(itemPath)) return null;

  const { size, files } = getDirSize(itemPath);
  const base = { name, size, files };

  if (category.kind === "deck") {
    const deck = readJsonIfPresent(path.join(itemPath, "deck.json"));
    return {
      ...base,
      id: deck?.id || fallbackId(name),
      title: deck?.name || deck?.label || deck?.title || name,
      description: deck?.description || "",
      system: String(deck?.system || "tarot").trim().toLowerCase() || "tarot"
    };
  }
  if (category.kind === "pack") {
    const pack = readJsonIfPresent(path.join(itemPath, "pack.json"));
    return {
      ...base,
      size: 0,
      files: 0,
      id: pack?.id || fallbackId(name),
      title: pack?.name || pack?.title || name,
      description: pack?.description || "",
      items: normalizePackItems(pack?.items)
    };
  }
  if (category.kind === "reference") {
    const reference = readJsonIfPresent(path.join(itemPath, "reference.json"));
    return {
      ...base,
      id: reference?.id || fallbackId(name),
      title: reference?.title || name,
      description: reference?.description || "",
      refKind: reference?.kind || "dictionary",
      keyScheme: reference?.keyScheme || "word"
    };
  }
  if (category.kind === "plugin" || category.kind === "api") {
    const manifest = readJsonIfPresent(path.join(itemPath, "manifest.json"));
    const changelog = readJsonIfPresent(path.join(itemPath, "changelog.json"));
    const section = manifest?.section && typeof manifest.section === "object" ? manifest.section : null;
    return {
      ...base,
      id: manifest?.id || fallbackId(name),
      title: manifest?.name || manifest?.title || name,
      description: manifest?.description || "",
      version: manifest?.version || "",
      entry: manifest?.entry || "",
      css: manifest?.css || "",
      section,
      role: normalizePluginRole(manifest?.role, section, manifest?.overhaul),
      preserveChrome: manifest?.preserveChrome === true,
      kind: isGuiPluginManifest(manifest) ? "gui" : category.kind,
      changelog: normalizeChangelogEntries(changelog?.entries)
    };
  }
  const text = readTextManifest(itemPath);
  return {
    ...base,
    id: text?.id || fallbackId(name),
    title: text?.title || text?.shortTitle || name,
    description: text?.description || text?.tradition || "",
    format: text?.input?.format || ""
  };
}

function resolveStatus(kind, name, id) {
  if (kind === "deck") {
    if (fs.existsSync(path.join(sourceDecksRoot, name))) return "installed";
    if (fs.existsSync(path.join(decksImportRoot, name))) return "staged";
    return "available";
  }
  if (kind === "reference") {
    if (resolveInstalledSourceFileName(id, name)) return "installed";
    if (fs.existsSync(path.join(referencesImportRoot, name))) return "staged";
    return "available";
  }
  if (kind === "plugin" || kind === "api" || kind === "gui") {
    try {
      const root = resolvePluginRoot(name);
      return isDirectory(root.dir) ? "installed" : "available";
    } catch (_error) {
      return "available";
    }
  }
  if (resolveInstalledSourceFileName(id, name)) return "installed";
  if (fs.existsSync(path.join(textImportRoot, `${name}.manifest.json`))) return "staged";
  return "available";
}

function normalizeItem(category, entry, root = dlcRoot) {
  const name = String(entry?.name || "").trim();
  if (!name) return null;

  const local = describeLocalItem(category, name, root);
  const id = String(entry?.id || local?.id || fallbackId(name));
  const catalogKind = (category.kind === "plugin" && (local?.kind === "gui" || isGuiPluginManifest(entry))) ? "gui" : category.kind;
  const item = {
    kind: catalogKind,
    name,
    id,
    title: String(entry?.title || local?.title || name),
    description: String(entry?.description || local?.description || ""),
    size: Number(entry?.size) || local?.size || 0,
    files: Number(entry?.files) || local?.files || 0,
    downloaded: Boolean(local),
    status: category.kind === "pack" ? "available" : resolveStatus(catalogKind === "gui" ? "plugin" : category.kind, name, id)
  };

  if (category.kind === "pack") {
    const published = normalizePackItems(entry?.items);
    item.items = published.length ? published : (local?.items || []);
    item.size = 0;
    item.files = 0;
  }

  if (category.kind === "reference") {
    item.refKind = String(entry?.kind || local?.refKind || "dictionary").trim();
    item.keyScheme = String(entry?.keyScheme || local?.keyScheme || "word").trim();
  }

  if (category.kind === "deck") {
    // Deck system drives the Admin DLC grouping (tarot, iching, …).
    item.system = String(entry?.system || local?.system || "tarot").trim().toLowerCase() || "tarot";
  }

  if (category.kind === "plugin" || category.kind === "api") {
    if (catalogKind === "gui") item.kind = "gui";
    // The checkout manifest is the live source of truth for installed plugins.
    // Remote entries without metadata must not override it.
    if (local?.title) {
      item.title = String(local.title);
    }
    if (local?.description) {
      item.description = String(local.description);
    }
    item.version = String(local?.version || entry?.version || "").trim();
    item.entry = String(local?.entry || entry?.entry || "").trim();
    item.css = String(local?.css || entry?.css || "").trim();
    item.section = local?.section || entry?.section || null;
    item.role = String(local?.role || entry?.role || "").trim();
    item.preserveChrome = local?.preserveChrome === true || entry?.preserveChrome === true;

    // Update detection: the published manifest carries the latest version;
    // the checkout carries the installed one. An update is available when an
    // installed plugin is older than the published version.
    const latestVersion = String(entry?.version || "").trim();
    item.latestVersion = latestVersion || item.version;
    item.updateAvailable = Boolean(
      local
      && latestVersion
      && item.version
      && compareVersionStrings(latestVersion, item.version) > 0
    );
    item.changelog = normalizeChangelogEntries(
      Array.isArray(entry?.changelog) ? entry.changelog : (local?.changelog || [])
    );
  }

  return item;
}

// A pack's size and status are the roll-up of the items it lists.
function resolvePackRollups(items) {
  const contentItems = items.filter((item) => item.kind !== "pack");
  for (const pack of items.filter((item) => item.kind === "pack")) {
    const members = pack.items
      .map((member) => findCatalogItem(contentItems, member.name, member.type, pack.sourceId).item
        || findCatalogItem(contentItems, member.name, member.type).item)
      .filter(Boolean);

    pack.memberCount = pack.items.length;
    pack.missingCount = pack.items.length - members.length;
    pack.size = members.reduce((sum, member) => sum + (member.size || 0), 0);
    pack.files = members.reduce((sum, member) => sum + (member.files || 0), 0);

    if (!members.length) {
      pack.status = "available";
    } else if (members.every((member) => member.status === "installed")) {
      pack.status = "installed";
    } else if (members.some((member) => member.status !== "available")) {
      pack.status = "partial";
    } else {
      pack.status = "available";
    }
  }
}

function normalizeCatalog(raw, root = dlcRoot) {
  const items = [];
  for (const category of CATEGORIES) {
    const entries = Array.isArray(raw?.[category.key]) ? raw[category.key] : [];
    for (const entry of entries) {
      const item = normalizeItem(category, typeof entry === "string" ? { name: entry } : entry, root);
      if (item) items.push(item);
    }
  }
  return items;
}

function markDuplicates(items) {
  const counts = new Map();
  for (const item of items) {
    const key = `${item.kind}:${String(item.name || "").toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const item of items) {
    const key = `${item.kind}:${String(item.name || "").toLowerCase()}`;
    item.duplicate = (counts.get(key) || 0) > 1;
  }
}

function describeGitItem(root, category, name) {
  const prefix = `${category.dir}/${name}`;
  const local = describeLocalItem(category, name, root);
  const base = { name, size: local?.size || 0, files: local?.files || 0 };

  if (category.kind === "deck") {
    const deck = gitShowJson(root, `${prefix}/deck.json`);
    if (!deck && local) return local;
    return {
      ...base,
      id: deck?.id || local?.id || fallbackId(name),
      title: deck?.name || deck?.label || deck?.title || local?.title || name,
      description: deck?.description || local?.description || "",
      system: String(deck?.system || local?.system || "tarot").trim().toLowerCase() || "tarot"
    };
  }
  if (category.kind === "pack") {
    const pack = gitShowJson(root, `${prefix}/pack.json`);
    if (!pack && local) return local;
    const packItems = normalizePackItems(pack?.items);
    return {
      ...base,
      id: pack?.id || local?.id || fallbackId(name),
      title: pack?.name || pack?.title || local?.title || name,
      description: pack?.description || local?.description || "",
      items: packItems.length ? packItems : (local?.items || [])
    };
  }
  if (category.kind === "reference") {
    const reference = gitShowJson(root, `${prefix}/reference.json`);
    if (!reference && local) return local;
    return {
      ...base,
      id: reference?.id || local?.id || fallbackId(name),
      title: reference?.title || local?.title || name,
      description: reference?.description || local?.description || "",
      refKind: reference?.kind || local?.refKind || "dictionary",
      keyScheme: reference?.keyScheme || local?.keyScheme || "word"
    };
  }
  if (category.kind === "plugin" || category.kind === "api") {
    const manifest = gitShowJson(root, `${prefix}/manifest.json`);
    const changelog = gitShowJson(root, `${prefix}/changelog.json`);
    if (!manifest && local) return local;
    const section = manifest?.section && typeof manifest.section === "object" ? manifest.section : (local?.section || null);
    return {
      ...base,
      id: manifest?.id || local?.id || fallbackId(name),
      title: manifest?.name || manifest?.title || local?.title || name,
      description: manifest?.description || local?.description || "",
      version: manifest?.version || "",
      entry: manifest?.entry || local?.entry || "",
      css: manifest?.css || local?.css || "",
      section,
      role: normalizePluginRole(manifest?.role, section, manifest?.overhaul) || local?.role,
      preserveChrome: manifest?.preserveChrome === true || local?.preserveChrome === true,
      kind: isGuiPluginManifest(manifest) || local?.kind === "gui" ? "gui" : category.kind,
      changelog: normalizeChangelogEntries(changelog?.entries).length
        ? normalizeChangelogEntries(changelog?.entries)
        : (local?.changelog || [])
    };
  }
  const text = gitShowJson(root, `${prefix}/metadata.json`) || gitShowJson(root, `${prefix}/text.json`);
  if (!text && local) return local;
  return {
    ...base,
    id: text?.id || local?.id || fallbackId(name),
    title: text?.title || text?.shortTitle || local?.title || name,
    description: text?.description || text?.tradition || local?.description || "",
    format: text?.input?.format || local?.format || ""
  };
}

function scanLocalTree(root = dlcRoot) {
  if (!isDirectory(root)) return null;
  const raw = {};
  let found = false;
  for (const category of CATEGORIES) {
    const names = listContentDirs(path.join(root, category.dir));
    if (names.length) found = true;
    raw[category.key] = names.map((name) => ({ name }));
  }
  return found ? raw : null;
}

function scanGitTree(root = dlcRoot) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const raw = {};
  let found = false;
  for (const category of CATEGORIES) {
    const names = listGitTreeDirs(root, category.dir);
    if (names.length) found = true;
    raw[category.key] = names.map((name) => describeGitItem(root, category, name));
  }
  return found ? raw : null;
}

const CATALOG_CACHE_TTL_MS = 30 * 1000;
let catalogCache = {
  expiresAtMs: 0,
  value: null
};

async function getCatalog({ refresh = false, log = () => {} } = {}) {
  const nowMs = Date.now();
  if (!refresh && catalogCache.value && catalogCache.expiresAtMs > nowMs) {
    return catalogCache.value;
  }

  const sources = dlcSources.listSources().filter((source) => source.enabled !== false);
  const items = [];
  const seen = new Set();
  let origin = "none";

  const addItems = (nextItems, source, from) => {
    for (const item of nextItems) {
      const key = `${source?.id || ""}:${item.kind}:${String(item.name || "").toLowerCase()}`;
      if (!key.endsWith(":") && seen.has(key)) {
        continue;
      }
      if (!key.endsWith(":")) {
        seen.add(key);
      }
      item.sourceId = source?.id || "";
      item.sourceName = source?.name || "";
      item.sourceUrl = source?.url || "";
      items.push(item);
    }
    if (from && origin === "none") {
      origin = from;
    } else if (from && origin !== from) {
      origin = "merged";
    }
  };

  for (const source of sources) {
    const root = dlcSources.getSourceRoot(source);
    const gitRaw = scanGitTree(root);
    if (gitRaw) {
      addItems(normalizeCatalog(gitRaw, root), source, "git");
    }
    const scanned = scanLocalTree(root);
    if (scanned) {
      addItems(normalizeCatalog(scanned, root), source, origin === "none" ? "scan" : origin);
    }
  }

  const localRaw = scanLocalTree(dlcRoot);
  if (localRaw) {
    addItems(
      normalizeCatalog(localRaw, dlcRoot),
      dlcSources.getPrimarySource() || { id: "primary", name: "local" },
      origin === "none" ? "scan" : origin
    );
  }

  resolvePackRollups(items);
  markDuplicates(items);

  const result = {
    origin,
    items,
    sources: dlcSources.listDescribedSources()
  };

  catalogCache = {
    expiresAtMs: nowMs + CATALOG_CACHE_TTL_MS,
    value: result
  };
  return result;
}

function findCatalogItem(items, name, kind, sourceId) {
  const wanted = String(name || "").trim().toLowerCase();
  const sourceWanted = String(sourceId || "").trim().toLowerCase();
  const matches = items.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (sourceWanted && String(item.sourceId || "").toLowerCase() !== sourceWanted) return false;
    return item.name.toLowerCase() === wanted || item.id.toLowerCase() === wanted;
  });
  return { matches, item: matches.length === 1 ? matches[0] : null };
}

// --- Install / uninstall -----------------------------------------------------

function stageDeck(name, log, sourceDir) {
  const source = sourceDir || path.join(dlcRoot, "decks", name);
  const staged = path.join(decksImportRoot, name);
  const installed = path.join(sourceDecksRoot, name);

  if (fs.existsSync(installed)) {
    log(`[deck] ${name} is already installed.`);
    return false;
  }
  if (fs.existsSync(staged)) {
    log(`[deck] ${name} is already staged in imports/decks.`);
    return false;
  }
  fs.mkdirSync(decksImportRoot, { recursive: true });
  fs.cpSync(source, staged, { recursive: true });
  log(`[deck] ${name} -> imports/decks/${name}`);
  return true;
}

function stageText(name, log, sourceDir) {
  const source = sourceDir || path.join(dlcRoot, "texts", name);
  const manifest = readTextManifest(source);
  if (!manifest) throw new Error(`'${name}' is missing a metadata.json manifest.`);

  const inputPath = String(manifest?.input?.path || "").trim();
  if (!inputPath) throw new Error(`'${name}' has no input.path in its metadata.json.`);
  const format = String(manifest?.input?.format || "").trim();
  if (format && !SUPPORTED_TEXT_FORMATS.has(format)) {
    throw new Error(`'${name}' declares unsupported input.format '${format}'.`);
  }

  const contentSource = path.resolve(source, inputPath);
  if (!contentSource.startsWith(path.resolve(source) + path.sep) || !fs.existsSync(contentSource)) {
    throw new Error(`'${name}' input.path does not resolve to a file inside the text folder.`);
  }

  const id = manifest.id || fallbackId(name);
  if (resolveInstalledSourceFileName(id, name)) {
    log(`[text] ${name} is already installed.`);
    return false;
  }

  fs.mkdirSync(textImportRoot, { recursive: true });
  const contentName = name + path.extname(inputPath);
  fs.copyFileSync(contentSource, path.join(textImportRoot, contentName));
  const stagedManifest = { ...manifest, input: { ...manifest.input, path: contentName } };
  fs.writeFileSync(path.join(textImportRoot, `${name}.manifest.json`), JSON.stringify(stagedManifest, null, 2), "utf8");
  log(`[text] ${name} -> imports/text/${contentName} + .manifest.json`);
  return true;
}

function stageReference(name, log, sourceDir) {
  const source = sourceDir || path.join(dlcRoot, "references", name);
  const manifest = readJsonIfPresent(path.join(source, "reference.json"));
  if (!manifest) throw new Error(`'${name}' is missing a reference.json manifest.`);

  const id = manifest.id || fallbackId(name);
  if (!id) throw new Error(`'${name}' has no id in reference.json.`);

  const entriesFile = String(manifest.entriesFile || "entries.json").trim();
  const entriesSource = path.resolve(source, entriesFile);
  if (!entriesSource.startsWith(path.resolve(source) + path.sep) || !fs.existsSync(entriesSource)) {
    throw new Error(`'${name}' entriesFile does not resolve to a file inside the reference folder.`);
  }

  const kind = String(manifest.kind || "dictionary").trim();
  const keyScheme = String(manifest.keyScheme || "word").trim();
  if (!REFERENCE_KINDS.has(kind)) {
    throw new Error(`'${name}' declares unsupported kind '${kind}'.`);
  }
  if (!REFERENCE_KEY_SCHEMES.has(keyScheme)) {
    throw new Error(`'${name}' declares unsupported keyScheme '${keyScheme}'.`);
  }

  if (resolveInstalledSourceFileName(id, name)) {
    log(`[reference] ${name} is already installed.`);
    return false;
  }

  const staged = path.join(referencesImportRoot, name);
  if (fs.existsSync(staged)) {
    log(`[reference] ${name} is already staged in imports/references.`);
    return false;
  }

  fs.mkdirSync(staged, { recursive: true });
  fs.copyFileSync(entriesSource, path.join(staged, path.basename(entriesSource)));
  fs.writeFileSync(path.join(staged, "reference.json"), JSON.stringify(manifest, null, 2), "utf8");
  log(`[reference] ${name} -> imports/references/${name}`);
  return true;
}

// Packs are read straight out of the DLC checkout at build time, so fetching the
// folder is the whole install step.
function expandPack(pack, items) {
  const contentItems = items.filter((item) => item.kind !== "pack");
  const members = [];
  const missing = [];
  for (const member of pack.items || []) {
    const { item } = findCatalogItem(contentItems, member.name, member.type, pack.sourceId);
    if (item) members.push(item);
    else {
      const fallback = findCatalogItem(contentItems, member.name, member.type);
      if (fallback.item) members.push(fallback.item);
      else missing.push(member);
    }
  }
  return { members, missing };
}

function invalidateCatalogCache() {
  catalogCache.expiresAtMs = 0;
  catalogCache.value = null;
}

function installItem(item, { log = () => {} } = {}) {
  const name = assertSafeName(item.name);
  const category = categoryByKind(item.kind);
  if (!category) throw new Error(`Unknown DLC kind '${item.kind}'.`);
  if (category.kind === "pack") throw new Error(`'${name}' is a pack; expand it before installing.`);

  // Locally created/edited DLC lives in the workspace checkout, not the git
  // source. Install it from there when present; otherwise fetch from the repo.
  const workspaceSource = path.join(dlcRoot, category.dir, name);
  let source = "";
  if (isDirectory(workspaceSource) && fs.readdirSync(workspaceSource).length) {
    source = workspaceSource;
    log(`Installing ${category.dir}/${name} from the local DLC checkout...`);
  } else {
    const sourceRecord = item.sourceId
      ? dlcSources.getSource(item.sourceId)
      : dlcSources.getPrimarySource();
    const root = dlcSources.getSourceRoot(sourceRecord);
    if (sourceRecord && !sourceRecord.primary) {
      dlcSources.syncSource(sourceRecord, { log });
    } else {
      updateRepo({ log });
    }
    materialize(`${category.dir}/${name}`, { log, root });
    source = path.join(root, category.dir, name);
  }

  if (!isDirectory(source) || !fs.readdirSync(source).length) {
    throw new Error(`'${name}' could not be downloaded from the DLC repository (expected ${category.dir}/${name}).`);
  }

  // Refuse to install content that is structurally broken.
  require("./dlc-validate").assertItemValid(category.kind, name, source);

  if (category.kind === "deck") {
    const staged = stageDeck(name, log, source);
    invalidateCatalogCache();
    return staged;
  }
  if (category.kind === "reference") {
    const staged = stageReference(name, log, source);
    invalidateCatalogCache();
    return staged;
  }
  if (category.kind === "plugin" || category.kind === "api") {
    invalidateCatalogCache();
    log(`[${category.kind}] ${name} installed (${category.dir}/${name})`);
    return true;
  }
  invalidateCatalogCache();
  return stageText(name, log, source);
}

// Updates a single installed plugin to the latest published version without
// touching the rest of the checkout. Admin-edited files inside the plugin
// folder (configs, uploaded pages, presets, media) are kept; everything else
// in that folder is brought up to origin's version.
function updateItem(item, { log = () => {} } = {}) {
  const name = assertSafeName(item.name);
  const category = categoryByKind(item.kind);
  if (!category) throw new Error(`Unknown DLC kind '${item.kind}'.`);
  if (category.kind !== "plugin" && category.kind !== "api") {
    throw new Error(`'${name}' is not a plugin; update other content with the full DLC update.`);
  }

  const pluginRoot = resolvePluginRoot(name);
  const pluginDir = pluginRoot.dir;
  if (!isDirectory(pluginDir)) {
    throw new Error(`${category.label} '${name}' is not installed.`);
  }

  const sourceEntry = dlcSources.listEnabledSourceRoots().find((entry) =>
    pluginDir === entry.root || pluginDir.startsWith(entry.root + path.sep)
  );
  const gitRoot = sourceEntry?.root || dlcRoot;
  const branch = sourceEntry?.source?.branch || resolveBranch();
  if (sourceEntry?.source && !sourceEntry.source.primary) {
    dlcSources.syncSource(sourceEntry.source, { log });
  } else {
    ensureRepo({ log });
  }
  log(`Updating plugin '${name}' from origin/${branch}...`);
  git(["fetch", "--filter=blob:none", "origin", branch], { cwd: gitRoot, stdio: "inherit" });

  const relativeDir = `${pluginRoot.kind === "api" ? "apis" : "plugins"}/${name}`;
  const changed = String(tryGit(["diff", "--name-only", "HEAD", `origin/${branch}`, "--", relativeDir], { cwd: gitRoot }).output || "")
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const dirty = listWorktreeDirtyPaths(gitRoot);
  const keptPaths = changed.filter((changedPath) => dirty.has(changedPath));
  const updatePaths = changed.filter((changedPath) => !keptPaths.includes(changedPath));

  keptPaths.forEach((keptPath) => log(`Keeping local version: ${keptPath}`));
  if (updatePaths.length) {
    git(["checkout", `origin/${branch}`, "--", ...updatePaths], { cwd: gitRoot, stdio: "inherit" });
    // Un-stage the refreshed paths so the checkout only reports real local edits.
    try {
      git(["reset", "HEAD", "--", relativeDir], { cwd: gitRoot });
    } catch (_resetError) {
      // Cosmetic bookkeeping; the files are already updated.
    }
  }

  invalidateCatalogCache();
  return {
    name,
    kind: category.kind,
    updatedFiles: updatePaths.length,
    keptPaths
  };
}

function uninstallItem(item, { purge = false, log = () => {} } = {}) {
  const name = assertSafeName(item.name);
  const category = categoryByKind(item.kind);
  if (!category) throw new Error(`Unknown DLC kind '${item.kind}'.`);
  if (category.kind === "pack") throw new Error(`'${name}' is a pack; expand it before uninstalling.`);

  let removed = 0;
  const removePath = (target) => {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    log(`  Removed: ${path.relative(projectRoot, target)}`);
    removed += 1;
  };

  // Installed content is copied out of imports/ into source/ by the migration
  // (decks -> source/assets, texts/references -> source/data/text). Uninstall
  // has to remove both the staged import and the installed canonical artifact.
  const removeInstalledCanonical = () => {
    const installedFile = resolveInstalledSourceFileName(item.id, name);
    if (installedFile) {
      removePath(path.join(sourceTextDataRoot, installedFile));
    }
  };

  if (category.kind === "deck") {
    removePath(path.join(sourceDecksRoot, name));
    removePath(path.join(decksImportRoot, name));
    removePath(path.join(decksRoot, name));
  } else if (category.kind === "plugin" || category.kind === "api") {
    try {
      removePath(resolvePluginRoot(name).dir);
    } catch (_error) {
      removePath(path.join(dlcRoot, category.dir, name));
    }
  } else if (category.kind === "reference") {
    removePath(path.join(referencesImportRoot, name));
    removeInstalledCanonical();
  } else {
    const manifestPath = path.join(textImportRoot, `${name}.manifest.json`);
    const manifest = readJsonIfPresent(manifestPath);
    const extension = path.extname(String(manifest?.input?.path || ".txt")) || ".txt";
    removePath(path.join(textImportRoot, name + extension));
    removePath(manifestPath);
    removeInstalledCanonical();
  }

  if (purge) {
    dematerialize(`${category.dir}/${name}`);
    log(`  Dropped ${category.dir}/${name} from the local DLC checkout.`);
  }

  invalidateCatalogCache();
  return removed;
}

// --- Plugin helpers -----------------------------------------------------------

function resolvePluginRoot(name) {
  const safeName = assertSafePluginName(name);
  const roots = dlcSources.listEnabledSourceRoots().map((entry) => entry.root);
  if (!roots.includes(dlcRoot)) {
    roots.unshift(dlcRoot);
  }
  for (const root of roots) {
    const pluginDir = path.join(root, "plugins", safeName);
    if (isDirectory(pluginDir)) return { kind: "plugin", dir: pluginDir, name: safeName };
    const apiDir = path.join(root, "apis", safeName);
    if (isDirectory(apiDir)) return { kind: "api", dir: apiDir, name: safeName };
  }
  return { kind: "plugin", dir: path.join(dlcRoot, "plugins", safeName), name: safeName };
}

// Plugin user data lives OUTSIDE the DLC checkout, under
// storage/plugin-data/<name>/ — so configs, logs, uploads and playlists never
// dirty the repo and can't be committed/pushed. Legacy in-checkout locations
// (plugins/<name>/user-data, media, config.json) are read and migrated once.
const PLUGIN_DATA_ROOT = path.join(storageRoot, "plugin-data");
const PLUGIN_USER_DATA_DIR = "user-data";
const PLUGIN_MEDIA_DIR = "media";
const PLUGIN_LAYOUT_SKIP_DIRS = Object.freeze([
  PLUGIN_USER_DATA_DIR,
  PLUGIN_MEDIA_DIR,
  "thumbs",
  "node_modules"
]);

function legacyPluginLayout(pluginDir) {
  const root = path.resolve(pluginDir);
  return {
    root,
    userData: path.join(root, PLUGIN_USER_DATA_DIR),
    media: path.join(root, PLUGIN_MEDIA_DIR),
    logs: path.join(root, PLUGIN_USER_DATA_DIR, "logs")
  };
}

function pluginDataLayout(name) {
  const safeName = assertSafePluginName(name);
  const root = path.join(PLUGIN_DATA_ROOT, safeName);
  return {
    root,
    configFile: path.join(root, "config.json"),
    media: path.join(root, "media"),
    logs: path.join(root, "logs")
  };
}

function resolvePluginDataDir(name) {
  return pluginDataLayout(name).root;
}

function firstExistingPath(paths, { directory = false } = {}) {
  return (Array.isArray(paths) ? paths : []).find((candidate) => {
    try {
      if (!candidate || !fs.existsSync(candidate)) {
        return false;
      }
      const stat = fs.statSync(candidate);
      return directory ? stat.isDirectory() : stat.isFile();
    } catch (_error) {
      return false;
    }
  }) || "";
}

function copyDirIfMissing(source, dest) {
  if (!isDirectory(source) || fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
  return true;
}

// Write via a temp file + rename so readers never see a partial file.
function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch (_error) {}
    throw error;
  }
}

const MIGRATION_MARKER = ".migrated-from-checkout";

// One-time (resumable) move of legacy in-checkout user data into storage.
function migrateLegacyPluginData(name, pluginDir) {
  const layout = pluginDataLayout(name);
  const marker = path.join(layout.root, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return layout;
  const legacy = legacyPluginLayout(pluginDir);
  if (isDirectory(legacy.userData)) {
    fs.mkdirSync(layout.root, { recursive: true });
    fs.readdirSync(legacy.userData, { withFileTypes: true }).forEach((entry) => {
      const source = path.join(legacy.userData, entry.name);
      const dest = path.join(layout.root, entry.name);
      try {
        if (entry.isDirectory()) {
          copyDirIfMissing(source, dest);
        } else if (entry.isFile() && !fs.existsSync(dest)) {
          fs.copyFileSync(source, dest);
        }
      } catch (_error) {
        // Best-effort migration; reads still fall back to the legacy path.
      }
    });
  }
  if (isDirectory(legacy.media)) {
    copyDirIfMissing(legacy.media, layout.media);
  }
  const legacyConfig = path.join(pluginDir, "config.json");
  if (!fs.existsSync(layout.configFile) && fs.existsSync(legacyConfig)) {
    fs.mkdirSync(layout.root, { recursive: true });
    fs.copyFileSync(legacyConfig, layout.configFile);
  }
  // Marker makes migration idempotent and resumable even if it was interrupted.
  // Legacy dirs are intentionally left in place (gitignored) as a safety net;
  // reads fall back to them if a storage file is ever missing.
  try {
    fs.mkdirSync(layout.root, { recursive: true });
    writeFileAtomic(marker, new Date().toISOString());
  } catch (_error) {}
  return layout;
}

function ensurePluginDataLayout(name, pluginDir = "") {
  const safeName = assertSafePluginName(name);
  const layout = pluginDataLayout(safeName);
  if (pluginDir && !fs.existsSync(path.join(layout.root, MIGRATION_MARKER))) {
    migrateLegacyPluginData(safeName, pluginDir);
  }
  fs.mkdirSync(layout.root, { recursive: true });
  fs.mkdirSync(layout.media, { recursive: true });
  fs.mkdirSync(layout.logs, { recursive: true });
  return layout;
}

// Tombstones hide a stock/legacy asset (or folder) without touching the repo,
// so "delete" works on pull-only checkouts. A later upload clears the entry.
function tombstonesFile(name) {
  return path.join(pluginDataLayout(name).root, ".tombstones.json");
}

function readTombstones(name) {
  const parsed = readJsonIfPresent(tombstonesFile(name));
  return new Set(Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []);
}

function writeTombstones(name, set) {
  writeFileAtomic(tombstonesFile(name), `${JSON.stringify([...set].sort(), null, 2)}\n`);
}

function isTombstoned(set, relative) {
  const key = String(relative || "").replace(/\\/g, "/");
  if (!key) return false;
  if (set.has(key)) return true;
  for (const entry of set) {
    if (entry.endsWith("/") && key.startsWith(entry)) return true;
  }
  return false;
}

function addTombstone(name, relative) {
  try {
    const set = readTombstones(name);
    set.add(String(relative || "").replace(/\\/g, "/"));
    writeTombstones(name, set);
  } catch (_error) {
    // Best-effort: the asset is removed/overridden anyway.
  }
}

function removeTombstone(name, relative) {
  try {
    const set = readTombstones(name);
    if (set.delete(String(relative || "").replace(/\\/g, "/"))) {
      writeTombstones(name, set);
    }
  } catch (_error) {
    // Best-effort.
  }
}

function resolvePluginConfigFile(name, pluginDir) {
  const layout = pluginDataLayout(name);
  const legacy = legacyPluginLayout(pluginDir);
  return firstExistingPath([
    layout.configFile,
    path.join(legacy.userData, "config.json"),
    path.join(pluginDir, "config.json")
  ]) || layout.configFile;
}

// Read order: storage media (uploads/overrides) -> legacy media -> stock files
// in the checkout. Write order: always storage media.
function pluginContentDirs(name, pluginDir, safeDir) {
  const layout = pluginDataLayout(name);
  const legacy = legacyPluginLayout(pluginDir);
  return safeDir
    ? [path.join(layout.media, safeDir), path.join(legacy.media, safeDir), path.join(pluginDir, safeDir)]
    : [layout.media, legacy.media, pluginDir];
}

function resolvePluginContentDir(name, pluginDir, dirName, { forWrite = false } = {}) {
  const safeDir = dirName ? assertSafeDirName(dirName) : "";
  if (forWrite) {
    const layout = ensurePluginDataLayout(name, pluginDir);
    return safeDir ? path.join(layout.media, safeDir) : layout.media;
  }
  const dirs = pluginContentDirs(name, pluginDir, safeDir);
  return firstExistingPath(dirs, { directory: true }) || path.join(pluginDataLayout(name).media, safeDir || "");
}

function normalizePluginRole(value, section, overhaul) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "skin" || role === "overhaul" || role === "ui" || overhaul === true) {
    return "skin";
  }
  if (role === "section" || (section && typeof section === "object")) {
    return "section";
  }
  return "widget";
}

function readPluginManifest(name) {
  const root = resolvePluginRoot(name);
  const manifest = readJsonIfPresent(path.join(root.dir, "manifest.json"));
  if (!manifest) return null;
  const section = manifest.section && typeof manifest.section === "object" ? manifest.section : null;
  return {
    name: root.name,
    kind: isGuiPluginManifest(manifest) ? "gui" : root.kind,
    id: String(manifest.id || fallbackId(root.name)).trim(),
    title: String(manifest.name || manifest.title || root.name).trim(),
    description: String(manifest.description || "").trim(),
    version: String(manifest.version || "").trim(),
    entry: String(manifest.entry || "").trim(),
    css: String(manifest.css || "").trim(),
    section,
    role: normalizePluginRole(manifest.role, section, manifest.overhaul),
    preserveChrome: manifest.preserveChrome === true,
    public: manifest.public === true
  };
}

function listInstalledPlugins() {
  const seen = new Set();
  const installed = [];
  const roots = dlcSources.listEnabledSourceRoots().map((entry) => entry.root);
  if (!roots.includes(dlcRoot)) {
    roots.unshift(dlcRoot);
  }
  for (const root of roots) {
    for (const kind of ["plugin", "api"]) {
      const dirName = kind === "api" ? "apis" : "plugins";
      for (const name of listContentDirs(path.join(root, dirName))) {
        if (seen.has(name)) continue;
        const manifest = readPluginManifest(name);
        if (!manifest) continue;
        seen.add(name);
        installed.push(manifest);
      }
    }
  }
  return installed;
}

function listPublicPlugins() {
  return listInstalledPlugins().filter((plugin) => plugin.public === true);
}

function isPublicPlugin(name) {
  const manifest = readPluginManifest(name);
  return Boolean(manifest && manifest.public === true);
}

function pluginServerEntryFileName(manifest) {
  const server = manifest?.server ?? manifest?.api ?? null;
  if (typeof server === "string") {
    return path.basename(server.trim());
  }
  if (server && typeof server === "object" && typeof server.entry === "string") {
    return path.basename(server.entry.trim());
  }
  return "server.js";
}

function isRestrictedPublicPluginFile(name, fileName) {
  const safeFile = String(fileName || "").trim();
  if (!safeFile || /^config\.json$/i.test(safeFile)) {
    return true;
  }
  const manifest = readJsonIfPresent(path.join(resolvePluginRoot(name).dir, "manifest.json"));
  const serverEntry = pluginServerEntryFileName(manifest);
  return Boolean(serverEntry) && safeFile.toLowerCase() === String(serverEntry).toLowerCase();
}

function resolvePluginAsset(name, fileName, dirName = "") {
  const safeName = assertSafePluginName(name);
  const safeFile = String(fileName || "").trim();
  if (!safeFile
    || safeFile.includes("/")
    || safeFile.includes("\\")
    || safeFile === "."
    || safeFile === ".."
    || safeFile.startsWith(".")) {
    return null;
  }
  const extension = path.extname(safeFile).toLowerCase();
  if (!PLUGIN_ASSET_EXTENSIONS.has(extension)) {
    return null;
  }
  const safeDir = assertSafeDirName(dirName);
  const root = resolvePluginRoot(safeName);
  // User uploads/overrides (storage) win over legacy media and stock files.
  const contentDirs = pluginContentDirs(safeName, root.dir, safeDir);
  const storageOverride = firstExistingPath([path.join(contentDirs[0], safeFile)]);
  if (storageOverride) return storageOverride;
  const relative = safeDir ? `${safeDir}/${safeFile}` : safeFile;
  if (isTombstoned(readTombstones(safeName), relative)) return null;
  const fullPath = firstExistingPath(contentDirs.slice(1).map((baseDir) => path.join(baseDir, safeFile)));
  return fullPath || null;
}

function assertSafeDirName(value) {
  const safe = String(value || "").trim();
  if (!safe || safe.startsWith(".") || safe.includes("/") || safe.includes("\\")) {
    return null;
  }
  return safe;
}

// List asset files inside a plugin subfolder (e.g. "music") so plugins can
// discover admin-managed content at runtime. Hidden files are skipped and only
// whitelisted extensions are returned.
function listPluginAssets(name, dirName = "") {
  const safeName = assertSafePluginName(name);
  const pluginDir = resolvePluginRoot(safeName).dir;
  const safeDir = assertSafeDirName(dirName);
  // Stock first, then legacy media, then storage media, so later entries win.
  const dirs = pluginContentDirs(safeName, pluginDir, safeDir).slice().reverse();
  const tombstones = readTombstones(safeName);
  const byName = new Map();
  dirs.forEach((baseDir) => {
    if (!isDirectory(baseDir)) {
      return;
    }
    fs.readdirSync(baseDir, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        return;
      }
      if (/^config\.json$/i.test(entry.name)) {
        return;
      }
      const relative = safeDir ? `${safeDir}/${entry.name}` : entry.name;
      if (isTombstoned(tombstones, relative)) {
        return;
      }
      if (!PLUGIN_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return;
      }
      const fullPath = path.join(baseDir, entry.name);
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch (_error) {}
      byName.set(entry.name, { name: entry.name, size });
    });
  });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// List subdirectories inside a plugin folder (or the plugin root when
// dirName is empty) so plugins like the music player can discover
// admin-created playlists. Hidden folders are skipped.
function listPluginSubdirs(name, dirName = "") {
  const safeName = assertSafePluginName(name);
  const pluginDir = resolvePluginRoot(safeName).dir;
  const safeDir = assertSafeDirName(dirName);
  const dirs = pluginContentDirs(safeName, pluginDir, safeDir);
  const tombstones = readTombstones(safeName);
  const names = new Set();
  dirs.forEach((baseDir) => {
    if (!isDirectory(baseDir)) {
      return;
    }
    fs.readdirSync(baseDir, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        return;
      }
      if (baseDir === pluginDir && PLUGIN_LAYOUT_SKIP_DIRS.includes(entry.name)) {
        return;
      }
      const relative = safeDir ? `${safeDir}/${entry.name}` : entry.name;
      if (isTombstoned(tombstones, relative) || isTombstoned(tombstones, `${relative}/`)) {
        return;
      }
      names.add(entry.name);
    });
  });
  return [...names].sort((a, b) => a.localeCompare(b)).map((dir) => ({ name: dir }));
}

// Playlists are plain folders inside the plugin (the music player treats every
// folder as a playlist). Creation is just an mkdir so an empty playlist can be
// picked before any song is uploaded into it.
function createPluginPlaylist(name, playlistName) {
  const safeName = assertSafePluginName(name);
  const safePlaylist = assertSafeDirName(playlistName);
  if (!safePlaylist) {
    throw new Error("Playlist name must be a simple folder name.");
  }
  const pluginDir = resolvePluginRoot(safeName).dir;
  if (!isDirectory(pluginDir)) {
    throw new Error(`Plugin '${safeName}' is not installed.`);
  }
  const layout = ensurePluginDataLayout(safeName, pluginDir);
  const playlistDir = path.join(layout.media, safePlaylist);
  if (fs.existsSync(playlistDir) && !fs.statSync(playlistDir).isDirectory()) {
    throw new Error(`'${safePlaylist}' exists and is not a folder.`);
  }
  fs.mkdirSync(playlistDir, { recursive: true });
  removeTombstone(safeName, safePlaylist);
  removeTombstone(safeName, `${safePlaylist}/`);
  return { name: safePlaylist, created: true };
}

// Removes a playlist folder and every file inside it. Refuses the plugin root
// and the default "music" folder so the out-of-the-box playlist survives.
function removePluginPlaylist(name, playlistName) {
  const safeName = assertSafePluginName(name);
  const safePlaylist = assertSafeDirName(playlistName);
  if (!safePlaylist) {
    throw new Error("Playlist name must be a simple folder name.");
  }
  if (safePlaylist === "music") {
    throw new Error("The default 'music' playlist cannot be deleted.");
  }
  const pluginDir = resolvePluginRoot(safeName).dir;
  if (!isDirectory(pluginDir)) {
    throw new Error(`Plugin '${safeName}' is not installed.`);
  }
  // Only user-data playlists are removed from disk; a stock folder in the
  // checkout is hidden with a tombstone so the repo stays pull-only.
  const layout = pluginDataLayout(safeName);
  const legacy = legacyPluginLayout(pluginDir);
  const stockDir = path.join(pluginDir, safePlaylist);
  const candidates = [
    path.join(layout.media, safePlaylist),
    path.join(legacy.media, safePlaylist)
  ];
  let removed = false;
  candidates.forEach((playlistDir) => {
    if (!isDirectory(playlistDir)) {
      return;
    }
    fs.rmSync(playlistDir, { recursive: true, force: true });
    removed = true;
  });
  if (isDirectory(stockDir)) {
    addTombstone(safeName, `${safePlaylist}/`);
    removed = true;
  }
  return { name: safePlaylist, removed };
}

// Plugin settings live in config.json inside the plugin folder. Admins can
// read and overwrite them through the API.
const MAX_PLUGIN_CONFIG_BYTES = 256 * 1024;

function readPluginConfig(name) {
  const safeName = assertSafePluginName(name);
  return readJsonIfPresent(resolvePluginConfigFile(safeName, resolvePluginRoot(safeName).dir));
}

function writePluginConfig(name, config) {
  const root = resolvePluginRoot(name);
  if (!isDirectory(root.dir)) {
    throw new Error(`Plugin '${root.name}' is not installed.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Plugin config must be a JSON object.");
  }
  const serialized = JSON.stringify(config, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLUGIN_CONFIG_BYTES) {
    throw new Error(`Plugin config exceeds ${MAX_PLUGIN_CONFIG_BYTES} bytes.`);
  }
  const layout = ensurePluginDataLayout(root.name, root.dir);
  writeFileAtomic(layout.configFile, `${serialized}\n`);
  return config;
}

// --- Plugin content files (admin-managed media folders) ----------------------

const DEFAULT_PLUGIN_UPLOAD_BYTES = 25 * 1024 * 1024;

function resolvePluginUploadLimit() {
  try {
    const { getRuntimeSettings } = require("./runtime-settings");
    const configured = Number(getRuntimeSettings().pluginUploadLimitBytes);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
  } catch (_error) {
    // Fall through to the default.
  }
  return DEFAULT_PLUGIN_UPLOAD_BYTES;
}

function assertSafePluginFileName(value) {
  const safe = String(value || "").trim();
  if (!safe
    || safe.startsWith(".")
    || safe.includes("/")
    || safe.includes("\\")
    || safe.length > 200) {
    return null;
  }
  return safe;
}

function writePluginAssetFile(name, dirName, fileName, dataBuffer) {
  const safeName = assertSafePluginName(name);
  const safeDir = assertSafeDirName(dirName);
  if (dirName && !safeDir) {
    throw new Error("Invalid folder name.");
  }
  const pluginDir = resolvePluginRoot(safeName).dir;
  if (!isDirectory(pluginDir)) {
    throw new Error(`Plugin '${safeName}' is not installed.`);
  }
  const contentDir = resolvePluginContentDir(safeName, pluginDir, safeDir || "", { forWrite: true });
  const safeFile = assertSafePluginFileName(fileName);
  if (!safeFile) {
    throw new Error("Invalid file name.");
  }
  const extension = path.extname(safeFile).toLowerCase();
  if (!UPLOADABLE_PLUGIN_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file type. Allowed: ${Array.from(UPLOADABLE_PLUGIN_EXTENSIONS).join(", ")}.`);
  }
  if (!Buffer.isBuffer(dataBuffer) || !dataBuffer.length) {
    throw new Error("No file data provided.");
  }
  const uploadLimit = resolvePluginUploadLimit();
  if (dataBuffer.length > uploadLimit) {
    throw new Error(`File exceeds the ${Math.round(uploadLimit / (1024 * 1024))}MB plugin upload limit.`);
  }
  fs.mkdirSync(contentDir, { recursive: true });
  const fullPath = path.join(contentDir, safeFile);
  writeFileAtomic(fullPath, dataBuffer);
  removeTombstone(safeName, safeDir ? `${safeDir}/${safeFile}` : safeFile);
  return {
    name: safeFile,
    size: dataBuffer.length,
    path: fullPath
  };
}

function removePluginAssetFile(name, dirName, fileName) {
  const safeName = assertSafePluginName(name);
  const safeDir = assertSafeDirName(dirName);
  const pluginDir = resolvePluginRoot(safeName).dir;
  const layout = pluginDataLayout(safeName);
  const legacy = legacyPluginLayout(pluginDir);
  const safeFile = assertSafePluginFileName(fileName);
  if (!safeFile) {
    throw new Error("Invalid file name.");
  }
  const dirKey = safeDir || "";
  const relative = dirKey ? `${dirKey}/${safeFile}` : safeFile;
  const joinAsset = (base) => (dirKey ? path.join(base, dirKey, safeFile) : path.join(base, safeFile));
  const storagePath = joinAsset(layout.media);
  const legacyPath = joinAsset(legacy.media);
  const stockPath = joinAsset(pluginDir);
  const existed = [storagePath, legacyPath, stockPath].some((fullPath) => {
    try {
      return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    } catch (_error) {
      return false;
    }
  });
  let removed = false;
  [storagePath, legacyPath].forEach((fullPath) => {
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
        removed = true;
      }
    } catch (_error) {}
  });
  // Hide a stock copy without touching the checkout (pull-only).
  if (existed) addTombstone(safeName, relative);
  return existed || removed;
}

const MAX_PLUGIN_LOG_BYTES = 512 * 1024;

function resolvePluginLogFile(name, pluginDir) {
  const storageFile = path.join(pluginDataLayout(name).logs, "plugin.log");
  if (fs.existsSync(storageFile)) return storageFile;
  const legacyFile = path.join(legacyPluginLayout(pluginDir).logs, "plugin.log");
  return fs.existsSync(legacyFile) ? legacyFile : storageFile;
}

function appendPluginLog(name, entry = {}) {
  const safeName = assertSafePluginName(name);
  const pluginDir = resolvePluginRoot(safeName).dir;
  if (!isDirectory(pluginDir)) {
    return null;
  }
  const layout = ensurePluginDataLayout(safeName, pluginDir);
  const file = path.join(layout.logs, "plugin.log");
  const record = {
    timestamp: new Date().toISOString(),
    level: String(entry.level || "info").toLowerCase(),
    message: String(entry.message == null ? "" : entry.message).slice(0, 2000)
  };
  if (entry.details && typeof entry.details === "object") {
    record.details = entry.details;
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  try {
    if (fs.statSync(file).size > MAX_PLUGIN_LOG_BYTES) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-400).join("\n")}\n`, "utf8");
    }
  } catch (_error) {}
  return record;
}

function readPluginLogs(name, { limit = 200, level = "" } = {}) {
  const safeName = assertSafePluginName(name);
  const file = resolvePluginLogFile(safeName, resolvePluginRoot(safeName).dir);
  if (!fs.existsSync(file)) {
    return [];
  }
  const wanted = String(level || "").toLowerCase();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const entries = [];
  lines.forEach((line) => {
    try {
      const parsed = JSON.parse(line);
      if (wanted && String(parsed.level || "") !== wanted) {
        return;
      }
      entries.push(parsed);
    } catch (_error) {
      entries.push({ timestamp: "", level: "info", message: line });
    }
  });
  return entries.slice(-Math.min(500, Math.max(1, Number(limit) || 200))).reverse();
}

function clearPluginLogs(name) {
  const safeName = assertSafePluginName(name);
  const pluginDir = resolvePluginRoot(safeName).dir;
  [path.join(pluginDataLayout(safeName).logs, "plugin.log"), path.join(legacyPluginLayout(pluginDir).logs, "plugin.log")]
    .forEach((file) => {
      if (fs.existsSync(file)) {
        fs.writeFileSync(file, "", "utf8");
      }
    });
  return { cleared: true };
}

// --- Third-party plugin scaffolding ------------------------------------------

const PLUGIN_ENTRY_TEMPLATE = (pluginName, title, version) => `/* ${pluginName}.js — user-created DLC plugin.
 * Registers with window.TaroTimePluginHost and mounts into the top bar host.
 * helpers: assetUrl(file), fileUrl(dir, file), listFiles(dir), pluginName, ui.
 * Set manifest "role": "skin" for a full UI overhaul instead of a top-bar widget.
 */
(function () {
  "use strict";

  const host = window.TaroTimePluginHost;
  if (!host || typeof host.register !== "function") {
    console.warn("[${pluginName}] TaroTimePluginHost is not available.");
    return;
  }

  host.register({
    id: "${pluginName}",
    name: "${title}",
    version: "${version}",
    mount(containerEl, helpers) {
      // containerEl is this plugin's slot in the top bar host.
      // Uncomment the next lines for a simple visible widget:
      // containerEl.style.display = "flex";
      // containerEl.textContent = "Hello from ${title}";
      return null; // optional cleanup function on unmount
    }
  });
})();
`;

const PLUGIN_SKIN_ENTRY_TEMPLATE = (pluginName, title, version) => `/* ${pluginName}.js — UI overhaul (skin) plugin.
 * Replaces the default top bar with a custom chrome. App pages stay the same;
 * only the shell/layout changes. helpers.ui: hideDefaultChrome, listNav,
 * openNav, attachPages, attachWidgets, getActiveSection, onSectionChange.
 */
(function () {
  "use strict";

  const host = window.TaroTimePluginHost;
  if (!host || typeof host.register !== "function") {
    console.warn("[${pluginName}] TaroTimePluginHost is not available.");
    return;
  }

  host.register({
    id: "${pluginName}",
    name: "${title}",
    version: "${version}",
    role: "skin",
    mount(shellEl, helpers) {
      const ui = helpers.ui;
      if (!ui) {
        console.warn("[${pluginName}] helpers.ui is not available.");
        return null;
      }
      ui.hideDefaultChrome();
      shellEl.className = "${pluginName}-shell";
      shellEl.innerHTML = '<nav class="${pluginName}-nav"></nav><div class="${pluginName}-pages"></div>';
      const navEl = shellEl.querySelector(".${pluginName}-nav");
      const pagesEl = shellEl.querySelector(".${pluginName}-pages");
      ui.attachPages(pagesEl);

      function renderNav() {
        navEl.innerHTML = "";
        const active = ui.getActiveSection();
        ui.listNav().filter((item) => !item.hidden).forEach((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = item.label;
          button.className = item.id === "open-" + active || (active === "home" && item.id === "open-home-menu") ? "is-active" : "";
          button.addEventListener("click", () => {
            if (item.children && item.children.length) {
              ui.openNav(item.children[0].id);
            } else {
              ui.openNav(item.id);
            }
          });
          navEl.appendChild(button);
        });
      }

      renderNav();
      const stop = ui.onSectionChange(renderNav);
      return () => {
        if (typeof stop === "function") stop();
      };
    }
  });
})();
`;

const PLUGIN_SKIN_CSS_TEMPLATE = (pluginName) => `/* ${pluginName} — starter UI overhaul layout (left nav, content on the right). */
.${pluginName}-shell {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
  width: 100%;
}
.${pluginName}-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-right: 1px solid var(--tt-border);
  background: var(--tt-bg);
  overflow: auto;
}
.${pluginName}-nav button {
  text-align: left;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: var(--tt-text);
  cursor: pointer;
}
.${pluginName}-nav button.is-active {
  background: var(--tt-surface);
}
.${pluginName}-pages {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
`;

function createPluginScaffold(name, input = {}) {
  const safeName = assertSafePluginName(name);
  const pluginDir = path.join(dlcRoot, "plugins", safeName);
  if (isDirectory(pluginDir)) {
    throw new Error(`Plugin '${safeName}' already exists.`);
  }

  const title = String(input?.title || input?.label || safeName).trim().slice(0, 80) || safeName;
  const version = String(input?.version || "1.0.0").trim().slice(0, 40) || "1.0.0";
  const description = String(input?.description || "").trim().slice(0, 400);
  const entry = safeName ? `${safeName}.js` : "plugin.js";
  const role = normalizePluginRole(input?.role, input?.section, input?.overhaul);
  let css = String(input?.css || "").trim().slice(0, 120);
  if (role === "skin" && !css) {
    css = `${safeName}.css`;
  }

  fs.mkdirSync(pluginDir, { recursive: true });
  const layout = ensurePluginDataLayout(safeName, pluginDir);

  const manifest = {
    id: safeName,
    name: title,
    version,
    description,
    entry,
    css
  };
  if (role === "skin") {
    manifest.role = "skin";
  }
  fs.writeFileSync(
    path.join(pluginDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(pluginDir, entry),
    role === "skin"
      ? PLUGIN_SKIN_ENTRY_TEMPLATE(safeName, title, version)
      : PLUGIN_ENTRY_TEMPLATE(safeName, title, version),
    "utf8"
  );
  if (!fs.existsSync(layout.configFile)) {
    fs.writeFileSync(layout.configFile, "{}\n", "utf8");
  }
  fs.writeFileSync(
    path.join(pluginDir, "README.md"),
    [
      `# ${title}`,
      "",
      "Stock plugin files live in this folder (`manifest.json`, entry JS/CSS).",
      "Operator data is stored outside the repository and is never published:",
      "",
      "- `storage/plugin-data/" + safeName + "/config.json` — settings",
      "- `storage/plugin-data/" + safeName + "/logs/plugin.log` — plugin logs",
      "- `storage/plugin-data/" + safeName + "/media/` — uploads, playlists, extra assets",
      ""
    ].join("\n"),
    "utf8"
  );
  if (css) {
    fs.writeFileSync(
      path.join(pluginDir, css),
      role === "skin" ? PLUGIN_SKIN_CSS_TEMPLATE(safeName) : "/* plugin styles */\n",
      "utf8"
    );
  }

  invalidateCatalogCache();
  return {
    name: safeName,
    title,
    version,
    description,
    entry,
    css,
    role
  };
}

function createTextDlc(input = {}, { log = () => {} } = {}) {
  const { slugify: slugifyText, sanitizeText } = require("./text-importer");
  const title = sanitizeText(input?.title || "").trim().slice(0, 120) || "Untitled text";
  const safeId = assertSafePluginName(
    (slugifyText(input?.id || title) || "untitled-text").slice(0, 40).replace(/-+$/g, "") || "untitled-text"
  );
  const textFolder = String(input.folderName || "").trim() ? assertSafeName(input.folderName) : safeId;
  const previousTextFolder = String(input.renameFrom || "").trim() ? assertSafeName(input.renameFrom) : "";
  if (input.overwrite === true && previousTextFolder && previousTextFolder !== textFolder) {
    const previousDir = path.join(dlcRoot, "texts", previousTextFolder);
    if (isDirectory(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
  }
  const textDir = path.join(dlcRoot, "texts", textFolder);
  if (isDirectory(textDir)) {
    if (input.overwrite === true) {
      fs.rmSync(textDir, { recursive: true, force: true });
    } else {
      throw new Error(`Text '${textFolder}' already exists.`);
    }
  }

  const rawWorks = Array.isArray(input?.document?.works) ? input.document.works : [];
  if (!rawWorks.length) {
    throw new Error("The text has no sections to save. Preview it first and keep at least one passage.");
  }
  const cleanText = (value) => (typeof value === "string" ? sanitizeText(value) : value);
  const works = rawWorks.map((work) => ({
    ...work,
    title: cleanText(work?.title),
    sections: (Array.isArray(work?.sections) ? work.sections : []).map((section) => ({
      ...section,
      title: cleanText(section?.title),
      label: cleanText(section?.label),
      verses: (Array.isArray(section?.verses) ? section.verses : []).map((verse) => ({
        ...verse,
        text: cleanText(verse?.text)
      }))
    }))
  }));

  const description = sanitizeText(input?.description || "").trim().slice(0, 800);
  const shortTitle = sanitizeText(input?.shortTitle || title).trim().slice(0, 80);
  const sourceDocument = {
    schemaVersion: 1,
    type: "structured-text-source",
    title,
    shortTitle,
    metadata: {
      description
    },
    works
  };
  const manifest = {
    id: safeId,
    title,
    shortTitle,
    description,
    language: sanitizeText(input?.language || "English").trim().slice(0, 60) || "English",
    script: sanitizeText(input?.script || "Latin").trim().slice(0, 60) || "Latin",
    tradition: sanitizeText(input?.tradition || "").trim().slice(0, 80),
    workLabel: sanitizeText(input?.workLabel || "Text").trim().slice(0, 40) || "Text",
    sectionLabel: sanitizeText(input?.sectionLabel || "Section").trim().slice(0, 40) || "Section",
    verseLabel: sanitizeText(input?.verseLabel || "Passage").trim().slice(0, 40) || "Passage",
    input: {
      path: `${safeId}.json`,
      format: "structured-json"
    }
  };

  fs.mkdirSync(textDir, { recursive: true });
  fs.writeFileSync(path.join(textDir, "metadata.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(textDir, `${safeId}.json`), `${JSON.stringify(sourceDocument, null, 2)}\n`, "utf8");
  const originalText = sanitizeText(input?.text || "").trim();
  if (originalText && !originalText.startsWith("{")) {
    fs.writeFileSync(path.join(textDir, "source.txt"), originalText.endsWith("\n") ? originalText : `${originalText}\n`, "utf8");
  }

  // Created DLC stays in the local checkout so the admin can review, publish,
  // or install it deliberately. No auto-install / hot reload here.
  invalidateCatalogCache();

  return {
    id: safeId,
    name: textFolder,
    title,
    kind: "text",
    staged: false,
    overwritten: input.overwrite === true,
    path: `texts/${textFolder}`
  };
}

function makeReferenceEntryId(key, title, keyScheme, slugifyText) {
  const scheme = String(keyScheme || "word").trim();
  const rawKey = String(key || title || "").trim();
  const rawTitle = String(title || key || "").trim();
  if (scheme === "strongs") {
    const match = rawKey.match(/^[HG]\d+/i) || rawTitle.match(/^[HG]\d+/i);
    return match ? match[0].toUpperCase() : (slugifyText(rawKey || rawTitle) || rawKey);
  }
  if (scheme === "term") {
    return (rawTitle || rawKey).toLowerCase();
  }
  return slugifyText(rawKey || rawTitle) || rawKey.toLowerCase();
}

function parseReferenceDocument(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Upload a JSON or JSONL file of reference entries first.");
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw new Error(`That file is not valid JSON. JSONL failed on line ${index + 1}.`);
      }
    }
    if (!rows.length) {
      throw new Error("That file is not valid JSON or JSONL.");
    }
    return rows;
  }
}

function referenceEntryBody(item) {
  const direct = item?.summary || item?.body || item?.definition || item?.meaning || item?.gloss;
  if (direct) return direct;
  const senses = Array.isArray(item?.senses) ? item.senses : [];
  return senses.map((sense) => String(sense?.gloss || "").trim()).filter(Boolean).join(" · ");
}

function normalizeReferenceEntries(raw, keyScheme = "word") {
  const { slugify: slugifyText } = require("./text-importer");
  const entries = {};
  const add = (key, title, body, extra) => {
    const id = makeReferenceEntryId(key, title, keyScheme, slugifyText);
    if (!id || entries[id]) {
      return;
    }
    const record = {};
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      Object.entries(extra).forEach(([field, value]) => {
        if (value == null || value === "") {
          return;
        }
        record[field] = value;
      });
    }
    if (!String(record.title || "").trim()) {
      record.title = String(title || id).trim() || id;
    }
    if (!String(record.body || "").trim()) {
      record.body = String(body || "").trim();
    }
    entries[id] = record;
  };

  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (typeof item === "string") {
        add(item, item, "");
        return;
      }
      if (!item || typeof item !== "object") {
        return;
      }
      add(
        item.slug || item.id || item.keyword || item.word || item.term || item.title,
        item.keyword || item.word || item.term || item.title || item.slug,
        referenceEntryBody(item),
        item
      );
    });
    return entries;
  }

  if (!raw || typeof raw !== "object") {
    return entries;
  }
  const source = raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)
    ? raw.entries
    : raw;
  Object.entries(source).forEach(([key, value]) => {
    if (typeof value === "string") {
      add(key, key, value);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    add(
      key,
      value.title || value.keyword || value.word || value.term || key,
      referenceEntryBody(value) || value.body || value.summary || value.definition,
      value
    );
  });
  return entries;
}

function previewReferenceImport(input = {}) {
  const parsed = parseReferenceDocument(input.text);
  const keyScheme = REFERENCE_KEY_SCHEMES.has(String(input.keyScheme || parsed.keyScheme || "").trim())
    ? String(input.keyScheme || parsed.keyScheme).trim()
    : "word";
  const entries = normalizeReferenceEntries(parsed, keyScheme);
  const keys = Object.keys(entries);
  if (!keys.length) {
    throw new Error("No reference entries found. Use an array of { keyword, summary } or a map of id → { title, body }.");
  }
  const { slugify: slugifyText } = require("./text-importer");
  const filename = String(input.filename || "").replace(/\.[^.]+$/, "");
  const title = String(input.title || parsed.title || filename.replace(/[-_]+/g, " ") || "Untitled reference").trim().slice(0, 120);
  const id = slugifyText(input.id || parsed.id || title) || "untitled-reference";
  const shuffled = keys.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  const previewKeys = shuffled.slice(0, 9);
  const list = previewKeys.map((key) => ({
    id: key,
    title: entries[key].title,
    body: String(entries[key].body || "").slice(0, 140),
    icon: entries[key].icon || "",
    category: entries[key].category || ""
  }));
  return {
    id: id.slice(0, 40),
    title,
    description: String(input.description || parsed.description || "").trim().slice(0, 800),
    kind: REFERENCE_KINDS.has(String(input.kind || parsed.kind || "").trim())
      ? String(input.kind || parsed.kind).trim()
      : "dictionary",
    keyScheme,
    count: keys.length,
    sample: list,
    list,
    entries
  };
}

function createReferenceDlc(input = {}, { log = () => {} } = {}) {
  const preview = input.entries && typeof input.entries === "object" && !Array.isArray(input.entries)
    ? {
      id: input.id,
      title: input.title,
      description: input.description,
      kind: input.kind,
      keyScheme: input.keyScheme,
      entries: input.entries,
      count: Object.keys(input.entries).length
    }
    : previewReferenceImport(input);
  if (!preview.count) {
    throw new Error("The reference has no entries to save.");
  }
  const { slugify: slugifyText } = require("./text-importer");
  const title = String(preview.title || "Untitled reference").trim().slice(0, 120);
  const safeId = assertSafePluginName(
    (slugifyText(preview.id || title) || "untitled-reference").slice(0, 40).replace(/-+$/g, "") || "untitled-reference"
  );
  const refFolder = String(input.folderName || "").trim() ? assertSafeName(input.folderName) : safeId;
  const previousRefFolder = String(input.renameFrom || "").trim() ? assertSafeName(input.renameFrom) : "";
  if (input.overwrite === true && previousRefFolder && previousRefFolder !== refFolder) {
    const previousDir = path.join(dlcRoot, "references", previousRefFolder);
    if (isDirectory(previousDir)) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
  }
  const refDir = path.join(dlcRoot, "references", refFolder);
  if (isDirectory(refDir)) {
    if (input.overwrite === true) {
      fs.rmSync(refDir, { recursive: true, force: true });
    } else {
      throw new Error(`Reference '${refFolder}' already exists.`);
    }
  }
  const kind = REFERENCE_KINDS.has(String(preview.kind || "").trim()) ? String(preview.kind).trim() : "dictionary";
  const keyScheme = REFERENCE_KEY_SCHEMES.has(String(preview.keyScheme || "").trim()) ? String(preview.keyScheme).trim() : "word";
  const manifest = {
    id: safeId,
    title,
    description: String(preview.description || "").trim().slice(0, 800),
    kind,
    keyScheme,
    entriesFile: "entries.json"
  };
  if (input.fieldConfig && typeof input.fieldConfig === "object") {
    const fieldConfig = {};
    Object.entries(input.fieldConfig).forEach(([key, value]) => {
      const name = String(key || "").trim();
      if (!name || !value || typeof value !== "object") {
        return;
      }
      const columns = {};
      if (value.columns && typeof value.columns === "object") {
        Object.entries(value.columns).forEach(([columnKey, columnValue]) => {
          const columnName = String(columnKey || "").trim();
          if (!columnName || !columnValue || typeof columnValue !== "object") {
            return;
          }
          columns[columnName] = {
            label: String(columnValue.label || columnName).trim().slice(0, 80) || columnName,
            visible: columnValue.visible !== false
          };
        });
      }
      fieldConfig[name] = {
        label: String(value.label || name).trim().slice(0, 80) || name,
        visible: value.visible !== false,
        list: value.list === true,
        ...(Object.keys(columns).length ? { columns } : {})
      };
    });
    if (Object.keys(fieldConfig).length) {
      manifest.fieldConfig = fieldConfig;
    }
    if (Array.isArray(input.listOrder)) {
      const allowed = new Set(Object.keys(fieldConfig).filter((key) => fieldConfig[key].list));
      manifest.listOrder = input.listOrder
        .map((key) => String(key || "").trim())
        .filter((key) => allowed.has(key));
    }
  }
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, "reference.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(refDir, "entries.json"), `${JSON.stringify(preview.entries, null, 2)}\n`, "utf8");
  // Created DLC stays in the local checkout so the admin can review, publish,
  // or install it deliberately. No auto-install / hot reload here.
  invalidateCatalogCache();
  return {
    id: safeId,
    name: refFolder,
    title,
    kind: "reference",
    count: preview.count,
    staged: false,
    overwritten: input.overwrite === true,
    path: `references/${refFolder}`
  };
}

const DECK_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function createDeckDlcFromZip(buffer, { log = () => {}, overwrite = false, folderName = "", renameFrom = "" } = {}) {
  const { unpackStoreZip } = require("../lib/zip-store");
  const { slugify: slugifyText } = require("./text-importer");
  const entries = unpackStoreZip(buffer);
  if (!entries.length) {
    throw new Error("The deck zip is empty.");
  }

  const deckEntry = entries.find((entry) => /(^|\/)deck\.json$/i.test(entry.name));
  if (!deckEntry) {
    throw new Error("The deck zip must include deck.json.");
  }
  let manifest;
  try {
    manifest = JSON.parse(deckEntry.data.toString("utf8"));
  } catch (_error) {
    throw new Error("deck.json is not valid JSON.");
  }
  if (!manifest || typeof manifest !== "object") {
    throw new Error("deck.json is invalid.");
  }

  const title = String(manifest.name || manifest.title || "").trim().slice(0, 120) || "Untitled deck";
  const safeId = assertSafePluginName(
    (slugifyText(manifest.id || title) || "untitled-deck").slice(0, 40).replace(/-+$/g, "") || "untitled-deck"
  );
  // The folder name is the catalog identity; deck.json id can be a slug that
  // differs from it (e.g. "Rider Waite" folder, "rider-waite" id). Editing must
  // overwrite the original folder, so callers can pin it explicitly.
  // Decks live under their display name ("Sola Busca"), matching built-in decks.
  let folderId;
  if (String(folderName || "").trim()) {
    folderId = assertSafeName(folderName);
  } else {
    try {
      folderId = assertSafeName(title);
    } catch (_error) {
      folderId = safeId;
    }
  }
  const previousFolder = String(renameFrom || "").trim() ? assertSafeName(renameFrom) : "";
  if (overwrite === true && previousFolder && previousFolder !== folderId) {
    // Remove the old workspace folder plus any installed runtime copies so a
    // rename updates the same deck instead of leaving an orphan behind. Runtime
    // copies are matched by old folder name or by deck.json id/title, which
    // also sweeps up copies installed under a stale folder name.
    const previousWorkspace = path.join(dlcRoot, "decks", previousFolder);
    if (isDirectory(previousWorkspace)) {
      fs.rmSync(previousWorkspace, { recursive: true, force: true });
    }
    [decksImportRoot, sourceDecksRoot, decksRoot].forEach((base) => {
      if (!isDirectory(base)) return;
      fs.readdirSync(base, { withFileTypes: true }).forEach((entry) => {
        if (!entry.isDirectory()) return;
        const record = readJsonIfPresent(path.join(base, entry.name, "deck.json"));
        if (!record) return;
        const sameId = String(record.id || "").trim() === String(safeId || "").trim();
        const sameTitle = String(record.name || record.title || record.label || "").trim() === previousFolder;
        if (sameId || sameTitle) {
          fs.rmSync(path.join(base, entry.name), { recursive: true, force: true });
        }
      });
    });
    log(`Renamed decks/${previousFolder} -> decks/${folderId}.`);
  }
  const deckDir = path.join(dlcRoot, "decks", folderId);
  if (isDirectory(deckDir)) {
    if (overwrite === true) {
      fs.rmSync(deckDir, { recursive: true, force: true });
    } else {
      throw new Error(`Deck '${folderId}' already exists.`);
    }
  }

  manifest.id = safeId;
  manifest.name = title;
  if (!manifest.thumbnails || typeof manifest.thumbnails !== "object") {
    manifest.thumbnails = {
      root: "thumbs",
      width: 240,
      height: 360,
      fit: "inside",
      quality: 82
    };
  }

  fs.mkdirSync(deckDir, { recursive: true });
  let imageCount = 0;
  try {
    fs.writeFileSync(path.join(deckDir, "deck.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    entries.forEach((entry) => {
      if (/(^|\/)deck\.json$/i.test(entry.name)) {
        return;
      }
      const relative = String(entry.name || "").replace(/\\/g, "/");
      const extension = path.posix.extname(relative).toLowerCase();
      if (!DECK_IMAGE_EXTENSIONS.has(extension)) {
        return;
      }
      const parts = relative.split("/").filter((part) => part && part !== ".." && part !== ".");
      if (!parts.length) {
        return;
      }
      const dest = path.join(deckDir, ...parts);
      if (!dest.startsWith(deckDir + path.sep)) {
        throw new Error("Zip entry path escaped the deck folder.");
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
      imageCount += 1;
    });
    if (!imageCount) {
      throw new Error("The deck zip has no card images.");
    }
  } catch (error) {
    fs.rmSync(deckDir, { recursive: true, force: true });
    throw error;
  }

  // Created DLC stays in the local checkout so the admin can review, publish,
  // or install it deliberately. No auto-install / hot reload here.
  invalidateCatalogCache();

  return {
    id: safeId,
    name: folderId,
    title,
    kind: "deck",
    images: imageCount,
    staged: false,
    overwritten: overwrite === true,
    path: `decks/${folderId}`
  };
}

// --- Bulk install (server-side, survives client navigation) -------------------

const installAllState = {
  state: "idle", // idle | running | done | error
  kind: "",
  current: "",
  done: 0,
  total: 0,
  installed: 0,
  failed: [],
  message: ""
};
let installAllPromise = null;

function getInstallAllState() {
  return {
    ...installAllState,
    failed: [...installAllState.failed]
  };
}

function runInstallAll({ kind = "", log = () => {} } = {}) {
  return (async () => {
    installAllState.state = "running";
    installAllState.kind = String(kind || "").trim();
    installAllState.current = "";
    installAllState.done = 0;
    installAllState.total = 0;
    installAllState.installed = 0;
    installAllState.failed = [];
    installAllState.message = "";

    const catalog = await getCatalog({ refresh: true });
    const targets = catalog.items.filter((item) =>
      item?.status === "available" && (!installAllState.kind || item.kind === installAllState.kind)
    );
    installAllState.total = targets.length;

    for (const item of targets) {
      installAllState.current = item.name;
      try {
        installItem(item, { log });
        installAllState.installed += 1;
      } catch (error) {
        installAllState.failed.push({ name: item.name, error: String(error?.message || "install failed") });
        log(`[install-all] ${item.name} failed: ${error?.message || ""}`);
      }
      installAllState.done += 1;
    }

    const installedContent = targets.some((item) => CONTENT_KINDS.includes(item.kind))
      && installAllState.installed > 0;
    if (installedContent) {
      installAllState.current = "storage snapshot";
      installAllState.message = `Installed ${installAllState.installed} of ${installAllState.total}. Refreshing storage snapshot…`;
      const { startBackgroundHotReload, getHotReloadState } = require("./storage-bootstrap");
      await startBackgroundHotReload();
      const reload = getHotReloadState();
      if (reload.state === "error") {
        installAllState.state = "error";
        installAllState.current = "";
        installAllState.message = `Installed ${installAllState.installed} of ${installAllState.total}, but storage refresh failed: ${reload.message}`;
        invalidateCatalogCache();
        return;
      }
    }

    installAllState.current = "";
    installAllState.state = "done";
    installAllState.message = installedContent
      ? `Installed ${installAllState.installed} of ${installAllState.total}. Storage refreshed — decks are live.`
      : `Installed ${installAllState.installed} of ${installAllState.total}.`;
    invalidateCatalogCache();
  })().catch((error) => {
    installAllState.state = "error";
    installAllState.message = String(error?.message || "Install-all failed.");
    invalidateCatalogCache();
  });
}

function resolveExportDir(kind, name) {
  const safe = assertSafeName(name);
  const category = categoryByKind(kind);
  if (!category || category.kind === "pack") {
    return "";
  }
  if (category.kind === "plugin" || category.kind === "api") {
    try {
      const root = resolvePluginRoot(safe);
      if (root?.dir && isDirectory(root.dir)) {
        return root.dir;
      }
    } catch (_error) {}
  }
  const candidates = [path.join(dlcRoot, category.dir, safe)];
  if (category.kind === "deck") {
    candidates.push(path.join(decksImportRoot, safe), path.join(sourceDecksRoot, safe));
  }
  if (category.kind === "text") {
    candidates.push(path.join(textImportRoot, safe));
  }
  if (category.kind === "reference") {
    candidates.push(path.join(referencesImportRoot, safe));
  }
  return candidates.find((dir) => isDirectory(dir)) || "";
}

function exportDlcItem(kind, name) {
  const safe = assertSafeName(name);
  const category = categoryByKind(kind);
  if (!category || category.kind === "pack") {
    throw new Error("That DLC kind cannot be exported.");
  }
  const dir = resolveExportDir(kind, safe);
  if (!dir) {
    throw new Error(`'${safe}' is not installed or staged.`);
  }
  const { packDirectory, packStoreZip, unpackStoreZip } = require("../lib/zip-store");
  const isPlugin = category.kind === "plugin" || category.kind === "api";
  const packed = packDirectory(dir, isPlugin
    ? {
      skipNames: ["user-data", "media", "thumbs", "node_modules", "music", "uploads", "data", "storage", "playlists"],
      skipFiles: ["config.json", "presets.json", ".env"],
      skipFilePattern: /secret|credential|apikey|api-key|password|token/i
    }
    : {
      skipNames: ["thumbs", "node_modules"],
      skipFiles: ["config.json", ".env"]
    });
  const files = unpackStoreZip(packed);
  files.unshift({
    name: "kabbak-dlc.json",
    data: Buffer.from(`${JSON.stringify({
      schema: 1,
      kind: category.kind,
      name: safe,
      exportedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8")
  });
  return {
    filename: `${safe}.kabbak.zip`,
    buffer: packStoreZip(files)
  };
}

function stripZipRoot(files) {
  const names = files.map((file) => file.name).filter(Boolean);
  if (!names.length) {
    return files;
  }
  const top = names[0].split("/")[0];
  if (!top || !names.every((name) => name === top || name.startsWith(`${top}/`))) {
    return files;
  }
  return files
    .map((file) => ({ ...file, name: file.name === top ? "" : file.name.slice(top.length + 1) }))
    .filter((file) => file.name);
}

function detectImportedKind(files, meta) {
  const declared = String(meta?.kind || "").trim().toLowerCase();
  if (declared && categoryByKind(declared) && declared !== "pack") {
    return categoryByKind(declared).kind;
  }
  const names = files.map((file) => file.name.replace(/\\/g, "/").toLowerCase());
  if (names.some((name) => name === "deck.json" || name.endsWith("/deck.json"))) {
    return "deck";
  }
  if (names.some((name) => name === "reference.json" || name.endsWith("/reference.json"))) {
    return "reference";
  }
  if (names.some((name) => name === "metadata.json" || name.endsWith("/metadata.json"))) {
    return "text";
  }
  if (names.some((name) => name === "manifest.json" || name.endsWith("/manifest.json"))) {
    return "plugin";
  }
  throw new Error("Could not detect DLC kind. Include kabbak-dlc.json, deck.json, metadata.json, or manifest.json.");
}

function importDlcZip(buffer, { log = () => {} } = {}) {
  const { unpackStoreZip } = require("../lib/zip-store");
  const files = stripZipRoot(unpackStoreZip(buffer));
  if (!files.length) {
    throw new Error("The zip is empty.");
  }
  const metaEntry = files.find((file) => /(^|\/)kabbak-dlc\.json$/i.test(file.name));
  let meta = {};
  if (metaEntry) {
    try {
      meta = JSON.parse(metaEntry.data.toString("utf8"));
    } catch (_error) {
      meta = {};
    }
  }
  const kind = detectImportedKind(files, meta);
  const category = categoryByKind(kind);
  const name = assertSafeName(meta.name || path.basename(files[0].name.split("/")[0] || "imported-dlc"));
  const dest = path.join(dlcRoot, category.dir, name);
  if (isDirectory(dest)) {
    throw new Error(`'${name}' already exists in the DLC checkout.`);
  }
  fs.mkdirSync(dest, { recursive: true });
  try {
    files.forEach((file) => {
      if (/(^|\/)kabbak-dlc\.json$/i.test(file.name)) {
        return;
      }
      const relative = String(file.name || "").replace(/\\/g, "/");
      const parts = relative.split("/").filter((part) => part && part !== ".." && part !== ".");
      if (!parts.length) {
        return;
      }
      const target = path.join(dest, ...parts);
      if (!target.startsWith(dest + path.sep)) {
        throw new Error("Zip entry path escaped the DLC folder.");
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data);
    });
    if (kind === "deck") {
      stageDeck(name, log, dest);
    } else if (kind === "text") {
      stageText(name, log, dest);
    } else if (kind === "reference") {
      stageReference(name, log, dest);
    } else {
      log(`[${kind}] ${name} imported (${category.dir}/${name})`);
    }
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
  invalidateCatalogCache();
  if (kind !== "plugin" && kind !== "api") {
    try {
      require("./storage-bootstrap").startBackgroundHotReload();
    } catch (_error) {}
  }
  return { kind, name, title: name };
}

function startInstallAll(options = {}) {
  if (installAllPromise) {
    return installAllPromise;
  }
  installAllPromise = runInstallAll(options).finally(() => {
    installAllPromise = null;
  });
  return installAllPromise;
}

module.exports = {
  CATEGORIES,
  CONTENT_KINDS,
  REFERENCE_KINDS,
  REFERENCE_KEY_SCHEMES,
  SUPPORTED_TEXT_FORMATS,
  appendPluginLog,
  assertSafeName,
  categoryByKind,
  clearPluginLogs,
  createPluginPlaylist,
  createPluginScaffold,
  createReferenceDlc,
  previewReferenceImport,
  readReferenceDisplayConfig,
  createTextDlc,
  createDeckDlcFromZip,
  exportDlcItem,
  importDlcZip,
  dematerialize,
  MISSING_DLC_REPO_MESSAGE,
  ensureRepo,
  expandPack,
  findCatalogItem,
  formatSize,
  getCatalog,
  getDirSize,
  getInstallAllState,
  installItem,
  isRepoPresent,
  isSparse,
  isPublicPlugin,
  isRestrictedPublicPluginFile,
  listContentDirs,
  listInstalledPlugins,
  listPluginAssets,
  listPluginSubdirs,
  listPublicPlugins,
  materialize,
  normalizePackItems,
  readJsonIfPresent,
  readPluginConfig,
  readPluginLogs,
  resolvePluginDataDir,
  readPluginManifest,
  removePluginAssetFile,
  removePluginPlaylist,
  resolveBranch,
  resolvePluginAsset,
  resolvePluginRoot,
  resolvePluginUploadLimit,
  resolveRepoUrl,
  resolveStatus,
  startInstallAll,
  uninstallItem,
  updateItem,
  updateRepo,
  invalidateCatalogCache,
  writePluginAssetFile,
  writePluginConfig
};
