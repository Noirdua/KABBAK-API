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

  const relPath = `${dir}/${safeName}`;
  const destDir = path.join(root, dir, safeName);
  const workspaceDir = path.join(dlcRoot, dir, safeName);
  const workspaceIsCheckout = path.resolve(workspaceDir) === path.resolve(destDir);

  if (!workspaceIsCheckout && fs.existsSync(workspaceDir)) {
    // Created/edited DLC lives in the local workspace; promote it into the
    // target checkout so the commit carries the admin's version.
    log(`Copying ${relPath} into ${source.name}.`);
    copyItemIntoCheckout(workspaceDir, destDir);
  } else if (!fs.existsSync(destDir)) {
    const other = dlcSources.listEnabledSourceRoots()
      .map(({ root: otherRoot }) => path.join(otherRoot, dir, safeName))
      .find((candidate) => fs.existsSync(candidate));
    if (!other) {
      throw new Error(`'${safeName}' was not found in the local workspace or any DLC checkout. Create or sync it first.`);
    }
    log(`Copying ${relPath} into ${source.name}.`);
    copyItemIntoCheckout(other, destDir);
  }

  const branch = resolvePublishBranch(root, source);
  log(`Publishing ${kind}:${safeName} to ${source.name} (${branch}).`);

  stageItem(root, relPath);
  const pending = tryGit(["status", "--porcelain", "--", relPath], root).trim();
  const headBefore = tryGit(["rev-parse", "--short", "HEAD"], root).trim();

  let committed = false;
  if (pending) {
    const commitMessage = String(message || "").trim() || `Add ${kind}: ${safeName}`;
    git(
      [
        "-c", `user.name=${COMMIT_NAME}`,
        "-c", `user.email=${COMMIT_EMAIL}`,
        "commit",
        "-m", commitMessage,
        "--",
        relPath
      ],
      root
    );
    committed = true;
  }

  const authedUrl = buildAuthedUrl(source.url, credential);
  const pushOnce = () => git(["push", authedUrl, `HEAD:${branch}`], root);

  try {
    pushOnce();
  } catch (error) {
    const firstMessage = redact((error && (error.stderr || error.message)) || "git push failed", credential.token);
    if (/rejected|non-fast-forward|fetch first|behind/i.test(firstMessage)) {
      log("Remote moved ahead; rebasing and retrying push.");
      try {
        git(["pull", "--rebase", "--autostash", authedUrl, branch], root);
        pushOnce();
      } catch (retryError) {
        const retryText = redact((retryError && (retryError.stderr || retryError.message)) || "", credential.token);
        throw new Error(`Push failed after rebase. ${retryText}`.trim());
      }
    } else {
      throw new Error(firstMessage);
    }
  }

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
    note: committed ? "" : "No local changes; the branch was already up to date."
  };
}

module.exports = {
  clearPublishCredential,
  getPublishStatus,
  publishItem,
  setPublishCredential
};
