const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const fsSync = require("fs");

const {
  sourceTextImportRoot,
  sourceDataRoot,
  sourceDecksRoot,
  sourceRuntimeAppRoot,
  databasePath,
  dataRoot,
  deckRegistryPath,
  managedApiClientsPath,
  runtimeAppRoot,
  dlcRoot,
  decksImportRoot,
  textImportRoot
} = require("../config/paths");
const {
  getTextSourceDefinitions,
  getTextReferenceDefinitions
} = require("../config/text-sources");

const apiRoot = path.resolve(__dirname, "..", "..");
const migrationScriptPath = path.join(apiRoot, "scripts", "migrate-data-to-sqlite.js");

const runtimeFiles = [
  "tarot-database-builders.js",
  "tarot-database-assembly.js",
  "tarot-database.js",
  "ui-tarot-relations.js",
  "quiz-plugin-helpers.js",
  "quiz-connections.js"
];

const requiredStoragePaths = [
  databasePath,
  path.join(dataRoot, "MANIFEST.json"),
  deckRegistryPath,
  managedApiClientsPath,
  ...runtimeFiles.map((fileName) => path.join(runtimeAppRoot, fileName))
];

const STORAGE_STATUS_CACHE_TTL_MS = 120 * 1000;
let storageStatusCache = {
  expiresAtMs: 0,
  value: null,
  pendingPromise: null
};

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectLatestMtimeMs(targetPath, options = {}) {
  const stats = await fs.stat(targetPath);
  let latestMtimeMs = stats.mtimeMs;

  if (!stats.isDirectory()) {
    return latestMtimeMs;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    // Shallow mode stats only the top-level entries — enough to notice
    // content being added/removed without walking entire trees (the DLC
    // checkout and deck folders can contain thousands of files).
    if (options.shallow && entry.isDirectory()) {
      try {
        const childStats = await fs.stat(childPath);
        if (childStats.mtimeMs > latestMtimeMs) {
          latestMtimeMs = childStats.mtimeMs;
        }
      } catch (_error) {
        // Unreadable entry: ignore.
      }
      continue;
    }

    const childMtimeMs = await collectLatestMtimeMs(childPath, options);
    if (childMtimeMs > latestMtimeMs) {
      latestMtimeMs = childMtimeMs;
    }
  }

  return latestMtimeMs;
}

async function getSourceLatestMtimeMs() {
  const textSourceDefinitions = getTextSourceDefinitions();
  const textReferenceDefinitions = getTextReferenceDefinitions();
  const sourceTargets = [
    sourceDataRoot,
    sourceTextImportRoot,
    sourceDecksRoot,
    decksImportRoot,
    textImportRoot,
    dlcRoot,
    ...textSourceDefinitions.map((entry) => entry.filePath),
    ...textReferenceDefinitions.map((entry) => entry.filePath),
    ...runtimeFiles.map((fileName) => path.join(sourceRuntimeAppRoot, fileName))
  ];

  let latestMtimeMs = 0;
  for (const sourceTarget of sourceTargets) {
    const sourceExists = await pathExists(sourceTarget);
    if (!sourceExists) {
      continue;
    }

    // The DLC checkout can hold thousands of files; a top-level scan is enough
    // to detect repository updates without burning CPU on every status check.
    const isDlcRoot = path.resolve(sourceTarget) === path.resolve(dlcRoot);
    const currentMtimeMs = await collectLatestMtimeMs(sourceTarget, {
      shallow: isDlcRoot
    });
    if (currentMtimeMs > latestMtimeMs) {
      latestMtimeMs = currentMtimeMs;
    }
  }

  return latestMtimeMs;
}

async function resolveDatabasePath() {
  const markerPath = databasePath + ".active";
  try {
    const activePath = (await fs.readFile(markerPath, "utf8")).trim();
    if (activePath) {
      try {
        await fs.access(activePath);
        return activePath;
      } catch {}
    }
  } catch {}

  try {
    await fs.access(databasePath);
    return databasePath;
  } catch {
    return databasePath;
  }
}

async function computeStorageStatus() {
  const tmpDatabasePath = databasePath + ".tmp";
  const dbExists = await pathExists(databasePath);

  if (!dbExists && await pathExists(tmpDatabasePath)) {
    try {
      await fs.rename(tmpDatabasePath, databasePath);
      console.log("[storage] Recovered pending database from previous migration attempt.");
    } catch (renameError) {
      return {
        ready: false,
        reason: `Cannot recover pending database: ${renameError.message}.`
      };
    }
  }

  const resolvedDbPath = await resolveDatabasePath();

  for (const targetPath of requiredStoragePaths) {
    const checkPath = targetPath === databasePath ? resolvedDbPath : targetPath;
    if (!await pathExists(checkPath)) {
      return {
        ready: false,
        reason: `Missing storage path: ${checkPath}`
      };
    }
  }

  const [databaseStats, sourceLatestMtimeMs] = await Promise.all([
    fs.stat(resolvedDbPath),
    getSourceLatestMtimeMs()
  ]);

  if (sourceLatestMtimeMs > databaseStats.mtimeMs) {
    return {
      ready: false,
      reason: "Source project is newer than the API storage snapshot.",
      sourceLatestMtimeMs,
      snapshotMtimeMs: databaseStats.mtimeMs
    };
  }

  return {
    ready: true,
    sourceLatestMtimeMs,
    snapshotMtimeMs: databaseStats.mtimeMs
  };
}

async function getStorageStatus({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && storageStatusCache.value && storageStatusCache.expiresAtMs > nowMs) {
    return storageStatusCache.value;
  }

  if (!force && storageStatusCache.pendingPromise) {
    return storageStatusCache.pendingPromise;
  }

  const pendingPromise = computeStorageStatus()
    .then((status) => {
      storageStatusCache = {
        expiresAtMs: Date.now() + STORAGE_STATUS_CACHE_TTL_MS,
        value: status,
        pendingPromise: null
      };
      return status;
    })
    .catch((error) => {
      storageStatusCache.pendingPromise = null;
      throw error;
    });

  storageStatusCache.pendingPromise = pendingPromise;
  return pendingPromise;
}

function relayOutput(logger, method, chunk) {
  const text = String(chunk || "").trimEnd();
  if (!text) {
    return;
  }

  text.split(/\r?\n/).forEach((line) => {
    logger[method](`[storage] ${line}`);
  });
}



async function runMigration(logger = console) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=4096", migrationScriptPath], {
      cwd: apiRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => relayOutput(logger, "log", chunk));
    child.stderr.on("data", (chunk) => relayOutput(logger, "error", chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Storage migration failed with exit code ${code}.`));
    });
  });
}

async function ensureStorageReady({ logger = console } = {}) {
  const status = await getStorageStatus();
  if (status.ready) {
    return status;
  }

  if (!require("./runtime-settings").getRuntimeSettings().autoMigrateEnabled) {
    throw new Error(`${status.reason} Run npm run migrate:data or enable KABBAK_AUTO_MIGRATE.`);
  }

  logger.log(`[storage] ${status.reason} Refreshing local storage snapshot...`);
  await runMigration(logger);

  const nextStatus = await getStorageStatus({ force: true });
  if (!nextStatus.ready) {
    throw new Error(`Storage snapshot is still not ready after migration: ${nextStatus.reason}`);
  }

  logger.log("[storage] Local storage snapshot is ready.");
  return nextStatus;
}

// --- Hot reload (DLC install/uninstall without a server restart) -------------

const hotReloadState = {
  state: "idle", // idle | running | done | error
  startedAt: "",
  finishedAt: "",
  message: ""
};

let hotReloadPromise = null;

function getHotReloadState() {
  return { ...hotReloadState };
}

async function runHotReload({ logger = console } = {}) {
  hotReloadState.state = "running";
  hotReloadState.startedAt = new Date().toISOString();
  hotReloadState.finishedAt = "";
  hotReloadState.message = "Refreshing storage snapshot…";

  try {
    // DLC install/uninstall stages content into imports/; the snapshot must be
    // rebuilt (not just cache-reset) or new decks/texts stay invisible until a
    // full restart. Always migrate so the freshly staged content is indexed.
    await runMigration(logger);
    const nextStatus = await getStorageStatus({ force: true });
    if (!nextStatus.ready) {
      throw new Error(`Storage snapshot is still not ready after migration: ${nextStatus.reason}`);
    }

    // Reopen the database and drop every in-memory cache so requests pick up
    // the freshly migrated snapshot without restarting the process.
    resetDataLoaderCaches();

    // Pick up any DLC plugins that contribute server routes (e.g. demo-users).
    try {
      require("./plugin-servers").reloadPluginServers({ log: (message) => logger.log(message) });
    } catch (_error) {
      // Best-effort: plugin server routes refresh on the next restart otherwise.
    }

    hotReloadState.state = "done";
    hotReloadState.finishedAt = new Date().toISOString();
    hotReloadState.message = "Storage refreshed. Changes are live.";
    logger.log("[storage] Hot reload complete.");
  } catch (error) {
    hotReloadState.state = "error";
    hotReloadState.finishedAt = new Date().toISOString();
    hotReloadState.message = String(error?.message || "Storage reload failed.");
    logger.error(`[storage] Hot reload failed: ${hotReloadState.message}`);
    throw error;
  }
}

function startBackgroundHotReload() {
  if (hotReloadPromise) {
    return hotReloadPromise;
  }
  hotReloadPromise = runHotReload().catch((error) => error).finally(() => {
    hotReloadPromise = null;
  });
  return hotReloadPromise;
}

// data-loader is required lazily so this module stays loadable during bootstrap.
function resetDataLoaderCaches() {
  try {
    const dataLoader = require("./data-loader");
    if (typeof dataLoader.resetCaches === "function") {
      dataLoader.resetCaches();
    }
  } catch (_error) {}
  try {
    require("./tarot-service").resetTarotContextCache?.();
  } catch (_error) {}
  try {
    require("./quiz-service").resetQuizTemplatesCache?.();
  } catch (_error) {}
  try {
    require("./browser-module-runtime").resetRuntimeCaches?.();
  } catch (_error) {}
}

module.exports = {
  ensureStorageReady,
  getHotReloadState,
  getStorageStatus,
  startBackgroundHotReload
};