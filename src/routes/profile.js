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
  getProfilePage,
  getProfileImage,
  getJournalForViewer,
  listPostsForViewer,
  getProfileFeed,
  getProfileCalendarFeed,
  getProfileEvent,
  getProfileEventAttachment,
  getProfileFriends,
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
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  removeFriend,
  sendDirectoryMessage,
  sendFriendRequest,
  updateProfileQuickNote,
  updateProfileBio,
  updateProfileTagline,
  updateProfilePage,
  updateProfileImage,
  deleteProfileImage,
  updateProfileJournalVisibility,
  createProfilePost,
  listProfilePosts,
  deleteProfilePost,
  addPostItem,
  deletePostItem,
  addEvidenceToStore,
  listEvidenceStore,
  deleteEvidenceFromStore,
  updateProfilePost,
  addPostEntry,
  updatePostEntry,
  deletePostEntry,
  addPostComment,
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
const { getProfilePostShare, previewProfilePost } = require("../services/post-share-service");
const {
  getInbox,
  getInboxMessage,
  getInboxMessageAttachment,
  markAllInboxRead,
  markInboxRead
} = require("../services/inbox-service");
const { buildProfileCalendarEvents } = require("../services/calendar-feed-service");
const { appendReply } = require("../services/reply-store");
const { readManagedApiClients } = require("../services/api-client-registry");
const { resolveClientLimits } = require("../services/api-roles");
const {
  buildSharedDemoProfileSummary,
  createDemoPersonalDisabledError,
  isSharedDemoClientId
} = require("../lib/demo-client");

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
  if (error.code === "friend_not_found") {
    return createNotFoundError("friend_not_found", error.message);
  }
  if (error.code === "friend_request_not_found") {
    return createNotFoundError("friend_request_not_found", error.message);
  }
  if (error.code === "not_in_directory") {
    return createNotFoundError("not_in_directory", error.message);
  }
  if (error.code === "already_friends") {
    return createHttpError(409, "already_friends", error.message);
  }
  if (error.code === "friend_requests_limit_reached") {
    return createHttpError(409, "friend_requests_limit_reached", error.message);
  }
  if (error.code === "friends_limit_reached") {
    return createHttpError(409, "friends_limit_reached", error.message);
  }
  if (error.code === "image_not_found") {
    return createNotFoundError("image_not_found", error.message);
  }
  if (error.code === "journal_private") {
    return createHttpError(403, "journal_private", error.message);
  }
  if (error.code === "post_not_found") {
    return createNotFoundError("post_not_found", error.message);
  }
  if (error.code === "post_comments_limit_reached") {
    return createHttpError(409, "post_comments_limit_reached", error.message);
  }
  if (error.code === "post_item_not_found" || error.code === "post_evidence_not_found") {
    return createNotFoundError(error.code, error.message);
  }
  if (error.code === "post_entry_not_found") {
    return createNotFoundError("post_entry_not_found", error.message);
  }
  if (error.code === "post_entries_limit_reached") {
    return createHttpError(409, "post_entries_limit_reached", error.message);
  }
  if (error.code === "post_items_limit_reached" || error.code === "evidence_store_limit_reached") {
    return createHttpError(409, error.code, error.message);
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

  if (isSharedDemoClientId(auth.clientId) && !isDemoAllowedProfileRequest(request)) {
    next(createDemoPersonalDisabledError());
    return;
  }

  next();
});

function isDemoAllowedProfileRequest(request) {
  if (String(request.method || "").toUpperCase() !== "GET") {
    return false;
  }
  const remainder = String(request.url || request.path || "").split("?")[0].replace(/\/+$/, "");
  if (remainder === "" || remainder === "/" || remainder === "/profile") {
    return true;
  }
  const original = String(request.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  return /(?:^|\/)profile$/.test(original);
}

router.get("/profile", wrapProfileHandler((request, response) => {
  const clientId = getProfileClientId(request, response);
  const auth = response.locals?.auth || request.auth || {};
  const authName = String(auth.name || "").trim();
  if (isSharedDemoClientId(clientId)) {
    response.apiSuccess({
      ...buildSharedDemoProfileSummary(clientId),
      authName
    });
    return;
  }
  const summary = getProfileSummary(clientId, getProfileOptions(request, response));
  // The owner's own username/email (never returned for another user's profile).
  const account = require("../services/account-service").findAccountByClientId(clientId);
  response.apiSuccess({
    ...summary,
    authName,
    username: String(account?.username || ""),
    email: String(account?.email || ""),
    demo: false,
    personalFeatures: true
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

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function defaultCalendarDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

router.get("/profile/calendar-feed", wrapProfileHandler((request, response) => {
  const feed = getProfileCalendarFeed(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(feed);
}));

// The same subscription events the ICS feed produces, as JSON, so the in-app
// calendar can show what the user subscribed to.
router.get("/profile/calendar-events", wrapProfileHandler(async (request, response) => {
  const fromParam = String(request.query.from || "").trim();
  const toParam = String(request.query.to || "").trim();
  const fromIso = CALENDAR_DATE_PATTERN.test(fromParam) ? fromParam : defaultCalendarDay(-7);
  const toIso = CALENDAR_DATE_PATTERN.test(toParam) ? toParam : defaultCalendarDay(60);
  if (toIso < fromIso || (Date.parse(toIso) - Date.parse(fromIso)) > 400 * 24 * 60 * 60 * 1000) {
    throw createHttpError(400, "invalid_date_range", "Provide from/to dates spanning at most 400 days.");
  }
  const result = await buildProfileCalendarEvents(
    getProfileClientId(request, response),
    {
      fromIso,
      toIso,
      utcOffsetMinutes: request.query.utcOffsetMinutes,
      options: getProfileOptions(request, response)
    }
  );
  response.apiSuccess(result);
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

// --- Friends + directory social actions --------------------------------------

router.get("/profile/friends", wrapProfileHandler((request, response) => {
  const friends = getProfileFriends(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(friends);
}));

router.post("/profile/friends/requests", wrapProfileHandler((request, response) => {
  const result = sendFriendRequest(
    getProfileClientId(request, response),
    getRequestBody(request).clientId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "send_friend_request",
    status: result.status
  });

  response.status(201).apiSuccess(result);
}));

router.post("/profile/friends/requests/:clientId/accept", wrapProfileHandler((request, response) => {
  const result = acceptFriendRequest(
    getProfileClientId(request, response),
    request.params.clientId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "accept_friend_request",
    status: result.status
  });

  response.apiSuccess(result);
}));

router.post("/profile/friends/requests/:clientId/decline", wrapProfileHandler((request, response) => {
  const result = declineFriendRequest(
    getProfileClientId(request, response),
    request.params.clientId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "decline_friend_request",
    status: result.status
  });

  response.apiSuccess(result);
}));

router.delete("/profile/friends/requests/:clientId", wrapProfileHandler((request, response) => {
  const result = cancelFriendRequest(
    getProfileClientId(request, response),
    request.params.clientId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "cancel_friend_request",
    status: result.status
  });

  response.apiSuccess(result);
}));

router.delete("/profile/friends/:clientId", wrapProfileHandler((request, response) => {
  const result = removeFriend(
    getProfileClientId(request, response),
    request.params.clientId,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "remove_friend",
    status: result.status
  });

  response.apiSuccess(result);
}));

router.patch("/profile/journal-visibility", wrapProfileHandler((request, response) => {
  const result = updateProfileJournalVisibility(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_journal_visibility",
    visibility: result.visibility
  });

  response.apiSuccess({ visibility: result.visibility }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Share a journal entry as a feed post on the owner's profile.
router.post("/profile/posts", wrapProfileHandler((request, response) => {
  const result = createProfilePost(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "create_profile_post", postId: result.post.id });
  response.status(201).apiSuccess(result.post, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Render an unsaved post draft through the share page template (owner-only).
router.post("/profile/posts/preview", wrapProfileHandler((request, response) => {
  const result = previewProfilePost(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  response.apiSuccess({ html: result.html });
}));

// Combined feed: own shares plus friends' and public shares.
router.get("/profile/feed", wrapProfileHandler((request, response) => {
  const result = getProfileFeed(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(result);
}));

router.get("/profile/posts", wrapProfileHandler((request, response) => {
  const posts = listProfilePosts(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess({ count: posts.length, posts });
}));

// Share page for one of the owner's posts (empty path when no feed secret).
router.get("/profile/posts/:postId/share", wrapProfileHandler((request, response) => {
  const result = getProfilePostShare(
    getProfileClientId(request, response),
    request.params.postId,
    getProfileOptions(request, response)
  );
  response.apiSuccess(result);
}));

router.patch("/profile/posts/:postId", wrapProfileHandler((request, response) => {
  const result = updateProfilePost(
    getProfileClientId(request, response),
    request.params.postId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "update_profile_post", postId: result.post.id });
  response.apiSuccess(result.post, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Thread entries: prose blocks or evidence inserted anywhere in the post.
router.post("/profile/posts/:postId/entries", wrapProfileHandler((request, response) => {
  const result = addPostEntry(
    getProfileClientId(request, response),
    request.params.postId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "add_profile_post_entry", postId: request.params.postId, entryId: result.entry.id });
  response.status(201).apiSuccess({ entry: result.entry, entries: result.entries }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/posts/:postId/entries/:entryId", wrapProfileHandler((request, response) => {
  const result = updatePostEntry(
    getProfileClientId(request, response),
    request.params.postId,
    request.params.entryId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "update_profile_post_entry", postId: request.params.postId, entryId: request.params.entryId });
  response.apiSuccess({ entries: result.entries }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/posts/:postId/entries/:entryId", wrapProfileHandler((request, response) => {
  const result = deletePostEntry(
    getProfileClientId(request, response),
    request.params.postId,
    request.params.entryId,
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_profile_post_entry", postId: request.params.postId, entryId: request.params.entryId });
  response.apiSuccess({ removed: result.removed, entries: result.entries }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Evidence store: everything collected with "Add to post", ready to insert.
router.get("/profile/evidence", wrapProfileHandler((request, response) => {
  response.apiSuccess(listEvidenceStore(getProfileClientId(request, response), getProfileOptions(request, response)));
}));

router.post("/profile/evidence", wrapProfileHandler((request, response) => {
  const result = addEvidenceToStore(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "add_evidence_store", evidenceId: result.item.id });
  response.status(201).apiSuccess({ item: result.item, count: result.count }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/evidence/:evidenceId", wrapProfileHandler((request, response) => {
  const result = deleteEvidenceFromStore(
    getProfileClientId(request, response),
    request.params.evidenceId,
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_evidence_store", evidenceId: request.params.evidenceId });
  response.apiSuccess({ removed: result.removed, count: result.count }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.post("/profile/posts/:postId/items", wrapProfileHandler((request, response) => {
  const result = addPostItem(
    getProfileClientId(request, response),
    request.params.postId,
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "add_profile_post_item", postId: result.postId });
  response.status(201).apiSuccess({ item: result.item, evidenceCount: result.evidenceCount }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/posts/:postId/items/:itemId", wrapProfileHandler((request, response) => {
  const result = deletePostItem(
    getProfileClientId(request, response),
    request.params.postId,
    request.params.itemId,
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_profile_post_item", postId: request.params.postId, itemId: request.params.itemId });
  response.apiSuccess({ removed: result.removed, evidenceCount: result.evidenceCount }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/posts/:postId", wrapProfileHandler((request, response) => {
  const result = deleteProfilePost(
    getProfileClientId(request, response),
    request.params.postId,
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_profile_post" });
  response.apiSuccess({ removed: result.removed }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Another user's shared entries, following the same visibility as the journal.
router.get("/profile/directory/users/:clientId/posts", wrapProfileHandler((request, response) => {
  const result = listPostsForViewer(
    request.params.clientId,
    getProfileClientId(request, response),
    getProfileOptions(request, response)
  );
  response.apiSuccess(result);
}));

router.post("/profile/directory/users/:clientId/posts/:postId/comments", wrapProfileHandler((request, response) => {
  const result = addPostComment(
    request.params.clientId,
    request.params.postId,
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "comment_profile_post" });
  response.status(201).apiSuccess({ comment: result.comment }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

// Read another user's journal when their visibility setting allows it.
router.get("/profile/directory/users/:clientId/journal", wrapProfileHandler((request, response) => {
  const journal = getJournalForViewer(
    request.params.clientId,
    getProfileClientId(request, response),
    getProfileOptions(request, response)
  );
  response.apiSuccess(journal);
}));

router.post("/profile/directory/users/:clientId/message", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = sendDirectoryMessage(
    getProfileClientId(request, response),
    request.params.clientId,
    body,
    getProfileOptions(request, response)
  );

  emitProfileMutationAuditEvent(request, response, {
    action: "send_directory_message",
    messageId: result.message.id
  });

  response.status(201).apiSuccess(result);
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

function sendProfileImage(request, response, kind) {
  const image = getProfileImage(getProfileClientId(request, response), kind, getProfileOptions(request, response));
  const { type, buffer } = decodeAttachmentPayload(image);
  response.setHeader("Content-Type", type || "application/octet-stream");
  response.setHeader("Cache-Control", "private, max-age=60");
  response.send(buffer);
}

router.get("/profile/avatar", wrapProfileHandler((request, response) => {
  sendProfileImage(request, response, "avatar");
}));

router.put("/profile/avatar", wrapProfileHandler((request, response) => {
  const result = updateProfileImage(
    getProfileClientId(request, response),
    "avatar",
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "update_profile_avatar" });
  response.apiSuccess({ type: result.type, size: result.size }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/avatar", wrapProfileHandler((request, response) => {
  const result = deleteProfileImage(
    getProfileClientId(request, response),
    "avatar",
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_profile_avatar" });
  response.apiSuccess({ removed: true }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/banner", wrapProfileHandler((request, response) => {
  sendProfileImage(request, response, "banner");
}));

router.put("/profile/banner", wrapProfileHandler((request, response) => {
  const result = updateProfileImage(
    getProfileClientId(request, response),
    "banner",
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "update_profile_banner" });
  response.apiSuccess({ type: result.type, size: result.size }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.delete("/profile/banner", wrapProfileHandler((request, response) => {
  const result = deleteProfileImage(
    getProfileClientId(request, response),
    "banner",
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "delete_profile_banner" });
  response.apiSuccess({ removed: true }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.patch("/profile/tagline", wrapProfileHandler((request, response) => {
  const result = updateProfileTagline(
    getProfileClientId(request, response),
    getRequestBody(request),
    getProfileOptions(request, response)
  );
  emitProfileMutationAuditEvent(request, response, { action: "update_profile_tagline" });
  response.apiSuccess({ tagline: result.tagline }, {
    storageUsedBytes: result.usage.usedBytes,
    storageQuotaBytes: result.usage.quotaBytes
  });
}));

router.get("/profile/page", wrapProfileHandler((request, response) => {
  const page = getProfilePage(getProfileClientId(request, response), getProfileOptions(request, response));
  response.apiSuccess(page);
}));

router.patch("/profile/page", wrapProfileHandler((request, response) => {
  const body = getRequestBody(request);
  const result = updateProfilePage(getProfileClientId(request, response), body, getProfileOptions(request, response));

  emitProfileMutationAuditEvent(request, response, {
    action: "update_profile_page"
  });

  response.apiSuccess({ pageHtml: result.pageHtml }, {
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
