/* tarot-database-assembly.js — Tarot card assembly helpers */
(function () {
  "use strict";

  function createTarotDatabaseAssembly(dependencies) {
    const getTarotDbConfig = dependencies?.getTarotDbConfig;
    const canonicalCardName = dependencies?.canonicalCardName;
    const formatMonthDayLabel = dependencies?.formatMonthDayLabel;
    const applyMeaningText = dependencies?.applyMeaningText;
    const buildDecanMetadata = dependencies?.buildDecanMetadata;
    const listMonthNumbersBetween = dependencies?.listMonthNumbersBetween;
    const buildHebrewLetterLookup = dependencies?.buildHebrewLetterLookup;
    const createRelation = dependencies?.createRelation;
    const parseLegacyRelation = dependencies?.parseLegacyRelation;
    const buildHebrewLetterRelation = dependencies?.buildHebrewLetterRelation;
    const buildMajorDynamicRelations = dependencies?.buildMajorDynamicRelations;
    const buildMinorDecanRelations = dependencies?.buildMinorDecanRelations;

    const monthNameByNumber = dependencies?.monthNameByNumber && typeof dependencies.monthNameByNumber === "object"
      ? dependencies.monthNameByNumber
      : {};
    const monthIdByNumber = dependencies?.monthIdByNumber && typeof dependencies.monthIdByNumber === "object"
      ? dependencies.monthIdByNumber
      : {};
    const majorHebrewLetterIdByCard = dependencies?.majorHebrewLetterIdByCard && typeof dependencies.majorHebrewLetterIdByCard === "object"
      ? dependencies.majorHebrewLetterIdByCard
      : {};

    if (
      typeof getTarotDbConfig !== "function"
      || typeof canonicalCardName !== "function"
      || typeof formatMonthDayLabel !== "function"
      || typeof applyMeaningText !== "function"
      || typeof buildDecanMetadata !== "function"
      || typeof listMonthNumbersBetween !== "function"
      || typeof buildHebrewLetterLookup !== "function"
      || typeof createRelation !== "function"
      || typeof parseLegacyRelation !== "function"
      || typeof buildHebrewLetterRelation !== "function"
      || typeof buildMajorDynamicRelations !== "function"
      || typeof buildMinorDecanRelations !== "function"
    ) {
      throw new Error("Tarot database assembly dependencies are incomplete");
    }

    function buildTokenDateRange(startToken, endToken) {
      const parseToken = (value) => {
        const match = String(value || "").trim().match(/^(\d{2})-(\d{2})$/);
        if (!match) {
          return null;
        }

        const month = Number(match[1]);
        const day = Number(match[2]);
        if (!Number.isFinite(month) || !Number.isFinite(day)) {
          return null;
        }

        return new Date(2025, month - 1, day);
      };

      const start = parseToken(startToken);
      const endBase = parseToken(endToken);
      if (!start || !endBase) {
        return null;
      }

      const wraps = endBase.getTime() < start.getTime();
      const end = wraps ? new Date(2026, endBase.getMonth(), endBase.getDate()) : endBase;

      return {
        start,
        end,
        startToken: startToken || null,
        endToken: endToken || null,
        label: `${formatMonthDayLabel(start)}–${formatMonthDayLabel(end)}`
      };
    }

    function buildMajorCards(referenceData, magickDataset) {
      const tarotDb = getTarotDbConfig(referenceData);
      const dynamicRelations = buildMajorDynamicRelations(referenceData);
      const hebrewLookup = buildHebrewLetterLookup(magickDataset);

      return tarotDb.majorCards.map((card) => {
        const canonicalName = canonicalCardName(card.name);
        const dynamic = dynamicRelations.get(canonicalName) || [];
        const hebrewLetterId = majorHebrewLetterIdByCard[canonicalName] || null;
        const hebrewLetterRelation = buildHebrewLetterRelation(hebrewLetterId, hebrewLookup);
        const staticRelations = (card.relations || [])
          .map((relation) => parseLegacyRelation(relation))
          .filter((relation) => relation.type !== "hebrewLetter" && relation.type !== "zodiac" && relation.type !== "planet");

        return {
          arcana: "Major",
          name: card.name,
          number: card.number,
          suit: null,
          rank: null,
          hebrewLetterId,
          kabbalahPathNumber: Number.isFinite(Number(card?.number)) ? Number(card.number) + 11 : null,
          hebrewLetter: hebrewLetterRelation?.data || null,
          summary: card.summary,
          meanings: {
            upright: card.upright,
            reversed: card.reversed
          },
          keywords: [...card.keywords],
          relations: [
            ...staticRelations,
            ...(hebrewLetterRelation ? [hebrewLetterRelation] : []),
            ...dynamic
          ]
        };
      });
    }

    function buildNumberMinorCards(referenceData) {
      const tarotDb = getTarotDbConfig(referenceData);
      const decanRelations = buildMinorDecanRelations(referenceData);
      const cards = [];

      tarotDb.suits.forEach((suit) => {
        const suitKey = suit.toLowerCase();
        const suitInfo = tarotDb.suitInfo[suitKey];
        if (!suitInfo) {
          return;
        }

        tarotDb.numberRanks.forEach((rank) => {
          const rankKey = rank.toLowerCase();
          const rankInfo = tarotDb.rankInfo[rankKey];
          if (!rankInfo) {
            return;
          }
          const cardName = `${rank} of ${suit}`;
          const dynamicRelations = decanRelations.get(canonicalCardName(cardName)) || [];

          cards.push({
            arcana: "Minor",
            name: cardName,
            number: null,
            suit,
            rank,
            summary: `${rank} energy expressed through ${suitInfo.domain}.`,
            meanings: {
              upright: `${rankInfo.upright} In ${suit}, this emphasizes ${suitInfo.domain}.`,
              reversed: `${rankInfo.reversed} In ${suit}, this may distort ${suitInfo.domain}.`
            },
            keywords: [...rankInfo.keywords, ...suitInfo.keywords],
            relations: [
              createRelation("element", suitInfo.element, `Element: ${suitInfo.element}`, {
                name: suitInfo.element
              }),
              createRelation("suitDomain", `${suitKey}-${rankKey}`, `Suit domain: ${suitInfo.domain}`, {
                suit,
                rank,
                domain: suitInfo.domain
              }),
              createRelation("numerology", rankInfo.number, `Numerology: ${rankInfo.number}`, {
                value: rankInfo.number
              }),
              ...dynamicRelations
            ]
          });
        });
      });

      return cards;
    }

    function buildCourtMinorCards(referenceData) {
      const tarotDb = getTarotDbConfig(referenceData);
      const cards = [];
      const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
      const signById = Object.fromEntries(signs.map((sign) => [sign.id, sign]));
      const planets = referenceData?.planets || {};

      const decanById = new Map();
      const decansBySign = referenceData?.decansBySign || {};
      Object.entries(decansBySign).forEach(([signId, decans]) => {
        const sign = signById[signId];
        if (!sign || !Array.isArray(decans)) {
          return;
        }
        decans.forEach((decan) => {
          if (!decan?.id) {
            return;
          }
          const meta = buildDecanMetadata(decan, sign);
          if (meta) {
            decanById.set(decan.id, meta);
          }
        });
      });

      tarotDb.suits.forEach((suit) => {
        const suitKey = suit.toLowerCase();
        const suitInfo = tarotDb.suitInfo[suitKey];
        if (!suitInfo) {
          return;
        }

        tarotDb.courtRanks.forEach((rank) => {
          const rankKey = rank.toLowerCase();
          const courtInfo = tarotDb.courtInfo[rankKey];
          if (!courtInfo) {
            return;
          }
          const cardName = `${rank} of ${suit}`;
          const windowDecanIds = tarotDb.courtDecanWindows[cardName] || [];
          const windowDecans = windowDecanIds
            .map((decanId) => decanById.get(decanId) || null)
            .filter(Boolean);
          const windowSignIds = tarotDb.courtSignWindows?.[cardName] || [];
          const windowSigns = windowSignIds
            .map((signId) => signById[signId] || null)
            .filter(Boolean);
          const explicitWindowRange = buildTokenDateRange(
            tarotDb.courtDateRanges?.[cardName]?.start,
            tarotDb.courtDateRanges?.[cardName]?.end
          );

          const dynamicRelations = [];
          const monthKeys = new Set();

          windowDecans.forEach((meta) => {
            dynamicRelations.push(
              createRelation(
                "decan",
                `${meta.signId}-${meta.index}-${rankKey}-${suitKey}`,
                `Decan ${meta.index}: ${meta.signSymbol} ${meta.signName} (${meta.startDegree}°–${meta.endDegree}°)${meta.dateRange ? ` · ${meta.dateRange.label}` : ""}`.trim(),
                {
                  signId: meta.signId,
                  signName: meta.signName,
                  signSymbol: meta.signSymbol,
                  index: meta.index,
                  startDegree: meta.startDegree,
                  endDegree: meta.endDegree,
                  dateStart: meta.dateRange?.startToken || null,
                  dateEnd: meta.dateRange?.endToken || null,
                  dateRange: meta.dateRange?.label || null
                }
              )
            );

            if (meta?.decan?.tarotMinorArcana) {
              dynamicRelations.push(
                createRelation(
                  "tarotCard",
                  `${meta.signId}-${meta.index}-${rankKey}-${suitKey}-decan-card`,
                  `Decan card: ${meta.decan.tarotMinorArcana} (${meta.signName} decan ${meta.index})`,
                  {
                    cardName: meta.decan.tarotMinorArcana,
                    decanId: meta.decan.id || `${meta.signId}-${meta.index}`,
                    signId: meta.signId,
                    signName: meta.signName,
                    decanIndex: meta.index,
                    dateRange: meta.dateRange?.label || null
                  }
                )
              );
            }

            const ruler = planets?.[meta?.decan?.rulerPlanetId] || null;
            if (ruler) {
              dynamicRelations.push(
                createRelation(
                  "decanRuler",
                  `${meta.signId}-${meta.index}-${ruler.id || meta.decan?.rulerPlanetId || rankKey}-${rankKey}-${suitKey}`,
                  `Decan ruler: ${ruler.symbol || ""} ${ruler.name || meta.decan?.rulerPlanetId || ""}`.trim(),
                  {
                    signId: meta.signId,
                    decanIndex: meta.index,
                    planetId: ruler.id || meta.decan?.rulerPlanetId || null,
                    symbol: ruler.symbol || "",
                    name: ruler.name || meta.decan?.rulerPlanetId || ""
                  }
                )
              );
            }

            const dateRange = meta.dateRange;
            if (dateRange?.start && dateRange?.end) {
              const monthNumbers = listMonthNumbersBetween(dateRange.start, dateRange.end);
              monthNumbers.forEach((monthNo) => {
                const monthId = monthIdByNumber[monthNo];
                const monthName = monthNameByNumber[monthNo] || `Month ${monthNo}`;
                const monthKey = `${monthId}:${meta.signId}:${meta.index}`;
                if (!monthId || monthKeys.has(monthKey)) {
                  return;
                }
                monthKeys.add(monthKey);

                dynamicRelations.push(
                  createRelation(
                    "calendarMonth",
                    `${monthId}-${meta.signId}-${meta.index}-${rankKey}-${suitKey}`,
                    `Calendar month: ${monthName} (${meta.signName} decan ${meta.index})`,
                    {
                      monthId,
                      name: monthName,
                      monthOrder: monthNo,
                      signId: meta.signId,
                      signName: meta.signName,
                      decanIndex: meta.index,
                      dateRange: meta.dateRange?.label || null
                    }
                  )
                );
              });
            }
          });

          windowSigns.forEach((sign) => {
            const signDateRange = buildTokenDateRange(sign?.start, sign?.end);
            const signName = sign?.name || sign?.id || "";
            const signSymbol = sign?.symbol || "";
            const relatedDecans = Array.isArray(decansBySign?.[sign.id]) ? decansBySign[sign.id] : [];

            dynamicRelations.push(
              createRelation(
                "signWindow",
                `${sign.id}-${rankKey}-${suitKey}`,
                `Sign window: ${signSymbol} ${signName} (0°–30°)${signDateRange ? ` · ${signDateRange.label}` : ""}`.trim(),
                {
                  signId: sign.id,
                  signName,
                  signSymbol,
                  startDegree: 0,
                  endDegree: 30,
                  dateStart: signDateRange?.startToken || null,
                  dateEnd: signDateRange?.endToken || null,
                  dateRange: signDateRange?.label || null
                }
              )
            );

            relatedDecans.forEach((decan) => {
              if (!decan?.tarotMinorArcana) {
                return;
              }

              dynamicRelations.push(
                createRelation(
                  "tarotCard",
                  `${sign.id}-${decan.id || decan.tarotMinorArcana}-${rankKey}-${suitKey}-sign-card`,
                  `Sign card: ${decan.tarotMinorArcana} (${signName})`,
                  {
                    cardName: decan.tarotMinorArcana,
                    decanId: decan.id || null,
                    signId: sign.id,
                    signName,
                    signSymbol,
                    dateRange: signDateRange?.label || null
                  }
                )
              );
            });

            if (signDateRange?.start && signDateRange?.end) {
              const monthNumbers = listMonthNumbersBetween(signDateRange.start, signDateRange.end);
              monthNumbers.forEach((monthNo) => {
                const monthId = monthIdByNumber[monthNo];
                const monthName = monthNameByNumber[monthNo] || `Month ${monthNo}`;
                const monthKey = `${monthId}:${sign.id}:sign-window`;
                if (!monthId || monthKeys.has(monthKey)) {
                  return;
                }
                monthKeys.add(monthKey);

                dynamicRelations.push(
                  createRelation(
                    "calendarMonth",
                    `${monthId}-${sign.id}-${rankKey}-${suitKey}-sign-window`,
                    `Calendar month: ${monthName} (${signName} sign window)`,
                    {
                      monthId,
                      name: monthName,
                      monthOrder: monthNo,
                      signId: sign.id,
                      signName,
                      dateRange: signDateRange?.label || null
                    }
                  )
                );
              });
            }
          });

          if (windowDecans.length || windowSigns.length) {
            const firstRange = windowDecans.length ? windowDecans[0].dateRange : null;
            const lastRange = windowDecans.length ? windowDecans[windowDecans.length - 1].dateRange : null;
            const firstSignRange = windowSigns.length ? buildTokenDateRange(windowSigns[0]?.start, windowSigns[0]?.end) : null;
            const lastSignRange = windowSigns.length ? buildTokenDateRange(windowSigns[windowSigns.length - 1]?.start, windowSigns[windowSigns.length - 1]?.end) : null;
            const fallbackWindowRange = firstRange && lastRange
              ? {
                  start: firstRange.start,
                  end: lastRange.end,
                  startToken: firstRange.startToken,
                  endToken: lastRange.endToken,
                  label: `${formatMonthDayLabel(firstRange.start)}–${formatMonthDayLabel(lastRange.end)}`
                }
              : (firstSignRange && lastSignRange
                  ? {
                      start: firstSignRange.start,
                      end: lastSignRange.end,
                      startToken: firstSignRange.startToken,
                      endToken: lastSignRange.endToken,
                      label: `${formatMonthDayLabel(firstSignRange.start)}–${formatMonthDayLabel(lastSignRange.end)}`
                    }
                  : null);
            const windowRange = explicitWindowRange || fallbackWindowRange;
            const windowLabel = windowRange?.label || "--";

            dynamicRelations.unshift(
              createRelation(
                "courtDateWindow",
                `${rankKey}-${suitKey}`,
                `Court date window: ${windowLabel}`,
                {
                  dateStart: windowRange?.startToken || null,
                  dateEnd: windowRange?.endToken || null,
                  dateRange: windowLabel,
                  decanIds: windowDecanIds,
                  signIds: windowSignIds
                }
              )
            );
          }

          cards.push({
            arcana: "Minor",
            name: cardName,
            number: null,
            suit,
            rank,
            summary: `${rank} as ${courtInfo.role} within ${suitInfo.domain}.`,
            meanings: {
              upright: `${courtInfo.upright} In ${suit}, this guides ${suitInfo.domain}.`,
              reversed: `${courtInfo.reversed} In ${suit}, this complicates ${suitInfo.domain}.`
            },
            keywords: [...courtInfo.keywords, ...suitInfo.keywords],
            relations: [
              createRelation("element", suitInfo.element, `Element: ${suitInfo.element}`, {
                name: suitInfo.element
              }),
              createRelation(
                "elementalFace",
                `${rankKey}-${suitKey}`,
                `${courtInfo.elementalFace} ${suitInfo.element}`,
                {
                  rank,
                  suit,
                  elementalFace: courtInfo.elementalFace,
                  element: suitInfo.element
                }
              ),
              createRelation("courtRole", rankKey, `Court role: ${courtInfo.role}`, {
                rank,
                role: courtInfo.role
              }),
              ...dynamicRelations
            ]
          });
        });
      });

      return cards;
    }

    function buildTarotDatabase(referenceData, magickDataset = null) {
      const cards = [
        ...buildMajorCards(referenceData, magickDataset),
        ...buildNumberMinorCards(referenceData),
        ...buildCourtMinorCards(referenceData)
      ];

      return applyMeaningText(cards, referenceData);
    }

    return {
      buildCourtMinorCards,
      buildMajorCards,
      buildNumberMinorCards,
      buildTarotDatabase
    };
  }

  window.TarotDatabaseAssembly = {
    createTarotDatabaseAssembly
  };
})();