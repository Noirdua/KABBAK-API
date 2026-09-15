const SunCalc = require("suncalc");

const { loadReferenceData } = require("./data-loader");
const {
  buildAttachmentShareUrl,
  expandEventOccurrences,
  findEventAttachment,
  findNoteAttachment,
  getProfileRevision,
  resolveCalendarFeedToken,
  resolveEventOccurrenceAttachments
} = require("./profile-service");
const { getMoonPhaseName } = require("./calendar-service");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FEED_PAST_DAYS = 365;
const FEED_FUTURE_DAYS = 730;
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const FEED_CACHE_MAX = 200;
const NOTE_DESCRIPTION_MAX = 4000;
const DEFAULT_LAYERS = Object.freeze(["user", "moon", "holidays"]);
const KNOWN_LAYERS = new Set([...DEFAULT_LAYERS, "notes"]);
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
  if (Array.isArray(event.attachments)) {
    event.attachments.forEach((url) => {
      if (url) {
        lines.push(`ATTACH:${url}`);
      }
    });
  }
  lines.push("END:VEVENT");
  return lines;
}

// RFC 5545 VJOURNAL. Standard, but not rendered by Apple/Google/Outlook calendar
// apps, so it is opt-in via ?notesFormat=journal; notes default to VEVENTs.
function renderVjournalLines(journal) {
  const lines = [
    "BEGIN:VJOURNAL",
    `UID:${journal.uid}`,
    `DTSTAMP:${journal.dtstamp}`,
    `DTSTART;VALUE=DATE:${compactDate(journal.date)}`
  ];
  if (journal.summary) {
    lines.push(`SUMMARY:${escapeIcsText(journal.summary)}`);
  }
  if (journal.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(journal.description)}`);
  }
  if (journal.categories) {
    lines.push(`CATEGORIES:${escapeIcsText(journal.categories)}`);
  }
  if (Array.isArray(journal.attachments)) {
    journal.attachments.forEach((url) => {
      if (url) {
        lines.push(`ATTACH:${url}`);
      }
    });
  }
  lines.push("END:VJOURNAL");
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
    lines.push(...(event.component === "journal" ? renderVjournalLines(event) : renderVeventLines(event)));
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

function collectUserEvents(events, fromIso, toIso, target, context = {}) {
  const linkBase = String(context.baseUrl || "").replace(/\/+$/, "");
  const shareOrigin = String(context.origin || "").replace(/\/+$/, "");
  const token = String(context.token || "");

  // Each attachment gets a raw file URL (for ATTACH) and a signed share page
  // (for the description link) that renders a clean page on any device.
  const attachmentItemsFor = (event, attachments) => {
    if (!linkBase || !token || !Array.isArray(attachments)) {
      return [];
    }
    return attachments
      .filter((att) => att && att.id)
      .map((att) => {
        const fileUrl = `${linkBase}/calendar/feed/attachment/${encodeURIComponent(event.id)}/${encodeURIComponent(att.id)}?token=${encodeURIComponent(token)}`;
        const pageUrl = (shareOrigin && context.profile)
          ? `${shareOrigin}${buildAttachmentShareUrl(context.profile, { c: context.clientId, t: "e", e: event.id, a: att.id })}`
          : "";
        return { name: att.name || "attachment", fileUrl, pageUrl: pageUrl || fileUrl };
      });
  };

  events.forEach((event) => {
    const isRecurring = (event.recurrence?.freq || "none") !== "none";
    const hasOverrides = Array.isArray(event.occurrenceOverrides) && event.occurrenceOverrides.length > 0;
    const allDay = event.allDay === true;
    const dtstamp = compactTimestamp(event.updatedAt || event.createdAt);
    const rrule = buildRRule(event.recurrence, allDay);
    const segments = Array.isArray(event.segments) && event.segments.length
      ? event.segments
      : [{ startTime: event.startTime, endTime: event.endTime }];

    const emit = (date, uidBase, effectiveAttachments, includeRrule) => {
      const attachmentItems = attachmentItemsFor(event, effectiveAttachments);
      const bodyLines = [
        event.location ? `Location: ${event.location}` : "",
        event.notes || ""
      ].filter(Boolean);
      if (attachmentItems.length) {
        bodyLines.push("", "Attachments:", ...attachmentItems.map((item) => `${item.name}: ${item.pageUrl}`));
      }
      const base = {
        dtstamp,
        allDay,
        date,
        rrule: includeRrule ? rrule : "",
        summary: event.title,
        description: bodyLines.join("\n"),
        location: event.location,
        categories: event.category,
        attachments: attachmentItems.map((item) => item.fileUrl)
      };
      if (allDay) {
        target.push({ ...base, uid: `${uidBase}@kabbak` });
        return;
      }
      // Split events emit one block per segment, each with its own UID so
      // calendar apps treat them as separate times on the same day.
      segments.forEach((segment, index) => {
        if (!segment?.startTime) {
          return;
        }
        target.push({
          ...base,
          uid: `${uidBase}-${index}@kabbak`,
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    };

    if (hasOverrides) {
      // Occasions carry per-occurrence attachments, so expand them into concrete
      // events rather than a single RRULE (which cannot vary ATTACH per date).
      expandEventOccurrences(event, fromIso, toIso).forEach((date) => {
        const { attachments } = resolveEventOccurrenceAttachments(event, date);
        emit(date, `${event.id}-${date}`, attachments, false);
      });
      return;
    }

    if (!isRecurring) {
      if (String(event.date) < fromIso || String(event.date) > toIso) {
        return;
      }
    } else if (event.recurrence?.until && event.recurrence.until < fromIso) {
      return;
    }
    emit(event.date, event.id, event.attachments, true);
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

function buildNoteBody(note) {
  const lines = [];
  const scenes = Array.isArray(note?.scenes) ? note.scenes : [];
  scenes.forEach((scene, index) => {
    const header = [];
    if (scenes.length > 1) {
      header.push(`Scene ${index + 1}`);
    }
    const time = scene.endTime ? `${scene.time}–${scene.endTime}` : String(scene.time || "");
    if (time) {
      header.push(time);
    }
    if (scene.place) {
      header.push(scene.place);
    }
    if (header.length) {
      lines.push(header.join(" · "));
    }
    const fields = [
      scene.mood ? `Mood: ${scene.mood}` : "",
      scene.emotion ? `Emotion: ${scene.emotion}` : "",
      scene.atmosphere ? `Atmosphere: ${scene.atmosphere}` : "",
      scene.scenario ? `Scenario: ${scene.scenario}` : "",
      scene.steps || "",
      scene.thoughts ? `Thoughts: ${scene.thoughts}` : "",
      scene.notes || ""
    ].filter(Boolean);
    lines.push(...fields);
    if (index < scenes.length - 1) {
      lines.push("");
    }
  });
  return lines.join("\n").slice(0, NOTE_DESCRIPTION_MAX);
}

function collectNotes(notes, fromIso, toIso, target, context = {}, format = "events") {
  const linkBase = String(context.baseUrl || "").replace(/\/+$/, "");
  const shareOrigin = String(context.origin || "").replace(/\/+$/, "");
  const token = String(context.token || "");
  (Array.isArray(notes) ? notes : []).forEach((note) => {
    const date = String(note?.occurredOn || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < fromIso || date > toIso) {
      return;
    }
    const attachmentItems = (linkBase && token)
      ? (note.scenes || []).flatMap((scene) => (scene.attachments || [])
          .filter((att) => att && att.id)
          .map((att) => {
            const fileUrl = `${linkBase}/calendar/feed/note-attachment/${encodeURIComponent(note.id)}/${encodeURIComponent(scene.id)}/${encodeURIComponent(att.id)}?token=${encodeURIComponent(token)}`;
            const pageUrl = (shareOrigin && context.profile)
              ? `${shareOrigin}${buildAttachmentShareUrl(context.profile, { c: context.clientId, t: "n", n: note.id, s: scene.id, a: att.id })}`
              : "";
            return { name: att.name || "attachment", fileUrl, pageUrl: pageUrl || fileUrl };
          }))
      : [];
    const bodyLines = [buildNoteBody(note)];
    if (attachmentItems.length) {
      bodyLines.push("", "Attachments:", ...attachmentItems.map((item) => `${item.name}: ${item.pageUrl}`));
    }
    const isDream = note.kind === "dream";
    target.push({
      component: format === "journal" ? "journal" : "event",
      uid: `note-${note.id}@kabbak`,
      dtstamp: compactTimestamp(note.updatedAt || note.createdAt),
      allDay: true,
      date,
      summary: `${isDream ? "Dream" : "Journal"}: ${note.title}`,
      description: bodyLines.filter(Boolean).join("\n"),
      categories: isDream ? "dream" : "journal",
      attachments: attachmentItems.map((item) => item.fileUrl)
    });
  });
}

function collectMoonPhases(fromIso, toIso, target) {
  const [fromYear, fromMonth, fromDay] = fromIso.split("-").map(Number);
  let cursor = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay));
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

async function buildCalendarFeed({ token, layers, notesFormat = "events", now = new Date(), options = {}, baseUrl = "", origin = "" } = {}) {
  const resolved = resolveCalendarFeedToken(token, options);
  if (!resolved) {
    return null;
  }

  const layerSet = normalizeLayers(layers);
  const noteMode = String(notesFormat || "events").toLowerCase() === "journal" ? "journal" : "events";
  // The revision bumps on every profile write, so a new event/note shows in the
  // feed immediately instead of waiting out the cache TTL. baseUrl and token are
  // in the key too because attachment links embed both.
  const cacheKey = [
    resolved.clientId,
    getProfileRevision(resolved.clientId),
    [...layerSet].sort().join(","),
    noteMode,
    token,
    String(baseUrl).replace(/\/+$/, ""),
    String(origin).replace(/\/+$/, "")
  ].join("|");
  const cached = readFeedCache(cacheKey);
  if (cached) {
    return cached;
  }

  const fromIso = localIsoDate(new Date(now.getTime() - FEED_PAST_DAYS * DAY_IN_MS));
  const toIso = localIsoDate(new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_IN_MS));
  const feedEvents = [];
  const collectContext = { baseUrl, origin, token, profile: resolved.profile, clientId: resolved.clientId };
  if (layerSet.has("user")) {
    collectUserEvents(resolved.profile.events || [], fromIso, toIso, feedEvents, collectContext);
  }
  if (layerSet.has("holidays")) {
    const referenceData = await loadReferenceData();
    collectHolidays(referenceData, fromIso, toIso, feedEvents);
  }
  if (layerSet.has("moon")) {
    collectMoonPhases(fromIso, toIso, feedEvents);
  }
  if (layerSet.has("notes")) {
    collectNotes(resolved.profile.notes || [], fromIso, toIso, feedEvents, collectContext, noteMode);
  }

  const calendarName = String(resolved.profile.displayName || "").trim() || "KABBAK";
  const body = renderIcs(calendarName, feedEvents);
  writeFeedCache(cacheKey, body);
  return body;
}

// Resolve an event attachment for the public feed route. Returns null when the
// token is invalid/disabled or the attachment does not exist.
function resolveFeedAttachment({ token, eventId, attachmentId, options = {} } = {}) {
  const resolved = resolveCalendarFeedToken(token, options);
  if (!resolved) {
    return null;
  }
  return findEventAttachment(resolved.profile, eventId, attachmentId);
}

function resolveFeedNoteAttachment({ token, noteId, sceneId, attachmentId, options = {} } = {}) {
  const resolved = resolveCalendarFeedToken(token, options);
  if (!resolved) {
    return null;
  }
  return findNoteAttachment(resolved.profile, noteId, sceneId, attachmentId);
}

module.exports = {
  buildCalendarFeed,
  escapeIcsText,
  foldIcsLine,
  resolveFeedAttachment,
  resolveFeedNoteAttachment
};
