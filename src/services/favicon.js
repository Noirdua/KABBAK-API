const fs = require("node:fs");
const path = require("node:path");
const { storageConfigRoot } = require("../config/paths");

const BASE_NAME = "favicon";
const MAX_BYTES = 2 * 1024 * 1024;
const MIME_TO_EXT = {
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg"
};
const EXT_TO_MIME = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
// Browsers report .ico inconsistently; fall back to the file extension.
const FUZZY_MIMES = new Set(["", "application/octet-stream", "application/x-ico", "text/plain"]);

function faviconPaths() {
  return Object.values(MIME_TO_EXT).map((ext) => path.join(storageConfigRoot, `${BASE_NAME}${ext}`));
}

function findFaviconFile() {
  return faviconPaths().find((filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch (_error) {
      return false;
    }
  }) || "";
}

function clearFaviconFile() {
  faviconPaths().forEach((filePath) => {
    try { fs.unlinkSync(filePath); } catch (_error) {}
  });
}

function resolveType(mime, fileName) {
  if (MIME_TO_EXT[mime]) {
    return { mime, ext: MIME_TO_EXT[mime] };
  }
  if (FUZZY_MIMES.has(mime)) {
    const ext = path.extname(String(fileName || "")).toLowerCase();
    if (EXT_TO_MIME[ext]) {
      return { mime: EXT_TO_MIME[ext], ext };
    }
  }
  return null;
}

function saveFaviconFromDataUrl(dataUrl, fileName = "") {
  const match = String(dataUrl || "").match(/^data:([^;,]*);base64,(.+)$/);
  if (!match) {
    throw new Error("Upload an .ico, PNG, SVG, WebP, GIF, or JPEG image.");
  }
  const type = resolveType(match[1].toLowerCase(), fileName);
  if (!type) {
    throw new Error("Unsupported image type. Use .ico, PNG, SVG, WebP, GIF, or JPEG.");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Image data is empty.");
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error("Favicon must be 2MB or smaller.");
  }
  fs.mkdirSync(storageConfigRoot, { recursive: true });
  clearFaviconFile();
  const dest = path.join(storageConfigRoot, `${BASE_NAME}${type.ext}`);
  fs.writeFileSync(dest, buffer);
  return {
    path: dest,
    mime: type.mime,
    url: `/api/v1/branding/favicon?v=${Date.now()}`
  };
}

module.exports = {
  findFaviconFile,
  clearFaviconFile,
  saveFaviconFromDataUrl
};
