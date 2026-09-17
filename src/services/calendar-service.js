const SunCalc = require("suncalc");
const Astronomy = require("astronomy-engine");

const { loadReferenceData } = require("./data-loader");
const { createHttpError } = require("../lib/http-errors");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const START = ["sol", "luna", "mars", "mercury", "jupiter", "venus", "saturn"];
const CHALDEAN = ["saturn", "jupiter", "mars", "sol", "venus", "mercury", "luna"];
const PLANET_CALENDAR_IDS = new Set(["saturn", "jupiter", "mars", "sol", "venus", "mercury", "luna"]);
const BACKFILL_DAYS = 4;
const FORECAST_DAYS = 7;
const NOW_SNAPSHOT_CACHE_TTL_MS = 30 * 1000;
const WEEK_EVENTS_CACHE_TTL_MS = 5 * 60 * 1000;
const nowSnapshotResponseCache = new Map();
const weekEventsResponseCache = new Map();

const PLANETARY_BODIES = [
  { id: "sol", astronomyBody: "Sun", fallbackName: "Sun", fallbackSymbol: "☉︎" },
  { id: "luna", astronomyBody: "Moon", fallbackName: "Moon", fallbackSymbol: "☾︎" },
  { id: "mercury", astronomyBody: "Mercury", fallbackName: "Mercury", fallbackSymbol: "☿︎" },
  { id: "venus", astronomyBody: "Venus", fallbackName: "Venus", fallbackSymbol: "♀︎" },
  { id: "mars", astronomyBody: "Mars", fallbackName: "Mars", fallbackSymbol: "♂︎" },
  { id: "jupiter", astronomyBody: "Jupiter", fallbackName: "Jupiter", fallbackSymbol: "♃︎" },
  { id: "saturn", astronomyBody: "Saturn", fallbackName: "Saturn", fallbackSymbol: "♄︎" },
  { id: "uranus", astronomyBody: "Uranus", fallbackName: "Uranus", fallbackSymbol: "♅︎" },
  { id: "neptune", astronomyBody: "Neptune", fallbackName: "Neptune", fallbackSymbol: "♆︎" },
  { id: "pluto", astronomyBody: "Pluto", fallbackName: "Pluto", fallbackSymbol: "♇︎" }
];

function getDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function minutesBetween(a, b) {
  return (a.getTime() - b.getTime()) / 60000;
}

function getMoonPhaseName(phase) {
  if (phase < 0.03 || phase > 0.97) return "New Moon";
  if (phase < 0.22) return "Waxing Crescent";
  if (phase < 0.28) return "First Quarter";
  if (phase < 0.47) return "Waxing Gibbous";
  if (phase < 0.53) return "Full Moon";
  if (phase < 0.72) return "Waning Gibbous";
  if (phase < 0.78) return "Last Quarter";
  return "Waning Crescent";
}

function parseMonthDay(monthDay) {
  const [month, day] = String(monthDay || "").split("-").map(Number);
  return { month, day };
}

function isDateInSign(date, sign) {
  const { month: startMonth, day: startDay } = parseMonthDay(sign.start);
  const { month: endMonth, day: endDay } = parseMonthDay(sign.end);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const wrapsYear = startMonth > endMonth;

  if (!wrapsYear) {
    const afterStart = month > startMonth || (month === startMonth && day >= startDay);
    const beforeEnd = month < endMonth || (month === endMonth && day <= endDay);
    return afterStart && beforeEnd;
  }

  const afterStart = month > startMonth || (month === startMonth && day >= startDay);
  const beforeEnd = month < endMonth || (month === endMonth && day <= endDay);
  return afterStart || beforeEnd;
}

function getSignStartDate(date, sign) {
  const { month: startMonth, day: startDay } = parseMonthDay(sign.start);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const wrapsYear = startMonth > parseMonthDay(sign.end).month;

  let year = date.getFullYear();
  if (wrapsYear && (month < startMonth || (month === startMonth && day < startDay))) {
    year -= 1;
  }

  return new Date(year, startMonth - 1, startDay);
}

function getSignForDate(date, signs) {
  return (Array.isArray(signs) ? signs : []).find((sign) => isDateInSign(date, sign)) || null;
}

function getDecanForDate(date, signs, decansBySign) {
  const sign = getSignForDate(date, signs);
  if (!sign) return null;

  const signDecans = decansBySign?.[sign.id] || [];
  if (!signDecans.length) {
    return { sign, decan: null };
  }

  const signStartDate = getSignStartDate(date, sign);
  const daysSinceSignStart = Math.floor((date.getTime() - signStartDate.getTime()) / DAY_IN_MS);
  let index = Math.floor(daysSinceSignStart / 10) + 1;
  if (index < 1) index = 1;
  if (index > 3) index = 3;

  const decan = signDecans.find((entry) => entry.index === index) || signDecans[0];
  return { sign, decan };
}

function calcPlanetaryHoursForDayAndLocation(date, geo) {
  const solar = SunCalc.getTimes(date, geo.latitude, geo.longitude);
  const nextDay = new Date(date.getTime() + DAY_IN_MS);
  const solarNext = SunCalc.getTimes(nextDay, geo.latitude, geo.longitude);
  const dayOfWeek = date.getDay();
  const chaldeanStartPos = CHALDEAN.indexOf(START[dayOfWeek]);

  const dayHourInMinutes = minutesBetween(solar.sunset, solar.sunrise) / 12;
  const nightHourInMinutes = minutesBetween(solarNext.sunrise, solar.sunset) / 12;

  const hours = [];
  for (let hour = 0; hour < 12; hour += 1) {
    const start = new Date(solar.sunrise.getTime() + dayHourInMinutes * hour * 60_000);
    const end = new Date(start.getTime() + dayHourInMinutes * 60_000);
    hours.push({
      start,
      end,
      planetId: CHALDEAN[(chaldeanStartPos + hour) % 7],
      isDaylight: true
    });
  }

  for (let hour = 12; hour < 24; hour += 1) {
    const start = new Date(solar.sunset.getTime() + nightHourInMinutes * (hour - 12) * 60_000);
    const end = new Date(start.getTime() + nightHourInMinutes * 60_000);
    hours.push({
      start,
      end,
      planetId: CHALDEAN[(chaldeanStartPos + hour) % 7],
      isDaylight: false
    });
  }

  return hours;
}

function parseGeo(input) {
  let place = null;
  try {
    place = require("./location-gazetteer").tryResolvePlace(input);
  } catch (error) {
    if (error.status) throw error;
    throw createHttpError(400, error.code || "invalid_location_place", error.message);
  }
  if (place) {
    return {
      latitude: place.latitude,
      longitude: place.longitude,
      label: place.label,
      placeId: place.id
    };
  }

  const latitude = Number(input?.latitude ?? input?.lat);
  const longitude = Number(input?.longitude ?? input?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw createHttpError(400, "invalid_coordinates", "Provide country/region/city, or numeric latitude and longitude.");
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw createHttpError(400, "invalid_coordinates", "Latitude must be between -90 and 90, and longitude must be between -180 and 180.");
  }
  return { latitude, longitude };
}

function parseAnchorDate(input) {
  if (!input) {
    return new Date();
  }
  const date = new Date(String(input));
  if (Number.isNaN(date.getTime())) {
    throw createHttpError(400, "invalid_date", "Invalid date query param.");
  }
  return date;
}

function buildWeekEvents(geo, referenceData, anchorDate) {
  const baseDate = anchorDate || new Date();
  const events = [];
  let runningId = 1;

  for (let offset = -BACKFILL_DAYS; offset <= FORECAST_DAYS; offset += 1) {
    const date = new Date(baseDate.getTime() + offset * DAY_IN_MS);
    const hours = calcPlanetaryHoursForDayAndLocation(date, geo);
    const moonIllum = SunCalc.getMoonIllumination(date);
    const moonPhase = getMoonPhaseName(moonIllum.phase);
    const sunInfo = getDecanForDate(date, referenceData.signs, referenceData.decansBySign);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);

    // Compact DTO: client expands titles/bodies from bootstrap reference data.
    events.push({
      id: `moon-${offset}`,
      kind: "moon",
      calendarId: "astrology",
      category: "allday",
      moonPhase,
      moonIlluminationPct: Math.round(moonIllum.fraction * 100),
      start: dayStart.toISOString(),
      end: dayEnd.toISOString(),
      isReadOnly: true
    });

    if (sunInfo?.sign) {
      events.push({
        id: `sun-${offset}`,
        kind: "sun",
        calendarId: "astrology",
        category: "allday",
        signId: sunInfo.sign.id,
        decanIndex: sunInfo.decan?.index || null,
        start: dayStart.toISOString(),
        end: dayEnd.toISOString(),
        isReadOnly: true
      });
    }

    for (const hour of hours) {
      if (!referenceData.planets?.[hour.planetId]) {
        continue;
      }

      const calendarId = PLANET_CALENDAR_IDS.has(hour.planetId)
        ? `planet-${hour.planetId}`
        : "planetary";

      events.push({
        id: `ph-${runningId++}`,
        kind: "planetaryHour",
        calendarId,
        category: "time",
        planetId: hour.planetId,
        isDaylight: hour.isDaylight === true,
        start: hour.start.toISOString(),
        end: hour.end.toISOString(),
        isReadOnly: true
      });
    }
  }

  return events;
}

function normalizeLongitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return ((numeric % 360) + 360) % 360;
}

function getSortedSigns(signs) {
  if (!Array.isArray(signs)) {
    return [];
  }
  return [...signs].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function ensureCalendarIndexes(referenceData) {
  if (!referenceData || typeof referenceData !== "object") {
    return {
      sortedSigns: [],
      sabianByDegree: new Map()
    };
  }

  if (referenceData.__calendarIndexes) {
    return referenceData.__calendarIndexes;
  }

  const sortedSigns = getSortedSigns(referenceData.signs);
  const sabianByDegree = new Map();
  const sabianSymbols = Array.isArray(referenceData.sabianSymbols) ? referenceData.sabianSymbols : [];
  sabianSymbols.forEach((entry) => {
    const degree = Number(entry?.absoluteDegree);
    if (Number.isFinite(degree)) {
      sabianByDegree.set(degree, entry);
    }
  });

  referenceData.__calendarIndexes = {
    sortedSigns,
    sabianByDegree
  };
  return referenceData.__calendarIndexes;
}

function getSignForLongitude(longitude, signsOrReferenceData) {
  const normalized = normalizeLongitude(longitude);
  if (normalized === null) {
    return null;
  }

  const sortedSigns = Array.isArray(signsOrReferenceData)
    ? getSortedSigns(signsOrReferenceData)
    : ensureCalendarIndexes(signsOrReferenceData).sortedSigns;
  if (!sortedSigns.length) {
    return null;
  }

  const signIndex = Math.min(sortedSigns.length - 1, Math.floor(normalized / 30));
  const sign = sortedSigns[signIndex] || null;
  if (!sign) {
    return null;
  }

  return {
    sign,
    degreeInSign: normalized - signIndex * 30,
    absoluteLongitude: normalized
  };
}

function getSabianSymbolForLongitude(longitude, sabianSymbolsOrReferenceData) {
  const normalized = normalizeLongitude(longitude);
  if (normalized === null) {
    return null;
  }

  const absoluteDegree = Math.floor(normalized) + 1;
  if (sabianSymbolsOrReferenceData && !Array.isArray(sabianSymbolsOrReferenceData)) {
    const indexed = ensureCalendarIndexes(sabianSymbolsOrReferenceData).sabianByDegree.get(absoluteDegree);
    return indexed || null;
  }

  if (!Array.isArray(sabianSymbolsOrReferenceData) || !sabianSymbolsOrReferenceData.length) {
    return null;
  }
  return sabianSymbolsOrReferenceData.find((entry) => Number(entry?.absoluteDegree) === absoluteDegree) || null;
}

function calculatePlanetPositions(referenceData, now) {
  if (!referenceData) {
    return [];
  }

  const positions = [];
  PLANETARY_BODIES.forEach((body) => {
    try {
      const geoVector = Astronomy.GeoVector(body.astronomyBody, now, true);
      const ecliptic = Astronomy.Ecliptic(geoVector);
      const signInfo = getSignForLongitude(ecliptic?.elon, referenceData);
      if (!signInfo?.sign) {
        return;
      }

      const planetInfo = referenceData.planets?.[body.id] || null;
      const symbol = planetInfo?.symbol || body.fallbackSymbol;
      const name = planetInfo?.name || body.fallbackName;

      positions.push({
        id: body.id,
        symbol,
        name,
        longitude: signInfo.absoluteLongitude,
        sign: signInfo.sign,
        degreeInSign: signInfo.degreeInSign,
        label: `${symbol} ${name}: ${signInfo.sign.symbol} ${signInfo.sign.name} ${signInfo.degreeInSign.toFixed(1)}°`
      });
    } catch {
    }
  });

  return positions;
}

function readResponseCache(cacheMap, cacheKey) {
  const cached = cacheMap.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (!Number.isFinite(cached.expiresAtMs) || cached.expiresAtMs <= Date.now()) {
    cacheMap.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function writeResponseCache(cacheMap, cacheKey, value, ttlMs) {
  cacheMap.set(cacheKey, {
    expiresAtMs: Date.now() + Math.max(1000, ttlMs),
    value
  });

  // Prevent unbounded growth if geo keys churn.
  if (cacheMap.size > 250) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey !== undefined) {
      cacheMap.delete(oldestKey);
    }
  }
}

function buildGeoCacheKey(geo, extra = "") {
  const latitude = Number(geo?.latitude);
  const longitude = Number(geo?.longitude);
  return `${latitude.toFixed(3)}|${longitude.toFixed(3)}|${extra}`;
}

function findCurrentPlanetaryHour(now, geo) {
  const todayHours = calcPlanetaryHoursForDayAndLocation(now, geo);
  let currentHour = todayHours.find((entry) => now >= entry.start && now < entry.end) || null;
  let hourPool = todayHours;
  let yesterdayHours = null;
  let tomorrowHours = null;

  // After local midnight and before sunrise, the active hour lives on "yesterday"'s night chain.
  if (!currentHour) {
    yesterdayHours = calcPlanetaryHoursForDayAndLocation(new Date(now.getTime() - DAY_IN_MS), geo);
    currentHour = yesterdayHours.find((entry) => now >= entry.start && now < entry.end) || null;
    if (currentHour) {
      hourPool = [...yesterdayHours, ...todayHours];
    }
  }

  if (!currentHour) {
    tomorrowHours = calcPlanetaryHoursForDayAndLocation(new Date(now.getTime() + DAY_IN_MS), geo);
    currentHour = tomorrowHours.find((entry) => now >= entry.start && now < entry.end) || null;
    if (currentHour) {
      hourPool = [...todayHours, ...tomorrowHours];
    }
  }

  if (!currentHour) {
    return { currentHour: null, nextHour: null };
  }

  const currentEndMs = currentHour.end.getTime();
  let nextHour = hourPool.find((entry) => entry.start.getTime() >= currentEndMs - 1000) || null;
  if (!nextHour) {
    tomorrowHours = tomorrowHours || calcPlanetaryHoursForDayAndLocation(new Date(now.getTime() + DAY_IN_MS), geo);
    nextHour = tomorrowHours.find((entry) => entry.start.getTime() >= currentEndMs - 1000) || tomorrowHours[0] || null;
  }

  return { currentHour, nextHour };
}

function getCurrentPhaseName(date) {
  return getMoonPhaseName(SunCalc.getMoonIllumination(date).phase);
}

function findNextMoonPhaseTransition(now) {
  const currentPhase = getCurrentPhaseName(now);
  // Coarse scan first (1h), then binary-search to ~1s. Much cheaper than 15-minute linear.
  const stepMs = 60 * 60 * 1000;
  const maxMs = 40 * DAY_IN_MS;
  let previousTime = now.getTime();
  let previousPhase = currentPhase;

  for (let t = previousTime + stepMs; t <= previousTime + maxMs; t += stepMs) {
    const phaseName = getCurrentPhaseName(new Date(t));
    if (phaseName !== previousPhase) {
      let low = previousTime;
      let high = t;
      while (high - low > 1000) {
        const mid = Math.floor((low + high) / 2);
        const midPhase = getCurrentPhaseName(new Date(mid));
        if (midPhase === currentPhase) {
          low = mid;
        } else {
          high = mid;
        }
      }

      return {
        fromPhase: currentPhase,
        nextPhase: getCurrentPhaseName(new Date(high + 1000)),
        changeAt: new Date(high)
      };
    }
    previousTime = t;
    previousPhase = phaseName;
  }

  return null;
}

function getNextSign(signs, currentSign) {
  const sorted = [...signs].sort((a, b) => (a.order || 0) - (b.order || 0));
  const index = sorted.findIndex((entry) => entry.id === currentSign.id);
  if (index < 0) {
    return null;
  }
  return sorted[(index + 1) % sorted.length] || null;
}

function getDecanByIndex(decansBySign, signId, index) {
  const signDecans = decansBySign[signId] || [];
  return signDecans.find((entry) => entry.index === index) || null;
}

function findNextDecanTransition(now, signs, decansBySign) {
  const currentInfo = getDecanForDate(now, signs, decansBySign);
  if (!currentInfo?.sign) {
    return null;
  }

  const currentIndex = currentInfo.decan?.index || 1;
  const signStart = getSignStartDate(now, currentInfo.sign);

  if (currentIndex < 3) {
    const changeAt = new Date(signStart.getTime() + currentIndex * 10 * DAY_IN_MS);
    const nextDecan = getDecanByIndex(decansBySign, currentInfo.sign.id, currentIndex + 1);
    return {
      key: `${currentInfo.sign.id}-${currentIndex}`,
      changeAt,
      nextLabel: nextDecan?.tarotMinorArcana || `${currentInfo.sign.name} Decan ${currentIndex + 1}`
    };
  }

  const nextSign = getNextSign(signs, currentInfo.sign);
  if (!nextSign) {
    return null;
  }

  const { month: nextMonth, day: nextDay } = parseMonthDay(nextSign.start);
  let changeAt = new Date(now.getFullYear(), nextMonth - 1, nextDay);
  if (changeAt.getTime() <= now.getTime()) {
    changeAt = new Date(now.getFullYear() + 1, nextMonth - 1, nextDay);
  }

  const nextDecan = getDecanByIndex(decansBySign, nextSign.id, 1);
  return {
    key: `${currentInfo.sign.id}-${currentIndex}`,
    changeAt,
    nextLabel: nextDecan?.tarotMinorArcana || `${nextSign.name} Decan 1`
  };
}

async function getWeekEventsForQuery(query = {}) {
  const referenceData = await loadReferenceData();
  ensureCalendarIndexes(referenceData);
  const geo = parseGeo(query);
  const anchorDate = parseAnchorDate(query.date);
  const cacheKey = buildGeoCacheKey(geo, getDateKey(anchorDate));
  const cached = readResponseCache(weekEventsResponseCache, cacheKey);
  if (cached) {
    return cached;
  }

  const events = buildWeekEvents(geo, referenceData, anchorDate);
  const payload = {
    anchorDate: anchorDate.toISOString(),
    geo,
    count: events.length,
    events
  };
  writeResponseCache(weekEventsResponseCache, cacheKey, payload, WEEK_EVENTS_CACHE_TTL_MS);
  return payload;
}

async function getNowSnapshot(query = {}) {
  const referenceData = await loadReferenceData();
  ensureCalendarIndexes(referenceData);
  const geo = parseGeo(query);
  const now = parseAnchorDate(query.date);
  const cacheBucket = Math.floor(now.getTime() / NOW_SNAPSHOT_CACHE_TTL_MS);
  const cacheKey = buildGeoCacheKey(geo, String(cacheBucket));
  const cached = readResponseCache(nowSnapshotResponseCache, cacheKey);
  if (cached) {
    // Refresh countdowns against "now" so cached snapshots stay accurate.
    const cloned = {
      ...cached,
      timestamp: now.toISOString()
    };
    if (cloned.currentHour?.end) {
      const endMs = new Date(cloned.currentHour.end).getTime();
      cloned.currentHour = {
        ...cloned.currentHour,
        msRemaining: Math.max(0, endMs - now.getTime())
      };
    }
    if (cloned.moon?.countdown?.changeAt) {
      const changeMs = new Date(cloned.moon.countdown.changeAt).getTime();
      cloned.moon = {
        ...cloned.moon,
        countdown: {
          ...cloned.moon.countdown,
          msRemaining: Math.max(0, changeMs - now.getTime())
        }
      };
    }
    if (cloned.decan?.countdown?.changeAt) {
      const changeMs = new Date(cloned.decan.countdown.changeAt).getTime();
      cloned.decan = {
        ...cloned.decan,
        countdown: {
          ...cloned.decan.countdown,
          msRemaining: Math.max(0, changeMs - now.getTime())
        }
      };
    }
    return cloned;
  }

  const { currentHour, nextHour } = findCurrentPlanetaryHour(now, geo);
  const moonIllum = SunCalc.getMoonIllumination(now);
  const moonPhase = getMoonPhaseName(moonIllum.phase);
  const moonCountdown = findNextMoonPhaseTransition(now);
  const sunInfo = getDecanForDate(now, referenceData.signs, referenceData.decansBySign);
  const decanCountdown = findNextDecanTransition(now, referenceData.signs, referenceData.decansBySign);
  const planetPositions = calculatePlanetPositions(referenceData, now);
  const sunPosition = planetPositions.find((entry) => entry.id === "sol") || null;
  const moonPosition = planetPositions.find((entry) => entry.id === "luna") || null;
  const sunSabianSymbol = sunPosition ? getSabianSymbolForLongitude(sunPosition.longitude, referenceData) : null;
  const moonSabianSymbol = moonPosition ? getSabianSymbolForLongitude(moonPosition.longitude, referenceData) : null;

  const payload = {
    dayKey: getDateKey(now),
    timestamp: now.toISOString(),
    geo,
    currentHour: currentHour ? {
      planetId: currentHour.planetId,
      start: currentHour.start.toISOString(),
      end: currentHour.end.toISOString(),
      isDaylight: currentHour.isDaylight === true,
      planet: referenceData.planets[currentHour.planetId] || null,
      nextHourPlanet: nextHour ? (referenceData.planets[nextHour.planetId] || null) : null,
      msRemaining: Math.max(0, currentHour.end.getTime() - now.getTime())
    } : null,
    moon: {
      phase: moonPhase,
      illuminationFraction: moonIllum.fraction,
      countdown: moonCountdown ? {
        fromPhase: moonCountdown.fromPhase,
        nextPhase: moonCountdown.nextPhase,
        changeAt: moonCountdown.changeAt.toISOString(),
        msRemaining: Math.max(0, moonCountdown.changeAt.getTime() - now.getTime())
      } : null,
      tarot: referenceData.planets.luna?.tarot || null
    },
    decan: sunInfo ? {
      sign: sunInfo.sign,
      decan: sunInfo.decan || null,
      signDegree: Number(((now.getTime() - getSignStartDate(now, sunInfo.sign).getTime()) / DAY_IN_MS).toFixed(1)),
      countdown: decanCountdown ? {
        nextLabel: decanCountdown.nextLabel,
        changeAt: decanCountdown.changeAt.toISOString(),
        msRemaining: Math.max(0, decanCountdown.changeAt.getTime() - now.getTime())
      } : null
    } : null,
    dayTarot: getTarotCardsForDate(now, referenceData),
    stats: {
      planetPositions,
      sunSabianSymbol,
      moonSabianSymbol
    },
    skyRefreshKey: `${currentHour ? `${currentHour.planetId}-${currentHour.start.toISOString()}` : "no-hour"}|${sunInfo?.sign ? `${sunInfo.sign.id}-${sunInfo.decan?.index || 1}` : "no-decan"}|${moonPhase}`
  };

  writeResponseCache(nowSnapshotResponseCache, cacheKey, payload, NOW_SNAPSHOT_CACHE_TTL_MS);
  return payload;
}

function isMMDDInRange(mmdd, start, end) {
  if (start <= end) return mmdd >= start && mmdd <= end;
  return mmdd >= start || mmdd <= end;
}

function getCourtCardForDate(date, courtDateRanges = {}) {
  if (!date || typeof date.getTime !== "function") return null;
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const mmdd = `${mm}-${dd}`;
  for (const [card, range] of Object.entries(courtDateRanges)) {
    if (range && isMMDDInRange(mmdd, range.start, range.end)) {
      return card;
    }
  }
  return null;
}

function getTarotCardsForDate(dateInput, referenceData = {}) {
  const date = parseAnchorDate(dateInput);
  const tarotDb = referenceData.tarotDatabase || {};
  const courtRanges = tarotDb.courtDateRanges || {};
  const court = getCourtCardForDate(date, courtRanges);
  const decanRes = getDecanForDate(date, referenceData.signs, referenceData.decansBySign);
  const decanTarot = decanRes?.decan?.tarotMinorArcana || null;
  const windows = tarotDb.courtDecanWindows || {};
  const windowIds = windows[court] || [];
  const flatDecans = Object.values(referenceData.decansBySign || {}).flatMap((arr) => Array.isArray(arr) ? arr : []);
  const decanTarots = windowIds
    .map((id) => {
      const d = flatDecans.find((dd) => dd && dd.id === id);
      return d ? d.tarotMinorArcana : null;
    })
    .filter(Boolean);
  return {
    court,
    decan: decanTarot,
    decans: decanTarots.length ? decanTarots : (decanTarot ? [decanTarot] : [])
  };
}

module.exports = {
  getWeekEventsForQuery,
  getNowSnapshot,
  getTarotCardsForDate,
  getMoonPhaseName,
  calcPlanetaryHoursForDayAndLocation,
  parseGeo
};