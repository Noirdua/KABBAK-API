const {
  loadReferenceData,
  loadMagickDataset
} = require("./data-loader");
const { loadQuizRuntime } = require("./browser-module-runtime");
const { createHttpError } = require("../lib/http-errors");
const { createSeededRandom } = require("../lib/random");

let quizTemplatesCache = null;
let quizTemplatesGeneratedAt = 0;

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

function resolveDifficultyValue(valueByDifficulty, difficulty = "normal") {
  if (valueByDifficulty == null) {
    return "";
  }

  if (typeof valueByDifficulty !== "object" || Array.isArray(valueByDifficulty)) {
    return valueByDifficulty;
  }

  if (Object.prototype.hasOwnProperty.call(valueByDifficulty, difficulty)) {
    return valueByDifficulty[difficulty];
  }

  if (Object.prototype.hasOwnProperty.call(valueByDifficulty, "normal")) {
    return valueByDifficulty.normal;
  }

  if (Object.prototype.hasOwnProperty.call(valueByDifficulty, "easy")) {
    return valueByDifficulty.easy;
  }

  if (Object.prototype.hasOwnProperty.call(valueByDifficulty, "hard")) {
    return valueByDifficulty.hard;
  }

  return "";
}

function shuffle(list, random) {
  const clone = list.slice();
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1));
    [clone[index], clone[nextIndex]] = [clone[nextIndex], clone[index]];
  }
  return clone;
}

function pickMany(list, count, random) {
  if (!Array.isArray(list) || !list.length || count <= 0) {
    return [];
  }
  return shuffle(list, random).slice(0, Math.min(count, list.length));
}

function buildOptions(correctValue, poolValues, random) {
  const correct = normalizeOption(correctValue);
  if (!correct) {
    return null;
  }

  const uniquePool = toUniqueOptionList(poolValues || []);
  if (!uniquePool.some((value) => normalizeKey(value) === normalizeKey(correct))) {
    uniquePool.push(correct);
  }

  const distractors = uniquePool.filter((value) => normalizeKey(value) !== normalizeKey(correct));
  if (distractors.length < 3) {
    return null;
  }

  const selectedDistractors = pickMany(distractors, 3, random);
  const options = shuffle([correct, ...selectedDistractors], random);
  const correctIndex = options.findIndex((value) => normalizeKey(value) === normalizeKey(correct));

  if (correctIndex < 0 || options.length < 4) {
    return null;
  }

  return {
    options,
    correctIndex
  };
}

function instantiateQuestion(template, difficulty, random) {
  if (!template) {
    return null;
  }

  const prompt = String(resolveDifficultyValue(template.promptByDifficulty, difficulty) || "").trim();
  const answer = normalizeOption(resolveDifficultyValue(template.answerByDifficulty, difficulty));
  const pool = toUniqueOptionList(resolveDifficultyValue(template.poolByDifficulty, difficulty) || []);

  if (!prompt || !answer) {
    return null;
  }

  const built = buildOptions(answer, pool, random);
  if (!built) {
    return null;
  }

  return {
    key: template.key,
    categoryId: template.categoryId,
    category: template.category,
    difficulty,
    prompt,
    answer,
    options: built.options,
    correctIndex: built.correctIndex
  };
}

async function getQuizTemplates() {
  const now = Date.now();
  if (quizTemplatesCache && (now - quizTemplatesGeneratedAt < 30 * 60 * 1000)) {
    return quizTemplatesCache;
  }

  const [referenceData, magickDataset, quizRuntime] = await Promise.all([
    loadReferenceData(),
    loadMagickDataset(),
    loadQuizRuntime()
  ]);

  quizTemplatesCache = quizRuntime.buildConnectionTemplates(referenceData, magickDataset)
    .map((template) => ({ ...template }));
  quizTemplatesGeneratedAt = now;

  return quizTemplatesCache;
}

async function listQuizCategories() {
  const templates = await getQuizTemplates();
  const labelByCategoryId = new Map();

  templates.forEach((template) => {
    const categoryId = String(template?.categoryId || "").trim();
    const category = String(template?.category || "").trim();
    if (categoryId && category && !labelByCategoryId.has(categoryId)) {
      labelByCategoryId.set(categoryId, category);
    }
  });

  const countByCategoryId = new Map();
  templates.forEach((template) => {
    const categoryId = String(template?.categoryId || "").trim();
    if (categoryId) {
      countByCategoryId.set(categoryId, (countByCategoryId.get(categoryId) || 0) + 1);
    }
  });

  const categories = [...labelByCategoryId.entries()]
    .sort((left, right) => String(left[1]).localeCompare(String(right[1])))
    .map(([id, label]) => ({
      id,
      label,
      questionCount: countByCategoryId.get(id) || 0
    }));

  return {
    count: categories.length,
    categories
  };
}

async function listQuizTemplates(query = {}) {
  const templates = await getQuizTemplates();
  const categoryId = String(query.categoryId || "").trim();
  const filtered = categoryId
    ? templates.filter((template) => template.categoryId === categoryId)
    : templates;

  return {
    count: filtered.length,
    templates: filtered
  };
}

function normalizeDifficulty(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ["easy", "hard"].includes(raw) ? raw : "normal";
}

function scopedTemplates(templates, templateKey, categoryId) {
  if (templateKey) {
    return templates.filter((template) => template.key === templateKey);
  }
  if (categoryId) {
    return templates.filter((template) => template.categoryId === categoryId);
  }
  return templates;
}

// A whole round of questions in one call: distinct templates, shuffled, no
// answers attached (the client checks locally and records the attempt once).
async function getQuizSession(query = {}) {
  const templates = await getQuizTemplates();
  const categoryId = String(query.categoryId || "").trim();
  const templateKey = String(query.templateKey || "").trim();
  const difficulty = normalizeDifficulty(query.difficulty);
  const requested = Number(query.count);
  const count = Number.isFinite(requested) ? Math.max(1, Math.min(25, Math.trunc(requested))) : 5;
  const seed = String(query.seed || "").trim();
  const includeAnswer = String(query.includeAnswer || "").trim().toLowerCase() === "true";
  const random = seed ? createSeededRandom(seed) : Math.random;

  const scoped = scopedTemplates(templates, templateKey, categoryId);
  if (!scoped.length) {
    throw createHttpError(
      404,
      "quiz_template_not_found",
      templateKey
        ? `Unknown quiz template '${templateKey}'.`
        : (categoryId ? `Unknown or empty quiz category '${categoryId}'.` : "No quiz templates available.")
    );
  }

  const questions = [];
  for (const template of shuffle(scoped, random)) {
    if (questions.length >= count) {
      break;
    }
    const question = instantiateQuestion(template, difficulty, random);
    if (!question) {
      continue;
    }
    const entry = {
      key: question.key,
      categoryId: question.categoryId,
      category: question.category,
      difficulty: question.difficulty,
      prompt: question.prompt,
      options: question.options
    };
    if (includeAnswer) {
      entry.answer = question.answer;
      entry.correctIndex = question.correctIndex;
    }
    questions.push(entry);
  }

  if (!questions.length) {
    throw createHttpError(500, "quiz_generation_failed", "Unable to generate questions from the available templates.");
  }

  return {
    count: questions.length,
    difficulty,
    categoryId: categoryId || null,
    templateKey: templateKey || null,
    questions
  };
}

async function pullQuizQuestion(query = {}) {
  const templates = await getQuizTemplates();
  const categoryId = String(query.categoryId || "").trim();
  const templateKey = String(query.templateKey || "").trim();
  const difficulty = normalizeDifficulty(query.difficulty);
  const seed = String(query.seed || "").trim();
  const includeAnswer = String(query.includeAnswer || "").trim().toLowerCase() === "true";
  const random = seed ? createSeededRandom(seed) : Math.random;

  const scopedTemplates = templateKey
    ? templates.filter((template) => template.key === templateKey)
    : (categoryId
      ? templates.filter((template) => template.categoryId === categoryId)
      : templates);

  if (!scopedTemplates.length) {
    throw createHttpError(
      404,
      "quiz_template_not_found",
      templateKey
        ? `Unknown quiz template '${templateKey}'.`
        : (categoryId ? `Unknown or empty quiz category '${categoryId}'.` : "No quiz templates available.")
    );
  }

  const template = scopedTemplates[Math.floor(random() * scopedTemplates.length)] || null;
  const question = instantiateQuestion(template, difficulty, random);
  if (!question) {
    throw createHttpError(500, "quiz_generation_failed", "Unable to generate a quiz question from the available templates.");
  }

  return includeAnswer
    ? question
    : {
        key: question.key,
        categoryId: question.categoryId,
        category: question.category,
        difficulty: question.difficulty,
        prompt: question.prompt,
        options: question.options
      };
}

function resetQuizTemplatesCache() {
  quizTemplatesCache = null;
  quizTemplatesGeneratedAt = 0;
}

module.exports = {
  getQuizSession,
  listQuizCategories,
  listQuizTemplates,
  pullQuizQuestion,
  resetQuizTemplatesCache
};