"use strict";

const path = require("path");
const express = require("express");

const { createApiRouter } = require("../lib/create-api-router");
const {
  CONTENT_TYPE_BY_EXT,
  fontsRoot,
  loadFontCatalog,
  renderFontCss
} = require("../services/font-catalog");

const router = createApiRouter();

const fontStaticOptions = {
  etag: true,
  lastModified: true,
  maxAge: "30d",
  immutable: true,
  fallthrough: true,
  setHeaders(response, filePath) {
    const type = CONTENT_TYPE_BY_EXT[path.extname(filePath).toLowerCase()];
    if (type) {
      response.setHeader("Content-Type", type);
    }
  }
};

router.get("/fonts", (_request, response) => {
  response.set("Cache-Control", "no-cache");
  response.apiSuccess(loadFontCatalog());
});

router.get("/fonts.css", (_request, response) => {
  response.set("Content-Type", "text/css; charset=utf-8");
  response.set("Cache-Control", "no-cache");
  response.send(renderFontCss());
});

router.use("/assets/fonts", express.static(fontsRoot, fontStaticOptions));

module.exports = router;
