const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Append-only history of admin sends (broadcasts and targeted). The live
// broadcast list stays authoritative for what users can see; this is an audit
// trail so an admin can see what was sent, to whom, and when.
const DEFAULT_LOG_PATH = path.join(storageConfigRoot, "message-log.json");
const MAX_LOG_ENTRIES = 1000;

function resolveLogPath(options = {}) {
  return options.filePath || DEFAULT_LOG_PATH;
}

function readLog(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveLogPath(options), "utf8"));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (_error) {
    return [];
  }
}

function writeLog(entries, options = {}) {
  const filePath = resolveLogPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
}

function normalizeLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const audience = String(entry.audience || "").trim().toLowerCase();
  return {
    id: String(entry.id || `mlog_${crypto.randomBytes(8).toString("hex")}`),
    audience: ["all", "users", "roles"].includes(audience) ? audience : "all",
    audienceDetail: {
      roles: Array.isArray(entry.audienceDetail?.roles)
        ? entry.audienceDetail.roles.map((role) => String(role)).slice(0, 50)
        : [],
      userCount: Math.max(0, Number(entry.audienceDetail?.userCount) || 0)
    },
    title: String(entry.title || "").slice(0, 200),
    kind: String(entry.kind || "message").slice(0, 40),
    visibility: entry.visibility === "public" ? "public" : "internal",
    broadcast: entry.broadcast === true,
    token: String(entry.token || ""),
    delivered: Math.max(0, Number(entry.delivered) || 0),
    failures: Math.max(0, Number(entry.failures) || 0),
    sender: String(entry.sender || "Admin").slice(0, 120),
    createdAt: String(entry.createdAt || new Date().toISOString())
  };
}

function appendLogEntry(entry, options = {}) {
  const normalized = normalizeLogEntry(entry);
  if (!normalized) {
    return null;
  }
  const entries = readLog(options);
  entries.push(normalized);
  writeLog(entries.slice(-MAX_LOG_ENTRIES), options);
  return normalized;
}

function listLogEntries(options = {}) {
  return readLog(options)
    .map((entry) => normalizeLogEntry(entry))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function deleteLogEntry(entryId, options = {}) {
  const entries = readLog(options);
  const next = entries.filter((entry) => entry.id !== String(entryId || "").trim());
  writeLog(next, options);
  return { removed: entries.length - next.length };
}

function clearLog(options = {}) {
  const entries = readLog(options);
  writeLog([], options);
  return { removed: entries.length };
}

module.exports = {
  appendLogEntry,
  clearLog,
  deleteLogEntry,
  listLogEntries
};
