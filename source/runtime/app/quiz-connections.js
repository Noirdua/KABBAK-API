/* quiz-connections.js — Dynamic quiz category plugin for dataset relations */
(function () {
  "use strict";

  const { getTarotCardDisplayName } = window.TarotCardImages || {};
  const quizPluginHelpers = window.QuizPluginHelpers || {};
  const {
    normalizeOption,
    normalizeKey,
    buildTemplatesFromSpec,
    buildTemplatesFromVariants
  } = quizPluginHelpers;

  if (
    typeof normalizeOption !== "function"
    || typeof normalizeKey !== "function"
    || typeof buildTemplatesFromSpec !== "function"
    || typeof buildTemplatesFromVariants !== "function"
  ) {
    throw new Error("QuizPluginHelpers must load before quiz-connections.js");
  }

  const cache = {
    referenceData: null,
    magickDataset: null,
    templates: [],
    templatesByCategory: new Map()
  };

  function toTitleCase(value) {
    const text = normalizeOption(value).toLowerCase();
    if (!text) {
      return "";
    }
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function labelFromId(value) {
    const id = normalizeOption(value);
    if (!id) {
      return "";
    }

    return id
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
      .join(" ");
  }

  function formatHebrewLetterLabel(entry, fallbackId = "") {
    if (entry?.name && entry?.char) {
      return `${entry.name} (${entry.char})`;
    }
    if (entry?.name) {
      return entry.name;
    }
    if (entry?.char) {
      return entry.char;
    }
    return labelFromId(fallbackId);
  }

  function slugifyId(value) {
    return normalizeKey(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function formatHexagramLabel(entry) {
    const number = Number(entry?.number);
    const name = normalizeOption(entry?.name);
    if (Number.isFinite(number) && name) {
      return `Hexagram ${number}: ${name}`;
    }
    if (Number.isFinite(number)) {
      return `Hexagram ${number}`;
    }
    return name || "Hexagram";
  }

  function formatTrigramLabel(trigram) {
    const name = normalizeOption(trigram?.name);
    const element = normalizeOption(trigram?.element);
    if (name && element) {
      return `${name} (${element})`;
    }
    return name || element;
  }

  function formatTarotLabel(value) {
    const raw = normalizeOption(value);
    if (!raw) {
      return "";
    }

    const keyMatch = raw.match(/^key\s*(\d{1,2})\s*:\s*(.+)$/i);
    if (keyMatch) {
      const trumpNumber = Number(keyMatch[1]);
      const fallbackName = normalizeOption(keyMatch[2]);
      if (typeof getTarotCardDisplayName === "function") {
        const displayName = normalizeOption(getTarotCardDisplayName(fallbackName, { trumpNumber }));
        if (displayName) {
          return displayName;
        }
      }
      return fallbackName;
    }

    if (typeof getTarotCardDisplayName === "function") {
      const displayName = normalizeOption(getTarotCardDisplayName(raw));
      if (displayName) {
        return displayName;
      }
    }

    return raw.replace(/\bPentacles\b/gi, "Disks");
  }

  function getPlanetLabelById(planetId, planetsById) {
    const key = normalizeKey(planetId);
    const label = planetsById?.[key]?.name;
    if (label) {
      return normalizeOption(label);
    }
    if (key === "primum-mobile") {
      return "Primum Mobile";
    }
    if (key === "olam-yesodot") {
      return "Earth / Elements";
    }
    return normalizeOption(labelFromId(planetId));
  }

  function formatPathLetter(path) {
    const transliteration = normalizeOption(path?.hebrewLetter?.transliteration);
    const glyph = normalizeOption(path?.hebrewLetter?.char);
    if (transliteration && glyph) {
      return `${transliteration} (${glyph})`;
    }
    return transliteration || glyph;
  }

  function getSephiraName(numberValue, idValue, sephiraByNumber, sephiraById) {
    const numberKey = Number(numberValue);
    if (Number.isFinite(numberKey) && sephiraByNumber.has(Math.trunc(numberKey))) {
      return sephiraByNumber.get(Math.trunc(numberKey));
    }

    const idKey = normalizeKey(idValue);
    if (idKey && sephiraById.has(idKey)) {
      return sephiraById.get(idKey);
    }

    if (Number.isFinite(numberKey)) {
      return `Sephira ${Math.trunc(numberKey)}`;
    }

    return labelFromId(idValue);
  }

  function toRomanNumeral(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return String(value || "");
    }

    const lookup = [
      [1000, "M"],
      [900, "CM"],
      [500, "D"],
      [400, "CD"],
      [100, "C"],
      [90, "XC"],
      [50, "L"],
      [40, "XL"],
      [10, "X"],
      [9, "IX"],
      [5, "V"],
      [4, "IV"],
      [1, "I"]
    ];

    let current = Math.trunc(numeric);
    let result = "";
    lookup.forEach(([size, symbol]) => {
      while (current >= size) {
        result += symbol;
        current -= size;
      }
    });

    return result || String(Math.trunc(numeric));
  }

  function formatDecanLabel(decan, signNameById) {
    const signName = signNameById.get(normalizeKey(decan?.signId)) || labelFromId(decan?.signId);
    const index = Number(decan?.index);
    if (!signName || !Number.isFinite(index)) {
      return "";
    }

    return `${signName} Decan ${toRomanNumeral(index)}`;
  }

  function buildEnglishGematriaCipherGroups(englishLetters, gematriaCiphers) {
    const ciphers = Array.isArray(gematriaCiphers?.ciphers) ? gematriaCiphers.ciphers : [];

    return ciphers
      .map((cipher) => {
        const cipherId = normalizeOption(cipher?.id);
        const cipherName = normalizeOption(cipher?.name || labelFromId(cipherId));
        const slug = slugifyId(cipherId || cipherName);
        const values = Array.isArray(cipher?.values) ? cipher.values : [];

        if (!slug || !cipherName || !values.length) {
          return null;
        }

        const categoryId = `english-gematria-${slug}`;
        const category = `English Gematria: ${cipherName}`;
        const rows = englishLetters
          .filter((entry) => normalizeOption(entry?.letter) && Number.isFinite(Number(entry?.index)))
          .map((entry) => {
            const position = Math.trunc(Number(entry.index));
            const value = values[position - 1];
            if (!Number.isFinite(Number(value))) {
              return null;
            }

            return {
              id: normalizeOption(entry.letter),
              letter: normalizeOption(entry.letter),
              value: String(Math.trunc(Number(value))),
              cipherName
            };
          })
          .filter(Boolean);

        if (rows.length < 4) {
          return null;
        }

        return {
          entries: rows,
          variants: [
            {
              keyPrefix: categoryId,
              categoryId,
              category,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `In the ${entry.cipherName} cipher, ${entry.letter} has a value of`,
              getAnswer: (entry) => entry.value
            }
          ]
        };
      })
      .filter(Boolean);
  }

  function buildAutomatedConnectionTemplates(referenceData, magickDataset) {
    if (cache.referenceData === referenceData && cache.magickDataset === magickDataset) {
      return cache.templates;
    }

    const planetsById = referenceData?.planets && typeof referenceData.planets === "object"
      ? referenceData.planets
      : {};
    const planets = Object.values(planetsById).filter(Boolean);
    const signs = Array.isArray(referenceData?.signs) ? referenceData.signs : [];
    const gematriaCiphers = referenceData?.gematriaCiphers && typeof referenceData.gematriaCiphers === "object"
      ? referenceData.gematriaCiphers
      : {};
    const decansBySign = referenceData?.decansBySign && typeof referenceData.decansBySign === "object"
      ? referenceData.decansBySign
      : {};
    const signNameById = new Map(
      signs
        .filter((entry) => normalizeOption(entry?.id) && normalizeOption(entry?.name))
        .map((entry) => [normalizeKey(entry.id), normalizeOption(entry.name)])
    );

    const grouped = magickDataset?.grouped || {};
    const alphabets = grouped.alphabets || {};
    const englishLetters = Array.isArray(alphabets?.english) ? alphabets.english : [];
    const hebrewLetters = Array.isArray(alphabets?.hebrew) ? alphabets.hebrew : [];
    const hebrewById = new Map(
      hebrewLetters
        .filter((entry) => normalizeOption(entry?.hebrewLetterId))
        .map((entry) => [normalizeKey(entry.hebrewLetterId), entry])
    );

    const kabbalahTree = grouped?.kabbalah?.["kabbalah-tree"] || {};
    const treePaths = Array.isArray(kabbalahTree?.paths) ? kabbalahTree.paths : [];
    const treeSephiroth = Array.isArray(kabbalahTree?.sephiroth) ? kabbalahTree.sephiroth : [];
    const sephiraByNumber = new Map(
      treeSephiroth
        .filter((entry) => Number.isFinite(Number(entry?.number)) && normalizeOption(entry?.name))
        .map((entry) => [Math.trunc(Number(entry.number)), normalizeOption(entry.name)])
    );
    const sephiraByTreeId = new Map(
      treeSephiroth
        .filter((entry) => normalizeOption(entry?.sephiraId) && normalizeOption(entry?.name))
        .map((entry) => [normalizeKey(entry.sephiraId), normalizeOption(entry.name)])
    );
    const sephirotById = grouped?.kabbalah?.sephirot && typeof grouped.kabbalah.sephirot === "object"
      ? grouped.kabbalah.sephirot
      : {};

    const cube = grouped?.kabbalah?.cube && typeof grouped.kabbalah.cube === "object"
      ? grouped.kabbalah.cube
      : {};
    const cubeWalls = Array.isArray(cube?.walls) ? cube.walls : [];
    const cubeEdges = Array.isArray(cube?.edges) ? cube.edges : [];
    const cubeCenter = cube?.center && typeof cube.center === "object" ? cube.center : null;

    const playingCardsData = grouped?.["playing-cards-52"];
    const playingCards = Array.isArray(playingCardsData)
      ? playingCardsData
      : (Array.isArray(playingCardsData?.entries) ? playingCardsData.entries : []);
    const flattenDecans = Object.values(decansBySign).flatMap((entries) => Array.isArray(entries) ? entries : []);

    const iChing = referenceData?.iChing;
    const trigrams = Array.isArray(iChing?.trigrams) ? iChing.trigrams : [];
    const hexagrams = Array.isArray(iChing?.hexagrams) ? iChing.hexagrams : [];
    const correspondences = Array.isArray(iChing?.correspondences?.tarotToTrigram)
      ? iChing.correspondences.tarotToTrigram
      : [];

    const trigramByKey = new Map(
      trigrams
        .map((trigram) => [normalizeKey(trigram?.name), trigram])
        .filter(([key]) => Boolean(key))
    );

    const hexagramRows = hexagrams
      .map((entry) => {
        const upper = trigramByKey.get(normalizeKey(entry?.upperTrigram)) || null;
        const lower = trigramByKey.get(normalizeKey(entry?.lowerTrigram)) || null;

        return {
          ...entry,
          number: Number(entry?.number),
          hexagramLabel: formatHexagramLabel(entry),
          upperLabel: formatTrigramLabel(upper || { name: entry?.upperTrigram }),
          lowerLabel: formatTrigramLabel(lower || { name: entry?.lowerTrigram })
        };
      })
      .filter((entry) => Number.isFinite(entry.number) && entry.hexagramLabel);

    const tarotCorrespondenceRows = correspondences
      .map((entry, index) => {
        const trigram = trigramByKey.get(normalizeKey(entry?.trigram)) || null;
        return {
          id: `${index}-${normalizeKey(entry?.tarot)}-${normalizeKey(entry?.trigram)}`,
          tarotLabel: formatTarotLabel(entry?.tarot),
          trigramLabel: formatTrigramLabel(trigram || { name: entry?.trigram })
        };
      })
      .filter((entry) => entry.tarotLabel && entry.trigramLabel);

    const englishGematriaGroups = buildEnglishGematriaCipherGroups(englishLetters, gematriaCiphers);

    const hebrewNumerologyRows = hebrewLetters
      .filter((entry) => normalizeOption(entry?.name) && normalizeOption(entry?.char) && Number.isFinite(Number(entry?.numerology)))
      .map((entry) => ({
        id: normalizeOption(entry.hebrewLetterId || entry.name),
        glyphLabel: `${normalizeOption(entry.name)} (${normalizeOption(entry.char)})`,
        char: normalizeOption(entry.char),
        value: String(Math.trunc(Number(entry.numerology)))
      }));

    const englishHebrewRows = englishLetters
      .map((entry) => {
        const hebrew = hebrewById.get(normalizeKey(entry?.hebrewLetterId)) || null;
        if (!normalizeOption(entry?.letter) || !hebrew) {
          return null;
        }
        return {
          id: normalizeOption(entry.letter),
          letter: normalizeOption(entry.letter),
          hebrewLabel: formatHebrewLetterLabel(hebrew, entry?.hebrewLetterId),
          hebrewChar: normalizeOption(hebrew?.char)
        };
      })
      .filter(Boolean);

    const kabbalahPathRows = treePaths
      .map((path) => {
        const pathNumber = Number(path?.pathNumber);
        if (!Number.isFinite(pathNumber)) {
          return null;
        }

        const pathNumberLabel = String(Math.trunc(pathNumber));
        const fromName = getSephiraName(path?.connects?.from, path?.connectIds?.from, sephiraByNumber, sephiraByTreeId);
        const toName = getSephiraName(path?.connects?.to, path?.connectIds?.to, sephiraByNumber, sephiraByTreeId);
        const letterLabel = formatPathLetter(path);
        const tarotLabel = formatTarotLabel(path?.tarot?.card);

        return {
          id: pathNumberLabel,
          pathNumberLabel,
          pathPairLabel: fromName && toName ? `${fromName} ↔ ${toName}` : "",
          fromName,
          toName,
          letterLabel,
          tarotLabel
        };
      })
      .filter(Boolean);

    const sephirotRows = Object.values(sephirotById || {})
      .map((sephira) => {
        const sephiraName = normalizeOption(sephira?.name?.roman || sephira?.name?.en);
        const planetLabel = getPlanetLabelById(sephira?.planetId, planetsById);
        if (!sephiraName || !planetLabel) {
          return null;
        }
        return {
          id: normalizeOption(sephira?.id || sephiraName),
          sephiraName,
          planetLabel
        };
      })
      .filter(Boolean);

    const decanRows = flattenDecans
      .map((decan) => {
        const id = normalizeOption(decan?.id);
        const tarotLabel = formatTarotLabel(decan?.tarotMinorArcana);
        const decanLabel = formatDecanLabel(decan, signNameById);
        const rulerLabel = getPlanetLabelById(decan?.rulerPlanetId, planetsById);
        if (!id || !tarotLabel) {
          return null;
        }
        return {
          id,
          tarotLabel,
          decanLabel,
          rulerLabel
        };
      })
      .filter(Boolean);

    const cubeTarotRows = [
      ...cubeWalls.map((wall) => {
        const wallName = normalizeOption(wall?.name || labelFromId(wall?.id));
        const locationLabel = wallName ? `${wallName} Wall` : "";
        const tarotLabel = formatTarotLabel(wall?.associations?.tarotCard);
        return tarotLabel && locationLabel
          ? { id: normalizeOption(wall?.id || wallName), tarotLabel, locationLabel }
          : null;
      }),
      ...cubeEdges.map((edge) => {
        const edgeName = normalizeOption(edge?.name || labelFromId(edge?.id));
        const locationLabel = edgeName ? `${edgeName} Edge` : "";
        const hebrew = hebrewById.get(normalizeKey(edge?.hebrewLetterId)) || null;
        const tarotLabel = formatTarotLabel(hebrew?.tarot?.card);
        return tarotLabel && locationLabel
          ? { id: normalizeOption(edge?.id || edgeName), tarotLabel, locationLabel }
          : null;
      }),
      (() => {
        const tarotLabel = formatTarotLabel(cubeCenter?.associations?.tarotCard || cubeCenter?.tarotCard);
        return tarotLabel ? { id: "center", tarotLabel, locationLabel: "Center" } : null;
      })()
    ].filter(Boolean);

    const cubeHebrewRows = [
      ...cubeWalls.map((wall) => {
        const wallName = normalizeOption(wall?.name || labelFromId(wall?.id));
        const locationLabel = wallName ? `${wallName} Wall` : "";
        const hebrew = hebrewById.get(normalizeKey(wall?.hebrewLetterId)) || null;
        const hebrewLabel = formatHebrewLetterLabel(hebrew, wall?.hebrewLetterId);
        return locationLabel && hebrewLabel
          ? { id: normalizeOption(wall?.id || wallName), locationLabel, hebrewLabel }
          : null;
      }),
      ...cubeEdges.map((edge) => {
        const edgeName = normalizeOption(edge?.name || labelFromId(edge?.id));
        const locationLabel = edgeName ? `${edgeName} Edge` : "";
        const hebrew = hebrewById.get(normalizeKey(edge?.hebrewLetterId)) || null;
        const hebrewLabel = formatHebrewLetterLabel(hebrew, edge?.hebrewLetterId);
        return locationLabel && hebrewLabel
          ? { id: normalizeOption(edge?.id || edgeName), locationLabel, hebrewLabel }
          : null;
      }),
      (() => {
        const hebrew = hebrewById.get(normalizeKey(cubeCenter?.hebrewLetterId)) || null;
        const hebrewLabel = formatHebrewLetterLabel(hebrew, cubeCenter?.hebrewLetterId);
        return hebrewLabel ? { id: "center", locationLabel: "Center", hebrewLabel } : null;
      })()
    ].filter(Boolean);

    const playingCardRows = playingCards
      .map((entry) => {
        const cardId = normalizeOption(entry?.id);
        const rankLabel = normalizeOption(entry?.rankLabel || entry?.rank);
        const suitLabel = normalizeOption(entry?.suitLabel || labelFromId(entry?.suit));
        const tarotLabel = formatTarotLabel(entry?.tarotCard);
        const playingCardLabel = rankLabel && suitLabel ? `${rankLabel} of ${suitLabel}` : "";
        return cardId && playingCardLabel && tarotLabel
          ? { id: cardId, playingCardLabel, tarotLabel }
          : null;
      })
      .filter(Boolean);

    const specGroups = [
      ...englishGematriaGroups,
      {
        entries: hebrewNumerologyRows,
        variants: [
          {
            keyPrefix: "hebrew-number",
            categoryId: "hebrew-numerology",
            category: "Hebrew Gematria",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.glyphLabel} has a gematria value of`,
            getAnswer: (entry) => entry.value
          }
        ]
      },
      {
        entries: englishHebrewRows,
        variants: [
          {
            keyPrefix: "english-hebrew",
            categoryId: "english-hebrew-mapping",
            category: "Alphabet Mapping",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.letter} maps to which Hebrew letter`,
            getAnswer: (entry) => entry.hebrewLabel,
            inverse: {
              keyPrefix: "hebrew-english",
              getUniquenessKey: (entry) => entry.hebrewLabel,
              getKey: (entry) => entry.hebrewChar || entry.hebrewLabel,
              getPrompt: (entry) => `${entry.hebrewLabel} maps to which English letter`,
              getAnswer: (entry) => entry.letter
            }
          }
        ]
      },
      {
        entries: signs.filter((entry) => entry?.name && entry?.rulingPlanetId),
        variants: [
          {
            keyPrefix: "zodiac-ruler",
            categoryId: "zodiac-rulers",
            category: "Zodiac Rulers",
            getKey: (entry) => entry.id || entry.name,
            getPrompt: (entry) => `${entry.name} is ruled by`,
            getAnswer: (entry) => getPlanetLabelById(entry.rulingPlanetId, planetsById)
          }
        ]
      },
      {
        entries: signs.filter((entry) => entry?.name && entry?.element),
        variants: [
          {
            keyPrefix: "zodiac-element",
            categoryId: "zodiac-elements",
            category: "Zodiac Elements",
            getKey: (entry) => entry.id || entry.name,
            getPrompt: (entry) => `${entry.name} is`,
            getAnswer: (entry) => normalizeOption(entry.element).replace(/^./, (char) => char.toUpperCase())
          }
        ]
      },
      {
        entries: planets.filter((entry) => entry?.name && entry?.weekday),
        variants: [
          {
            keyPrefix: "planet-weekday",
            categoryId: "planetary-weekdays",
            category: "Planetary Weekdays",
            getKey: (entry) => entry.id || entry.name,
            getPrompt: (entry) => `${entry.name} corresponds to`,
            getAnswer: (entry) => normalizeOption(entry.weekday),
            inverse: {
              keyPrefix: "weekday-planet",
              getUniquenessKey: (entry) => normalizeOption(entry.weekday),
              getKey: (entry) => normalizeOption(entry.weekday),
              getPrompt: (entry) => `${normalizeOption(entry.weekday)} corresponds to which planet`,
              getAnswer: (entry) => normalizeOption(entry.name)
            }
          }
        ]
      },
      {
        entries: signs.filter((entry) => entry?.name && (entry?.tarot?.majorArcana || entry?.tarot?.card)),
        variants: [
          {
            keyPrefix: "zodiac-tarot",
            categoryId: "zodiac-tarot",
            category: "Zodiac ↔ Tarot",
            getKey: (entry) => entry.id || entry.name,
            getPrompt: (entry) => `${entry.name} corresponds to`,
            getAnswer: (entry) => formatTarotLabel(entry?.tarot?.majorArcana || entry?.tarot?.card),
            inverse: {
              keyPrefix: "tarot-zodiac",
              getUniquenessKey: (entry) => formatTarotLabel(entry?.tarot?.majorArcana || entry?.tarot?.card),
              getKey: (entry) => formatTarotLabel(entry?.tarot?.majorArcana || entry?.tarot?.card),
              getPrompt: (entry) => `${formatTarotLabel(entry?.tarot?.majorArcana || entry?.tarot?.card)} corresponds to which zodiac sign`,
              getAnswer: (entry) => normalizeOption(entry.name)
            }
          }
        ]
      },
      {
        entries: kabbalahPathRows.filter((entry) => entry.fromName && entry.toName),
        variants: [
          {
            keyPrefix: "kabbalah-path-between",
            categoryId: "kabbalah-path-between-sephirot",
            category: "Kabbalah Paths",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `What path connects ${entry.fromName} and ${entry.toName}`,
            getAnswer: (entry) => entry.pathNumberLabel
          }
        ]
      },
      {
        entries: kabbalahPathRows.filter((entry) => entry.letterLabel),
        variants: [
          {
            keyPrefix: "kabbalah-path-letter",
            categoryId: "kabbalah-path-letter",
            category: "Kabbalah Paths",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `Path ${entry.pathNumberLabel} carries which Hebrew letter`,
            getAnswer: (entry) => entry.letterLabel,
            inverse: {
              keyPrefix: "kabbalah-letter-path-number",
              getUniquenessKey: (entry) => entry.letterLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.letterLabel} belongs to which path`,
              getAnswer: (entry) => entry.pathNumberLabel
            }
          }
        ]
      },
      {
        entries: kabbalahPathRows.filter((entry) => entry.tarotLabel),
        variants: [
          {
            keyPrefix: "kabbalah-path-tarot",
            categoryId: "kabbalah-path-tarot",
            category: "Kabbalah ↔ Tarot",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `Path ${entry.pathNumberLabel} corresponds to which Tarot trump`,
            getAnswer: (entry) => entry.tarotLabel,
            inverse: {
              keyPrefix: "tarot-trump-path",
              getUniquenessKey: (entry) => entry.tarotLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.tarotLabel} is on which path`,
              getAnswer: (entry) => entry.pathNumberLabel
            }
          }
        ]
      },
      {
        entries: sephirotRows,
        variants: [
          {
            keyPrefix: "sephirot-planet",
            categoryId: "sephirot-planets",
            category: "Sephirot ↔ Planet",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.sephiraName} corresponds to which planet`,
            getAnswer: (entry) => entry.planetLabel
          }
        ]
      },
      {
        entries: decanRows.filter((entry) => entry.decanLabel),
        variants: [
          {
            keyPrefix: "tarot-decan-sign",
            categoryId: "tarot-decan-sign",
            category: "Tarot Decans",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.tarotLabel} belongs to which decan`,
            getAnswer: (entry) => entry.decanLabel,
            inverse: {
              keyPrefix: "decan-tarot-card",
              getUniquenessKey: (entry) => entry.decanLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.decanLabel} corresponds to which Tarot card`,
              getAnswer: (entry) => entry.tarotLabel
            }
          }
        ]
      },
      {
        entries: decanRows.filter((entry) => entry.rulerLabel),
        variants: [
          {
            keyPrefix: "tarot-decan-ruler",
            categoryId: "tarot-decan-ruler",
            category: "Tarot Decans",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `The decan of ${entry.tarotLabel} is ruled by`,
            getAnswer: (entry) => entry.rulerLabel
          }
        ]
      },
      {
        entries: cubeTarotRows,
        variants: [
          {
            keyPrefix: "tarot-cube-location",
            categoryId: "tarot-cube-location",
            category: "Tarot ↔ Cube",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.tarotLabel} is on which Cube location`,
            getAnswer: (entry) => entry.locationLabel,
            inverse: {
              keyPrefix: "cube-location-tarot",
              getUniquenessKey: (entry) => entry.locationLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.locationLabel} corresponds to which Tarot card`,
              getAnswer: (entry) => entry.tarotLabel
            }
          }
        ]
      },
      {
        entries: cubeHebrewRows,
        variants: [
          {
            keyPrefix: "cube-hebrew-letter",
            categoryId: "cube-hebrew-letter",
            category: "Cube ↔ Hebrew",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.locationLabel} corresponds to which Hebrew letter`,
            getAnswer: (entry) => entry.hebrewLabel,
            inverse: {
              keyPrefix: "hebrew-cube-location",
              getUniquenessKey: (entry) => entry.hebrewLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.hebrewLabel} is on which Cube location`,
              getAnswer: (entry) => entry.locationLabel
            }
          }
        ]
      },
      {
        entries: playingCardRows,
        variants: [
          {
            keyPrefix: "playing-card-tarot",
            categoryId: "playing-card-tarot",
            category: "Playing Card ↔ Tarot",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.playingCardLabel} maps to which Tarot card`,
            getAnswer: (entry) => entry.tarotLabel,
            inverse: {
              keyPrefix: "tarot-playing-card",
              getUniquenessKey: (entry) => entry.tarotLabel,
              getKey: (entry) => entry.id,
              getPrompt: (entry) => `${entry.tarotLabel} maps to which playing card`,
              getAnswer: (entry) => entry.playingCardLabel
            }
          }
        ]
      },
      {
        entries: hexagramRows.filter((entry) => normalizeOption(entry.planetaryInfluence)),
        variants: [
          {
            keyPrefix: "iching-planet",
            categoryId: "iching-planetary-influence",
            category: "I Ching ↔ Planet",
            getKey: (entry) => String(entry.number),
            getPrompt: (entry) => `${entry.hexagramLabel} corresponds to which planetary influence`,
            getAnswer: (entry) => normalizeOption(entry.planetaryInfluence)
          }
        ]
      },
      {
        entries: hexagramRows,
        variants: [
          {
            keyPrefix: "iching-upper-trigram",
            categoryId: "iching-trigrams",
            category: "I Ching Trigrams",
            getKey: (entry) => `${entry.number}-upper`,
            getPrompt: (entry) => `What is the upper trigram of ${entry.hexagramLabel}`,
            getAnswer: (entry) => entry.upperLabel
          },
          {
            keyPrefix: "iching-lower-trigram",
            categoryId: "iching-trigrams",
            category: "I Ching Trigrams",
            getKey: (entry) => `${entry.number}-lower`,
            getPrompt: (entry) => `What is the lower trigram of ${entry.hexagramLabel}`,
            getAnswer: (entry) => entry.lowerLabel
          }
        ]
      },
      {
        entries: tarotCorrespondenceRows,
        variants: [
          {
            keyPrefix: "iching-tarot-trigram",
            categoryId: "iching-tarot-correspondence",
            category: "I Ching ↔ Tarot",
            getKey: (entry) => entry.id,
            getPrompt: (entry) => `${entry.tarotLabel} corresponds to which I Ching trigram`,
            getAnswer: (entry) => entry.trigramLabel
          }
        ]
      }
    ];

    const templates = specGroups.flatMap((specGroup) => {
      if (Array.isArray(specGroup.variants) && specGroup.variants.length > 1) {
        return buildTemplatesFromVariants(specGroup);
      }

      const [variant] = specGroup.variants || [];
      return buildTemplatesFromSpec({
        entries: specGroup.entries,
        categoryId: variant?.categoryId,
        category: variant?.category,
        keyPrefix: variant?.keyPrefix,
        getKey: variant?.getKey,
        getPrompt: variant?.getPrompt,
        getAnswer: variant?.getAnswer
      });
    });
    const templatesByCategory = new Map();

    templates.forEach((template) => {
      if (!templatesByCategory.has(template.categoryId)) {
        templatesByCategory.set(template.categoryId, []);
      }
      templatesByCategory.get(template.categoryId).push(template);
    });

    cache.referenceData = referenceData;
    cache.magickDataset = magickDataset;
    cache.templates = templates;
    cache.templatesByCategory = templatesByCategory;

    return templates;
  }

  function buildConnectionTemplates(referenceData, magickDataset) {
    return buildAutomatedConnectionTemplates(referenceData, magickDataset).slice();
  }

  function registerConnectionQuizCategories() {
    const { registerQuizCategory } = window.QuizSectionUi || {};
    if (typeof registerQuizCategory !== "function") {
      return;
    }

    registerQuizCategory("quiz-connections", "Connection Quizzes", buildConnectionTemplates);
  }

  registerConnectionQuizCategories();

  window.QuizConnectionsPlugin = {
    registerConnectionQuizCategories,
    buildAutomatedConnectionTemplates,
    buildConnectionTemplates
  };
})();