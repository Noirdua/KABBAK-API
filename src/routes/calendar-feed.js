const rateLimit = require("express-rate-limit");

const { createApiRouter } = require("../lib/create-api-router");
const { buildCalendarFeed } = require("../services/calendar-feed-service");

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

router.get("/calendar/feed.ics", feedRateLimiter, async (request, response) => {
  const token = String(request.query.token || "").trim();
  const layers = String(request.query.layers || "").trim();
  const body = token ? await buildCalendarFeed({ token, layers }) : null;
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

module.exports = router;
