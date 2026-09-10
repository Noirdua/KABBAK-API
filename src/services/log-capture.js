/* log-capture.js — in-memory ring buffer of recent log events so the Admin
 * panel can show live server logs without touching the console/journal.
 */
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

function captureLogEvent(level, message) {
  const text = String(message == null ? "" : message);
  const structured = parseStructuredEvent(text);
  entries.push({
    timestamp: new Date().toISOString(),
    level: String(level || "info").toLowerCase(),
    event: structured?.event || "",
    structured,
    message: structured ? JSON.stringify(structured) : text
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

function getRecentLogEvents({ limit = 200, level = "all", event = "" } = {}) {
  const normalizedLevel = String(level || "all").toLowerCase();
  const normalizedEvent = String(event || "").trim();
  return entries
    .filter((entry) => {
      if (normalizedLevel !== "all" && entry.level !== normalizedLevel) return false;
      if (normalizedEvent && entry.event !== normalizedEvent) return false;
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
  getRecentLogEvents
};
