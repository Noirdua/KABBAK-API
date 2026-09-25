const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { profilesRoot } = require("../config/profile-storage");

const writeTails = new Map();
const writeHolders = new Map();

function resolveRoot(options = {}) {
  return String(options.rootPath || options.profilesRoot || profilesRoot || "").trim();
}

function withProfileWriteLock(clientId, fn) {
  const key = String(clientId || "").trim();
  if (!key) {
    return Promise.resolve().then(fn);
  }
  if (writeHolders.get(key)) {
    writeHolders.set(key, writeHolders.get(key) + 1);
    return Promise.resolve().then(fn).finally(() => {
      const depth = (writeHolders.get(key) || 1) - 1;
      if (depth <= 0) {
        writeHolders.delete(key);
      } else {
        writeHolders.set(key, depth);
      }
    });
  }
  const previous = writeTails.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => {
    writeHolders.set(key, 1);
    return Promise.resolve().then(fn);
  }).finally(() => {
    const depth = (writeHolders.get(key) || 1) - 1;
    if (depth <= 0) {
      writeHolders.delete(key);
    } else {
      writeHolders.set(key, depth);
    }
  });
  const settled = run.then(() => {}, () => {});
  writeTails.set(key, settled);
  settled.finally(() => {
    if (writeTails.get(key) === settled) {
      writeTails.delete(key);
    }
  });
  return run;
}

function clientDirName(clientId) {
  const normalized = String(clientId || "").trim();
  const safePart = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "client";
  const hashPart = crypto.createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8);
  return `${safePart}-${hashPart}`;
}

function attachmentFilePath(clientId, options = {}) {
  return path.join(resolveRoot(options), `attachments-${clientDirName(clientId)}.json`);
}

function readAttachmentMap(clientId, options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(attachmentFilePath(clientId, options), "utf8"));
    return parsed && typeof parsed.files === "object" && parsed.files ? parsed.files : {};
  } catch (_error) {
    return {};
  }
}

function safeFileToken(value, fallback) {
  const token = String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return token || fallback;
}

function isStoredAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const id = String(value.id || "");
  if (!id.startsWith("att_")) {
    return false;
  }
  return typeof value.data === "string" || typeof value.file === "string";
}

function walk(value, visitor, seen) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor, seen));
    return;
  }
  if (isStoredAttachment(value)) {
    visitor(value);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      walk(child, visitor, seen);
    }
  }
}

function imageFileName(kind) {
  return kind === "banner" ? "banner" : "avatar";
}

function prepareStoredProfile(profile, clientId, options = {}) {
  const stored = structuredClone(profile);
  const existing = readAttachmentMap(clientId, options);
  const files = {};
  walk(stored, (attachment) => {
    const fileName = safeFileToken(attachment.file || attachment.id, "");
    if (!fileName) {
      return;
    }
    if (typeof attachment.data === "string" && attachment.data) {
      files[fileName] = attachment.data;
    } else if (typeof existing[fileName] === "string") {
      files[fileName] = existing[fileName];
    }
    attachment.file = fileName;
    delete attachment.data;
  }, new Set());
  for (const kind of ["avatar", "banner"]) {
    const image = stored[kind];
    if (!image || typeof image !== "object") {
      continue;
    }
    const fileName = imageFileName(kind);
    if (typeof image.data === "string" && image.data) {
      files[fileName] = image.data;
    } else if (typeof existing[fileName] === "string") {
      files[fileName] = existing[fileName];
    }
    if (image.file || files[fileName]) {
      image.file = fileName;
      delete image.data;
    }
  }
  const payload = `${JSON.stringify({ files })}\n`;
  return {
    stored,
    attachmentBytes: Buffer.byteLength(payload),
    commit() {
      if (!Object.keys(files).length) {
        fs.rmSync(attachmentFilePath(clientId, options), { force: true });
        return;
      }
      const target = attachmentFilePath(clientId, options);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tempPath = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, payload);
      fs.renameSync(tempPath, target);
    }
  };
}

function hydrateProfileAttachments(profile, clientId, options = {}) {
  if (!profile || typeof profile !== "object") {
    return profile;
  }
  const files = readAttachmentMap(clientId, options);
  walk(profile, (attachment) => {
    if (typeof attachment.data === "string" && attachment.data) {
      return;
    }
    const stored = files[safeFileToken(attachment.file, "")];
    if (typeof stored === "string" && stored) {
      attachment.data = stored;
    }
  }, new Set());
  for (const kind of ["avatar", "banner"]) {
    const image = profile[kind];
    if (!image || typeof image !== "object" || (typeof image.data === "string" && image.data)) {
      continue;
    }
    const stored = files[safeFileToken(image.file || imageFileName(kind), "")];
    if (typeof stored === "string" && stored) {
      image.data = stored;
    }
  }
  return profile;
}

function attachmentDirBytes(clientId, options = {}) {
  try {
    return fs.statSync(attachmentFilePath(clientId, options)).size;
  } catch (_error) {
    return 0;
  }
}

function removeProfileAttachmentFiles(clientId, options = {}) {
  fs.rmSync(attachmentFilePath(clientId, options), { force: true });
}

function indexPath(options = {}) {
  return path.join(resolveRoot(options), "directory-index.json");
}

function readDirectoryIndex(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(options), "utf8"));
    return parsed && typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {};
  } catch (_error) {
    return {};
  }
}

function writeDirectoryIndex(entries, options = {}) {
  const target = indexPath(options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ entries })}\n`);
  fs.renameSync(tempPath, target);
}

function summaryFromProfile(profile, stat, fileName = "") {
  const avatar = profile?.avatar;
  return {
    fileName: String(fileName || ""),
    mtimeMs: stat?.mtimeMs || 0,
    size: stat?.size || 0,
    clientId: String(profile?.clientId || "").trim(),
    directoryVisibility: String(profile?.directoryVisibility || "private"),
    displayName: String(profile?.displayName || "").trim().slice(0, 80),
    tagline: String(profile?.tagline || "").slice(0, 120),
    bio: String(profile?.bio || "").slice(0, 300),
    createdAt: String(profile?.createdAt || ""),
    hasAvatar: Boolean(avatar?.data || avatar?.file),
    boardWatch: Array.isArray(profile?.boardWatch) ? profile.boardWatch : [],
    quizAttempts: Array.isArray(profile?.quiz?.attempts) ? profile.quiz.attempts : []
  };
}

function rememberDirectorySummary(profile, stat, fileName = "", options = {}) {
  const clientId = String(profile?.clientId || "").trim();
  if (!clientId) {
    return;
  }
  const entries = readDirectoryIndex(options);
  entries[clientId] = summaryFromProfile(profile, stat, fileName);
  writeDirectoryIndex(entries, options);
}

function forgetDirectorySummary(clientId, options = {}) {
  const key = String(clientId || "").trim();
  if (!key) {
    return;
  }
  const entries = readDirectoryIndex(options);
  if (!entries[key]) {
    return;
  }
  delete entries[key];
  writeDirectoryIndex(entries, options);
}

module.exports = {
  attachmentDirBytes,
  forgetDirectorySummary,
  hydrateProfileAttachments,
  prepareStoredProfile,
  readDirectoryIndex,
  rememberDirectorySummary,
  removeProfileAttachmentFiles,
  summaryFromProfile,
  withProfileWriteLock,
  writeDirectoryIndex
};
