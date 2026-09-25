const Astronomy = require("astronomy-engine");
const SunCalc = require("suncalc");

const { loadLinkedReference } = require("./document-slices");
const { createHttpError } = require("../lib/http-errors");
const { parseGeo, getMoonPhaseName } = require("./calendar-service");

const DEG = Math.PI / 180;
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

const ASPECTS = [
  { id: "conjunction", name: "Conjunction", glyph: "☌", angle: 0, orb: 8 },
  { id: "sextile", name: "Sextile", glyph: "⚹", angle: 60, orb: 6 },
  { id: "square", name: "Square", glyph: "□", angle: 90, orb: 7 },
  { id: "trine", name: "Trine", glyph: "△", angle: 120, orb: 8 },
  { id: "opposition", name: "Opposition", glyph: "☍", angle: 180, orb: 8 }
];

function normalizeLongitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return ((numeric % 360) + 360) % 360;
}

function parseTruthy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatIsoDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatIsoTime(hour, minute, second) {
  return second
    ? `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
    : `${pad2(hour)}:${pad2(minute)}`;
}

const MIN_YEAR = 1000;
const MAX_YEAR = 2500;
const MIN_OFFSET_MINUTES = -14 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;
const POLAR_LATITUDE_LIMIT = 89.5;
const ISO_INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function assertValidInstant(instant, code, message) {
  if (!instant || Number.isNaN(instant.getTime())) {
    throw createHttpError(400, code, message);
  }
  const year = instant.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw createHttpError(400, "invalid_datetime", `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }
}

function parseDateParts(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function parseUtcOffsetMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  const offsetMinutes = Number(raw);
  if (!Number.isFinite(offsetMinutes) || offsetMinutes < MIN_OFFSET_MINUTES || offsetMinutes > MAX_OFFSET_MINUTES) {
    throw createHttpError(400, "invalid_offset", "utcOffsetMinutes must be between -840 and 840.");
  }
  return offsetMinutes;
}

function parseTimeParts(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return { hour, minute, second };
}

function parseBirthMoment(query, geo) {
  const datetimeRaw = String(query?.datetime || query?.timestamp || "").trim();
  if (datetimeRaw) {
    if (!ISO_INSTANT_RE.test(datetimeRaw)) {
      throw createHttpError(400, "invalid_datetime", "datetime must be an ISO instant with a Z or ±HH:MM offset.");
    }
    const instant = new Date(datetimeRaw);
    assertValidInstant(instant, "invalid_datetime", "Invalid datetime query param.");
    return {
      instant,
      date: instant.toISOString().slice(0, 10),
      time: instant.toISOString().slice(11, 16),
      timeUnknown: parseTruthy(query?.timeUnknown),
      interpretation: "datetime"
    };
  }

  const dateParts = parseDateParts(query?.date);
  if (!dateParts) {
    throw createHttpError(400, "invalid_date", "Provide a valid date (YYYY-MM-DD) or datetime (ISO with offset).");
  }

  const timeRaw = String(query?.time || "").trim();
  const timeParts = timeRaw ? parseTimeParts(timeRaw) : { hour: 12, minute: 0, second: 0 };
  if (!timeParts) {
    throw createHttpError(400, "invalid_time", "Time must be HH:MM or HH:MM:SS.");
  }

  const timeUnknown = !timeRaw || parseTruthy(query?.timeUnknown);
  const providedOffset = timeUnknown ? null : parseUtcOffsetMinutes(query?.utcOffsetMinutes ?? query?.offsetMinutes);
  const offsetMinutes = providedOffset == null ? Number(geo?.longitude) * 4 : providedOffset;
  const interpretation = providedOffset == null ? "lmt" : "offset";
  const utcMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second
  ) - offsetMinutes * 60 * 1000;
  const instant = new Date(utcMs);
  assertValidInstant(instant, "invalid_datetime", "Birth date/time is out of range.");

  return {
    instant,
    date: formatIsoDate(dateParts.year, dateParts.month, dateParts.day),
    time: timeUnknown ? null : formatIsoTime(timeParts.hour, timeParts.minute, timeParts.second),
    timeUnknown,
    interpretation
  };
}

function ofDateLongitude(bodyName, date) {
  const time = Astronomy.MakeTime(date);
  const eqj = Astronomy.GeoVector(bodyName, time, true);
  const rotated = Astronomy.RotateVector(Astronomy.Rotation_EQJ_ECT(time), eqj);
  return normalizeLongitude(Math.atan2(rotated.y, rotated.x) / DEG);
}

function isRetrograde(bodyName, date) {
  if (bodyName === "Sun" || bodyName === "Moon") {
    return false;
  }
  const earlier = ofDateLongitude(bodyName, new Date(date.getTime() - 12 * 60 * 60 * 1000));
  const later = ofDateLongitude(bodyName, new Date(date.getTime() + 12 * 60 * 60 * 1000));
  if (earlier == null || later == null) {
    return false;
  }
  let delta = later - earlier;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta < 0;
}

function computeAngles(date, geo) {
  const time = Astronomy.MakeTime(date);
  const ramc = normalizeLongitude((Astronomy.SiderealTime(time) + Number(geo.longitude) / 15) * 15);
  const eps = Astronomy.e_tilt(time).tobl * DEG;
  const phi = Number(geo.latitude) * DEG;
  const theta = ramc * DEG;
  const asc = normalizeLongitude(Math.atan2(
    Math.cos(theta),
    -(Math.sin(theta) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))
  ) / DEG);
  const mc = normalizeLongitude(Math.atan2(
    Math.sin(theta),
    Math.cos(theta) * Math.cos(eps)
  ) / DEG);
  return { ramc, ascendant: asc, midheaven: mc };
}

function getSortedSigns(signs) {
  return [...(Array.isArray(signs) ? signs : [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function slimSign(sign) {
  if (!sign) {
    return null;
  }
  return {
    id: sign.id,
    name: sign.name,
    symbol: sign.symbol || "",
    element: sign.element || "",
    modality: sign.modality || "",
    rulingPlanetId: sign.rulingPlanetId || "",
    tarot: sign.tarot || null
  };
}

function getSignForLongitude(longitude, sortedSigns) {
  const normalized = normalizeLongitude(longitude);
  if (normalized === null || !sortedSigns.length) {
    return null;
  }
  const signIndex = Math.min(sortedSigns.length - 1, Math.floor(normalized / 30));
  const sign = sortedSigns[signIndex] || null;
  if (!sign) {
    return null;
  }
  return {
    sign: slimSign(sign),
    degreeInSign: normalized - signIndex * 30,
    absoluteLongitude: normalized
  };
}

function getDecanForDegree(signId, degreeInSign, decansBySign) {
  const index = Math.max(1, Math.min(3, Math.floor(Number(degreeInSign) / 10) + 1));
  const decan = (decansBySign?.[signId] || []).find((entry) => Number(entry.index) === index) || null;
  return {
    index,
    id: decan?.id || `${signId}-${index}`,
    rulerPlanetId: decan?.rulerPlanetId || "",
    tarotMinorArcana: decan?.tarotMinorArcana || ""
  };
}

function getSabian(longitude, sabianSymbols) {
  const normalized = normalizeLongitude(longitude);
  if (normalized === null || !Array.isArray(sabianSymbols)) {
    return null;
  }
  const absoluteDegree = Math.floor(normalized) + 1;
  const entry = sabianSymbols.find((item) => Number(item?.absoluteDegree) === absoluteDegree) || null;
  if (!entry) {
    return null;
  }
  return {
    absoluteDegree,
    degreeInSign: entry.degreeInSign || null,
    phrase: entry.phrase || ""
  };
}

function houseNumber(longitude, ascendant) {
  const normalized = normalizeLongitude(longitude - ascendant);
  if (normalized === null) {
    return null;
  }
  return Math.floor(normalized / 30) + 1;
}

function formatDegree(degreeInSign) {
  const total = Number(degreeInSign);
  if (!Number.isFinite(total)) {
    return "";
  }
  const deg = Math.floor(total);
  const minutes = Math.round((total - deg) * 60);
  return `${deg}°${pad2(minutes)}'`;
}

function buildPlacement(id, name, symbol, longitude, sortedSigns, decansBySign, sabianSymbols, ascendant) {
  const signInfo = getSignForLongitude(longitude, sortedSigns);
  if (!signInfo?.sign) {
    return null;
  }
  const decan = getDecanForDegree(signInfo.sign.id, signInfo.degreeInSign, decansBySign);
  return {
    id,
    name,
    symbol,
    longitude: signInfo.absoluteLongitude,
    degreeInSign: Number(signInfo.degreeInSign.toFixed(4)),
    degreeLabel: formatDegree(signInfo.degreeInSign),
    sign: signInfo.sign,
    decan,
    sabian: getSabian(signInfo.absoluteLongitude, sabianSymbols),
    house: Number.isFinite(ascendant) ? houseNumber(signInfo.absoluteLongitude, ascendant) : null,
    label: `${symbol} ${name} ${signInfo.sign.symbol} ${signInfo.sign.name} ${formatDegree(signInfo.degreeInSign)}`
  };
}

function circularDelta(a, b) {
  let delta = Math.abs(normalizeLongitude(a) - normalizeLongitude(b));
  if (delta > 180) {
    delta = 360 - delta;
  }
  return delta;
}

function computeAspects(points) {
  const aspects = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const left = points[i];
      const right = points[j];
      const separation = circularDelta(left.longitude, right.longitude);
      let best = null;
      ASPECTS.forEach((aspect) => {
        const orb = Math.abs(separation - aspect.angle);
        if (orb <= aspect.orb && (!best || orb < best.orb)) {
          best = { ...aspect, orb: Number(orb.toFixed(2)) };
        }
      });
      if (best) {
        aspects.push({
          id: `${left.id}-${best.id}-${right.id}`,
          type: best.id,
          name: best.name,
          glyph: best.glyph,
          angle: best.angle,
          orb: best.orb,
          from: { id: left.id, name: left.name, symbol: left.symbol },
          to: { id: right.id, name: right.name, symbol: right.symbol }
        });
      }
    }
  }
  aspects.sort((a, b) => a.orb - b.orb);
  return aspects;
}

function tally(planets, field) {
  const counts = {};
  planets.forEach((planet) => {
    const key = String(planet?.sign?.[field] || "").trim();
    if (!key) {
      return;
    }
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

async function getNatalChart(query = {}) {
  const referenceData = await loadLinkedReference();
  const geo = parseGeo(query);
  const birth = parseBirthMoment(query, geo);
  const sortedSigns = getSortedSigns(referenceData.signs);
  const sabianSymbols = Array.isArray(referenceData.sabianSymbols) ? referenceData.sabianSymbols : [];
  const polar = Math.abs(Number(geo.latitude)) >= POLAR_LATITUDE_LIMIT;
  const computedAngles = birth.timeUnknown || polar ? null : computeAngles(birth.instant, geo);
  const hasAngles = Number.isFinite(computedAngles?.ascendant) && Number.isFinite(computedAngles?.midheaven);
  const angles = hasAngles ? computedAngles : null;

  const planets = [];
  PLANETARY_BODIES.forEach((body) => {
    try {
      const longitude = ofDateLongitude(body.astronomyBody, birth.instant);
      const planetInfo = referenceData.planets?.[body.id] || null;
      const placement = buildPlacement(
        body.id,
        planetInfo?.name || body.fallbackName,
        planetInfo?.symbol || body.fallbackSymbol,
        longitude,
        sortedSigns,
        referenceData.decansBySign,
        sabianSymbols,
        angles?.ascendant
      );
      if (!placement) {
        return;
      }
      placement.retrograde = isRetrograde(body.astronomyBody, birth.instant);
      planets.push(placement);
    } catch {
    }
  });

  const sun = planets.find((entry) => entry.id === "sol") || null;
  const moon = planets.find((entry) => entry.id === "luna") || null;
  const ascendant = hasAngles
    ? buildPlacement("asc", "Ascendant", "ASC", angles.ascendant, sortedSigns, referenceData.decansBySign, sabianSymbols, angles.ascendant)
    : null;
  const midheaven = hasAngles
    ? buildPlacement("mc", "Midheaven", "MC", angles.midheaven, sortedSigns, referenceData.decansBySign, sabianSymbols, angles.ascendant)
    : null;
  const descendant = hasAngles
    ? buildPlacement("dsc", "Descendant", "DSC", normalizeLongitude(angles.ascendant + 180), sortedSigns, referenceData.decansBySign, sabianSymbols, angles.ascendant)
    : null;
  const ic = hasAngles
    ? buildPlacement("ic", "Imum Coeli", "IC", normalizeLongitude(angles.midheaven + 180), sortedSigns, referenceData.decansBySign, sabianSymbols, angles.ascendant)
    : null;

  const houses = [];
  if (hasAngles) {
    for (let number = 1; number <= 12; number += 1) {
      const longitude = normalizeLongitude(angles.ascendant + (number - 1) * 30);
      const signInfo = getSignForLongitude(longitude, sortedSigns);
      houses.push({
        number,
        longitude,
        degreeInSign: signInfo?.degreeInSign ?? null,
        degreeLabel: signInfo ? formatDegree(signInfo.degreeInSign) : "",
        sign: signInfo?.sign || null
      });
    }
  }

  const aspectPoints = planets.map((planet) => ({
    id: planet.id,
    name: planet.name,
    symbol: planet.symbol,
    longitude: planet.longitude
  }));
  if (ascendant) {
    aspectPoints.push({ id: "asc", name: "Ascendant", symbol: "ASC", longitude: ascendant.longitude });
  }
  if (midheaven) {
    aspectPoints.push({ id: "mc", name: "Midheaven", symbol: "MC", longitude: midheaven.longitude });
  }

  const moonIllum = SunCalc.getMoonIllumination(birth.instant);
  const notes = [];
  if (birth.timeUnknown) {
    notes.push(
      birth.interpretation === "datetime"
        ? "Birth time unknown — rising sign and houses omitted. Planets use the provided datetime."
        : "Birth time unknown — rising sign and houses omitted. Planets use 12:00 local mean time."
    );
  } else if (birth.interpretation === "lmt") {
    notes.push("Time interpreted as local mean time at the given longitude.");
  } else if (birth.interpretation === "offset") {
    notes.push("Time interpreted with the provided UTC offset.");
  }
  if (polar || (angles && !hasAngles)) {
    notes.push("Rising and houses omitted near the poles.");
  }

  return {
    houseSystem: "equal",
    birth: {
      datetime: birth.instant.toISOString(),
      date: birth.date,
      time: birth.time,
      timeUnknown: birth.timeUnknown,
      interpretation: birth.interpretation,
      geo
    },
    points: {
      sun,
      moon,
      ascendant,
      midheaven,
      descendant,
      ic
    },
    planets,
    houses,
    aspects: computeAspects(aspectPoints),
    elements: tally(planets, "element"),
    modalities: tally(planets, "modality"),
    moonPhase: {
      name: getMoonPhaseName(moonIllum.phase),
      illuminationFraction: moonIllum.fraction
    },
    notes
  };
}

module.exports = {
  getNatalChart
};
