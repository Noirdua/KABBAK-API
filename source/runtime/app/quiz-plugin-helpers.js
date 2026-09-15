/* quiz-plugin-helpers.js — Shared utilities for dynamic quiz plugins */
(function () {
  "use strict";

  function normalizeOption(value) {
    return String(value || "").trim();
  }

  function normalizeKey(value) {
    return normalizeOption(value).toLowerCase();
  }

  function toUniqueOptionList(values) {
    const seen = new Set();
    const unique = [];

    (values || []).forEach((value) => {
      const formatted = normalizeOption(value);
      if (!formatted) {
        return;
      }

      const key = normalizeKey(formatted);
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      unique.push(formatted);
    });

    return unique;
  }

  function buildTier(prompt, answer, pool) {
    const promptText = normalizeOption(prompt);
    const answerText = normalizeOption(answer);
    const optionPool = toUniqueOptionList(pool || []);

    if (!promptText || !answerText) {
      return null;
    }

    if (!optionPool.some((value) => normalizeKey(value) === normalizeKey(answerText))) {
      optionPool.push(answerText);
    }

    const distractorCount = optionPool.filter((value) => normalizeKey(value) !== normalizeKey(answerText)).length;
    if (distractorCount < 3) {
      return null;
    }

    return { prompt: promptText, answer: answerText, pool: optionPool };
  }

  // `hardOverride` (optional) is the harder form of the same relation — usually
  // the inverse question. Easy and normal share the base tier; hard uses the
  // override when it is valid, otherwise falls back to the base.
  function makeTemplate(key, categoryId, category, prompt, answer, pool, hardOverride) {
    if (!key || !categoryId || !category) {
      return null;
    }

    const base = buildTier(prompt, answer, pool);
    if (!base) {
      return null;
    }

    const hard = (hardOverride
      && buildTier(hardOverride.prompt, hardOverride.answer, hardOverride.pool))
      || base;

    return {
      key,
      categoryId,
      category,
      promptByDifficulty: { normal: base.prompt, hard: hard.prompt },
      answerByDifficulty: { normal: base.answer, hard: hard.answer },
      poolByDifficulty: { normal: base.pool, hard: hard.pool }
    };
  }

  function buildTemplatesFromSpec(spec) {
    const rows = Array.isArray(spec?.entries) ? spec.entries : [];
    const categoryId = normalizeOption(spec?.categoryId);
    const category = normalizeOption(spec?.category);
    const keyPrefix = normalizeOption(spec?.keyPrefix);
    const getPrompt = spec?.getPrompt;
    const getAnswer = spec?.getAnswer;
    const getKey = spec?.getKey;
    const getHardPrompt = spec?.getHardPrompt;
    const getHardAnswer = spec?.getHardAnswer;
    const hardPool = toUniqueOptionList(spec?.hardPool || []);

    if (!rows.length || !categoryId || !category || !keyPrefix) {
      return [];
    }

    if (typeof getPrompt !== "function" || typeof getAnswer !== "function") {
      return [];
    }

    const pool = toUniqueOptionList(rows.map((entry) => getAnswer(entry)).filter(Boolean));
    if (pool.length < 4) {
      return [];
    }

    return rows
      .map((entry, index) => {
        const keyValue = typeof getKey === "function" ? getKey(entry, index) : String(index);
        const hardAnswer = typeof getHardAnswer === "function" ? getHardAnswer(entry) : "";
        const hardOverride = (typeof getHardPrompt === "function" && normalizeOption(hardAnswer))
          ? { prompt: getHardPrompt(entry), answer: hardAnswer, pool: hardPool }
          : null;
        return makeTemplate(
          `${keyPrefix}:${keyValue}`,
          categoryId,
          category,
          getPrompt(entry),
          getAnswer(entry),
          pool,
          hardOverride
        );
      })
      .filter(Boolean);
  }

  function buildTemplatesFromVariants(spec) {
    const variants = Array.isArray(spec?.variants) ? spec.variants : [];
    if (!variants.length) {
      return [];
    }

    const entries = Array.isArray(spec?.entries) ? spec.entries : [];
    const uniquenessOf = (inverse, variant, entry) => {
      if (typeof inverse?.getUniquenessKey === "function") {
        return inverse.getUniquenessKey(entry);
      }
      return typeof variant?.getAnswer === "function" ? variant.getAnswer(entry) : "";
    };

    return variants.flatMap((variant) => {
      const inverse = variant.inverse;
      const hasInverse = Boolean(inverse)
        && typeof inverse?.getPrompt === "function"
        && typeof inverse?.getAnswer === "function";

      // Rows whose inverse answer is unique can ask the reverse question, which
      // becomes the "hard" tier of the forward template.
      let uniqueByKey = new Map();
      let uniqueRows = [];
      let inversePool = [];
      if (hasInverse) {
        const rows = entries.filter((entry) => {
          const uniquenessValue = uniquenessOf(inverse, variant, entry);
          return normalizeOption(uniquenessValue) && normalizeOption(inverse.getAnswer(entry));
        });
        const counts = new Map();
        rows.forEach((entry) => {
          const key = normalizeKey(uniquenessOf(inverse, variant, entry));
          counts.set(key, (counts.get(key) || 0) + 1);
        });
        uniqueRows = rows.filter((entry) => counts.get(normalizeKey(uniquenessOf(inverse, variant, entry))) === 1);
        uniqueRows.forEach((entry) => {
          uniqueByKey.set(normalizeKey(uniquenessOf(inverse, variant, entry)), entry);
        });
        inversePool = toUniqueOptionList(uniqueRows.map((entry) => inverse.getAnswer(entry)));
      }

      const forwardTemplates = buildTemplatesFromSpec({
        entries,
        categoryId: variant.categoryId || spec.categoryId,
        category: variant.category || spec.category,
        keyPrefix: variant.keyPrefix || spec.keyPrefix,
        getKey: variant.getKey || spec.getKey,
        getPrompt: variant.getPrompt,
        getAnswer: variant.getAnswer,
        getHardPrompt: hasInverse
          ? (entry) => {
              const target = uniqueByKey.get(normalizeKey(uniquenessOf(inverse, variant, entry)));
              return target ? inverse.getPrompt(target) : "";
            }
          : undefined,
        getHardAnswer: hasInverse
          ? (entry) => {
              const target = uniqueByKey.get(normalizeKey(uniquenessOf(inverse, variant, entry)));
              return target ? inverse.getAnswer(target) : "";
            }
          : undefined,
        hardPool: inversePool
      });

      if (!hasInverse) {
        return forwardTemplates;
      }

      const inverseTemplates = buildTemplatesFromSpec({
        entries: uniqueRows,
        categoryId: inverse.categoryId || variant.categoryId || spec.categoryId,
        category: inverse.category || variant.category || spec.category,
        keyPrefix: inverse.keyPrefix || `${variant.keyPrefix || spec.keyPrefix}-reverse`,
        getKey: inverse.getKey || variant.getKey || spec.getKey,
        getPrompt: inverse.getPrompt,
        getAnswer: inverse.getAnswer
      });

      return [...forwardTemplates, ...inverseTemplates];
    });
  }

  window.QuizPluginHelpers = {
    normalizeOption,
    normalizeKey,
    toUniqueOptionList,
    makeTemplate,
    buildTemplatesFromSpec,
    buildTemplatesFromVariants
  };
})();