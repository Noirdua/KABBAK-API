const SunCalc = require("suncalc");

const { loadReferenceData } = require("./data-loader");
const { resolveCalendarFeedToken } = require("./profile-service");
const { getMoonPhaseName } = require("./calendar-service");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FEED_PAST_DAYS = 180;
const FEED_FUTURE_DAYS = 730;
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const FEED_CACHE_MAX = 200;
const DEFAULT_LAYERS = Object.freeze(["user", "moon", "holidays"]);
const KNOWN_LAYERS = new Set(DEFAULT_LAYERS);
const PRINCIPAL_MOON_PHASES = new Set(["New Moon", "First Quarter", "Full Moon", "Last Quarter"]);

const feedCache = new Map();

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addIsoDays(dateIso, days) {
  const [year, month, day] = String(dateIso).split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day) + days * DAY_IN_MS);
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, "0");
  const d = String(next.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function compactDate(dateIso) {
  return String(dateIso).replace(/-/g, "");
}

function compactDateTime(dateIso, time) {
  const hhmm = String(time || "").replace(":", "");
  return `${compactDate(dateIso)}T${hhmm.padStart(4, "0")}00`;
}

function compactTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return compactTimestamp(new Date().toISOString());
  }
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 line folding: keep lines within 75 octets, continue with a space.
function foldIcsLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) {
    return line;
  }
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (currentBytes + charBytes > 74) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.join("\r\n ");
}

function buildRRule(recurrence, allDay) {
  const freq = String(recurrence?.freq || "none");
  const frequency = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[freq];
  if (!frequency) {
    return "";
  }
  const parts = [`FREQ=${frequency}`];
  const interval = Number(recurrence?.interval);
  if (Number.isFinite(interval) && interval > 1) {
    parts.push(`INTERVAL=${Math.floor(interval)}`);
  }
  if (freq === "weekly" && Array.isArray(recurrence?.byWeekday) && recurrence.byWeekday.length) {
    const names = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const byDay = recurrence.byWeekday.map((day) => names[day]).filter(Boolean);
    if (byDay.length) {
      parts.push(`BYDAY=${byDay.join(",")}`);
    }
  }
  if (recurrence?.until) {
    parts.push(allDay ? `UNTIL=${compactDate(recurrence.until)}` : `UNTIL=${compactDate(recurrence.until)}T235959Z`);
  }
  return parts.join(";");
}

function renderVeventLines(event) {
  const lines = ["BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${event.dtstamp}`];
  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addIsoDays(event.date, 1))}`);
  } else {
    lines.push(`DTSTART:${compactDateTime(event.date, event.startTime)}`);
    if (event.endTime) {
      lines.push(`DTEND:${compactDateTime(event.date, event.endTime)}`);
    }
  }
  if (event.rrule) {
    lines.push(`RRULE:${event.rrule}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (event.categories) {
    lines.push(`CATEGORIES:${escapeIcsText(event.categories)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

function renderIcs(calendarName, events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KABBAK//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`
  ];
  events.forEach((event) => {
    lines.push(...renderVeventLines(event));
  });
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function normalizeLayers(rawLayers) {
  const requested = String(rawLayers || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => KNOWN_LAYERS.has(entry));
  if (!requested.length) {
    return new Set(DEFAULT_LAYERS);
  }
  return new Set(requested);
}

function collectUserEvents(events, fromIso, toIso, target) {
  events.forEach((event) => {
    const isRecurring = (event.recurrence?.freq || "none") !== "none";
    if (!isRecurring) {
      if (String(event.date) < fromIso || String(event.date) > toIso) {
        return;
      }
    } else if (event.recurrence?.until && event.recurrence.until < fromIso) {
      return;
    }
    const body = [
      event.location ? `Location: ${event.location}` : "",
      event.notes || ""
    ].filter(Boolean).join("\n");
    const allDay = event.allDay === true;
    const rrule = buildRRule(event.recurrence, allDay);
    const base = {
      dtstamp: compactTimestamp(event.updatedAt || event.createdAt),
      allDay,
      date: event.date,
      rrule,
      summary: event.title,
      description: body,
      location: event.location,
      categories: event.category
    };

    if (allDay) {
      target.push({ ...base, uid: `${event.id}@kabbak` });
      return;
    }

    // Split events emit one block per segment, each with its own UID so calendar
    // apps treat them as separate times on the same day.
    const segments = Array.isArray(event.segments) && event.segments.length
      ? event.segments
      : [{ startTime: event.startTime, endTime: event.endTime }];
    segments.forEach((segment, index) => {
      if (!segment?.startTime) {
        return;
      }
      target.push({
        ...base,
        uid: `${event.id}-${index}@kabbak`,
        startTime: segment.startTime,
        endTime: segment.endTime
      });
    });
  });
}

function collectHolidays(referenceData, fromIso, toIso, target) {
  const holidays = Array.isArray(referenceData?.calendarHolidays) ? referenceData.calendarHolidays : [];
  const fromYear = Number(fromIso.slice(0, 4));
  const toYear = Number(toIso.slice(0, 4));
  const seen = new Set();
  for (const holiday of holidays) {
    const monthDay = String(holiday?.monthDayStart || "").trim();
    if (!/^\d{2}-\d{2}$/.test(monthDay)) {
      continue;
    }
    for (let year = fromYear; year <= toYear; year += 1) {
      const date = `${year}-${monthDay}`;
      if (date < fromIso || date > toIso) {
        continue;
      }
      const uid = `holiday-${holiday.id}-${date}@kabbak`;
      if (seen.has(uid)) {
        continue;
      }
      seen.add(uid);
      target.push({
        uid,
        dtstamp: compactTimestamp(new Date().toISOString()),
        allDay: true,
        date,
        summary: holiday.name,
        description: holiday.description || "",
        categories: "holiday"
      });
    }
  }
}

function collectMoonPhases(fromIso, toIso, target) {
  const [fromYear, fromMonth, fromDay] = fromIso.split("-").map(Number);
  const cursor = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));
  const [toYear, toMonth, toDay] = toIso.split("-").map(Number);
  const end = new Date(Date.UTC(toYear, toMonth - 1, toDay));
  let previousPhase = "";
  for (; cursor <= end; cursor = new Date(cursor.getTime() + DAY_IN_MS)) {
    const phase = getMoonPhaseName(SunCalc.getMoonIllumination(cursor).phase);
    const date = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
    if (PRINCIPAL_MOON_PHASES.has(phase) && phase !== previousPhase) {
      target.push({
        uid: `moon-${date}@kabbak`,
        dtstamp: compactTimestamp(new Date().toISOString()),
        allDay: true,
        date,
        summary: `Moon: ${phase}`,
        categories: "moon"
      });
    }
    previousPhase = phase;
  }
}

function readFeedCache(key) {
  const cached = feedCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAtMs <= Date.now()) {
    feedCache.delete(key);
    return null;
  }
  return cached.body;
}

function writeFeedCache(key, body) {
  feedCache.set(key, { body, expiresAtMs: Date.now() + FEED_CACHE_TTL_MS });
  if (feedCache.size > FEED_CACHE_MAX) {
    const oldest = feedCache.keys().next().value;
    if (oldest !== undefined) {
      feedCache.delete(oldest);
    }
  }
}

async function buildCalendarFeed({ token, layers, now = new Date(), options = {} } = {}) {
  const resolved = resolveCalendarFeedToken(token, options);
  if (!resolved) {
    return null;
  }

  const layerSet = normalizeLayers(layers);
  const cacheKey = `${resolved.clientId}|${[...layerSet].sort().join(",")}`;
  const cached = readFeedCache(cacheKey);
  if (cached) {
    return cached;
  }

  const fromIso = localIsoDate(new Date(now.getTime() - FEED_PAST_DAYS * DAY_IN_MS));
  const toIso = localIsoDate(new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_IN_MS));
  const feedEvents = [];
  if (layerSet.has("user")) {
    collectUserEvents(resolved.profile.events || [], fromIso, toIso, feedEvents);
  }
  if (layerSet.has("holidays")) {
    const referenceData = await loadReferenceData();
    collectHolidays(referenceData, fromIso, toIso, feedEvents);
  }
  if (layerSet.has("moon")) {
    collectMoonPhases(fromIso, toIso, feedEvents);
  }

  const calendarName = String(resolved.profile.displayName || "").trim() || "KABBAK";
  const body = renderIcs(calendarName, feedEvents);
  writeFeedCache(cacheKey, body);
  return body;
}

module.exports = {
  buildCalendarFeed,
  escapeIcsText,
  foldIcsLine
};
