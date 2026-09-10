(function () {
  "use strict";

  function createTarotDatabaseHelpers(config) {
    const majorCards = Array.isArray(config?.majorCards) ? config.majorCards : [];
    const suits = Array.isArray(config?.suits) ? config.suits : [];
    const numberRanks = Array.isArray(config?.numberRanks) ? config.numberRanks : [];
    const courtRanks = Array.isArray(config?.courtRanks) ? config.courtRanks : [];
    const suitInfo = config?.suitInfo && typeof config.suitInfo === "object" ? config.suitInfo : {};
    const rankInfo = config?.rankInfo && typeof config.rankInfo === "object" ? config.rankInfo : {};
    const courtInfo = config?.courtInfo && typeof config.courtInfo === "object" ? config.courtInfo : {};
    const courtDecanWindows = config?.courtDecanWindows && typeof config.courtDecanWindows === "object" ? config.courtDecanWindows : {};
    const courtSignWindows = config?.courtSignWindows && typeof config.courtSignWindows === "object" ? config.courtSignWindows : {};
    const majorAliases = config?.majorAliases && typeof config.majorAliases === "object" ? config.majorAliases : {};
    const minorNumeralAliases = config?.minorNumeralAliases && typeof config.minorNumeralAliases === "object" ? config.minorNumeralAliases : {};
    const monthNameByNumber = config?.monthNameByNumber && typeof config.monthNameByNumber === "object" ? config.monthNameByNumber : {};
    const monthIdByNumber = config?.monthIdByNumber && typeof config.monthIdByNumber === "object" ? config.monthIdByNumber : {};
    const monthShort = Array.isArray(config?.monthShort) ? config.monthShort : [];
    const hebrewLetterAliases = config?.hebrewLetterAliases && typeof config.hebrewLetterAliases === "object" ? config.hebrewLetterAliases : {};

    function getTarotDbConfig(referenceData) {
      const db = referenceData?.tarotDatabase;
      const hasDb = db && typeof db === "object";

      return {
        majorCards: hasDb && Array.isArray(db.majorCards) && db.majorCards.length ? db.majorCards : majorCards,
        suits: hasDb && Array.isArray(db.suits) && db.suits.length ? db.suits : suits,
        numberRanks: hasDb && Array.isArray(db.numberRanks) && db.numberRanks.length ? db.numberRanks : numberRanks,
        courtRanks: hasDb && Array.isArray(db.courtRanks) && db.courtRanks.length ? db.courtRanks : courtRanks,
        suitInfo: hasDb && db.suitInfo && typeof db.suitInfo === "object" ? db.suitInfo : suitInfo,
        rankInfo: hasDb && db.rankInfo && typeof db.rankInfo === "object" ? db.rankInfo : rankInfo,
        courtInfo: hasDb && db.courtInfo && typeof db.courtInfo === "object" ? db.courtInfo : courtInfo,
        courtDecanWindows: hasDb && db.courtDecanWindows && typeof db.courtDecanWindows === "object" ? db.courtDecanWindows : courtDecanWindows,
        courtSignWindows: hasDb && db.courtSignWindows && typeof db.courtSignWindows === "object" ? db.courtSignWindows : courtSignWindows,
        courtDateRanges: hasDb && db.courtDateRanges && typeof db.courtDateRanges === "object" ? db.courtDateRanges : {}
      };
    }

    function normalizeCardName(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^the\s+/, "")
        .replace(/\s+/g, " ");
    }

    function canonicalCardName(value) {
      const normalized = normalizeCardName(value);
      const majorCanonical = majorAliases[normalized] || normalized;
      const withSuitAliases = majorCanonical.replace(/\bof\s+(pentacles?|coins?)\b/i, "of disks");
      const numberMatch = withSuitAliases.match(/^(\d{1,2})\s+of\s+(.+)$/i);

      if (numberMatch) {
        const number = Number(numberMatch[1]);
        const suit = String(numberMatch[2] || "").trim();
        const numberWord = minorNumeralAliases[number];
        if (numberWord && suit) {
          return `${numberWord} of ${suit}`;
        }
      }

      return withSuitAliases;
    }

    function parseMonthDay(value) {
      const [month, day] = String(value || "").split("-").map((part) => Number(part));
      if (!Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
      }
      return { month, day };
    }

    function monthDayToDate(monthDay, year) {
      const parsed = parseMonthDay(monthDay);
      if (!parsed) {
        return null;
      }
      return new Date(year, parsed.month - 1, parsed.day);
    }

    function addDays(date, days) {
      const next = new Date(date);
      next.setDate(next.getDate() + days);
      return next;
    }

    function formatMonthDayLabel(date) {
      if (!(date instanceof Date)) {
        return "--";
      }
      return `${monthShort[date.getMonth()]} ${date.getDate()}`;
    }

    function formatMonthDayToken(date) {
      if (!(date instanceof Date)) {
        return "";
      }
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${month}-${day}`;
    }

    function normalizeMinorTarotCardName(value) {
      const normalized = canonicalCardName(value);
      return normalized
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    }

    function deriveSummaryFromMeaning(meaningText, fallbackSummary) {
      const normalized = String(meaningText || "")
        .replace(/\s+/g, " ")
        .trim();

      if (!normalized) {
        return fallbackSummary;
      }

      const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
      if (sentenceMatch && sentenceMatch[1]) {
        return sentenceMatch[1].trim();
      }

      if (normalized.length <= 220) {
        return normalized;
      }

      return `${normalized.slice(0, 217).trimEnd()}…`;
    }

    function applyMeaningText(cards, referenceData) {
      const majorByTrumpNumber = referenceData?.tarotDatabase?.meanings?.majorByTrumpNumber;
      const byCardName = referenceData?.tarotDatabase?.meanings?.byCardName;

      if ((!majorByTrumpNumber || typeof majorByTrumpNumber !== "object")
        && (!byCardName || typeof byCardName !== "object")) {
        return cards;
      }

      return cards.map((card) => {
        const trumpNumber = Number(card?.number);
        const isMajorTrumpCard = card?.arcana === "Major" && Number.isFinite(trumpNumber);
        const canonicalName = canonicalCardName(card?.name);

        const majorMeaning = isMajorTrumpCard
          ? String(majorByTrumpNumber?.[trumpNumber] || "").trim()
          : "";
        const nameMeaning = String(byCardName?.[canonicalName] || "").trim();
        const selectedMeaning = majorMeaning || nameMeaning;

        if (!selectedMeaning) {
          return card;
        }

        return {
          ...card,
          meaning: selectedMeaning,
          summary: deriveSummaryFromMeaning(selectedMeaning, card.summary),
          meanings: {
            upright: selectedMeaning,
            reversed: card?.meanings?.reversed || ""
          }
        };
      });
    }

    function getSignDateBounds(sign) {
      const start = monthDayToDate(sign?.start, 2025);
      const endBase = monthDayToDate(sign?.end, 2025);
      if (!start || !endBase) {
        return null;
      }

      const wraps = endBase.getTime() < start.getTime();
      const end = wraps ? monthDayToDate(sign?.end, 2026) : endBase;
      if (!end) {
        return null;
      }

      return { start, end };
    }

    function buildTokenDateRange(startToken, endToken) {
      const start = monthDayToDate(startToken, 2025);
      const endBase = monthDayToDate(endToken, 2025);
      if (!start || !endBase) {
        return null;
      }

      const wraps = endBase.getTime() < start.getTime();
      const end = wraps ? monthDayToDate(endToken, 2026) : endBase;
      if (!end) {
        return null;
      }

      return {
        start,
        end,
        startMonth: start.getMonth() + 1,
        endMonth: end.getMonth() + 1,
        startToken: formatMonthDayToken(start),
        endToken: formatMonthDayToken(end),
        label: `${formatMonthDayLabel(start)}–${formatMonthDayLabel(end)}`
      };
    }

    function buildDecanDateRange(sign, decanIndex, decan = null) {
      const explicitRange = buildTokenDateRange(decan?.dateStart, decan?.dateEnd);
      if (explicitRange) {
        return explicitRange;
      }

      const bounds = getSignDateBounds(sign);
      if (!bounds || !Number.isFinite(Number(decanIndex))) {
        return null;
      }

      const index = Number(decanIndex);
      const start = addDays(bounds.start, (index - 1) * 10);
      const nominalEnd = addDays(start, 9);
      const end = nominalEnd.getTime() > bounds.end.getTime() ? bounds.end : nominalEnd;

      return {
        start,
        end,
        startMonth: start.getMonth() + 1,
        endMonth: end.getMonth() + 1,
        startToken: formatMonthDayToken(start),
        endToken: formatMonthDayToken(end),
        label: `${formatMonthDayLabel(start)}–${formatMonthDayLabel(end)}`
      };
    }

    function listMonthNumbersBetween(start, end) {
      if (!(start instanceof Date) || !(end instanceof Date)) {
        return [];
      }

      const result = [];
      const seen = new Set();
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
      const limit = new Date(end.getFullYear(), end.getMonth(), 1);

      while (cursor.getTime() <= limit.getTime()) {
        const monthNo = cursor.getMonth() + 1;
        if (!seen.has(monthNo)) {
          seen.add(monthNo);
          result.push(monthNo);
        }
        cursor.setMonth(cursor.getMonth() + 1);
      }

      return result;
    }

    function getSignName(sign, fallback) {
      return sign?.name?.en || sign?.name || sign?.id || fallback || "Unknown";
    }

    function formatDegreeRangeLabel(startDegree, endDegree) {
      const start = Number(startDegree);
      const end = Number(endDegree);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return "";
      }

      return `${String(Math.trunc(start)).padStart(2, "0")}°–${String(Math.trunc(end)).padStart(2, "0")}°`;
    }

    function buildDecanMetadata(decan, sign) {
      if (!decan || !sign) {
        return null;
      }

      const index = Number(decan.index);
      if (!Number.isFinite(index)) {
        return null;
      }

        const startDegree = (index - 1) * 10;
        const endDegree = startDegree + 9;
        const dateRange = buildDecanDateRange(sign, index, decan);

      return {
        decan,
        sign,
        index,
        signId: sign.id,
        signName: getSignName(sign, decan.signId),
        signSymbol: sign.symbol || "",
        startDegree,
        endDegree,
        dateRange,
        degreeRangeLabel: formatDegreeRangeLabel(startDegree, endDegree),
        normalizedCardName: normalizeMinorTarotCardName(decan.tarotMinorArcana || "")
      };
    }

    function normalizeRelationId(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "unknown";
    }

    function createRelation(type, id, label, data = null) {
      return {
        type,
        id: normalizeRelationId(id),
        label: String(label || "").trim(),
        data
      };
    }

    function relationSignature(value) {
      if (!value || typeof value !== "object") {
        return String(value || "");
      }

      return `${value.type || "text"}|${value.id || ""}|${value.label || ""}`;
    }

    function parseLegacyRelation(text) {
      const raw = String(text || "").trim();
      const match = raw.match(/^([^:]+):\s*(.+)$/);
      if (!match) {
        return createRelation("note", raw, raw, { value: raw });
      }

      const key = normalizeRelationId(match[1]);
      const value = String(match[2] || "").trim();

      if (key === "element") {
        return createRelation("element", value, `Element: ${value}`, { name: value });
      }

      if (key === "planet") {
        return createRelation("planet", value, `Planet: ${value}`, { name: value });
      }

      if (key === "zodiac") {
        return createRelation("zodiac", value, `Zodiac: ${value}`, { name: value });
      }

      if (key === "suit-domain") {
        return createRelation("suitDomain", value, `Suit domain: ${value}`, { value });
      }

      if (key === "numerology") {
        const numeric = Number(value);
        return createRelation("numerology", value, `Numerology: ${value}`, {
          value: Number.isFinite(numeric) ? numeric : value
        });
      }

      if (key === "court-role") {
        return createRelation("courtRole", value, `Court role: ${value}`, { value });
      }

      if (key === "hebrew-letter") {
        const normalized = normalizeHebrewKey(value);
        const canonical = hebrewLetterAliases[normalized] || normalized;
        return createRelation("hebrewLetter", canonical, `Hebrew Letter: ${value}`, {
          requestedName: value
        });
      }

      return createRelation(key || "relation", value, raw, { value });
    }

    function normalizeHebrewKey(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    }

    function buildHebrewLetterLookup(magickDataset) {
      const letters = magickDataset?.grouped?.hebrewLetters;
      const lookup = new Map();

      if (!letters || typeof letters !== "object") {
        return lookup;
      }

      Object.entries(letters).forEach(([letterId, entry]) => {
        const idKey = normalizeHebrewKey(letterId);
        const canonicalKey = hebrewLetterAliases[idKey] || idKey;

        if (canonicalKey && !lookup.has(canonicalKey)) {
          lookup.set(canonicalKey, entry);
        }

        const nameKey = normalizeHebrewKey(entry?.letter?.name);
        const canonicalNameKey = hebrewLetterAliases[nameKey] || nameKey;
        if (canonicalNameKey && !lookup.has(canonicalNameKey)) {
          lookup.set(canonicalNameKey, entry);
        }

        const entryIdKey = normalizeHebrewKey(entry?.id);
        const canonicalEntryIdKey = hebrewLetterAliases[entryIdKey] || entryIdKey;
        if (canonicalEntryIdKey && !lookup.has(canonicalEntryIdKey)) {
          lookup.set(canonicalEntryIdKey, entry);
        }
      });

      return lookup;
    }

    function buildHebrewLetterRelation(hebrewLetterId, hebrewLookup) {
      if (!hebrewLetterId || !hebrewLookup) {
        return null;
      }

      const normalizedId = normalizeHebrewKey(hebrewLetterId);
      const canonicalId = hebrewLetterAliases[normalizedId] || normalizedId;
      const entry = hebrewLookup.get(canonicalId);
      if (!entry) {
        return createRelation("hebrewLetter", canonicalId, `Hebrew Letter: ${hebrewLetterId}`, null);
      }

      const glyph = entry?.letter?.he || "";
      const name = entry?.letter?.name || hebrewLetterId;
      const latin = entry?.letter?.latin || "";
      const index = Number.isFinite(entry?.index) ? entry.index : null;
      const value = Number.isFinite(entry?.value) ? entry.value : null;
      const meaning = entry?.meaning?.en || "";

      const indexText = index !== null ? index : "?";
      const valueText = value !== null ? value : "?";
      const meaningText = meaning ? ` · ${meaning}` : "";

      return createRelation(
        "hebrewLetter",
        entry?.id || canonicalId,
        `Hebrew Letter: ${glyph} ${name} (${latin}) (index ${indexText}, value ${valueText})${meaningText}`.trim(),
        {
          id: entry?.id || canonicalId,
          glyph,
          name,
          latin,
          index,
          value,
          meaning
        }
      );
    }

    function pushMapValue(map, key, value) {
      if (!key || !value) {
        return;
      }

      if (!map.has(key)) {
        map.set(key, []);
      }

      const existing = map.get(key);
      const signature = relationSignature(value);
      const duplicate = existing.some((entry) => relationSignature(entry) === signature);

      if (!duplicate) {
        existing.push(value);
      }
    }

    function collectCalendarMonthRelationsFromDecan(targetKey, relationMap, decanMeta) {
      const dateRange = decanMeta?.dateRange;
      if (!dateRange?.start || !dateRange?.end) {
        return;
      }

      const monthNumbers = listMonthNumbersBetween(dateRange.start, dateRange.end);
      monthNumbers.forEach((monthNo) => {
        const monthId = monthIdByNumber[monthNo];
        const monthName = monthNameByNumber[monthNo] || `Month ${monthNo}`;
        if (!monthId) {
          return;
        }

        pushMapValue(
          relationMap,
          targetKey,
          createRelation(
            "calendarMonth",
            `${monthId}-${decanMeta.signId}-${decanMeta.index}`,
            `Calendar month: ${monthName} (${decanMeta.signName} decan ${decanMeta.index})`,
            {
              monthId,
              name: monthName,
              monthOrder: monthNo,
              signId: decanMeta.signId,
              signName: decanMeta.signName,
              decanIndex: decanMeta.index,
              dateRange: dateRange.label
            }
          )
        );
      });
    }

    function buildMajorDynamicRelations(referenceData) {
      const relationMap = new Map();

      const planets = referenceData?.planets && typeof referenceData.planets === "object"
        ? Object.values(referenceData.planets)
        : [];

      planets.forEach((planet) => {
        const cardName = planet?.tarot?.majorArcana;
        if (!cardName) {
          return;
        }

        const relation = createRelation(
          "planetCorrespondence",
          planet?.id || planet?.name || cardName,
          `Planet correspondence: ${planet.symbol || ""} ${planet.name || ""}`.trim(),
          {
            planetId: planet?.id || null,
            symbol: planet?.symbol || "",
            name: planet?.name || ""
          }
        );
        pushMapValue(relationMap, canonicalCardName(cardName), relation);
      });

      const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
      signs.forEach((sign) => {
        const cardName = sign?.tarot?.majorArcana;
        if (!cardName) {
          return;
        }

        const relation = createRelation(
          "zodiacCorrespondence",
          sign?.id || sign?.name || cardName,
          `Zodiac correspondence: ${sign.symbol || ""} ${sign.name || ""}`.trim(),
          {
            signId: sign?.id || null,
            symbol: sign?.symbol || "",
            name: sign?.name || ""
          }
        );
        pushMapValue(relationMap, canonicalCardName(cardName), relation);
      });

      return relationMap;
    }

    function buildMinorDecanRelations(referenceData) {
      const relationMap = new Map();
      const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
      const signById = Object.fromEntries(signs.map((sign) => [sign.id, sign]));
      const planets = referenceData?.planets || {};

      if (!referenceData?.decansBySign || typeof referenceData.decansBySign !== "object") {
        return relationMap;
      }

      Object.entries(referenceData.decansBySign).forEach(([signId, decans]) => {
        const sign = signById[signId];
        if (!Array.isArray(decans) || !sign) {
          return;
        }

        decans.forEach((decan) => {
          const cardName = decan?.tarotMinorArcana;
          if (!cardName) {
            return;
          }

          const decanMeta = buildDecanMetadata(decan, sign);
          if (!decanMeta) {
            return;
          }

          const { startDegree, endDegree, dateRange, degreeRangeLabel, signId: metaSignId, signName, signSymbol, index } = decanMeta;
          const ruler = planets[decan.rulerPlanetId] || null;
          const cardKey = canonicalCardName(cardName);

          pushMapValue(
            relationMap,
            cardKey,
            createRelation(
              "zodiac",
              metaSignId,
              `Zodiac: ${sign.symbol || ""} ${signName}`.trim(),
              {
                signId: metaSignId,
                signName,
                symbol: sign.symbol || ""
              }
            )
          );

          pushMapValue(
            relationMap,
            cardKey,
            createRelation(
              "decan",
              `${metaSignId}-${index}`,
              `Decan ${decan.index}: ${sign.symbol || ""} ${signName} (${degreeRangeLabel || `${startDegree}°–${endDegree}°`})${dateRange ? ` · ${dateRange.label}` : ""}`.trim(),
              {
                signId: metaSignId,
                signName,
                signSymbol,
                index,
                startDegree,
                endDegree,
                degreeRangeLabel: degreeRangeLabel || null,
                dateStart: dateRange?.startToken || null,
                dateEnd: dateRange?.endToken || null,
                dateRange: dateRange?.label || null
              }
            )
          );

          collectCalendarMonthRelationsFromDecan(cardKey, relationMap, decanMeta);

          if (ruler) {
            pushMapValue(
              relationMap,
              cardKey,
              createRelation(
                "decanRuler",
                `${metaSignId}-${index}-${decan.rulerPlanetId}`,
                `Decan ruler: ${ruler.symbol || ""} ${ruler.name || decan.rulerPlanetId}`.trim(),
                {
                  signId: metaSignId,
                  decanIndex: index,
                  planetId: decan.rulerPlanetId,
                  symbol: ruler.symbol || "",
                  name: ruler.name || decan.rulerPlanetId
                }
              )
            );
          }
        });
      });

      return relationMap;
    }

    return {
      getTarotDbConfig,
      canonicalCardName,
      formatMonthDayLabel,
      applyMeaningText,
      buildDecanMetadata,
      listMonthNumbersBetween,
      buildHebrewLetterLookup,
      createRelation,
      parseLegacyRelation,
      buildHebrewLetterRelation,
      buildMajorDynamicRelations,
      buildMinorDecanRelations
    };
  }

  window.TarotDatabaseBuilders = { createTarotDatabaseHelpers };
})();