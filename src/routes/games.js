"use strict";

const { createApiRouter } = require("../lib/create-api-router");
const { createHttpError, createNotFoundError } = require("../lib/http-errors");
const {
  acceptSession,
  createSession,
  declineSession,
  getSession,
  listGameTypes,
  listSessions,
  playMove
} = require("../services/game-service");
const { createDemoPersonalDisabledError, isSharedDemoClientId } = require("../lib/demo-client");

const router = createApiRouter();

function getAuth(request, response) {
  const auth = response.locals?.auth || request.auth || {};
  if (auth.authenticated !== true || !String(auth.clientId || "").trim()) {
    throw createHttpError(401, "unauthorized", "A valid API key is required to play games.");
  }
  return auth;
}

function isDemoAllowedGamesRequest(request) {
  if (String(request.method || "").toUpperCase() !== "GET") {
    return false;
  }
  const url = String(request.originalUrl || request.url || "").split("?")[0].replace(/\/+$/, "");
  return /\/games$/.test(url);
}

router.use("/games", (request, response, next) => {
  if (request.method === "OPTIONS") {
    next();
    return;
  }
  try {
    const auth = getAuth(request, response);
    if (isSharedDemoClientId(auth.clientId) && !isDemoAllowedGamesRequest(request)) {
      next(createDemoPersonalDisabledError());
      return;
    }
  } catch (error) {
    next(mapGameError(error));
    return;
  }
  next();
});

function mapGameError(error) {
  if (error?.code === "game_not_found") {
    return createNotFoundError("game_not_found", error.message);
  }
  if (error?.code === "not_game_player") {
    return createHttpError(403, "not_game_player", error.message);
  }
  if (error?.code === "not_in_directory") {
    return createNotFoundError("not_in_directory", error.message);
  }
  if (error?.code === "invalid_move" || error?.code === "invalid_game") {
    return createHttpError(400, error.code, error.message);
  }
  return error;
}

function wrap(handler) {
  return (request, response, next) => {
    try {
      const result = handler(request, response, next);
      Promise.resolve(result).catch((error) => next(mapGameError(error)));
    } catch (error) {
      next(mapGameError(error));
    }
  };
}

router.get("/games", wrap((request, response) => {
  getAuth(request, response);
  const games = listGameTypes();
  response.apiSuccess({ count: games.length, games });
}));

router.get("/games/sessions", wrap((request, response) => {
  const auth = getAuth(request, response);
  const sessions = listSessions(auth.clientId);
  response.apiSuccess({ count: sessions.length, sessions });
}));

router.get("/games/sessions/:sessionId", wrap((request, response) => {
  const auth = getAuth(request, response);
  response.apiSuccess(getSession(request.params.sessionId, auth.clientId));
}));

router.post("/games/sessions", wrap((request, response) => {
  const auth = getAuth(request, response);
  const body = request.body && typeof request.body === "object" ? request.body : {};
  // A player may not supply engine settings (e.g. a Hangman word); only the
  // match-up is taken from the request.
  const session = createSession(auth.clientId, {
    gameId: body.gameId,
    opponentClientId: body.opponentClientId ?? body.guestClientId
  });
  response.status(201).apiSuccess(session);
}));

router.post("/games/sessions/:sessionId/accept", wrap((request, response) => {
  const auth = getAuth(request, response);
  response.apiSuccess(acceptSession(request.params.sessionId, auth.clientId));
}));

router.post("/games/sessions/:sessionId/decline", wrap((request, response) => {
  const auth = getAuth(request, response);
  response.apiSuccess(declineSession(request.params.sessionId, auth.clientId));
}));

router.post("/games/sessions/:sessionId/moves", wrap((request, response) => {
  const auth = getAuth(request, response);
  response.apiSuccess(playMove(request.params.sessionId, auth.clientId, request.body || {}));
}));

module.exports = router;
