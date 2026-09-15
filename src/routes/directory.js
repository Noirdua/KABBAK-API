const rateLimit = require("express-rate-limit");

const { createApiRouter } = require("../lib/create-api-router");
const { listPublicDirectoryEntries } = require("../services/profile-service");

// Public, pre-auth directory of users who opted in from their profile settings.
const router = createApiRouter();

const directoryRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

router.get("/directory", directoryRateLimiter, (_request, response) => {
  const users = listPublicDirectoryEntries();
  response.apiSuccess({ count: users.length, users });
});

module.exports = router;
