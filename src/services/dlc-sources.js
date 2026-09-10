const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  projectRoot,
  storageConfigRoot,
  dlcRoot,
  dlcSourcesRoot
} = require("../config/paths");

const SOURCES_PATH = path.join(storageConfigRoot, "dlc-sources.json");
const PRIMARY_ID = "primary";

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

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `source-${Date.now().toString(36)}`;
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Repository URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Repository URL must use http or https.");
  }
  return raw.replace(/\.git$/i, "").replace(/\/+$/, "");
}

function normalizeBranch(value) {
  const branch = String(value || "main").trim() || "main";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error("Branch names may only contain letters, numbers, dots, slashes, underscores, and dashes.");
  }
  return branch;
}

function normalizeSource(raw, fallbackIndex = 0) {
  const id = String(raw?.id || "").trim() || (raw?.primary ? PRIMARY_ID : `source-${fallbackIndex + 1}`);
  return {
    id,
    name: String(raw?.name || id).trim() || id,
    url: String(raw?.url || "").trim(),
    branch: String(raw?.branch || "main").trim() || "main",
    enabled: raw?.enabled !== false,
    primary: raw?.primary === true || id === PRIMARY_ID
  };
}

function persist(sources) {
  fs.mkdirSync(path.dirname(SOURCES_PATH), { recursive: true });
  fs.writeFileSync(SOURCES_PATH, `${JSON.stringify({ sources }, null, 2)}\n`, "utf8");
}

function readStoredSources() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
    if (!parsed || !Array.isArray(parsed.sources)) {
      return null;
    }
    return parsed.sources.map((entry, index) => normalizeSource(entry, index));
  } catch {
    return null;
  }
}

function seedSources() {
  const envUrl = String(process.env.KABBAK_DLC_REPO || "").trim();
  const envBranch = String(process.env.KABBAK_DLC_BRANCH || "").trim();
  let url = envUrl;
  let branch = envBranch || "main";
  if (!url && fs.existsSync(path.join(dlcRoot, ".git"))) {
    url = tryGit(["remote", "get-url", "origin"], { cwd: dlcRoot }).output.trim();
    const head = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dlcRoot }).output.trim();
    if (!envBranch && head && head !== "HEAD") {
      branch = head;
    }
  }
  return [
    normalizeSource({
      id: PRIMARY_ID,
      name: "KABBAK DLC",
      url,
      branch,
      enabled: true,
      primary: true
    })
  ];
}

function listSources() {
  let sources = readStoredSources();
  if (!sources || !sources.length) {
    sources = seedSources();
    persist(sources);
  }
  if (!sources.some((source) => source.primary)) {
    sources[0].primary = true;
    persist(sources);
  }
  return sources;
}

function getSource(id) {
  const wanted = String(id || "").trim();
  return listSources().find((source) => source.id === wanted) || null;
}

function getPrimarySource() {
  return listSources().find((source) => source.primary) || listSources()[0] || null;
}

function getSourceRoot(source) {
  if (!source || source.primary || source.id === PRIMARY_ID) {
    return dlcRoot;
  }
  return path.join(dlcSourcesRoot, source.id);
}

function listEnabledSourceRoots() {
  return listSources()
    .filter((source) => source.enabled)
    .map((source) => ({ source, root: getSourceRoot(source) }));
}

function describeSource(source) {
  const root = getSourceRoot(source);
  const present = fs.existsSync(path.join(root, ".git"));
  const head = present
    ? tryGit(["rev-parse", "--short", "HEAD"], { cwd: root }).output.trim()
    : "";
  const liveUrl = present
    ? tryGit(["remote", "get-url", "origin"], { cwd: root }).output.trim()
    : "";
  return {
    ...source,
    present,
    head,
    liveUrl,
    path: path.relative(projectRoot, root).replace(/\\/g, "/")
  };
}

function listDescribedSources() {
  return listSources().map(describeSource);
}

function writeSources(nextSources) {
  const normalized = nextSources.map((entry, index) => normalizeSource(entry, index));
  if (!normalized.some((source) => source.primary) && normalized.length) {
    normalized[0].primary = true;
  }
  persist(normalized);
  return normalized;
}

function applyRemoteUrl(source) {
  const root = getSourceRoot(source);
  if (!fs.existsSync(path.join(root, ".git"))) {
    return;
  }
  git(["remote", "set-url", "origin", source.url], { cwd: root });
}

function syncSource(sourceOrId, { log = () => {} } = {}) {
  const source = typeof sourceOrId === "string" ? getSource(sourceOrId) : sourceOrId;
  if (!source) {
    throw new Error("Unknown DLC source.");
  }
  if (!source.url) {
    throw new Error(`DLC source '${source.id}' has no repository URL.`);
  }
  const root = getSourceRoot(source);
  const relative = path.relative(projectRoot, root).replace(/\\/g, "/");
  if (!fs.existsSync(path.join(root, ".git"))) {
    if (fs.existsSync(root) && fs.readdirSync(root).length) {
      throw new Error(`${relative} already exists but is not a git checkout.`);
    }
    fs.mkdirSync(path.dirname(root), { recursive: true });
    log(`Cloning DLC catalog from ${source.url} (metadata only)...`);
    git(["clone", "--filter=blob:none", "--sparse", source.url, relative], { stdio: "inherit" });
  } else {
    applyRemoteUrl(source);
  }

  const branch = source.branch || "main";
  log(`Updating ${source.name} (${branch})...`);
  git(["fetch", "--filter=blob:none", "origin", branch], { cwd: root, stdio: "inherit" });
  git(["checkout", branch], { cwd: root, stdio: "inherit" });
  git(["merge", "--ff-only", `origin/${branch}`], { cwd: root, stdio: "inherit" });
  return describeSource(getSource(source.id) || source);
}

function addSource({ name, url, branch } = {}, { log = () => {} } = {}) {
  const sources = listSources();
  const label = String(name || "").trim() || "Additional DLC";
  let id = slugify(label);
  if (!id || id === PRIMARY_ID || sources.some((source) => source.id === id)) {
    id = `${slugify(label) || "source"}-${Date.now().toString(36)}`;
  }
  const source = normalizeSource({
    id,
    name: label,
    url: normalizeUrl(url),
    branch: normalizeBranch(branch),
    enabled: true,
    primary: false
  });
  sources.push(source);
  persist(sources);
  try {
    syncSource(source, { log });
  } catch (error) {
    persist(sources.filter((entry) => entry.id !== source.id));
    throw error;
  }
  return describeSource(getSource(id));
}

function updateSource(id, patch = {}, { log = () => {} } = {}) {
  const sources = listSources();
  const index = sources.findIndex((source) => source.id === String(id || "").trim());
  if (index < 0) {
    throw new Error(`Unknown DLC source '${id}'.`);
  }
  const current = { ...sources[index] };
  if (patch.name != null) {
    current.name = String(patch.name).trim() || current.name;
  }
  if (patch.url != null) {
    current.url = normalizeUrl(patch.url);
  }
  if (patch.branch != null) {
    current.branch = normalizeBranch(patch.branch);
  }
  if (patch.enabled != null) {
    current.enabled = patch.enabled === true;
    if (current.primary && current.enabled === false) {
      throw new Error("The primary DLC repository cannot be disabled.");
    }
  }
  if (patch.primary === true) {
    sources.forEach((source) => {
      source.primary = source.id === current.id;
    });
  }
  sources[index] = current;
  persist(sources);
  if (patch.url != null || patch.branch != null || patch.primary === true) {
    applyRemoteUrl(current);
  }
  if (patch.sync === true) {
    syncSource(current, { log });
  }
  return describeSource(getSource(current.id));
}

function removeSource(id) {
  const wanted = String(id || "").trim();
  const source = getSource(wanted);
  if (!source) {
    throw new Error(`Unknown DLC source '${wanted}'.`);
  }
  if (source.primary || source.id === PRIMARY_ID) {
    throw new Error("The primary DLC repository cannot be removed. Change its URL instead.");
  }
  persist(listSources().filter((entry) => entry.id !== wanted));
  return { removed: true, id: wanted };
}

function syncAllEnabledSources({ log = () => {} } = {}) {
  const results = [];
  for (const source of listSources().filter((entry) => entry.enabled)) {
    results.push(syncSource(source, { log }));
  }
  return results;
}

module.exports = {
  PRIMARY_ID,
  addSource,
  describeSource,
  getPrimarySource,
  getSource,
  getSourceRoot,
  listDescribedSources,
  listEnabledSourceRoots,
  listSources,
  removeSource,
  syncAllEnabledSources,
  syncSource,
  updateSource
};
