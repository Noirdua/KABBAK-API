const fs = require("node:fs");
const path = require("node:path");
const { storageConfigRoot } = require("../config/paths");

const BASE_NAME = "overlay-background";
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

function overlayPaths() {
  return Object.values(MIME_TO_EXT).map((ext) => path.join(storageConfigRoot, `${BASE_NAME}${ext}`));
}

function findOverlayFile() {
  return overlayPaths().find((filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch (_error) {
      return false;
    }
  }) || "";
}

function clearOverlayFile() {
  overlayPaths().forEach((filePath) => {
    try { fs.unlinkSync(filePath); } catch (_error) {}
  });
}

function saveOverlayFromDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Upload a JPEG, PNG, WebP, or GIF image.");
  }
  const mime = match[1].toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    throw new Error("Unsupported image type. Use JPEG, PNG, WebP, or GIF.");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Image data is empty.");
  }
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error("Overlay image must be 8MB or smaller.");
  }
  fs.mkdirSync(storageConfigRoot, { recursive: true });
  clearOverlayFile();
  const dest = path.join(storageConfigRoot, `${BASE_NAME}${ext}`);
  fs.writeFileSync(dest, buffer);
  return {
    path: dest,
    mime,
    url: `/api/v1/branding/overlay?v=${Date.now()}`
  };
}

module.exports = {
  findOverlayFile,
  clearOverlayFile,
  saveOverlayFromDataUrl
};
