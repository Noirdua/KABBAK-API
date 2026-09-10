/* ui-tarot-relations.js — Tarot relation builders */
(function () {
  "use strict";

  const TAROT_TRUMP_NUMBER_BY_NAME = {
    "the fool": 0,
    fool: 0,
    "the magus": 1,
    magus: 1,
    magician: 1,
    "the high priestess": 2,
    "high priestess": 2,
    "the empress": 3,
    empress: 3,
    "the emperor": 4,
    emperor: 4,
    "the hierophant": 5,
    hierophant: 5,
    "the lovers": 6,
    lovers: 6,
    "the chariot": 7,
    chariot: 7,
    strength: 8,
    lust: 8,
    "the hermit": 9,
    hermit: 9,
    fortune: 10,
    "wheel of fortune": 10,
    justice: 11,
    "the hanged man": 12,
    "hanged man": 12,
    death: 13,
    temperance: 14,
    art: 14,
    "the devil": 15,
    devil: 15,
    "the tower": 16,
    tower: 16,
    "the star": 17,
    star: 17,
    "the moon": 18,
    moon: 18,
    "the sun": 19,
    sun: 19,
    aeon: 20,
    judgement: 20,
    judgment: 20,
    universe: 21,
    world: 21,
    "the world": 21
  };

  const HEBREW_LETTER_ALIASES = {
    aleph: "alef",
    alef: "alef",
    heh: "he",
    he: "he",
    beth: "bet",
    bet: "bet",
    cheth: "het",
    chet: "het",
    kaph: "kaf",
    kaf: "kaf",
    peh: "pe",
    tzaddi: "tsadi",
    tzadi: "tsadi",
    tsadi: "tsadi",
    qoph: "qof",
    qof: "qof",
    taw: "tav",
    tau: "tav"
  };

  const CUBE_MOTHER_CONNECTOR_BY_LETTER = {
    alef: { connectorId: "above-below", connectorName: "Above ↔ Below" },
    mem: { connectorId: "east-west", connectorName: "East ↔ West" },
    shin: { connectorId: "south-north", connectorName: "South ↔ North" }
  };

  const MINOR_RANK_NUMBER_BY_NAME = {
    ace: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  function normalizeRelationId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function normalizeTarotName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^key\s+\d+\s*:\s*/g, "")
      .replace(/\b(pentacles?|coins?)\b/g, "disks")
      .replace(/\s+/g, " ");
  }

  function normalizeHebrewLetterId(value) {
    const key = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    return HEBREW_LETTER_ALIASES[key] || key;
  }

  function resolveTarotTrumpNumber(cardName) {
    const rawKey = String(cardName || "")
      .trim()
      .toLowerCase();
    const keyMatch = rawKey.match(/\bkey\s*(\d{1,2})\b/);
    if (keyMatch) {
      return Number(keyMatch[1]);
    }

    const key = normalizeTarotName(cardName);
    if (!key) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(TAROT_TRUMP_NUMBER_BY_NAME, key)) {
      return TAROT_TRUMP_NUMBER_BY_NAME[key];
    }
    const withoutLeadingThe = key.replace(/^the\s+/, "");
    if (Object.prototype.hasOwnProperty.call(TAROT_TRUMP_NUMBER_BY_NAME, withoutLeadingThe)) {
      return TAROT_TRUMP_NUMBER_BY_NAME[withoutLeadingThe];
    }
    return null;
  }

  function cardMatchesTarotAssociation(card, tarotCardName) {
    const associationName = normalizeTarotName(tarotCardName);
    if (!associationName || !card) {
      return false;
    }

    const cardName = normalizeTarotName(card.name);
    const cardBare = cardName.replace(/^the\s+/, "");
    const assocBare = associationName.replace(/^the\s+/, "");

    if (
      associationName === cardName ||
      associationName === cardBare ||
      assocBare === cardName ||
      assocBare === cardBare
    ) {
      return true;
    }

    if (card.arcana === "Major" && Number.isFinite(Number(card.number))) {
      const trumpNumber = resolveTarotTrumpNumber(associationName);
      if (trumpNumber != null) {
        return trumpNumber === Number(card.number);
      }
    }

    return false;
  }

  function buildCourtCardByDecanId(cards) {
    const map = new Map();

    (cards || []).forEach((card) => {
      if (!card || card.arcana !== "Minor") {
        return;
      }

      const rankKey = String(card.rank || "").trim().toLowerCase();
      if (rankKey !== "knight" && rankKey !== "queen" && rankKey !== "prince") {
        return;
      }

      const windowRelation = (Array.isArray(card.relations) ? card.relations : [])
        .find((relation) => relation && typeof relation === "object" && relation.type === "courtDateWindow");

      const decanIds = Array.isArray(windowRelation?.data?.decanIds)
        ? windowRelation.data.decanIds
        : [];

      decanIds.forEach((decanId) => {
        const decanKey = normalizeRelationId(decanId);
        if (!decanKey || map.has(decanKey)) {
          return;
        }

        map.set(decanKey, {
          cardName: card.name,
          rank: card.rank,
          suit: card.suit,
          dateRange: String(windowRelation?.data?.dateRange || "").trim()
        });
      });
    });

    return map;
  }

  function buildSmallCardCourtLinkRelations(card, relations, courtCardByDecanId) {
    if (!card || card.arcana !== "Minor") {
      return [];
    }

    const rankKey = String(card.rank || "").trim().toLowerCase();
    const rankNumber = MINOR_RANK_NUMBER_BY_NAME[rankKey];
    if (!Number.isFinite(rankNumber) || rankNumber < 2 || rankNumber > 10) {
      return [];
    }

    const decans = (relations || []).filter((relation) => relation?.type === "decan");
    if (!decans.length) {
      return [];
    }

    const results = [];
    const seenCourtCardNames = new Set();

    decans.forEach((decan) => {
      const signId = String(decan?.data?.signId || "").trim().toLowerCase();
      const decanIndex = Number(decan?.data?.index);
      if (!signId || !Number.isFinite(decanIndex)) {
        return;
      }

      const decanId = normalizeRelationId(`${signId}-${decanIndex}`);
      const linkedCourt = courtCardByDecanId?.get(decanId);
      if (!linkedCourt?.cardName || seenCourtCardNames.has(linkedCourt.cardName)) {
        return;
      }

      seenCourtCardNames.add(linkedCourt.cardName);

      results.push({
        type: "tarotCard",
        id: `${decanId}-${normalizeRelationId(linkedCourt.cardName)}`,
        label: `Shared court date window: ${linkedCourt.cardName}${linkedCourt.dateRange ? ` · ${linkedCourt.dateRange}` : ""}`,
        data: {
          cardName: linkedCourt.cardName,
          dateRange: linkedCourt.dateRange || "",
          decanId
        },
        __key: `tarotCard|${decanId}|${normalizeRelationId(linkedCourt.cardName)}`
      });
    });

    return results;
  }

  function parseMonthDayToken(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
      return null;
    }

    const month = Number(match[1]);
    const day = Number(match[2]);
    if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    return { month, day };
  }

  function toReferenceDate(token, year) {
    if (!token) {
      return null;
    }
    return new Date(year, token.month - 1, token.day, 12, 0, 0, 0);
  }

  function splitMonthDayRangeByMonth(startToken, endToken) {
    const startDate = toReferenceDate(startToken, 2025);
    const endBase = toReferenceDate(endToken, 2025);
    if (!startDate || !endBase) {
      return [];
    }

    const wrapsYear = endBase.getTime() < startDate.getTime();
    const endDate = wrapsYear ? toReferenceDate(endToken, 2026) : endBase;
    if (!endDate) {
      return [];
    }

    const segments = [];
    let cursor = new Date(startDate);

    while (cursor.getTime() <= endDate.getTime()) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 12, 0, 0, 0);
      const segmentEnd = monthEnd.getTime() < endDate.getTime() ? monthEnd : endDate;

      segments.push({
        monthNo: cursor.getMonth() + 1,
        startDay: cursor.getDate(),
        endDay: segmentEnd.getDate()
      });

      cursor = new Date(segmentEnd.getFullYear(), segmentEnd.getMonth(), segmentEnd.getDate() + 1, 12, 0, 0, 0);
    }

    return segments;
  }

  function formatMonthDayRangeLabel(monthName, startDay, endDay) {
    const start = Number(startDay);
    const end = Number(endDay);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return monthName;
    }
    if (start === end) {
      return `${monthName} ${start}`;
    }
    return `${monthName} ${start}-${end}`;
  }

  function buildMonthReferencesByCard(referenceData, cards) {
    const map = new Map();
    const months = Array.isArray(referenceData?.calendarMonths) ? referenceData.calendarMonths : [];
    const holidays = Array.isArray(referenceData?.celestialHolidays) ? referenceData.celestialHolidays : [];
    const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
    const monthById = new Map(months.map((month) => [month.id, month]));

    function parseMonthFromDateToken(value) {
      const token = parseMonthDayToken(value);
      return token ? token.month : null;
    }

    function findMonthByNumber(monthNo) {
      if (!Number.isInteger(monthNo) || monthNo < 1 || monthNo > 12) {
        return null;
      }

      const byOrder = months.find((month) => Number(month?.order) === monthNo);
      if (byOrder) {
        return byOrder;
      }

      return months.find((month) => parseMonthFromDateToken(month?.start) === monthNo) || null;
    }

    function pushRef(card, month, options = {}) {
      if (!card?.id || !month?.id) {
        return;
      }

      if (!map.has(card.id)) {
        map.set(card.id, []);
      }

      const rows = map.get(card.id);
      const monthOrder = Number.isFinite(Number(month.order)) ? Number(month.order) : 999;
      const startToken = parseMonthDayToken(options.startToken || month.start);
      const endToken = parseMonthDayToken(options.endToken || month.end);
      const dateRange = String(options.dateRange || "").trim() || (
        startToken && endToken
          ? formatMonthDayRangeLabel(month.name || month.id, startToken.day, endToken.day)
          : ""
      );

      const uniqueKey = [
        month.id,
        dateRange.toLowerCase(),
        String(options.context || "").trim().toLowerCase(),
        String(options.source || "").trim().toLowerCase()
      ].join("|");

      if (rows.some((entry) => entry.uniqueKey === uniqueKey)) {
        return;
      }

      rows.push({
        id: month.id,
        name: month.name || month.id,
        order: monthOrder,
        startToken: startToken ? `${String(startToken.month).padStart(2, "0")}-${String(startToken.day).padStart(2, "0")}` : null,
        endToken: endToken ? `${String(endToken.month).padStart(2, "0")}-${String(endToken.day).padStart(2, "0")}` : null,
        dateRange,
        context: String(options.context || "").trim(),
        source: String(options.source || "").trim(),
        uniqueKey
      });
    }

    function captureRefs(associations, month) {
      const tarotCardName = associations?.tarotCard;
      if (!tarotCardName) {
        return;
      }

      cards.forEach((card) => {
        if (cardMatchesTarotAssociation(card, tarotCardName)) {
          pushRef(card, month);
        }
      });
    }

    months.forEach((month) => {
      captureRefs(month?.associations, month);

      const events = Array.isArray(month?.events) ? month.events : [];
      events.forEach((event) => {
        const tarotCardName = event?.associations?.tarotCard;
        if (!tarotCardName) {
          return;
        }
        cards.forEach((card) => {
          if (!cardMatchesTarotAssociation(card, tarotCardName)) {
            return;
          }
          pushRef(card, month, {
            source: "month-event",
            context: String(event?.name || "").trim()
          });
        });
      });
    });

    holidays.forEach((holiday) => {
      const month = monthById.get(holiday?.monthId);
      if (!month) {
        return;
      }
      const tarotCardName = holiday?.associations?.tarotCard;
      if (!tarotCardName) {
        return;
      }
      cards.forEach((card) => {
        if (!cardMatchesTarotAssociation(card, tarotCardName)) {
          return;
        }
        pushRef(card, month, {
          source: "holiday",
          context: String(holiday?.name || "").trim()
        });
      });
    });

    signs.forEach((sign) => {
      const signTrumpNumber = Number(sign?.tarot?.number);
      const signTarotName = sign?.tarot?.majorArcana || sign?.tarot?.card || sign?.tarotCard;
      if (!Number.isFinite(signTrumpNumber) && !signTarotName) {
        return;
      }

      const signName = String(sign?.name || sign?.id || "").trim();
      const startToken = parseMonthDayToken(sign?.start);
      const endToken = parseMonthDayToken(sign?.end);
      const monthSegments = splitMonthDayRangeByMonth(startToken, endToken);
      const fallbackStartMonthNo = parseMonthFromDateToken(sign?.start);
      const fallbackEndMonthNo = parseMonthFromDateToken(sign?.end);
      const fallbackStartMonth = findMonthByNumber(fallbackStartMonthNo);
      const fallbackEndMonth = findMonthByNumber(fallbackEndMonthNo);

      cards.forEach((card) => {
        const cardTrumpNumber = Number(card?.number);
        const matchesByTrump = card?.arcana === "Major"
          && Number.isFinite(cardTrumpNumber)
          && Number.isFinite(signTrumpNumber)
          && cardTrumpNumber === signTrumpNumber;
        const matchesByName = signTarotName ? cardMatchesTarotAssociation(card, signTarotName) : false;

        if (!matchesByTrump && !matchesByName) {
          return;
        }

        if (monthSegments.length) {
          monthSegments.forEach((segment) => {
            const month = findMonthByNumber(segment.monthNo);
            if (!month) {
              return;
            }

            pushRef(card, month, {
              source: "zodiac-window",
              context: signName ? `${signName} window` : "",
              startToken: `${String(segment.monthNo).padStart(2, "0")}-${String(segment.startDay).padStart(2, "0")}`,
              endToken: `${String(segment.monthNo).padStart(2, "0")}-${String(segment.endDay).padStart(2, "0")}`,
              dateRange: formatMonthDayRangeLabel(month.name || month.id, segment.startDay, segment.endDay)
            });
          });
          return;
        }

        if (fallbackStartMonth) {
          pushRef(card, fallbackStartMonth, {
            source: "zodiac-window",
            context: signName ? `${signName} window` : ""
          });
        }
        if (fallbackEndMonth && (!fallbackStartMonth || fallbackEndMonth.id !== fallbackStartMonth.id)) {
          pushRef(card, fallbackEndMonth, {
            source: "zodiac-window",
            context: signName ? `${signName} window` : ""
          });
        }
      });
    });

    map.forEach((rows, key) => {
      const monthIdsWithZodiacWindows = new Set(
        rows
          .filter((entry) => entry?.source === "zodiac-window" && entry?.id)
          .map((entry) => entry.id)
      );

      const filteredRows = rows.filter((entry) => {
        if (!entry?.id || entry?.source === "zodiac-window") {
          return true;
        }

        if (!monthIdsWithZodiacWindows.has(entry.id)) {
          return true;
        }

        const month = monthById.get(entry.id);
        if (!month) {
          return true;
        }

        const isFullMonth = String(entry.startToken || "") === String(month.start || "")
          && String(entry.endToken || "") === String(month.end || "");

        return !isFullMonth;
      });

      filteredRows.sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }

        const startLeft = parseMonthDayToken(left.startToken);
        const startRight = parseMonthDayToken(right.startToken);
        const dayLeft = startLeft ? startLeft.day : 999;
        const dayRight = startRight ? startRight.day : 999;
        if (dayLeft !== dayRight) {
          return dayLeft - dayRight;
        }

        return String(left.dateRange || left.name || "").localeCompare(String(right.dateRange || right.name || ""));
      });
      map.set(key, filteredRows);
    });

    return map;
  }

  function buildCubeFaceRelationsForCard(card, magickDataset) {
    const cube = magickDataset?.grouped?.kabbalah?.cube;
    const walls = Array.isArray(cube?.walls) ? cube.walls : [];
    if (!card || !walls.length) {
      return [];
    }

    return walls
      .map((wall, index) => {
        const wallTarot = wall?.associations?.tarotCard || wall?.tarotCard;
        if (!wallTarot || !cardMatchesTarotAssociation(card, wallTarot)) {
          return null;
        }

        const wallId = String(wall?.id || "").trim();
        const wallName = String(wall?.name || wallId || "").trim();
        if (!wallId) {
          return null;
        }

        return {
          type: "cubeFace",
          id: wallId,
          label: `Cube: ${wallName} Wall - Face`,
          data: {
            wallId,
            wallName,
            edgeId: ""
          },
          __key: `cubeFace|${wallId}|${index}`
        };
      })
      .filter(Boolean);
  }

  function cardMatchesPathTarot(card, path) {
    if (!card || !path) {
      return false;
    }

    const trumpNumber = Number(path?.tarot?.trumpNumber);
    if (card?.arcana === "Major" && Number.isFinite(Number(card?.number)) && Number.isFinite(trumpNumber)) {
      if (Number(card.number) === trumpNumber) {
        return true;
      }
    }

    return cardMatchesTarotAssociation(card, path?.tarot?.card);
  }

  function buildCubeEdgeRelationsForCard(card, magickDataset) {
    const cube = magickDataset?.grouped?.kabbalah?.cube;
    const tree = magickDataset?.grouped?.kabbalah?.["kabbalah-tree"];
    const edges = Array.isArray(cube?.edges) ? cube.edges : [];
    const paths = Array.isArray(tree?.paths) ? tree.paths : [];

    if (!card || !edges.length || !paths.length) {
      return [];
    }

    const pathByLetterId = new Map(
      paths
        .map((path) => [normalizeHebrewLetterId(path?.hebrewLetter?.transliteration), path])
        .filter(([letterId]) => Boolean(letterId))
    );

    return edges
      .map((edge, index) => {
        const edgeLetterId = normalizeHebrewLetterId(edge?.hebrewLetterId || edge?.associations?.hebrewLetterId);
        if (!edgeLetterId) {
          return null;
        }

        const pathMatch = pathByLetterId.get(edgeLetterId);
        if (!pathMatch || !cardMatchesPathTarot(card, pathMatch)) {
          return null;
        }

        const edgeId = String(edge?.id || "").trim();
        if (!edgeId) {
          return null;
        }

        const edgeName = String(edge?.name || edgeId).trim();
        const wallId = String(Array.isArray(edge?.walls) ? (edge.walls[0] || "") : "").trim();

        return {
          type: "cubeEdge",
          id: edgeId,
          label: `Cube: ${edgeName} Edge`,
          data: {
            edgeId,
            edgeName,
            wallId: wallId || undefined,
            hebrewLetterId: edgeLetterId
          },
          __key: `cubeEdge|${edgeId}|${index}`
        };
      })
      .filter(Boolean);
  }

  function buildCubeMotherConnectorRelationsForCard(card, magickDataset) {
    const tree = magickDataset?.grouped?.kabbalah?.["kabbalah-tree"];
    const paths = Array.isArray(tree?.paths) ? tree.paths : [];
    const relations = Array.isArray(card?.relations) ? card.relations : [];

    return Object.entries(CUBE_MOTHER_CONNECTOR_BY_LETTER)
      .map(([letterId, connector]) => {
        const pathMatch = paths.find((path) => normalizeHebrewLetterId(path?.hebrewLetter?.transliteration) === letterId) || null;

        const matchesByPath = cardMatchesPathTarot(card, pathMatch);

        const matchesByHebrewRelation = relations.some((relation) => {
          if (relation?.type !== "hebrewLetter") {
            return false;
          }
          const relationLetterId = normalizeHebrewLetterId(
            relation?.data?.id || relation?.id || relation?.data?.latin || relation?.data?.name
          );
          return relationLetterId === letterId;
        });

        if (!matchesByPath && !matchesByHebrewRelation) {
          return null;
        }

        return {
          type: "cubeConnector",
          id: connector.connectorId,
          label: `Cube: ${connector.connectorName}`,
          data: {
            connectorId: connector.connectorId,
            connectorName: connector.connectorName,
            hebrewLetterId: letterId
          },
          __key: `cubeConnector|${connector.connectorId}|${letterId}`
        };
      })
      .filter(Boolean);
  }

  function buildCubePrimalPointRelationsForCard(card, magickDataset) {
    const center = magickDataset?.grouped?.kabbalah?.cube?.center;
    if (!center || !card) {
      return [];
    }

    const centerTarot = center?.associations?.tarotCard || center?.tarotCard;
    const centerTrump = Number(center?.associations?.tarotTrumpNumber);
    const matchesByName = cardMatchesTarotAssociation(card, centerTarot);
    const matchesByTrump = card?.arcana === "Major"
      && Number.isFinite(Number(card?.number))
      && Number.isFinite(centerTrump)
      && Number(card.number) === centerTrump;

    if (!matchesByName && !matchesByTrump) {
      return [];
    }

    return [{
      type: "cubeCenter",
      id: "primal-point",
      label: "Cube: Primal Point",
      data: {
        nodeType: "center",
        primalPoint: true
      },
      __key: "cubeCenter|primal-point"
    }];
  }

  function buildCubeRelationsForCard(card, magickDataset) {
    return [
      ...buildCubeFaceRelationsForCard(card, magickDataset),
      ...buildCubeEdgeRelationsForCard(card, magickDataset),
      ...buildCubePrimalPointRelationsForCard(card, magickDataset),
      ...buildCubeMotherConnectorRelationsForCard(card, magickDataset)
    ];
  }

  function buildIChingRelationsForCard(card, referenceData) {
    const iChing = referenceData?.iChing;
    const hexagrams = Array.isArray(iChing?.hexagrams) ? iChing.hexagrams : [];
    const hexagramByNumber = new Map(
      hexagrams
        .filter((h) => Number.isFinite(h?.number))
        .map((h) => [Number(h.number), h])
    );

    const directMappings = Array.isArray(iChing?.correspondences?.tarotToHexagram)
      ? iChing.correspondences.tarotToHexagram
      : [];

    if (!card || !directMappings.length) {
      return [];
    }

    const matchedHexagramNumbers = directMappings
      .filter((row) => cardMatchesTarotAssociation(card, row?.tarot))
      .map((row) => Number(row?.hexagram))
      .filter((n) => Number.isFinite(n) && hexagramByNumber.has(n));

    if (!matchedHexagramNumbers.length) {
      return [];
    }

    return matchedHexagramNumbers.map((hexNum) => {
      const hexagram = hexagramByNumber.get(hexNum);
      return {
        type: "ichingHexagram",
        id: String(hexNum),
        label: `Hexagram ${hexNum}: ${hexagram?.name || "--"}`,
        data: {
          hexagramNumber: hexNum,
          name: hexagram?.name || "",
          upperTrigram: hexagram?.upperTrigram || "",
          lowerTrigram: hexagram?.lowerTrigram || ""
        },
        __key: `ichingHexagram|${hexNum}`
      };
    });
  }

  window.TarotRelationsUi = {
    buildCourtCardByDecanId,
    buildSmallCardCourtLinkRelations,
    buildMonthReferencesByCard,
    buildCubeRelationsForCard,
    buildIChingRelationsForCard,
    parseMonthDayToken
  };
})();