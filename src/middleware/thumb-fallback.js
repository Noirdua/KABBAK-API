"use strict";

const fs = require("fs");
const path = require("path");

function createThumbFallback(rootPath) {
  const root = path.resolve(rootPath);

  return function thumbFallback(request, response, next) {
    const relativeUrl = decodeURIComponent(String(request.path || "")).replace(/^\/+/, "");
    const match = relativeUrl.match(/^(.*\/)?thumbs\/(.+)$/i);
    if (!match) {
      next();
      return;
    }

    const prefix = match[1] || "";
    const rest = match[2];
    const fallback = path.resolve(root, prefix, rest);
    const relative = path.relative(root, fallback);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      next();
      return;
    }

    try {
      if (!fs.existsSync(fallback) || !fs.statSync(fallback).isFile()) {
        next();
        return;
      }
    } catch (_error) {
      next();
      return;
    }

    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(fallback);
  };
}

module.exports = {
  createThumbFallback
};
