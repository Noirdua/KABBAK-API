const rateLimit = require("express-rate-limit");

const { createApiRouter } = require("../lib/create-api-router");
const { apiBasePath } = require("../config/service");
const { sendStoredAttachment } = require("../services/profile-service");
const {
  buildCalendarFeed,
  resolveFeedAttachment,
  resolveFeedNoteAttachment
} = require("../services/calendar-feed-service");

const router = createApiRouter();

// Public, pre-auth read-only ICS feed. Calendar apps cannot send API key
// headers, so the URL carries a per-profile feed token that can be rotated or
// disabled from the app.
const feedRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

function requestBase(request) {
  const protocol = request.protocol || "http";
  const host = request.get("host") || "";
  if (!host) {
    return { origin: "", baseUrl: "" };
  }
  const origin = `${protocol}://${host}`;
  return { origin, baseUrl: `${origin}${apiBasePath}` };
}

router.get("/calendar/feed.ics", feedRateLimiter, async (request, response) => {
  const token = String(request.query.token || "").trim();
  const layers = String(request.query.layers || "").trim();
  const notesFormat = String(request.query.notesFormat || "").trim();
  const utcOffsetMinutes = String(request.query.utcOffsetMinutes || "").trim();
  const base = requestBase(request);
  const body = token
    ? await buildCalendarFeed({
        token,
        layers,
        notesFormat,
        utcOffsetMinutes,
        baseUrl: base.baseUrl,
        origin: base.origin
      })
    : null;
  if (!body) {
    response.status(404).type("text/plain").send("Calendar feed not found.");
    return;
  }

  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.setHeader("Content-Disposition", 'inline; filename="kabbak.ics"');
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.send(body);
});

// Attachment bytes for the feed's linked images. Same token as the feed; the
// device fetches this when the user taps an attachment link.
router.get(
  "/calendar/feed/attachment/:eventId/:attachmentId",
  feedRateLimiter,
  (request, response) => {
    const token = String(request.query.token || "").trim();
    const attachment = token
      ? resolveFeedAttachment({
          token,
          eventId: request.params.eventId,
          attachmentId: request.params.attachmentId
        })
      : null;
    if (!attachment || !attachment.data) {
      response.status(404).type("text/plain").send("Attachment not found.");
      return;
    }

    sendStoredAttachment(response, attachment);
  }
);

// Attachment bytes for note/scene files linked from the notes layer.
router.get(
  "/calendar/feed/note-attachment/:noteId/:sceneId/:attachmentId",
  feedRateLimiter,
  (request, response) => {
    const token = String(request.query.token || "").trim();
    const attachment = token
      ? resolveFeedNoteAttachment({
          token,
          noteId: request.params.noteId,
          sceneId: request.params.sceneId,
          attachmentId: request.params.attachmentId
        })
      : null;
    if (!attachment || !attachment.data) {
      response.status(404).type("text/plain").send("Attachment not found.");
      return;
    }

    sendStoredAttachment(response, attachment);
  }
);

module.exports = router;
