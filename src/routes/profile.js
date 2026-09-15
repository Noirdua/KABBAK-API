const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const { createLogWriter } = require("../lib/logger-utils");
const { sanitizeRequestUrl } = require("../lib/request-url");
const {
  ProfileStorageError,
  addProfileQuickNote,
  createProfileEvent,
  createProfileNote,
  deleteProfileEvent,
  deleteProfileNote,
  deleteProfileQuickNote,
  buildSharePath,
  createProfileLink,
  decodeAttachmentPayload,
  deleteProfileLink,
  getProfileBio,
  getProfileCalendarFeed,
  getProfileEvent,
  getProfileEventAttachment,
  getProfileLibrary,
  getProfileLink,
  listProfileLinks,
  updateProfileLink,
  getProfileNote,
  getProfilePluginState,
  getProfileQuizProgress,
  getProfileSummary,
  listProfileEvents,
  listProfileEventsInRange,
  listProfileNotes,
  listProfileQuickNotes,
  recordQuizAttempt,
  updateProfileQuickNote,
  updateProfileBio,
  updateProfileCalendarFeed,
  updateProfileDisplayName,
  updateProfileDirectory,
  updateProfileEvent,
  updateProfileLocation,
  updateProfileQuietHours,
  updateProfileLibrary,
  updateProfileNote,
  updateProfilePluginState,
  updateProfilePreferredDeck
} = require("../services/profile-service");
const {
  getInbox,
  getInboxMessage,
  getInboxMessageAttachment,
  markAllInboxRead,
  markInboxRead
} = require("../services/inbox-service");
const { appendReply } = require("../services/reply-store");
const { readManagedApiClients } = require("../services/api-client-registry");
const { resolveClientLimits } = require("../services/api-roles");

const router = createApiRouter();

function getProfileClientId(request, response) {
  const auth = response.locals?.auth || request.auth || {};
  return String(auth.clientId || "").trim();
}

const profileOptionsCache = new Map();

function getProfileOptions(request, response) {
  const nowMs = Date.now();
  const auth = response.locals?.auth || request.auth || {};
  const clientId = String(auth.clientId || "").trim();
  const cached = profileOptionsCache.get(clientId);
  if (cached?.value && cached.expiresAtMs > nowMs) {
    return cached.value;
  }

  const client = readManagedApiClients().find((entry) => entry.id === clientId) || null;
  const limits = resolveClientLimits(client);
  const options = {
    quotaBytes: limits.storageBytes,
    maxNotes: limits.notes,
    maxEvents: limits.events,
    maxAttachmentsPerScene: limits.attachmentsPerScene,
    maxAttachmentsPerEvent: limits.attachmentsPerScene,
    maxAttachmentBytes: limits.attachmentBytes
  };
  profileOptionsCache.set(clientId, {
    expiresAtMs: nowMs + 5000,
    value: options
  });
  return options;
}

function getRequestBody(request) {
  if (request.body == null) {
    return {};
  }

  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw createHttpError(400, "invalid_request_body", "Request body must be a JSON object.");
  }

  return request.body;
}

function mapProfileStorageError(error) {
  if (!(error instanceof ProfileStorageError)) {
    return error;
  }

  if (error.code === "note_not_found") {
    return createNotFoundError("note_not_found", error.message);
  }
  if (error.code === "quick_note_not_found") {
    return createNotFoundError("quick_note_not_found", error.message);
  }
  if (error.code === "event_not_found") {
    return createNotFoundError("event_not_found", error.message);
  }
  if (error.code === "quota_exceeded") {
    return createHttpError(413, "profile_quota_exceeded", error.message);
  }
  if (error.code === "notes_limit_reached") {
    return createHttpError(409, "notes_limit_reached", error.message);
  }
  if (error.code === "events_limit_reached") {
    return createHttpError(409, "events_limit_reached", error.message);
  }
  if (error.code === "attachment_not_found") {
    return createNotFoundError("attachment_not_found", error.message);
  }
  if (error.code === "attachments_limit_reached") {
    return createHttpError(409, "attachments_limit_reached", error.message);
  }
  if (error.code === "attachment_too_large") {
    return createHttpError(413, "attachment_too_large", error.message);
  }
  if (error.code === "link_not_found") {
    return createNotFoundError("link_not_found", error.message);
  }
  if (error.code === "links_limit_reached") {
    return createHttpError(409, "links_limit_reached", error.message);
  }

  return createHttpError(400, error.code || "invalid_profile_request", error.message);
}

function wrapProfileHandler(handler) {
  return function profileHandler(request, response, next) {
    try {
      const result = handler(request, response, next);
      Promise.resolve(result).catch((error) => next(mapProfileStorageError(error)));
    } catch (error) {
      next(mapProfileStorageError(error));
    }
  };
}

function emitProfileMutationAuditEvent(request, response, payload) {
  const writeLog = createLogWriter(request.app?.locals?.logger || console);
  if (!writeLog) {
    return;
  }

  const auth = response.locals?.auth || request.auth || {};
  writeLog(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "api_profile_mutation",
    requestId: response.locals?.requestId || request.id || "unknown",
    method: request.method,
    path: sanitizeRequestUrl(request.originalUrl),
    actorClientId: auth.clientId || "",
    ...payload
  }));
}

router.use("/profile", (request, response, next) => {
  if (request.method === "OPTIONS") {
    next();
    return;
  }

  const auth = response.locals?.auth || request.auth || {};
  if (auth.authenticated !== true || !String(auth.clientId || "").trim()) {
    next(createHttpError(401, "profile_requires_api_key", "A valid API key is required to access your profile."));
    return;
  }

  next();
});

router.get("/profile", wrapProfileHandler((request, response) => {
  const summary = getProfileSummary(getProfileClientId(request, response), getProfileOptions(request, response));
  const auth = response.locals?.auth || request.auth || {};
  response.apiSuccess({
    ...summary,
    authName: String(auth.name || "").trim()
  });
}));

router.get("/profile/notes", wrapProfileHandler((request, response) => {
  const notes = listProfileNotes(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess({
    count: notes.length,
    notes
  });
}));

// --- Quick notes -------------------------------------------------------------

router.get("/profile/quick-notes", wrapProfileHandler((request, response) => {
  const quickNotes = listProfileQuickNotes(
    getProfileClientId(request, response),
    getProfileOptions(request, response)
  );
  response.apiSuccess({
    count: quickNotes.length,
    quickNotes
  });
}));

router.post("/profile/quick-notes", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = addProfileQuickNote(
    getProfileClientId(request, response),
    body,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "create_quick_note",
    quickNoteId: result.quickNote.id
  });

  response.status(201).apiSuccess(
    { quickNote: result.quickNote, count: result.count },
    {
      storageUsedBytes: result.usage.usedBytes,
      storageQuotaBytes: result.usage.quotaBytes
    }
  );
}));

router.put("/profile/quick-notes/:quickNoteId", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfileQuickNote(
    getProfileClientId(request, response),
    String(request.params.quickNoteId || ""),
    body,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_quick_note",
    quickNoteId: result.quickNote.id
  });

  response.apiSuccess(
    { quickNote: result.quickNote, count: result.count },
    {
      storageUsedBytes: result.usage.usedBytes,
      storageQuotaBytes: result.usage.quotaBytes
    }
  );
}));

router.delete("/profile/quick-notes/:quickNoteId", wrapProfileHandler((request, response) => {
  const result = deleteProfileQuickNote(
    getProfileClientId(request, response),
    String(request.params.quickNoteId || ""),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "delete_quick_note",
    quickNoteId: String(request.params.quickNoteId || ""),
    removed: result.removed
  });

  response.apiSuccess(
    { removed: result.removed },
    {
      storageUsedBytes: result.usage.usedBytes,
      storageQuotaBytes: result.usage.quotaBytes
    }
  );
}));

router.get("/profile/notes/:noteId", wrapProfileHandler((request, response) => {
  const note = getProfileNote(
    getProfileClientId(request, response),
    request.params.noteId,
    getProfileOptions(request, response)
  );
  response.apiSuccess(note);
}));

router.post("/profile/notes", wrapProfileHandler((request, response) => {
  const result = createProfileNote(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "create_profile_note",
    targetNoteId: result.note.id
  });

  response.status(201).apiSuccess(result.note, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/notes/:noteId", wrapProfileHandler((request, response) => {
  const result = updateProfileNote(
    getProfileClientId(request, response),
    request.params.noteId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_note",
    targetNoteId: result.note.id
  });

  response.apiSuccess(result.note, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/notes/:noteId", wrapProfileHandler((request, response) => {
  const result = deleteProfileNote(
    getProfileClientId(request, response),
    request.params.noteId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "delete_profile_note",
    targetNoteId: request.params.noteId
  });

  response.apiSuccess({
    removed: result.removed
  }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// --- Calendar events ---------------------------------------------------------

router.get("/profile/events", wrapProfileHandler((request, response) => {
  const clientId = getProfileClientId(request, response);
  const options = getProfileOptions(request, response);
  const from = String(request.query.from || "").trim();
  const to = String(request.query.to || "").trim();
  const events = (from || to)
    ? listProfileEventsInRange(clientId, from, to, options)
    : listProfileEvents(clientId, options);
  response.apiSuccess({
    count: events.length,
    events
  });
}));

// --- Calendar subscription feed ----------------------------------------------

router.get("/profile/calendar-feed", wrapProfileHandler((request, response) => {
  const feed = getProfileCalendarFeed(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(feed);
}));

router.post("/profile/calendar-feed", wrapProfileHandler((request, response) => {
  const result = updateProfileCalendarFeed(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_calendar_feed",
    enabled: result.feed.enabled
  });

  response.apiSuccess(result.feed, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/events/:eventId", wrapProfileHandler((request, response) => {
  const event = getProfileEvent(
    getProfileClientId(request, response),
    request.params.eventId,
    getProfileOptions(request, response)
  );
  response.apiSuccess(event);
}));

router.get("/profile/events/:eventId/attachments/:attachmentId", wrapProfileHandler((request, response) => {
  const attachment = getProfileEventAttachment(
    getProfileClientId(request, response),
    request.params.eventId,
    request.params.attachmentId,
    getProfileOptions(request, response)
  );
  const { type, buffer } = decodeAttachmentPayload(attachment);
  response.setHeader("Content-Type", type || "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(attachment.name || "attachment")}"`
  );
  response.setHeader("Cache-Control", "private, max-age=300");
  response.send(buffer);
}));

router.post("/profile/events", wrapProfileHandler((request, response) => {
  const result = createProfileEvent(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "create_profile_event",
    targetEventId: result.event.id
  });

  response.status(201).apiSuccess(result.event, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/events/:eventId", wrapProfileHandler((request, response) => {
  const result = updateProfileEvent(
    getProfileClientId(request, response),
    request.params.eventId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_event",
    targetEventId: result.event.id
  });

  response.apiSuccess(result.event, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/events/:eventId", wrapProfileHandler((request, response) => {
  const result = deleteProfileEvent(
    getProfileClientId(request, response),
    request.params.eventId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "delete_profile_event",
    targetEventId: String(request.params.eventId || ""),
    removed: result.removed
  });

  response.apiSuccess({
    removed: result.removed
  }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// --- Share links -------------------------------------------------------------

router.get("/profile/links", wrapProfileHandler((request, response) => {
  const links = listProfileLinks(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess({ count: links.length, links });
}));

router.get("/profile/links/:linkId", wrapProfileHandler((request, response) => {
  const link = getProfileLink(
    getProfileClientId(request, response),
    request.params.linkId,
    getProfileOptions(request, response)
  );
  response.apiSuccess({ ...link, path: buildSharePath(link.token) });
}));

router.post("/profile/links", wrapProfileHandler((request, response) => {
  const result = createProfileLink(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "create_profile_link",
    targetLinkId: result.link.id
  });

  response.status(201).apiSuccess({ ...result.link, path: buildSharePath(result.link.token) }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/links/:linkId", wrapProfileHandler((request, response) => {
  const result = updateProfileLink(
    getProfileClientId(request, response),
    request.params.linkId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_link",
    targetLinkId: result.link.id
  });

  response.apiSuccess({ ...result.link, path: buildSharePath(result.link.token) }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/links/:linkId", wrapProfileHandler((request, response) => {
  const result = deleteProfileLink(
    getProfileClientId(request, response),
    request.params.linkId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "delete_profile_link",
    targetLinkId: String(request.params.linkId || ""),
    removed: result.removed
  });

  response.apiSuccess({ removed: result.removed }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// --- Inbox -------------------------------------------------------------------

router.get("/profile/inbox", wrapProfileHandler((request, response) => {
  const options = {
    ...getProfileOptions(request, response),
    kind: String(request.query.kind || "").trim(),
    scope: String(request.query.scope || "").trim(),
    unreadOnly: String(request.query.unread || "") === "1"
  };
  const inbox = getInbox(getProfileClientId(request, response), options);
  response.apiSuccess(inbox);
}));

router.post("/profile/inbox/:scope/:messageId/read", wrapProfileHandler((request, response) => {
  const result = markInboxRead(
    getProfileClientId(request, response),
    request.params.scope,
    request.params.messageId,
    getProfileOptions(request, response)
  );
  response.apiSuccess({ read: true, changed: result.changed });
}));

router.get("/profile/inbox/:scope/:messageId", wrapProfileHandler((request, response) => {
  const message = getInboxMessage(
    getProfileClientId(request, response),
    request.params.scope,
    request.params.messageId,
    getProfileOptions(request, response)
  );
  if (!message) {
    throw createNotFoundError("message_not_found", "Message not found in your inbox.");
  }
  response.apiSuccess(message);
}));

router.get("/profile/inbox/:scope/:messageId/attachments/:attachmentId", wrapProfileHandler((request, response) => {
  const attachment = getInboxMessageAttachment(
    getProfileClientId(request, response),
    request.params.scope,
    request.params.messageId,
    request.params.attachmentId,
    getProfileOptions(request, response)
  );
  if (!attachment || !attachment.data) {
    throw createNotFoundError("attachment_not_found", "Attachment not found.");
  }
  const { type, buffer } = decodeAttachmentPayload(attachment);
  response.setHeader("Content-Type", type || "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(attachment.name || "attachment")}"`
  );
  response.setHeader("Cache-Control", "private, max-age=300");
  response.send(buffer);
}));

router.post("/profile/inbox/:scope/:messageId/reply", wrapProfileHandler((request, response) => {
  const clientId = getProfileClientId(request, response);
  const options = getProfileOptions(request, response);
  const scope = String(request.params.scope || "").trim().toLowerCase();
  if (scope !== "broadcast" && scope !== "direct") {
    throw createHttpError(400, "invalid_scope", "Inbox scope must be 'broadcast' or 'direct'.");
  }
  const messageId = String(request.params.messageId || "").trim();
  const inbox = getInbox(clientId, options);
  const item = inbox.items.find((entry) => entry.scope === scope && entry.id === messageId);
  if (!item) {
    throw createNotFoundError("message_not_found", "Message not found in your inbox.");
  }
  const body = String(getRequestBody(request)?.body || "").trim();
  if (!body) {
    throw createHttpError(400, "empty_reply", "A reply body is required.");
  }
  const summary = getProfileSummary(clientId, options);
  const reply = appendReply({
    scope,
    messageId,
    messageTitle: item.title,
    fromClientId: clientId,
    fromName: String(summary.displayName || clientId).trim(),
    body
  });
  response.status(201).apiSuccess(reply);
}));

router.post("/profile/inbox/read-all", wrapProfileHandler((request, response) => {
  const result = markAllInboxRead(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess({ changed: result.changed });
}));

// --- Quiet hours -------------------------------------------------------------

router.get("/profile/quiet-hours", wrapProfileHandler((request, response) => {
  const summary = getProfileSummary(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(summary.quietHours);
}));

router.patch("/profile/quiet-hours", wrapProfileHandler((request, response) => {
  const result = updateProfileQuietHours(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_quiet_hours",
    enabled: result.quietHours.enabled
  });

  response.apiSuccess(result.quietHours, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// --- Public directory opt-in -------------------------------------------------

router.get("/profile/directory", wrapProfileHandler((request, response) => {
  const summary = getProfileSummary(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess({ visibility: summary.directoryVisibility });
}));

router.patch("/profile/directory", wrapProfileHandler((request, response) => {
  const result = updateProfileDirectory(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_directory",
    visibility: result.visibility
  });

  response.apiSuccess({ visibility: result.visibility }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/quiz-progress", wrapProfileHandler((request, response) => {
  const progress = getProfileQuizProgress(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(progress);
}));

router.post("/profile/quiz-progress", wrapProfileHandler((request, response) => {
  const result = recordQuizAttempt(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "record_quiz_attempt",
    targetAttemptId: result.attempt.id
  });

  response.status(201).apiSuccess(result.attempt, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/bio", wrapProfileHandler((request, response) => {
  const bioInfo = getProfileBio(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(bioInfo);
}));

router.patch("/profile/bio", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfileBio(getProfileClientId(request, response), body, getProfileOptions(request, response));

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_bio"
  });

  response.apiSuccess({ bio: result.bio }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/location", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfileLocation(getProfileClientId(request, response), body, getProfileOptions(request, response));

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_location"
  });

  response.apiSuccess({ location: result.location }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/preferred-deck", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfilePreferredDeck(getProfileClientId(request, response), body, getProfileOptions(request, response));

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_preferred_deck"
  });

  response.apiSuccess({ preferredDeck: result.preferredDeck }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/library", wrapProfileHandler((request, response) => {
  const library = getProfileLibrary(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(library);
}));

router.put("/profile/library", wrapProfileHandler((request, response) => {
  const result = updateProfileLibrary(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_library",
    bookmarkCount: result.library.bookmarks.length,
    noteCount: result.library.notes.length
  });

  response.apiSuccess(result.library, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/plugin-state/:pluginId", wrapProfileHandler((request, response) => {
  const result = getProfilePluginState(
    getProfileClientId(request, response),
    request.params.pluginId,
    getProfileOptions(request, response)
  );
  response.apiSuccess(result);
}));

router.put("/profile/plugin-state/:pluginId", wrapProfileHandler((request, response) => {
  const result = updateProfilePluginState(
    getProfileClientId(request, response),
    request.params.pluginId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_plugin_state",
    pluginId: result.pluginId
  });

  response.apiSuccess({
    pluginId: result.pluginId,
    state: result.state
  }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/display-name", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfileDisplayName(getProfileClientId(request, response), body, getProfileOptions(request, response));

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_display_name"
  });

  response.apiSuccess({ displayName: result.displayName }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

module.exports = router;
