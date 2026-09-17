"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");
const { createHangman, moveHangman, viewHangman } = require("./games/hangman");
const { isSessionPlayer } = require("./games/session-utils");
const {
  addProfileMessage,
  getProfileFriends,
  getProfileSummary
} = require("./profile-service");

const DEFAULT_GAMES_PATH = path.join(storageConfigRoot, "game-sessions.json");
const MAX_SESSIONS = 500;
const MAX_ACTIVE_PER_PLAYER = 20;

const builtinGames = new Map();
const pluginGames = new Map();
// Parsed store cache keyed by file path and stat identity, so a list/get does
// not re-parse the whole document on every request.
const storeCache = new Map();

function resolveGamesPath(options = {}) {
  return options.filePath || DEFAULT_GAMES_PATH;
}

function gameError(message, code = "invalid_game") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function summarizeGame(game) {
  return {
    id: game.id,
    title: game.title,
    description: game.description || "",
    builtin: game.builtin === true,
    plugin: game.plugin || "",
    minPlayers: game.minPlayers || 2,
    maxPlayers: game.maxPlayers || 2
  };
}

function registerGame(definition, { pluginName = "" } = {}) {
  const rawId = String(definition?.id || "").trim();
  if (!rawId) {
    throw gameError("A game id is required.");
  }
  if (typeof definition.create !== "function" || typeof definition.view !== "function" || typeof definition.move !== "function") {
    throw gameError("A game needs create, view, and move functions.");
  }
  const id = pluginName && !rawId.startsWith("plugin:") ? `plugin:${pluginName}:${rawId}` : rawId;
  const game = {
    id,
    title: String(definition.title || id).trim().slice(0, 80) || id,
    description: String(definition.description || "").trim().slice(0, 400),
    builtin: !pluginName,
    plugin: pluginName || "",
    minPlayers: 2,
    maxPlayers: 2,
    create: definition.create,
    view: definition.view,
    move: definition.move
  };
  (pluginName ? pluginGames : builtinGames).set(id, game);
  return summarizeGame(game);
}

function unregisterPluginGames(pluginName) {
  const prefix = String(pluginName || "").trim();
  if (!prefix) {
    pluginGames.clear();
    return;
  }
  for (const [id, game] of pluginGames) {
    if (game.plugin === prefix) {
      pluginGames.delete(id);
    }
  }
}

function getGame(gameId) {
  const id = String(gameId || "").trim();
  return builtinGames.get(id) || pluginGames.get(id) || null;
}

function listGameTypes() {
  return [...builtinGames.values(), ...pluginGames.values()].map(summarizeGame);
}

function readStore(options = {}) {
  const filePath = resolveGamesPath(options);
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return [];
  }
  const cached = storeCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.sessions;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    storeCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, sessions });
    return sessions;
  } catch (_error) {
    return [];
  }
}

function writeStore(sessions, options = {}) {
  const filePath = resolveGamesPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
  try {
    const stats = fs.statSync(filePath);
    storeCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, sessions });
  } catch (_error) {
    storeCache.delete(filePath);
  }
}

function playerName(clientId, options = {}) {
  try {
    return String(getProfileSummary(clientId, options).displayName || "").trim() || String(clientId);
  } catch (_error) {
    return String(clientId);
  }
}

// Returns the target's profile summary so callers can reuse it for the display
// name instead of reading the same profile twice.
function canChallenge(fromId, targetId, options = {}) {
  const target = getProfileSummary(targetId, options);
  if (String(target.directoryVisibility || "private") === "public") {
    return target;
  }
  const friends = getProfileFriends(fromId, options);
  if ((friends.friends || []).some((entry) => entry.clientId === targetId)) {
    return target;
  }
  throw gameError("You can only challenge public-directory users or friends.", "not_in_directory");
}

function notify(clientId, title, description, options = {}) {
  try {
    addProfileMessage(clientId, {
      kind: "message",
      title,
      description,
      visibility: "internal"
    }, { sender: "Games" }, {
      rootPath: options.rootPath,
      profilesRoot: options.profilesRoot,
      encryptionSecret: options.encryptionSecret
    });
  } catch (_error) {
    // Notifications are best-effort.
  }
}



function presentSession(session, viewerId, game) {
  const engine = game || getGame(session.gameId);
  let view = {};
  try {
    view = engine ? engine.view(session, viewerId) : { ...(session.public || {}) };
  } catch (_error) {
    view = { ...(session.public || {}) };
  }
  return {
    id: session.id,
    gameId: session.gameId,
    title: engine ? engine.title : session.gameId,
    status: session.status,
    hostClientId: session.hostClientId,
    hostName: session.hostName,
    guestClientId: session.guestClientId,
    guestName: session.guestName,
    currentClientId: session.currentClientId,
    winnerClientId: session.winnerClientId || "",
    result: session.result || "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    yourTurn: session.status === "active" && session.currentClientId === viewerId,
    view
  };
}

function countActiveFor(sessions, clientId) {
  return sessions.filter((session) => (
    isSessionPlayer(session, clientId)
    && (session.status === "pending" || session.status === "active")
  )).length;
}

function createSession(hostClientId, input = {}, options = {}) {
  const hostId = String(hostClientId || "").trim();
  const guestId = String(input.opponentClientId || input.guestClientId || "").trim();
  if (!hostId) {
    throw gameError("A host is required.");
  }
  if (!guestId) {
    throw gameError("Choose an opponent.");
  }
  if (hostId === guestId) {
    throw gameError("You cannot challenge yourself.");
  }
  const game = getGame(input.gameId);
  if (!game) {
    throw gameError(`Unknown game '${input.gameId}'.`, "game_not_found");
  }
  const target = canChallenge(hostId, guestId, options);
  const sessions = readStore(options);
  if (countActiveFor(sessions, hostId) >= MAX_ACTIVE_PER_PLAYER || countActiveFor(sessions, guestId) >= MAX_ACTIVE_PER_PLAYER) {
    throw gameError("Too many games already in play.");
  }
  const existing = sessions.find((session) => (
    session.gameId === game.id
    && session.status === "pending"
    && session.hostClientId === hostId
    && session.guestClientId === guestId
  ));
  if (existing) {
    return presentSession(existing, hostId, game);
  }
  const nowIso = new Date().toISOString();
  const seeded = game.create({
    hostClientId: hostId,
    guestClientId: guestId,
    players: [hostId, guestId],
    settings: input.settings && typeof input.settings === "object" ? input.settings : {}
  });
  const session = {
    id: `game_${crypto.randomBytes(6).toString("hex")}`,
    gameId: game.id,
    status: "pending",
    hostClientId: hostId,
    hostName: playerName(hostId, options),
    guestClientId: guestId,
    guestName: String(target.displayName || "").trim() || playerName(guestId, options),
    // Games decide who opens; default is the challenged player.
    firstClientId: seeded?.firstClientId || guestId,
    currentClientId: "",
    winnerClientId: "",
    result: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    secret: seeded?.secret && typeof seeded.secret === "object" ? seeded.secret : {},
    public: seeded?.public && typeof seeded.public === "object" ? seeded.public : {}
  };
  sessions.push(session);
  writeStore(sessions.slice(-MAX_SESSIONS), options);
  notify(guestId, `${session.hostName} challenged you to ${game.title}`, "Open Games to accept or decline.", options);
  return presentSession(session, hostId, game);
}

function listSessions(clientId, options = {}) {
  const id = String(clientId || "").trim();
  return readStore(options)
    .filter((session) => isSessionPlayer(session, id))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map((session) => presentSession(session, id));
}

function getSession(sessionId, clientId, options = {}) {
  const session = readStore(options).find((entry) => entry.id === String(sessionId || "").trim());
  if (!session) {
    throw gameError("That game was not found.", "game_not_found");
  }
  if (!isSessionPlayer(session, clientId)) {
    throw gameError("That game is not yours.", "not_game_player");
  }
  return presentSession(session, clientId);
}

function updateSession(sessionId, mutate, options = {}) {
  const sessions = readStore(options);
  const index = sessions.findIndex((entry) => entry.id === String(sessionId || "").trim());
  if (index === -1) {
    throw gameError("That game was not found.", "game_not_found");
  }
  const session = sessions[index];
  mutate(session);
  session.updatedAt = new Date().toISOString();
  sessions[index] = session;
  writeStore(sessions, options);
  return session;
}

function acceptSession(sessionId, clientId, options = {}) {
  const gameRef = { game: null };
  const session = updateSession(sessionId, (current) => {
    if (current.guestClientId !== clientId) {
      throw gameError("Only the challenged player can accept.", "not_game_player");
    }
    if (current.status !== "pending") {
      throw gameError("This challenge is no longer pending.");
    }
    const game = getGame(current.gameId);
    if (!game) {
      throw gameError("Unknown game.", "game_not_found");
    }
    gameRef.game = game;
    current.status = "active";
    current.currentClientId = current.firstClientId || current.guestClientId;
  }, options);
  const opens = (session.firstClientId || session.guestClientId) === session.hostClientId;
  notify(
    session.hostClientId,
    `${session.guestName} accepted your ${gameRef.game.title} challenge`,
    opens ? "Open Games — it is your turn." : "Open Games — it is their turn.",
    options
  );
  return presentSession(session, clientId, gameRef.game);
}

function declineSession(sessionId, clientId, options = {}) {
  const session = updateSession(sessionId, (current) => {
    if (current.guestClientId !== clientId) {
      throw gameError("Only the challenged player can decline.", "not_game_player");
    }
    if (current.status !== "pending") {
      throw gameError("This challenge is no longer pending.");
    }
    current.status = "declined";
    current.currentClientId = "";
  }, options);
  notify(session.hostClientId, `${session.guestName} declined your game`, "The challenge was cancelled.", options);
  return presentSession(session, clientId);
}

function playMove(sessionId, clientId, move, options = {}) {
  const gameRef = { game: null };
  const session = updateSession(sessionId, (current) => {
    if (!isSessionPlayer(current, clientId)) {
      throw gameError("That game is not yours.", "not_game_player");
    }
    const game = getGame(current.gameId);
    if (!game) {
      throw gameError("Unknown game.", "game_not_found");
    }
    gameRef.game = game;
    game.move(current, clientId, move && typeof move === "object" ? move : {});
  }, options);
  const game = gameRef.game;
  if (session.status === "finished") {
    const winner = session.winnerClientId === session.hostClientId ? session.hostName : session.guestName;
    const title = session.winnerClientId
      ? `${game.title}: ${winner} wins`
      : `${game.title} ended`;
    notify(session.hostClientId, title, "Open Games to see the result.", options);
    if (session.guestClientId !== session.hostClientId) {
      notify(session.guestClientId, title, "Open Games to see the result.", options);
    }
  } else if (session.currentClientId && session.currentClientId !== clientId) {
    notify(session.currentClientId, `Your turn in ${game.title}`, "Open Games to play.", options);
  }
  return presentSession(session, clientId, game);
}

registerGame({
  id: "hangman",
  title: "Hangman",
  description: "Take turns guessing letters. No clock — play when you can.",
  create: createHangman,
  view: viewHangman,
  move: moveHangman
});

module.exports = {
  acceptSession,
  createSession,
  declineSession,
  getGame,
  getSession,
  listGameTypes,
  listSessions,
  playMove,
  registerGame,
  unregisterPluginGames
};
