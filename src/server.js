require("dotenv").config();

const http = require("http");
const { createApp } = require("./app");
const { appEnv } = require("./config/app-env");
const { apiBasePath, serviceName, serviceVersion } = require("./config/service");
const { ensureStorageReady, startBackgroundThumbnails } = require("./services/storage-bootstrap");
const { registerDigestJob } = require("./services/digest-service");
const { startScheduler } = require("./services/scheduler");
const { resolvePluginUploadLimit } = require("./services/dlc-catalog");
const { createCapturingLogger } = require("./services/log-capture");

function listen(server, { port, host }) {
  return new Promise((resolve, reject) => {
    function handleError(error) {
      server.off("listening", handleListening);
      reject(error);
    }

    function handleListening() {
      server.off("error", handleError);
      resolve(server);
    }

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

function createShutdownController(server, { logger = console, timeoutMs = 10_000 } = {}) {
  const sockets = new Set();
  let shutdownPromise = null;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  return async function shutdown(signal = "shutdown") {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    logger.log(`[api] Received ${signal}. Shutting down HTTP server...`);
    shutdownPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sockets.forEach((socket) => {
          socket.destroy();
        });
      }, timeoutMs);

      timeout.unref?.();
      server.close((error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    return shutdownPromise;
  };
}

async function startServer({ logger = console } = {}) {
  // Route all logs through the ring buffer so the Admin panel can show them.
  const activeLogger = createCapturingLogger(logger);

  await ensureStorageReady({ logger: activeLogger });

  // Load plugin servers once at startup so plugin routes and plugin-registered
  // games exist before the first request (lazy dispatch alone would hide them
  // from GET /games until a plugin route happened to be hit).
  try {
    require("./services/plugin-servers").reloadPluginServers({
      log: (message) => activeLogger.log(message)
    });
  } catch (error) {
    activeLogger.warn(`[api] Plugin server registration failed: ${error && error.message ? error.message : error}`);
  }

  const runtime = require("./services/runtime-settings").getRuntimeSettings();
  activeLogger.log(`[api] Request body limit: ${runtime.jsonBodyLimit} · plugin upload limit: ${Math.round(resolvePluginUploadLimit() / (1024 * 1024))}MB`);
  // Uploads travel as base64 (about 1.34x), so the body limit must exceed the
  // upload limit or large files will 413.
  const bodyLimitMatch = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(runtime.jsonBodyLimit || ""));
  if (bodyLimitMatch) {
    const bodyBytes = Number(bodyLimitMatch[1]) * Math.pow(1024, { b: 0, kb: 1, mb: 2, gb: 3 }[String(bodyLimitMatch[2] || "").toLowerCase()] ?? 0);
    if (bodyBytes < resolvePluginUploadLimit() * 1.4) {
      activeLogger.warn(`[api] WARNING: JSON body limit (${runtime.jsonBodyLimit}) is smaller than ~1.4x the plugin upload limit (${Math.round(resolvePluginUploadLimit() / (1024 * 1024))}MB) — larger uploads will fail with 413. Raise KABBAK_JSON_BODY_LIMIT or the Admin panel setting.`);
    }
  }
  if (runtime.allowedOrigins.length) {
    activeLogger.log(`[api] Allowed CORS origins: ${runtime.allowedOrigins.join(", ")}`);
  } else {
    activeLogger.log("[api] CORS: localhost only (set KABBAK_ALLOWED_ORIGINS for other origins)");
  }

  const app = createApp({ logger: activeLogger });
  const server = http.createServer(app);
  const shutdown = createShutdownController(server, { logger: activeLogger });

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await listen(server, { port: appEnv.port, host: appEnv.host });
  activeLogger.log(`[api] ${serviceName}@${serviceVersion} listening on http://${appEnv.host}:${appEnv.port}${apiBasePath}/health`);
  startBackgroundThumbnails({ logger: activeLogger });
  setTimeout(() => {
    require("./services/correspondence-store").ensureCorrespondenceStore()
      .then(() => require("./services/document-slices").warmDocumentSlices())
      .catch((error) => {
        activeLogger.warn(`[api] Correspondence index skipped: ${error && error.message ? error.message : error}`);
      });
    require("./services/gematria-service").warmDictionaryIndexes().catch(() => {});
  }, 60_000).unref();
  // One shared scheduler drives the nightly digest and any plugin jobs.
  startScheduler({ log: (message) => activeLogger.log(message) });
  registerDigestJob({ log: (message) => activeLogger.log(message) });

  return {
    app,
    server,
    shutdown
  };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer
};