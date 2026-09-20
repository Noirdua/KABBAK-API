const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const {
  addReply,
  createTopic,
  deleteReply,
  deleteTopic,
  getContributors,
  getTopic,
  listTopics,
  setPinned,
  updateReply,
  updateTopic
} = require("../services/board-service");
const { addReport } = require("../services/report-store");
const {
  addProfileMessage,
  getProfileBoardWatch,
  getProfileSummary,
  listTopicWatchers,
  updateProfileBoardWatch
} = require("../services/profile-service");
const { ADMIN_API_MANAGEMENT_CAPABILITY } = require("../middleware/api-client-capability");
const { rejectSharedDemoPersonalWrites } = require("../lib/demo-client");

// Internal community message board. Requires a valid API key and is never
// exposed publicly. Moderation is minimal: authors delete their own posts and
// admins can delete anything.
const router = createApiRouter();
router.use("/board", rejectSharedDemoPersonalWrites);

function getAuth(request, response) {
  const auth = response.locals?.auth || request.auth || {};
  if (auth.authenticated !== true || !String(auth.clientId || "").trim()) {
    throw createHttpError(401, "unauthorized", "A valid API key is required for the message board.");
  }
  return auth;
}

function isAdminAuth(auth) {
  const wantedRoles = ADMIN_API_MANAGEMENT_CAPABILITY.anyRoles.map((role) => String(role).toLowerCase());
  const wantedScopes = ADMIN_API_MANAGEMENT_CAPABILITY.anyScopes.map((scope) => String(scope).toLowerCase());
  const roles = (Array.isArray(auth?.roles) ? auth.roles : []).map((role) => String(role).toLowerCase());
  const scopes = (Array.isArray(auth?.scopes) ? auth.scopes : []).map((scope) => String(scope).toLowerCase());
  return roles.some((role) => wantedRoles.includes(role)) || scopes.some((scope) => wantedScopes.includes(scope));
}

function authorFor(auth) {
  let name = "";
  try {
    name = String(getProfileSummary(auth.clientId).displayName || "").trim();
  } catch (_error) {
    name = "";
  }
  return { clientId: auth.clientId, name: name || String(auth.clientId) };
}

function assertCanModify(auth, ownerClientId) {
  if (String(ownerClientId || "") === String(auth.clientId || "")) {
    return;
  }
  if (isAdminAuth(auth)) {
    return;
  }
  throw createHttpError(403, "not_post_author", "You can only change your own posts.");
}

function assertAdmin(auth) {
  if (isAdminAuth(auth)) {
    return;
  }
  throw createHttpError(403, "admin_required", "Only admins can pin topics.");
}

function mapBoardError(error) {
  if (error?.code === "topic_not_found") {
    return createNotFoundError("topic_not_found", error.message);
  }
  if (error?.code === "reply_not_found") {
    return createNotFoundError("reply_not_found", error.message);
  }
  if (error?.code === "invalid_post") {
    return createHttpError(400, "invalid_post", error.message);
  }
  return error;
}

router.get("/board/topics", (request, response) => {
  getAuth(request, response);
  const topics = listTopics();
  response.apiSuccess({ count: topics.length, topics });
});

router.get("/board/contributors", (request, response) => {
  getAuth(request, response);
  const contributors = getContributors({ limit: request.query.limit });
  response.apiSuccess({ count: contributors.length, contributors });
});

router.get("/board/topics/:topicId", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  response.apiSuccess({
    ...topic,
    watching: getProfileBoardWatch(auth.clientId).includes(topic.id)
  });
});

router.post("/board/topics", (request, response) => {
  const auth = getAuth(request, response);
  try {
    const topic = createTopic(request.body, authorFor(auth));
    response.status(201).apiSuccess(topic);
  } catch (error) {
    throw mapBoardError(error);
  }
});

router.delete("/board/topics/:topicId", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  assertCanModify(auth, topic.authorClientId);
  response.apiSuccess(deleteTopic(request.params.topicId));
});

// Flag a topic or reply for an admin to review.
router.post("/board/report", (request, response) => {
  const auth = getAuth(request, response);
  const topicId = String(request.body?.topicId || "").trim();
  const topic = getTopic(topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${topicId}' was not found.`);
  }
  const replyId = String(request.body?.replyId || "").trim();
  if (replyId && !topic.replies.some((reply) => reply.id === replyId)) {
    throw createNotFoundError("reply_not_found", `Reply '${replyId}' was not found.`);
  }
  try {
    const report = addReport(
      { topicId, replyId, topicTitle: topic.title, reason: request.body?.reason },
      authorFor(auth)
    );
    response.status(201).apiSuccess(report);
  } catch (error) {
    if (error?.code === "invalid_report") {
      throw createHttpError(400, "invalid_report", error.message);
    }
    throw error;
  }
});

router.patch("/board/topics/:topicId", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  assertCanModify(auth, topic.authorClientId);
  try {
    response.apiSuccess(updateTopic(request.params.topicId, request.body));
  } catch (error) {
    throw mapBoardError(error);
  }
});

// Admin-only pinning keeps important topics at the top of the list.
router.post("/board/topics/:topicId/pin", (request, response) => {
  const auth = getAuth(request, response);
  assertAdmin(auth);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  response.apiSuccess(setPinned(request.params.topicId, request.body?.pinned === true));
});

// Watchers get an inbox note when a topic they follow gets a reply.
function notifyTopicWatchers(topic, auth) {
  try {
    const lastReply = topic.replies[topic.replies.length - 1];
    const excerpt = String(lastReply?.body || "").slice(0, 200);
    const watchers = listTopicWatchers(topic.id).filter((clientId) => clientId && clientId !== auth.clientId);
    watchers.slice(0, 200).forEach((clientId) => {
      try {
        addProfileMessage(clientId, {
          kind: "report",
          title: `New reply in ${topic.title}`,
          description: excerpt,
          visibility: "internal"
        }, { sender: "Community" });
      } catch (_error) {
        // A single failed notification must not fail the reply.
      }
    });
  } catch (_error) {
    // Notifications are best-effort.
  }
}

router.post("/board/topics/:topicId/replies", (request, response) => {
  const auth = getAuth(request, response);
  try {
    const topic = addReply(request.params.topicId, request.body, authorFor(auth));
    notifyTopicWatchers(topic, auth);
    response.status(201).apiSuccess(topic);
  } catch (error) {
    throw mapBoardError(error);
  }
});

router.post("/board/topics/:topicId/watch", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  try {
    const result = updateProfileBoardWatch(auth.clientId, request.params.topicId, request.body?.watching === true);
    response.apiSuccess({ watching: result.watching });
  } catch (error) {
    if (error?.code === "invalid_watch") {
      throw createHttpError(400, "invalid_watch", error.message);
    }
    throw error;
  }
});

router.delete("/board/topics/:topicId/replies/:replyId", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  const reply = topic.replies.find((entry) => entry.id === String(request.params.replyId || "").trim());
  if (!reply) {
    throw createNotFoundError("reply_not_found", `Reply '${request.params.replyId}' was not found.`);
  }
  assertCanModify(auth, reply.authorClientId);
  response.apiSuccess(deleteReply(request.params.topicId, request.params.replyId));
});

router.patch("/board/topics/:topicId/replies/:replyId", (request, response) => {
  const auth = getAuth(request, response);
  const topic = getTopic(request.params.topicId);
  if (!topic) {
    throw createNotFoundError("topic_not_found", `Topic '${request.params.topicId}' was not found.`);
  }
  const reply = topic.replies.find((entry) => entry.id === String(request.params.replyId || "").trim());
  if (!reply) {
    throw createNotFoundError("reply_not_found", `Reply '${request.params.replyId}' was not found.`);
  }
  assertCanModify(auth, reply.authorClientId);
  try {
    response.apiSuccess(updateReply(request.params.topicId, request.params.replyId, request.body));
  } catch (error) {
    throw mapBoardError(error);
  }
});

module.exports = router;
