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
  sourceTextDataRoot
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

  try {
    git(["merge", "--ff-only", `origin/${branch}`], { cwd: dlcRoot, stdio: "inherit" });
  } catch (mergeError) {
    // Admin-edited files (plugin configs, uploaded pages, presets, logos)
    // live inside the checkout. A plain fast-forward refuses to run when one
    // of those files is dirty, so fall back to a selective update: move the
    // branch to the fetched commit, then re-apply the incoming content only
    // for clean paths that are present on disk. Locally modified/added files
    // keep the admin's version.
    const isAncestor = tryGit(["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], { cwd: dlcRoot }).ok;
    const dirty = listWorktreeDirtyPaths();
    if (!isAncestor || dirty.size === 0) {
      throw mergeError;
    }

    const changed = String(tryGit(["diff", "--name-only", "HEAD", `origin/${branch}`], { cwd: dlcRoot }).output || "")
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const keptPaths = changed.filter((changedPath) => dirty.has(changedPath) || !fs.existsSync(path.join(dlcRoot, changedPath)));
    const updatePaths = changed.filter((changedPath) => !keptPaths.includes(changedPath));

    keptPaths.forEach((keptPath) => log(`Keeping local version: ${keptPath}`));
    git(["reset", "--mixed", `origin/${branch}`], { cwd: dlcRoot, stdio: "inherit" });
    if (updatePaths.length) {
      git(["checkout", "HEAD", "--", ...updatePaths], { cwd: dlcRoot, stdio: "inherit" });
    }
    log("DLC updated selectively; admin-edited files were kept.");
  }

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
    return { ...base, id: deck?.id || fallbackId(name), title: deck?.name || deck?.label || deck?.title || name, description: deck?.description || "" };
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
    return { ...base, id: deck?.id || local?.id || fallbackId(name), title: deck?.name || deck?.label || deck?.title || local?.title || name, description: deck?.description || local?.description || "" };
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

  const source = path.join(root, category.dir, name);
  if (!isDirectory(source) || !fs.readdirSync(source).length) {
    throw new Error(`'${name}' could not be downloaded from the DLC repository (expected ${category.dir}/${name}).`);
  }

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

  if (category.kind === "deck") {
    removePath(path.join(decksImportRoot, name));
  } else if (category.kind === "plugin" || category.kind === "api") {
    try {
      removePath(resolvePluginRoot(name).dir);
    } catch (_error) {
      removePath(path.join(dlcRoot, category.dir, name));
    }
  } else if (category.kind === "reference") {
    removePath(path.join(referencesImportRoot, name));
  } else {
    const manifestPath = path.join(textImportRoot, `${name}.manifest.json`);
    const manifest = readJsonIfPresent(manifestPath);
    const extension = path.extname(String(manifest?.input?.path || ".txt")) || ".txt";
    removePath(path.join(textImportRoot, name + extension));
    removePath(manifestPath);
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
  const fullPath = safeDir
    ? path.join(root.dir, safeDir, safeFile)
    : path.join(root.dir, safeFile);
  try {
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return fullPath;
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
  const safeDir = assertSafeDirName(dirName);
  const baseDir = safeDir
    ? path.join(resolvePluginRoot(safeName).dir, safeDir)
    : resolvePluginRoot(safeName).dir;
  if (!isDirectory(baseDir)) return [];

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile() || entry.name.startsWith(".")) return false;
      return PLUGIN_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    })
    .map((entry) => {
      const fullPath = path.join(baseDir, entry.name);
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        // Unreadable file: list it with size 0 rather than aborting the listing.
      }
      return { name: entry.name, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// List subdirectories inside a plugin folder (or the plugin root when
// dirName is empty) so plugins like the music player can discover
// admin-created playlists. Hidden folders are skipped.
function listPluginSubdirs(name, dirName = "") {
  const safeName = assertSafePluginName(name);
  const safeDir = assertSafeDirName(dirName);
  const baseDir = safeDir
    ? path.join(resolvePluginRoot(safeName).dir, safeDir)
    : resolvePluginRoot(safeName).dir;
  if (!isDirectory(baseDir)) return [];

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  const playlistDir = path.join(pluginDir, safePlaylist);
  if (fs.existsSync(playlistDir) && !fs.statSync(playlistDir).isDirectory()) {
    throw new Error(`'${safePlaylist}' exists and is not a folder.`);
  }
  fs.mkdirSync(playlistDir, { recursive: true });
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
  const playlistDir = path.join(pluginDir, safePlaylist);
  if (!isDirectory(playlistDir)) {
    return { name: safePlaylist, removed: false };
  }
  fs.rmSync(playlistDir, { recursive: true, force: true });
  return { name: safePlaylist, removed: true };
}

// Plugin settings live in config.json inside the plugin folder. Admins can
// read and overwrite them through the API.
const MAX_PLUGIN_CONFIG_BYTES = 256 * 1024;

function readPluginConfig(name) {
  const safeName = assertSafePluginName(name);
  return readJsonIfPresent(path.join(resolvePluginRoot(safeName).dir, "config.json"));
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
  fs.writeFileSync(path.join(root.dir, "config.json"), `${serialized}\n`, "utf8");
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
  const contentDir = safeDir
    ? path.join(resolvePluginRoot(safeName).dir, safeDir)
    : resolvePluginRoot(safeName).dir;
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
  const pluginDir = resolvePluginRoot(safeName).dir;
  if (!isDirectory(pluginDir)) {
    throw new Error(`Plugin '${safeName}' is not installed.`);
  }
  fs.mkdirSync(contentDir, { recursive: true });
  const fullPath = path.join(contentDir, safeFile);
  fs.writeFileSync(fullPath, dataBuffer);
  return {
    name: safeFile,
    size: dataBuffer.length,
    path: fullPath
  };
}

function removePluginAssetFile(name, dirName, fileName) {
  const safeName = assertSafePluginName(name);
  const safeDir = assertSafeDirName(dirName);
  const contentDir = safeDir
    ? path.join(resolvePluginRoot(safeName).dir, safeDir)
    : resolvePluginRoot(safeName).dir;
  const safeFile = assertSafePluginFileName(fileName);
  if (!safeFile) {
    throw new Error("Invalid file name.");
  }
  const fullPath = path.join(contentDir, safeFile);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return false;
  }
  fs.unlinkSync(fullPath);
  return true;
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
  fs.writeFileSync(path.join(pluginDir, "config.json"), "{}\n", "utf8");
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
  const { slugify: slugifyText } = require("./text-importer");
  const title = String(input?.title || "").trim().slice(0, 120) || "Untitled text";
  const safeId = assertSafePluginName(
    (slugifyText(input?.id || title) || "untitled-text").slice(0, 40).replace(/-+$/g, "") || "untitled-text"
  );
  const textDir = path.join(dlcRoot, "texts", safeId);
  if (isDirectory(textDir)) {
    throw new Error(`Text '${safeId}' already exists.`);
  }

  const works = Array.isArray(input?.document?.works) ? input.document.works : [];
  if (!works.length) {
    throw new Error("The text has no sections to save. Preview it first and keep at least one passage.");
  }

  const sourceDocument = {
    schemaVersion: 1,
    type: "structured-text-source",
    title,
    shortTitle: String(input?.shortTitle || title).trim().slice(0, 80),
    metadata: {
      description: String(input?.description || "").trim().slice(0, 800)
    },
    works
  };
  const manifest = {
    id: safeId,
    title,
    shortTitle: sourceDocument.shortTitle,
    description: String(input?.description || "").trim().slice(0, 800),
    language: String(input?.language || "English").trim().slice(0, 60) || "English",
    script: String(input?.script || "Latin").trim().slice(0, 60) || "Latin",
    tradition: String(input?.tradition || "").trim().slice(0, 80),
    workLabel: String(input?.workLabel || "Text").trim().slice(0, 40) || "Text",
    sectionLabel: String(input?.sectionLabel || "Section").trim().slice(0, 40) || "Section",
    verseLabel: String(input?.verseLabel || "Passage").trim().slice(0, 40) || "Passage",
    input: {
      path: `${safeId}.json`,
      format: "structured-json"
    }
  };

  fs.mkdirSync(textDir, { recursive: true });
  fs.writeFileSync(path.join(textDir, "metadata.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(textDir, `${safeId}.json`), `${JSON.stringify(sourceDocument, null, 2)}\n`, "utf8");
  const originalText = String(input?.text || "").trim();
  if (originalText && !originalText.startsWith("{")) {
    fs.writeFileSync(path.join(textDir, "source.txt"), originalText.endsWith("\n") ? originalText : `${originalText}\n`, "utf8");
  }

  const staged = stageText(safeId, log, textDir);
  invalidateCatalogCache();
  if (staged) {
    try {
      require("./storage-bootstrap").startBackgroundHotReload();
    } catch (_error) {}
  }

  return {
    id: safeId,
    name: safeId,
    title,
    kind: "text",
    staged: Boolean(staged),
    path: `texts/${safeId}`
  };
}

const DECK_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function createDeckDlcFromZip(buffer, { log = () => {} } = {}) {
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
  const deckDir = path.join(dlcRoot, "decks", safeId);
  if (isDirectory(deckDir)) {
    throw new Error(`Deck '${safeId}' already exists.`);
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

  const staged = stageDeck(safeId, log, deckDir);
  invalidateCatalogCache();
  if (staged) {
    try {
      require("./storage-bootstrap").startBackgroundHotReload();
    } catch (_error) {}
  }

  return {
    id: safeId,
    name: safeId,
    title,
    kind: "deck",
    images: imageCount,
    staged: Boolean(staged),
    path: `decks/${safeId}`
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
  assertSafeName,
  categoryByKind,
  createPluginPlaylist,
  createPluginScaffold,
  createTextDlc,
  createDeckDlcFromZip,
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
