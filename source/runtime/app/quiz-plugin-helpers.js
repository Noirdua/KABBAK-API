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

  function makeTemplate(key, categoryId, category, prompt, answer, pool) {
    const promptText = normalizeOption(prompt);
    const answerText = normalizeOption(answer);
    const optionPool = toUniqueOptionList(pool || []);

    if (!key || !categoryId || !category || !promptText || !answerText) {
      return null;
    }

    if (!optionPool.some((value) => normalizeKey(value) === normalizeKey(answerText))) {
      optionPool.push(answerText);
    }

    const distractorCount = optionPool.filter((value) => normalizeKey(value) !== normalizeKey(answerText)).length;
    if (distractorCount < 3) {
      return null;
    }

    return {
      key,
      categoryId,
      category,
      promptByDifficulty: promptText,
      answerByDifficulty: answerText,
      poolByDifficulty: optionPool
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
        return makeTemplate(
          `${keyPrefix}:${keyValue}`,
          categoryId,
          category,
          getPrompt(entry),
          getAnswer(entry),
          pool
        );
      })
      .filter(Boolean);
  }

  function buildTemplatesFromVariants(spec) {
    const variants = Array.isArray(spec?.variants) ? spec.variants : [];
    if (!variants.length) {
      return [];
    }

    return variants.flatMap((variant) => {
      const forwardTemplates = buildTemplatesFromSpec({
        entries: spec.entries,
        categoryId: variant.categoryId || spec.categoryId,
        category: variant.category || spec.category,
        keyPrefix: variant.keyPrefix || spec.keyPrefix,
        getKey: variant.getKey || spec.getKey,
        getPrompt: variant.getPrompt,
        getAnswer: variant.getAnswer
      });

      const inverse = variant.inverse;
      if (!inverse || typeof inverse.getPrompt !== "function" || typeof inverse.getAnswer !== "function") {
        return forwardTemplates;
      }

      const entries = Array.isArray(spec.entries) ? spec.entries : [];
      const rows = entries.filter((entry) => {
        const uniquenessValue = typeof inverse.getUniquenessKey === "function"
          ? inverse.getUniquenessKey(entry)
          : variant.getAnswer(entry);
        return normalizeOption(uniquenessValue) && normalizeOption(inverse.getAnswer(entry));
      });

      const occurrenceCountByKey = new Map();
      rows.forEach((entry) => {
        const uniquenessValue = typeof inverse.getUniquenessKey === "function"
          ? inverse.getUniquenessKey(entry)
          : variant.getAnswer(entry);
        const key = normalizeKey(uniquenessValue);
        occurrenceCountByKey.set(key, (occurrenceCountByKey.get(key) || 0) + 1);
      });

      const uniqueRows = rows.filter((entry) => {
        const uniquenessValue = typeof inverse.getUniquenessKey === "function"
          ? inverse.getUniquenessKey(entry)
          : variant.getAnswer(entry);
        return occurrenceCountByKey.get(normalizeKey(uniquenessValue)) === 1;
      });

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