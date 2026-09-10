const fs = require("fs/promises");
const path = require("path");
const vm = require("vm");

const { runtimeAppRoot } = require("../config/paths");

let tarotRuntimeCache = null;
let quizRuntimeCache = null;

async function evaluateScript(context, filePath) {
  const source = await fs.readFile(filePath, "utf8");
  vm.runInContext(source, context, { filename: filePath });
}

async function loadTarotRuntime() {
  if (tarotRuntimeCache) {
    return tarotRuntimeCache;
  }

  const sandbox = {
    console,
    window: {},
    Map,
    Set,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    RegExp
  };

  sandbox.window.window = sandbox.window;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const scriptPaths = [
    path.join(runtimeAppRoot, "tarot-database-builders.js"),
    path.join(runtimeAppRoot, "tarot-database-assembly.js"),
    path.join(runtimeAppRoot, "tarot-database.js"),
    path.join(runtimeAppRoot, "ui-tarot-relations.js")
  ];

  for (const scriptPath of scriptPaths) {
    await evaluateScript(context, scriptPath);
  }

  const tarotDatabase = context.window.TarotCardDatabase;
  const tarotRelationsUi = context.window.TarotRelationsUi;

  if (typeof tarotDatabase?.buildTarotDatabase !== "function") {
    throw new Error("Failed to load TarotCardDatabase runtime.");
  }

  if (
    typeof tarotRelationsUi?.buildMonthReferencesByCard !== "function"
    || typeof tarotRelationsUi?.buildCubeRelationsForCard !== "function"
    || typeof tarotRelationsUi?.buildIChingRelationsForCard !== "function"
    || typeof tarotRelationsUi?.buildCourtCardByDecanId !== "function"
    || typeof tarotRelationsUi?.buildSmallCardCourtLinkRelations !== "function"
  ) {
    throw new Error("Failed to load TarotRelationsUi runtime.");
  }

  tarotRuntimeCache = {
    buildTarotDatabase: tarotDatabase.buildTarotDatabase,
    buildMonthReferencesByCard: tarotRelationsUi.buildMonthReferencesByCard,
    buildCubeRelationsForCard: tarotRelationsUi.buildCubeRelationsForCard,
    buildIChingRelationsForCard: tarotRelationsUi.buildIChingRelationsForCard,
    buildCourtCardByDecanId: tarotRelationsUi.buildCourtCardByDecanId,
    buildSmallCardCourtLinkRelations: tarotRelationsUi.buildSmallCardCourtLinkRelations
  };

  return tarotRuntimeCache;
}

async function loadQuizRuntime() {
  if (quizRuntimeCache) {
    return quizRuntimeCache;
  }

  const sandbox = {
    console,
    window: {
      TarotCardImages: {
        getTarotCardDisplayName: (cardName) => String(cardName || "").trim()
      }
    },
    Map,
    Set,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    RegExp
  };

  sandbox.window.window = sandbox.window;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const scriptPaths = [
    path.join(runtimeAppRoot, "quiz-plugin-helpers.js"),
    path.join(runtimeAppRoot, "quiz-connections.js")
  ];

  for (const scriptPath of scriptPaths) {
    await evaluateScript(context, scriptPath);
  }

  const plugin = context.window.QuizConnectionsPlugin;
  if (typeof plugin?.buildConnectionTemplates !== "function") {
    throw new Error("Failed to load QuizConnectionsPlugin runtime.");
  }

  quizRuntimeCache = {
    buildConnectionTemplates: plugin.buildConnectionTemplates,
    buildAutomatedConnectionTemplates: plugin.buildAutomatedConnectionTemplates
  };

  return quizRuntimeCache;
}

function resetRuntimeCaches() {
  tarotRuntimeCache = null;
  quizRuntimeCache = null;
}

module.exports = {
  loadTarotRuntime,
  loadQuizRuntime,
  resetRuntimeCaches
};