"use strict";

const { createHttpError } = require("./http-errors");

const DEMO_ID_PREFIX = "cli_demo";
const DEMO_PERSONAL_DISABLED_MESSAGE = "Shared demo accounts cannot use personal features. Create a trial account to keep a journal, friends, and a profile.";

function isSharedDemoClientId(clientId) {
  const id = String(clientId || "").trim();
  return id === DEMO_ID_PREFIX || id.startsWith(`${DEMO_ID_PREFIX}_`);
}

function createDemoPersonalDisabledError() {
  return createHttpError(403, "demo_personal_disabled", DEMO_PERSONAL_DISABLED_MESSAGE);
}

function buildSharedDemoProfileSummary(clientId) {
  return {
    clientId: String(clientId || "").trim(),
    createdAt: "",
    updatedAt: "",
    bio: "",
    tagline: "",
    hasPage: false,
    hasAvatar: false,
    hasBanner: false,
    journalVisibility: "private",
    displayName: "Demo",
    location: null,
    preferredDeck: "",
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
    directoryVisibility: "private",
    storage: {
      usedBytes: 0,
      quotaBytes: 0,
      quotaPercent: 0,
      jsonBytes: 0,
      attachmentsBytes: 0
    },
    counts: {
      notes: 0,
      events: 0,
      links: 0,
      messages: 0,
      friends: 0,
      posts: 0,
      quizAttempts: 0,
      attachments: 0
    },
    demo: true,
    personalFeatures: false
  };
}

function rejectSharedDemoPersonal(request, response, next) {
  if (request.method === "OPTIONS") {
    next();
    return;
  }
  const auth = response.locals?.auth || request.auth || {};
  if (!isSharedDemoClientId(auth.clientId)) {
    next();
    return;
  }
  next(createDemoPersonalDisabledError());
}

function rejectSharedDemoPersonalWrites(request, response, next) {
  if (request.method === "OPTIONS" || request.method === "GET" || request.method === "HEAD") {
    next();
    return;
  }
  rejectSharedDemoPersonal(request, response, next);
}

module.exports = {
  DEMO_ID_PREFIX,
  DEMO_PERSONAL_DISABLED_MESSAGE,
  buildSharedDemoProfileSummary,
  createDemoPersonalDisabledError,
  isSharedDemoClientId,
  rejectSharedDemoPersonal,
  rejectSharedDemoPersonalWrites
};
