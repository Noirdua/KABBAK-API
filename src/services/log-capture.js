/* log-capture.js — in-memory ring buffer of recent log events so the Admin
 * panel can show live server logs without touching the console/journal.
 */
const { ingestStructured } = require("./job-progress");

const MAX_ENTRIES = 500;

const entries = [];

function parseStructuredEvent(message) {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function derivePathGroup(path, message, structured) {
  const raw = String(path || "").split("?")[0].trim();
  if (raw) {
    const parts = raw.split("/").filter(Boolean);
    if (parts[0] === "api" && parts.length >= 3) {
      return `/${parts[0]}/${parts[1]}/${parts[2]}`;
    }
    return raw;
  }
  const event = String(structured?.event || "");
  if (event === "api_dlc" || event.startsWith("api_dlc_")) return "/api/v1/dlc";
  if (event.startsWith("api_admin")) return "/api/v1/admin";
  const text = String(message || "");
  if (text.includes("[storage]")) return "storage";
  if (text.includes("[plugins]")) return "plugins";
  if (text.includes("[install-all]")) return "/api/v1/dlc";
  return "other";
}

function captureLogEvent(level, message) {
  const text = String(message == null ? "" : message);
  const structured = parseStructuredEvent(text);
  if (structured) {
    ingestStructured(structured);
  }
  const path = String(structured?.path || "").trim();
  entries.push({
    timestamp: new Date().toISOString(),
    level: String(level || "info").toLowerCase(),
    event: structured?.event || "",
    path,
    pathGroup: derivePathGroup(path, text, structured),
    method: String(structured?.method || "").trim(),
    statusCode: Number(structured?.statusCode) || 0,
    structured,
    message: structured ? JSON.stringify(structured) : text
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

function countMapToList(map) {
  return [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getLogFacets() {
  const pathGroups = new Map();
  const events = new Map();
  entries.forEach((entry) => {
    const group = entry.pathGroup || "other";
    pathGroups.set(group, (pathGroups.get(group) || 0) + 1);
    if (entry.event) {
      events.set(entry.event, (events.get(entry.event) || 0) + 1);
    }
  });
  return {
    pathGroups: countMapToList(pathGroups),
    events: countMapToList(events)
  };
}

function getRecentLogEvents({
  limit = 200,
  level = "all",
  event = "",
  pathGroup = "",
  q = "",
  since = "",
  until = "",
  sinceMinutes = 0
} = {}) {
  const normalizedLevel = String(level || "all").toLowerCase();
  const normalizedEvent = String(event || "").trim();
  const normalizedGroup = String(pathGroup || "").trim();
  const query = String(q || "").trim().toLowerCase();
  let sinceMs = 0;
  const minutes = Number(sinceMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    sinceMs = Date.now() - minutes * 60 * 1000;
  }
  const sinceParsed = Date.parse(since);
  if (Number.isFinite(sinceParsed)) {
    sinceMs = sinceParsed;
  }
  let untilMs = Number.POSITIVE_INFINITY;
  const untilParsed = Date.parse(until);
  if (Number.isFinite(untilParsed)) {
    untilMs = untilParsed;
  }

  return entries
    .filter((entry) => {
      if (normalizedLevel !== "all" && entry.level !== normalizedLevel) return false;
      if (normalizedEvent && entry.event !== normalizedEvent) return false;
      if (normalizedGroup && entry.pathGroup !== normalizedGroup) return false;
      const stamp = Date.parse(entry.timestamp);
      if (Number.isFinite(stamp) && (stamp < sinceMs || stamp > untilMs)) return false;
      if (query) {
        const haystack = `${entry.message || ""} ${entry.path || ""} ${entry.event || ""} ${entry.pathGroup || ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .slice(-Math.min(500, Math.max(1, Number(limit) || 200)))
    .reverse();
}

function clearLogEntries() {
  entries.length = 0;
}

// Wraps the app logger so every log line also lands in the ring buffer.
function createCapturingLogger(baseLogger) {
  const base = baseLogger || console;
  const wrap = (level) => (message) => {
    captureLogEvent(level, message);
    const baseFn = base[level] || base.log;
    if (typeof baseFn === "function") {
      baseFn.call(base, message);
    }
  };
  return {
    log: wrap("info"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error")
  };
}

module.exports = {
  captureLogEvent,
  clearLogEntries,
  createCapturingLogger,
  getLogFacets,
  getRecentLogEvents
};
