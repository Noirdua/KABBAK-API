/* dlc-publish.js — push created/updated DLC items back to a configured git
 * source using an admin-supplied HTTPS access token.
 *
 * Credentials live in storage/config/dlc-publish.json (gitignored) and are
 * never returned to the client; only a "set" flag and username are exposed.
 * Push uses a credential-injected URL passed as one execFile argument so it is
 * never shell-interpolated, and every error message is redacted.
 *
 * Created DLC is written to the local workspace (imports/dlc). When the item is
 * not already inside the target checkout, it is copied in first, then staged
 * with `git add --sparse` because DLC sources are sparse partial clones.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { storageConfigRoot, dlcRoot } = require("../config/paths");
const dlcSources = require("./dlc-sources");
const { assertSafeName, categoryByKind } = require("./dlc-catalog");
const { assertItemValid } = require("./dlc-validate");

const PUBLISH_PATH = path.join(storageConfigRoot, "dlc-publish.json");
const COMMIT_NAME = "KABBAK";
const COMMIT_EMAIL = "kabbak@localhost";
const DEFAULT_TOKEN_USER = "oauth2";

const EXCLUDED_COPY_NAMES = new Set(["node_modules", ".git", "user-data", "media", "logs"]);

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PUBLISH_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sources && typeof parsed.sources === "object") {
      return parsed;
    }
  } catch (_error) {
    // Missing/corrupt store starts empty.
  }
  return { sources: {} };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(PUBLISH_PATH), { recursive: true });
  fs.writeFileSync(PUBLISH_PATH, `${JSON.stringify({ sources: store.sources || {} }, null, 2)}\n`, "utf8");
}

function getCredential(sourceId) {
  const store = readStore();
  const entry = store.sources[String(sourceId || "").trim()];
  if (!entry || typeof entry !== "object") return null;
  const token = String(entry.token || "").trim();
  if (!token) return null;
  return {
    username: String(entry.username || "").trim(),
    token
  };
}

function credentialSummary(sourceId) {
  const cred = getCredential(sourceId);
  return {
    set: Boolean(cred),
    username: cred?.username || ""
  };
}

function setPublishCredential(sourceId, input = {}) {
  const id = String(sourceId || "").trim();
  if (!id) throw new Error("sourceId is required.");
  const source = dlcSources.getSource(id);
  if (!source) throw new Error(`Unknown DLC source '${id}'.`);
  const token = String(input.token || "").trim();
  const store = readStore();
  if (!token) {
    delete store.sources[id];
    writeStore(store);
    return getPublishStatus();
  }
  store.sources[id] = {
    username: String(input.username || "").trim(),
    token
  };
  writeStore(store);
  return getPublishStatus();
}

function clearPublishCredential(sourceId) {
  return setPublishCredential(sourceId, { token: "" });
}

function getPublishStatus() {
  return dlcSources.listSources().map((source) => {
    const root = dlcSources.getSourceRoot(source);
    return {
      id: source.id,
      name: source.name,
      url: source.url,
      branch: source.branch,
      primary: source.primary === true,
      enabled: source.enabled !== false,
      present: fs.existsSync(path.join(root, ".git")),
      credential: credentialSummary(source.id)
    };
  });
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd) || "";
  } catch (_error) {
    return "";
  }
}

function redact(value, token) {
  let text = String(value || "");
  const secret = String(token || "");
  if (!secret) return text;
  text = text.split(secret).join("***");
  try {
    text = text.split(encodeURIComponent(secret)).join("***");
  } catch (_error) {
    // Ignore encoding failures.
  }
  // Belt-and-braces: strip any userinfo from URLs in the message.
  return text.replace(/\/\/[^/@\s]+@/g, "//***@");
}

function buildAuthedUrl(rawUrl, credential) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch (_error) {
    throw new Error("DLC source URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) DLC source URLs can be pushed with an access token.");
  }
  parsed.username = encodeURIComponent(credential.username || DEFAULT_TOKEN_USER);
  parsed.password = encodeURIComponent(credential.token);
  return parsed.toString();
}

function resolvePublishBranch(root, source) {
  const head = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
  if (head && head !== "HEAD") return head;
  return String(source?.branch || "main").trim() || "main";
}

function resolveCategory(kind) {
  const normalized = kind === "gui" ? "plugin" : kind;
  return categoryByKind(normalized);
}

function resolveItemDir(kind) {
  if (kind === "api") return "apis";
  const category = resolveCategory(kind);
  return category ? category.dir : "";
}

function resolveTargetSource(sourceId) {
  const explicit = String(sourceId || "").trim();
  if (explicit) {
    const source = dlcSources.getSource(explicit);
    if (!source) throw new Error(`Unknown DLC source '${explicit}'.`);
    return source;
  }
  const sources = dlcSources.listSources().filter((source) => source.enabled !== false);
  const withUrl = sources.find((source) => String(source.url || "").trim());
  return withUrl || dlcSources.getPrimarySource() || sources[0] || null;
}

function copyItemIntoCheckout(sourceDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(sourceDir, destDir, {
    recursive: true,
    filter: (entry) => !EXCLUDED_COPY_NAMES.has(path.basename(entry))
  });
}

function stageItem(root, relPath) {
  try {
    git(["add", "--sparse", "--", relPath], root);
  } catch (_error) {
    git(["add", "--", relPath], root);
  }
}

function stageDeletion(root, relPath) {
  // `--sparse` is required to stage deletions of tracked paths that a sparse
  // checkout hasn't materialized (skip-worktree entries are otherwise skipped).
  const attempts = [
    ["rm", "-r", "--cached", "--ignore-unmatch", "--sparse", "--", relPath],
    ["rm", "-r", "--cached", "--ignore-unmatch", "--", relPath],
    ["add", "--sparse", "-A", "--", relPath],
    ["add", "-A", "--", relPath]
  ];
  for (const args of attempts) {
    try {
      git(args, root);
      return;
    } catch (_error) {
      // Try the next form.
    }
  }
}

const ITEM_MANIFEST_FILES = {
  deck: ["deck.json"],
  reference: ["reference.json"],
  text: ["metadata.json", "text.json"],
  plugin: ["manifest.json"],
  api: ["manifest.json"],
  gui: ["manifest.json"]
};

function readItemMeta(kind, dir) {
  const files = ITEM_MANIFEST_FILES[kind === "gui" ? "plugin" : kind] || [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      return {
        id: String(parsed.id || "").trim(),
        title: String(parsed.name || parsed.title || parsed.label || "").trim()
      };
    } catch (_error) {
      // Try the next manifest candidate.
    }
  }
  return { id: "", title: "" };
}

// Map of relative path -> byte size for a local item folder (publish-copy
// exclusions applied), used to compare against the committed HEAD tree.
function dirSignatureMap(dir) {
  const map = new Map();
  const walk = (current, base) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.forEach((entry) => {
      if (EXCLUDED_COPY_NAMES.has(entry.name)) return;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), `${base}${entry.name}/`);
        return;
      }
      if (!entry.isFile()) return;
      let size = 0;
      try {
        size = fs.statSync(path.join(current, entry.name)).size;
      } catch (_error) {
        size = -1;
      }
      map.set(`${base}${entry.name}`, size);
    });
  };
  walk(dir, "");
  return map;
}

// Tracked paths at HEAD (fast; no blob fetch, safe for blobless clones).
function gitHeadPaths(root) {
  const output = tryGit(["ls-tree", "-r", "--name-only", "HEAD"], root) || "";
  return new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

// Stamp of an item's user-visible files (path:size:mtime). Compared against the
// snapshot recorded at the last successful publish to detect local edits.
function itemStamp(dir) {
  const parts = [];
  dirSignatureMap(dir).forEach((size, relative) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, relative)).mtimeMs;
    } catch (_error) {
      mtime = 0;
    }
    parts.push(`${relative}:${size}:${Math.round(mtime)}`);
  });
  parts.sort();
  return parts.join("\n");
}

const SNAPSHOTS_PATH = path.join(storageConfigRoot, "dlc-publish-snapshots.json");

function readSnapshots() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeSnapshots(store) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOTS_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOTS_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch (_error) {
    // Snapshot is best-effort; a miss only shows Publish once more.
  }
}

function recordSnapshot(sourceId, kind, name, dir) {
  const store = readSnapshots();
  store[`${sourceId}:${kind}:${name}`] = itemStamp(dir);
  writeSnapshots(store);
}

// Whether an item has anything to publish: it isn't tracked at HEAD, its files
// changed since the last publish snapshot, or the checkout is dirty. `ctx`
// caches git reads across a batch of items.
function getPublishPending({ kind, name, sourceId } = {}, ctx = {}) {
  try {
    const source = resolveTargetSource(sourceId);
    if (!source) return { pending: false, reason: "no source" };
    const root = dlcSources.getSourceRoot(source);
    if (!fs.existsSync(path.join(root, ".git"))) return { pending: true, reason: "no checkout" };

    const dir = resolveItemDir(kind);
    if (!dir) return { pending: false, reason: "unknown kind" };
    const safeName = assertSafeName(name);
    const workspaceDir = path.join(dlcRoot, dir, safeName);
    let sourceItemDir = fs.existsSync(workspaceDir) ? workspaceDir : "";
    if (!sourceItemDir) {
      sourceItemDir = dlcSources.listEnabledSourceRoots()
        .map(({ root: otherRoot }) => path.join(otherRoot, dir, safeName))
        .find((candidate) => fs.existsSync(candidate)) || "";
    }
    if (!sourceItemDir) return { pending: false, reason: "not local" };

    const targetName = safeName;
    const relPath = `${dir}/${targetName}`;

    if (!ctx.paths) ctx.paths = new Map();
    if (!ctx.dirty) ctx.dirty = new Map();
    if (!ctx.paths.has(root)) ctx.paths.set(root, gitHeadPaths(root));
    if (!ctx.dirty.has(root)) {
      const output = tryGit(["status", "--porcelain"], root) || "";
      ctx.dirty.set(root, output.split(/\r?\n/).map((line) => line.replace(/^..\s+/, "").trim()).filter(Boolean));
    }

    const tracked = ctx.paths.get(root);
    if (![...tracked].some((filePath) => filePath === relPath || filePath.startsWith(`${relPath}/`))) {
      return { pending: true, reason: "notpublished" };
    }

    const key = `${source.id}:${kind}:${targetName}`;
    const snapshots = readSnapshots();
    const stamp = itemStamp(sourceItemDir);
    if (!snapshots[key]) {
      // First time we see a tracked, already-published item: baseline it so
      // later edits show Publish without flagging everything as changed.
      snapshots[key] = stamp;
      writeSnapshots(snapshots);
    } else if (snapshots[key] !== stamp) {
      return { pending: true, reason: "changes" };
    }

    if (ctx.dirty.get(root).some((p) => p === relPath || p.startsWith(`${relPath}/`))) {
      return { pending: true, reason: "uncommitted" };
    }
    return { pending: false, reason: "uptodate" };
  } catch (error) {
    return { pending: true, reason: error?.message || "error" };
  }
}

function pushBranchWithRetry(root, authedUrl, branch, credential, log) {
  const pushOnce = () => git(["push", authedUrl, `HEAD:${branch}`], root);
  try {
    pushOnce();
    return;
  } catch (error) {
    const firstMessage = redact((error && (error.stderr || error.message)) || "git push failed", credential.token);
    if (!/rejected|non-fast-forward|fetch first|behind/i.test(firstMessage)) {
      throw new Error(firstMessage);
    }
  }
  log("Remote moved ahead; rebasing and retrying push.");
  try {
    git(["pull", "--rebase", "--autostash", authedUrl, branch], root);
    pushOnce();
  } catch (retryError) {
    const retryText = redact((retryError && (retryError.stderr || retryError.message)) || "", credential.token);
    throw new Error(`Push failed after rebase. ${retryText}`.trim());
  }
}

function publishItem({ kind, name, sourceId, message } = {}, { log = () => {} } = {}) {
  const source = resolveTargetSource(sourceId);
  if (!source) {
    throw new Error("No DLC repository is configured. Add one under Admin → DLC first.");
  }
  const credential = getCredential(source.id);
  if (!credential) {
    throw new Error(`No access token saved for '${source.name}'. Add one in Admin → DLC → Repository access.`);
  }
  const root = dlcSources.getSourceRoot(source);
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error(`'${source.name}' has no git checkout yet. Sync it first.`);
  }

  const dir = resolveItemDir(kind);
  if (!dir) {
    throw new Error(`Unknown DLC kind '${kind}'.`);
  }
  let safeName;
  try {
    safeName = assertSafeName(name);
  } catch (error) {
    throw new Error(error.message);
  }

  // Locate the item to publish (workspace first, then any enabled checkout).
  const workspaceDir = path.join(dlcRoot, dir, safeName);
  let sourceItemDir = "";
  if (fs.existsSync(workspaceDir)) {
    sourceItemDir = workspaceDir;
  } else {
    sourceItemDir = dlcSources.listEnabledSourceRoots()
      .map(({ root: otherRoot }) => path.join(otherRoot, dir, safeName))
      .find((candidate) => fs.existsSync(candidate)) || "";
  }
  if (!sourceItemDir) {
    throw new Error(`'${safeName}' was not found in the local workspace or any DLC checkout. Create or sync it first.`);
  }

  // Repo folders track the manifest id (deck/reference/text). If the item was
  // renamed, publish under the new id and remove the stale folder.
  const isPluginKind = ["plugin", "api", "gui"].includes(kind);
  const meta = readItemMeta(kind, sourceItemDir);
  // The workspace folder name is the identity (it already follows the deck title
  // after an edit-save); publish just mirrors it and sweeps stale id folders.
  const targetName = safeName;
  const relPath = `${dir}/${targetName}`;
  const destDir = path.join(root, dir, targetName);
  const oldRelPaths = [];

  if (!isPluginKind && meta.id) {
    const base = path.join(root, dir);
    if (fs.existsSync(base)) {
      fs.readdirSync(base, { withFileTypes: true }).forEach((entry) => {
        if (!entry.isDirectory() || entry.name === targetName) return;
        const existingId = readItemMeta(kind, path.join(base, entry.name)).id;
        if (existingId === meta.id) {
          fs.rmSync(path.join(base, entry.name), { recursive: true, force: true });
          oldRelPaths.push(`${dir}/${entry.name}`);
          log(`Removing stale ${dir}/${entry.name} (renamed to ${targetName}).`);
        }
      });
    }
  }

  const samePath = path.resolve(sourceItemDir) === path.resolve(destDir);
  if (!samePath) {
    log(`Copying ${relPath} into ${source.name}.`);
    copyItemIntoCheckout(sourceItemDir, destDir);
  }

  // Keep the local workspace folder in sync with the published name.
  if (path.resolve(path.dirname(sourceItemDir)) === path.resolve(path.join(dlcRoot, dir))
    && path.basename(sourceItemDir) !== targetName) {
    const renamedWorkspace = path.join(dlcRoot, dir, targetName);
    try {
      fs.rmSync(renamedWorkspace, { recursive: true, force: true });
      fs.renameSync(sourceItemDir, renamedWorkspace);
    } catch (_error) {
      // The published copy is what matters; the workspace rename is cosmetic.
    }
  }

  // Never publish a broken item to the shared repo.
  assertItemValid(kind, targetName, destDir);

  const branch = resolvePublishBranch(root, source);
  log(`Publishing ${kind}:${targetName} to ${source.name} (${branch}).`);

  const stagedPaths = [relPath, ...oldRelPaths];
  stageItem(root, relPath);
  oldRelPaths.forEach((oldRelPath) => stageDeletion(root, oldRelPath));
  const pending = tryGit(["status", "--porcelain", "--", ...stagedPaths], root).trim();
  const headBefore = tryGit(["rev-parse", "--short", "HEAD"], root).trim();

  let committed = false;
  if (pending) {
    const commitMessage = String(message || "").trim() || `Add ${kind}: ${targetName}`;
    git(
      [
        "-c", `user.name=${COMMIT_NAME}`,
        "-c", `user.email=${COMMIT_EMAIL}`,
        "commit",
        "-m", commitMessage,
        "--",
        ...stagedPaths
      ],
      root
    );
    committed = true;
  }

  const authedUrl = buildAuthedUrl(source.url, credential);
  pushBranchWithRetry(root, authedUrl, branch, credential, log);

  recordSnapshot(source.id, kind, targetName, destDir);
  const head = tryGit(["rev-parse", "--short", "HEAD"], root).trim();
  return {
    sourceId: source.id,
    sourceName: source.name,
    kind,
    name: targetName,
    branch,
    committed,
    pushed: true,
    head,
    previousHead: headBefore,
    note: committed ? "" : "No local changes; the branch was already up to date."
  };
}

// Delete an item from the repository: remove its folder(s) from the checkout
// (matching by folder name and by manifest id, so renames are covered), stage
// the deletions, and commit + push. Also drops the local workspace copy.
function deleteItemFromRepo({ kind, name, sourceId, message } = {}, { log = () => {} } = {}) {
  const source = resolveTargetSource(sourceId);
  if (!source) throw new Error("No DLC repository is configured. Add one under Admin → DLC first.");
  const credential = getCredential(source.id);
  if (!credential) throw new Error(`No access token saved for '${source.name}'. Add one in Admin → DLC → Repository access.`);
  const root = dlcSources.getSourceRoot(source);
  if (!fs.existsSync(path.join(root, ".git"))) throw new Error(`'${source.name}' has no git checkout yet. Sync it first.`);

  const dir = resolveItemDir(kind);
  if (!dir) throw new Error(`Unknown DLC kind '${kind}'.`);
  const safeName = assertSafeName(name);
  const workspaceDir = path.join(dlcRoot, dir, safeName);
  const checkoutDir = path.join(root, dir, safeName);
  const metaSource = fs.existsSync(workspaceDir) ? workspaceDir : (fs.existsSync(checkoutDir) ? checkoutDir : "");
  const meta = metaSource ? readItemMeta(kind, metaSource) : { id: "", title: "" };

  const targets = new Set([`${dir}/${safeName}`]);
  if (meta.id) {
    const base = path.join(root, dir);
    if (fs.existsSync(base)) {
      fs.readdirSync(base, { withFileTypes: true }).forEach((entry) => {
        if (entry.isDirectory() && readItemMeta(kind, path.join(base, entry.name)).id === meta.id) {
          targets.add(`${dir}/${entry.name}`);
        }
      });
    }
  }

  const tracked = gitHeadPaths(root);
  const relPaths = [...targets];
  const trackedUnderItem = relPaths.some((rel) => tracked.has(rel) || [...tracked].some((p) => p.startsWith(`${rel}/`)));
  relPaths.forEach((rel) => {
    const absolute = path.join(root, rel);
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });

  const headBefore = tryGit(["rev-parse", "--short", "HEAD"], root).trim();
  if (!trackedUnderItem) {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    return {
      kind,
      name: safeName,
      committed: false,
      pushed: false,
      removed: [],
      note: "Nothing to delete in the repository; removed the local copy."
    };
  }

  const branch = resolvePublishBranch(root, source);
  relPaths.forEach((rel) => stageDeletion(root, rel));
  const pending = tryGit(["status", "--porcelain", "--", ...relPaths], root).trim();

  let committed = false;
  if (pending) {
    const commitMessage = String(message || "").trim() || `Delete ${kind}: ${safeName}`;
    git(
      [
        "-c", `user.name=${COMMIT_NAME}`,
        "-c", `user.email=${COMMIT_EMAIL}`,
        "commit",
        "-m", commitMessage,
        "--",
        ...relPaths
      ],
      root
    );
    committed = true;
  }

  log(`Deleting ${kind}:${safeName} from ${source.name} (${branch}).`);
  const authedUrl = buildAuthedUrl(source.url, credential);
  pushBranchWithRetry(root, authedUrl, branch, credential, log);

  // Only drop the local workspace copy once the deletion is safely pushed.
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  const store = readSnapshots();
  let changed = false;
  relPaths.forEach((rel) => {
    const key = `${source.id}:${kind}:${rel.split("/").pop()}`;
    if (store[key] !== undefined) {
      delete store[key];
      changed = true;
    }
  });
  if (changed) writeSnapshots(store);

  const head = tryGit(["rev-parse", "--short", "HEAD"], root).trim();
  return {
    sourceId: source.id,
    sourceName: source.name,
    kind,
    name: safeName,
    branch,
    committed,
    pushed: true,
    head,
    previousHead: headBefore,
    removed: relPaths,
    note: committed ? "" : "Nothing changed; the repository was already up to date."
  };
}

module.exports = {
  clearPublishCredential,
  deleteItemFromRepo,
  getPublishPending,
  getPublishStatus,
  publishItem,
  setPublishCredential
};
