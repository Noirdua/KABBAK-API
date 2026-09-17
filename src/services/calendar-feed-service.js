const Astronomy = require("astronomy-engine");

const { loadReferenceData } = require("./data-loader");
const {
  buildAttachmentShareUrl,
  expandEventOccurrences,
  findEventAttachment,
  findNoteAttachment,
  getProfileRevision,
  normalizeCalendarFeedOptions,
  readProfile,
  resolveCalendarFeedToken,
  resolveEventOccurrenceAttachments
} = require("./profile-service");
const { calcPlanetaryHoursForDayAndLocation } = require("./calendar-service");
const {
  CALENDAR_FEED_LAYERS,
  DEFAULT_CALENDAR_FEED_LAYERS
} = require("../config/profile-storage");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FEED_PAST_DAYS = 365;
const FEED_FUTURE_DAYS = 730;
const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
const FEED_CACHE_MAX = 200;
const NOTE_DESCRIPTION_MAX = 4000;
const KNOWN_LAYERS = new Set(CALENDAR_FEED_LAYERS);
// Moon phase angles (Sun→Moon elongation) and their slug/label.
const MOON_PHASE_TARGETS = Object.freeze([
  { angle: 0, slug: "new", label: "New Moon" },
  { angle: 90, slug: "first-quarter", label: "First Quarter" },
  { angle: 180, slug: "full", label: "Full Moon" },
  { angle: 270, slug: "last-quarter", label: "Last Quarter" }
]);
const DECAN_DEGREES = 10;
const SEARCH_LIMIT_DAYS = 45;
// Planetary hours are 24 timed events a day, so a subscription only covers a
// rolling window to keep the feed a sane size.
const PLANETARY_PAST_DAYS = 14;
const PLANETARY_FUTURE_DAYS = 60;

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
      // Hours that cross midnight end on the next day.
      lines.push(`DTEND:${compactDateTime(event.endDate || event.date, event.endTime)}`);
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
  const explicit = Array.isArray(rawLayers) || (typeof rawLayers === "string" && rawLayers.trim() !== "");
  const requested = (Array.isArray(rawLayers) ? rawLayers : String(rawLayers || "").split(","))
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => KNOWN_LAYERS.has(entry));
  if (requested.length) {
    return new Set(requested);
  }
  // Explicit empty means "no layers"; absent falls back to the defaults.
  return explicit ? new Set() : new Set(DEFAULT_CALENDAR_FEED_LAYERS);
}

// Feed times are civil dates at the subscriber's location, so resolve an offset
// from the request, then the saved location, then the longitude.
function resolveFeedOffsetMinutes(profile, explicit) {
  const provided = Number(explicit);
  if (Number.isFinite(provided) && provided >= -720 && provided <= 840) {
    return Math.round(provided);
  }
  const stored = Number(profile?.location?.utcOffsetMinutes);
  if (Number.isFinite(stored) && stored >= -720 && stored <= 840) {
    return Math.round(stored);
  }
  const longitude = Number(profile?.location?.longitude);
  if (Number.isFinite(longitude)) {
    return Math.round(longitude / 15) * 60;
  }
  return 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// Civil date of an instant at the subscriber's offset.
function localDateLabel(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function formatLocalMoment(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  const absolute = Math.abs(offsetMinutes);
  const zone = `UTC${offsetMinutes < 0 ? "-" : "+"}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
  return `${localDateLabel(date, offsetMinutes)} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())} ${zone}`;
}

function localTimeLabel(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function utcWindow(fromIso, toIso, offsetMinutes) {
  return {
    start: new Date(Date.parse(`${fromIso}T00:00:00Z`) - offsetMinutes * 60 * 1000),
    end: new Date(Date.parse(`${toIso}T23:59:59Z`) - offsetMinutes * 60 * 1000)
  };
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

// Exact principal-phase instants (astronomy-engine's moon phase angle), emitted
// as all-day events on the subscriber's local date with the precise moment in
// the description.
function collectMoonPhases(fromIso, toIso, target, { offsetMinutes = 0, phases } = {}) {
  const { start, end } = utcWindow(fromIso, toIso, offsetMinutes);
  // An explicit array is honoured even when empty (no phases); only an absent
  // value means "all phases".
  const allowed = Array.isArray(phases) ? new Set(phases) : null;
  MOON_PHASE_TARGETS.filter((phase) => !allowed || allowed.has(phase.slug)).forEach(({ angle, slug, label }) => {
    let cursor = new Date(start.getTime());
    for (let guard = 0; guard < 80; guard += 1) {
      const found = Astronomy.SearchMoonPhase(angle, cursor, SEARCH_LIMIT_DAYS);
      if (!found || !found.date) {
        break;
      }
      if (found.date.getTime() > end.getTime()) {
        break;
      }
      const date = localDateLabel(found.date, offsetMinutes);
      target.push({
        uid: `moon-${slug}-${date}@kabbak`,
        dtstamp: compactTimestamp(new Date().toISOString()),
        allDay: true,
        date,
        time: localTimeLabel(found.date, offsetMinutes),
        summary: `Moon: ${label}`,
        description: `${label} exact at ${formatLocalMoment(found.date, offsetMinutes)}.`,
        categories: "moon"
      });
      cursor = new Date(found.date.getTime() + 60 * 1000);
    }
  });
}

// Exact astrology boundaries: the Sun's apparent ecliptic longitude crossing a
// step. `detail` picks the step: "decan" (10°, the default), "degree" (1°, about
// daily), or "sign" (30°, the sign ingresses).
function collectAstrologyEvents(referenceData, fromIso, toIso, target, { offsetMinutes = 0, detail = "decan" } = {}) {
  const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
  const decansBySign = referenceData?.decansBySign || {};
  if (!signs.length) {
    return;
  }
  const step = detail === "sign" ? 30 : (detail === "degree" ? 1 : DECAN_DEGREES);
  const byOrder = new Map(signs.map((sign) => [Number(sign.order) || 0, sign]));
  const { start, end } = utcWindow(fromIso, toIso, offsetMinutes);
  const startLongitude = SunLongitude(start);
  let targetLongitude = (Math.floor(startLongitude / step) + 1) * step;
  let cursor = new Date(start.getTime());
  const maxEvents = step === 1 ? 1200 : 400;
  for (let guard = 0; guard < maxEvents; guard += 1) {
    const normalized = ((targetLongitude % 360) + 360) % 360;
    const found = Astronomy.SearchSunLongitude(normalized, cursor, SEARCH_LIMIT_DAYS);
    if (!found || !found.date) {
      break;
    }
    if (found.date.getTime() > end.getTime()) {
      break;
    }
    const signOrder = Math.floor(normalized / 30) + 1;
    const sign = byOrder.get(signOrder);
    const signName = sign?.name || "";
    const degree = Math.round(normalized % 30);
    const date = localDateLabel(found.date, offsetMinutes);
    const time = localTimeLabel(found.date, offsetMinutes);
    const exact = formatLocalMoment(found.date, offsetMinutes);
    const dtstamp = compactTimestamp(new Date().toISOString());

    if (detail === "sign") {
      target.push({
        uid: `sign-${sign?.id || signOrder}-${date}@kabbak`,
        dtstamp,
        allDay: true,
        date,
        time,
        summary: `Sun enters ${signName}`,
        description: `Sun enters ${signName} at 0° ${signName} — exact ${exact}.`,
        categories: "astrology"
      });
    } else if (detail === "degree") {
      target.push({
        uid: `degree-${sign?.id || signOrder}-${degree}-${date}@kabbak`,
        dtstamp,
        allDay: true,
        date,
        time,
        summary: `Sun ${degree}° ${signName}`,
        description: `Sun reaches ${degree}° ${signName} — exact ${exact}.`,
        categories: "astrology"
      });
    } else {
      const decanIndex = Math.floor((normalized % 30) / DECAN_DEGREES) + 1;
      const decan = (decansBySign[sign?.id] || []).find((entry) => entry.index === decanIndex) || null;
      const label = decan?.tarotMinorArcana || `${signName} decan ${decanIndex}`.trim();
      target.push({
        uid: `decan-${sign?.id || signOrder}-${decanIndex}-${date}@kabbak`,
        dtstamp,
        allDay: true,
        date,
        time,
        // Index is 1..3 within the sign (0°/10°/20°) and resets each sign; make
        // that explicit, since the tarot card number runs across the zodiac.
        summary: `Decan ${decanIndex}/3: ${label}`,
        description: `Sun enters decan ${decanIndex} of ${signName} (${label}) at ${degree}° ${signName} — exact ${exact}.`,
        categories: "astrology"
      });
    }
    targetLongitude = normalized + step;
    cursor = new Date(found.date.getTime() + 60 * 1000);
  }
}

// 24 timed events per day, capped to a rolling window around now.
function collectPlanetaryHours(profile, fromIso, toIso, target, { offsetMinutes = 0, referenceData = null } = {}) {
  const latitude = Number(profile?.location?.latitude);
  const longitude = Number(profile?.location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }
  const planets = referenceData?.planets || {};
  const windowFrom = localIsoDate(new Date(Date.now() - PLANETARY_PAST_DAYS * DAY_IN_MS));
  const windowTo = localIsoDate(new Date(Date.now() + PLANETARY_FUTURE_DAYS * DAY_IN_MS));
  const startIso = fromIso > windowFrom ? fromIso : windowFrom;
  const endIso = toIso < windowTo ? toIso : windowTo;
  if (endIso < startIso) {
    return;
  }
  const geo = { latitude, longitude };
  let cursor = new Date(`${startIso}T12:00:00Z`);
  const end = new Date(`${endIso}T12:00:00Z`);
  for (; cursor <= end; cursor = new Date(cursor.getTime() + DAY_IN_MS)) {
    const hours = calcPlanetaryHoursForDayAndLocation(cursor, geo);
    hours.forEach((hour, index) => {
      const start = hour?.start;
      const finish = hour?.end;
      if (!(start instanceof Date) || Number.isNaN(start.getTime())
        || !(finish instanceof Date) || Number.isNaN(finish.getTime())) {
        return;
      }
      const planet = planets[hour.planetId];
      const planetName = planet?.name || hour.planetId;
      const symbol = planet?.symbol || "";
      const localStart = new Date(start.getTime() + offsetMinutes * 60 * 1000);
      const localEnd = new Date(finish.getTime() + offsetMinutes * 60 * 1000);
      const date = `${localStart.getUTCFullYear()}-${pad2(localStart.getUTCMonth() + 1)}-${pad2(localStart.getUTCDate())}`;
      const endDate = `${localEnd.getUTCFullYear()}-${pad2(localEnd.getUTCMonth() + 1)}-${pad2(localEnd.getUTCDate())}`;
      target.push({
        uid: `planetary-${date}-${index}-${hour.planetId}@kabbak`,
        dtstamp: compactTimestamp(new Date().toISOString()),
        allDay: false,
        date,
        startTime: `${pad2(localStart.getUTCHours())}:${pad2(localStart.getUTCMinutes())}`,
        endTime: `${pad2(localEnd.getUTCHours())}:${pad2(localEnd.getUTCMinutes())}`,
        endDate: endDate !== date ? endDate : undefined,
        summary: `${symbol ? `${symbol} ` : ""}${planetName} hour`,
        description: `${hour.isDaylight ? "Day" : "Night"} hour of ${planetName}.`,
        categories: "planetary"
      });
    });
  }
}

function SunLongitude(date) {
  const position = Astronomy.SunPosition(date);
  const longitude = Number(position?.elon);
  if (!Number.isFinite(longitude)) {
    return 0;
  }
  return ((longitude % 360) + 360) % 360;
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

async function buildCalendarFeed({ token, layers, notesFormat = "", now = new Date(), utcOffsetMinutes, options = {}, baseUrl = "", origin = "" } = {}) {
  const resolved = resolveCalendarFeedToken(token, options);
  if (!resolved) {
    return null;
  }

  // Saved subscription choices win, so the token-only URL reflects the current
  // selection without the user re-adding the calendar. A ?layers= query is only
  // honored for feeds that have no saved selection yet (legacy subscriptions),
  // which lets an old layered URL migrate as soon as the user saves once.
  const stored = resolved.profile.calendarFeed && typeof resolved.profile.calendarFeed === "object"
    ? resolved.profile.calendarFeed
    : {};
  const hasStoredLayers = Array.isArray(stored.layers);
  const layerSet = normalizeLayers(hasStoredLayers ? stored.layers : (layers || stored.layers));
  const storedFormat = String(stored.notesFormat || "").toLowerCase();
  const noteMode = (storedFormat || String(notesFormat || "").toLowerCase() || "events") === "journal" ? "journal" : "events";
  const offsetMinutes = resolveFeedOffsetMinutes(resolved.profile, utcOffsetMinutes);
  const feedOptions = normalizeCalendarFeedOptions(stored.options);
  // The revision bumps on every profile write, so a new event/note shows in the
  // feed immediately instead of waiting out the cache TTL. baseUrl and token are
  // in the key too because attachment links embed both.
  const cacheKey = [
    resolved.clientId,
    getProfileRevision(resolved.clientId),
    [...layerSet].sort().join(","),
    noteMode,
    feedOptions.astrologyDetail,
    [...feedOptions.moonPhases].sort().join(","),
    String(offsetMinutes),
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
  const feedEvents = await collectSubscriptionEvents({
    profile: resolved.profile,
    layers: layerSet,
    fromIso,
    toIso,
    offsetMinutes,
    noteMode,
    feedOptions,
    collectContext: { baseUrl, origin, token, profile: resolved.profile, clientId: resolved.clientId }
  });

  const calendarName = String(resolved.profile.displayName || "").trim() || "KABBAK";
  const body = renderIcs(calendarName, feedEvents);
  writeFeedCache(cacheKey, body);
  return body;
}

// Build the events for the selected layers. Shared by the ICS feed and the
// in-app calendar so both always agree on what a subscription contains.
async function collectSubscriptionEvents({
  profile,
  layers,
  fromIso,
  toIso,
  offsetMinutes = 0,
  noteMode = "events",
  feedOptions = {},
  collectContext = {}
} = {}) {
  const layerSet = layers instanceof Set ? layers : normalizeLayers(layers);
  const { moonPhases, astrologyDetail } = normalizeCalendarFeedOptions(feedOptions);
  const feedEvents = [];
  if (layerSet.has("user")) {
    collectUserEvents(profile?.events || [], fromIso, toIso, feedEvents, collectContext);
  }
  if (layerSet.has("holidays") || layerSet.has("astrology") || layerSet.has("planetary")) {
    const referenceData = await loadReferenceData();
    if (layerSet.has("holidays")) {
      collectHolidays(referenceData, fromIso, toIso, feedEvents);
    }
    if (layerSet.has("astrology")) {
      collectAstrologyEvents(referenceData, fromIso, toIso, feedEvents, { offsetMinutes, detail: astrologyDetail });
    }
    if (layerSet.has("planetary")) {
      collectPlanetaryHours(profile, fromIso, toIso, feedEvents, { offsetMinutes, referenceData });
    }
  }
  if (layerSet.has("moon")) {
    collectMoonPhases(fromIso, toIso, feedEvents, { offsetMinutes, phases: moonPhases });
  }
  if (layerSet.has("notes")) {
    collectNotes(profile?.notes || [], fromIso, toIso, feedEvents, collectContext, noteMode);
  }
  return feedEvents;
}

// The same events as JSON for the in-app calendar, so a user can confirm what
// their subscription contains. `time` is the exact local moment when known.
async function buildProfileCalendarEvents(clientId, { fromIso, toIso, options = {} } = {}) {
  const profile = readProfile(clientId, options);
  const stored = profile.calendarFeed && typeof profile.calendarFeed === "object" ? profile.calendarFeed : {};
  const layerSet = normalizeLayers(stored.layers);
  const offsetMinutes = resolveFeedOffsetMinutes(profile);
  const noteMode = String(stored.notesFormat || "events").toLowerCase() === "journal" ? "journal" : "events";
  const feedOptions = normalizeCalendarFeedOptions(stored.options);
  // The in-app calendar renders the profile's own events from the events API and
  // planetary hours from /calendar/week-events, so the read-only overlay excludes
  // both `user` and `planetary` to avoid duplicates.
  const overlayLayers = new Set([...layerSet].filter((layer) => layer !== "user" && layer !== "planetary"));
  const events = await collectSubscriptionEvents({
    profile,
    layers: overlayLayers,
    fromIso,
    toIso,
    offsetMinutes,
    noteMode,
    feedOptions,
    collectContext: { baseUrl: "", origin: "", token: "", profile, clientId: "" }
  });
  return {
    layers: [...layerSet],
    options: feedOptions,
    offsetMinutes,
    events: events.map((event) => ({
      id: event.uid,
      title: event.summary,
      date: event.date,
      time: event.time || "",
      allDay: event.allDay !== false,
      category: event.categories || "",
      description: event.description || ""
    }))
  };
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
  buildProfileCalendarEvents,
  escapeIcsText,
  foldIcsLine,
  resolveFeedAttachment,
  resolveFeedNoteAttachment,
  // Exposed for tests and for callers that precompute layers/events.
  collectAstrologyEvents,
  collectMoonPhases,
  collectPlanetaryHours,
  collectSubscriptionEvents,
  normalizeLayers,
  resolveFeedOffsetMinutes
};
