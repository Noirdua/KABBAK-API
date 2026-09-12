"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const { appendPluginLog, listInstalledPlugins, resolvePluginRoot } = require("./dlc-catalog");

// DLC plugins are normally browser-only. A plugin can opt into contributing
// Express routes by declaring a `server` entry in its manifest, e.g.
//   "server": { "entry": "server.js" }
// The entry must export `register(router, ctx)` (or be that function directly).
// Plugins are operator-installed code, so they are trusted, but we still keep
// the entry inside the plugin directory and isolate load failures.
let loadedServers = new Map();
let loadedAt = 0;

function apiRoot() {
  return path.resolve(__dirname, "..", "..");
}

function normalizeServerEntry(manifest) {
  const server = manifest?.server ?? manifest?.api ?? null;
  if (typeof server === "string") {
    return server.trim();
  }
  if (server && typeof server === "object" && typeof server.entry === "string") {
    return server.entry.trim();
  }
  return "";
}

function readManifest(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  } catch (_error) {
    return null;
  }
}

function buildContext(name, rootDir) {
  const root = apiRoot();
  return {
    name,
    rootDir,
    apiRoot: root,
    logger: console,
    log(level, message, details) {
      const LEVELS = new Set(["debug", "info", "warn", "error"]);
      let resolvedLevel = String(level || "info").toLowerCase();
      let text = message;
      let extra = details;
      if (!LEVELS.has(resolvedLevel)) {
        // log("message") or log("message", details)
        extra = message && typeof message === "object" ? message : details;
        text = level;
        resolvedLevel = "info";
      }
      const out = String(text == null ? "" : text);
      try {
        appendPluginLog(name, { level: resolvedLevel, message: out, details: extra });
      } catch (_error) {}
      const method = resolvedLevel === "error" ? "error" : (resolvedLevel === "warn" ? "warn" : "log");
      console[method](`[plugins:${name}] ${out}`);
    },
    createHttpError,
    createNotFoundError,
    // Trusted helper so a plugin can reuse the API's own services/middleware.
    requireApi(relativePath) {
      const resolved = path.resolve(root, String(relativePath || ""));
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Plugin server module path must stay inside the API root.");
      }
      return require(resolved);
    }
  };
}

function loadPluginServer(plugin, log) {
  const root = resolvePluginRoot(plugin.name);
  const manifest = readManifest(root.dir);
  const entry = normalizeServerEntry(manifest);
  if (!entry) {
    return null;
  }

  const pluginDir = path.resolve(root.dir);
  const entryPath = path.resolve(pluginDir, entry);
  if (entryPath !== pluginDir && !entryPath.startsWith(pluginDir + path.sep)) {
    log(`[plugins] refusing server entry outside plugin dir: ${plugin.name}`);
    return null;
  }
  if (!fs.existsSync(entryPath)) {
    log(`[plugins] server entry not found for ${plugin.name}: ${entry}`);
    return null;
  }

  try {
    const resolvedEntry = require.resolve(entryPath);
    delete require.cache[resolvedEntry];
    const mod = require(entryPath);
    const register = typeof mod === "function" ? mod : mod?.register;
    if (typeof register !== "function") {
      log(`[plugins] ${plugin.name} server entry does not export register().`);
      return null;
    }
    const router = express.Router();
    register(router, buildContext(plugin.name, root.dir));
    log(`[plugins] server routes loaded for ${plugin.name}.`);
    return router;
  } catch (error) {
    try {
      appendPluginLog(plugin.name, { level: "error", message: `failed to load server routes: ${error.message}` });
    } catch (_error) {}
    log(`[plugins] failed to load server routes for ${plugin.name}: ${error.message}`);
    return null;
  }
}

function reloadPluginServers({ log = () => {} } = {}) {
  loadedServers = new Map();
  loadedAt = Date.now();
  listInstalledPlugins().forEach((plugin) => {
    const router = loadPluginServer(plugin, log);
    if (router) {
      loadedServers.set(plugin.name, router);
    }
  });
  return [...loadedServers.keys()];
}

function getPluginServer(name) {
  if (!loadedAt) {
    reloadPluginServers({ log: () => {} });
  }
  return loadedServers.get(String(name || "")) || null;
}

function pluginServerHealth() {
  return {
    loaded: loadedAt > 0,
    plugins: [...loadedServers.keys()]
  };
}

function createPluginServerDispatch() {
  return (request, response, next) => {
    const name = String(request.params?.pluginName || "").trim();
    const router = getPluginServer(name);
    if (!router) {
      next(createNotFoundError("plugin_server_not_found", `No server routes for plugin '${name}'.`));
      return;
    }
    router(request, response, next);
  };
}

module.exports = {
  createPluginServerDispatch,
  getPluginServer,
  pluginServerHealth,
  reloadPluginServers
};
