"use strict";

const { isSessionPlayer } = require("./session-utils");

const WORDS = Object.freeze([
  "alchemy", "angel", "ankh", "arcana", "aries", "astral", "aurora",
  "binah", "caduceus", "chakra", "chalice", "cipher", "circle", "comet",
  "covenant", "crown", "crystal", "daemon", "decan", "dragon", "eclipse",
  "element", "elixir", "emperor", "empress", "enochian", "ether",
  "fool", "gemini", "golem", "grail", "hermes", "hexagram", "hierophant",
  "horus", "iching", "isis", "jupiter", "kabbalah", "kether", "lantern",
  "leo", "libra", "lotus", "magick", "malkuth", "mandala", "mercury",
  "mirror", "moon", "neptune", "oracle", "osiris", "ouroboros", "phoenix",
  "planet", "pluto", "priestess", "qabalah", "runes", "saturn", "scroll",
  "sephira", "serpent", "sigil", "solstice", "sphere", "spirit", "star",
  "sun", "sword", "talisman", "tarot", "temple", "teth", "thoth", "tiphereth",
  "tower", "tree", "trigram", "uranus", "venus", "vesica", "wand", "wheel",
  "wisdom", "yesod", "zodiac"
]);

const MAX_MISSES = 6;

function gameError(message, code = "invalid_move") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeLetter(value) {
  const letter = String(value || "").trim().toLowerCase();
  if (!/^[a-z]$/.test(letter)) {
    throw gameError("Guess a single letter A-Z.");
  }
  return letter;
}

function normalizeWord(value) {
  const word = String(value || "").trim().toLowerCase();
  if (!/^[a-z]{4,16}$/.test(word)) {
    throw gameError("A hangman word must be 4-16 letters.", "invalid_game");
  }
  return word;
}

function pickWord(settings, random = Math.random) {
  if (settings && settings.word) {
    return normalizeWord(settings.word);
  }
  const index = Math.max(0, Math.min(WORDS.length - 1, Math.floor(Number(random()) * WORDS.length)));
  return WORDS[index];
}

function patternFor(word, guessed) {
  const known = new Set(guessed);
  return [...word].map((letter) => (known.has(letter) ? letter : null));
}

function isRevealed(pattern) {
  return pattern.every(Boolean);
}

function createHangman({ settings = {}, random } = {}) {
  const word = pickWord(settings, random);
  const guessed = [];
  return {
    secret: { word },
    public: {
      length: word.length,
      pattern: patternFor(word, guessed),
      guessed,
      misses: 0,
      maxMisses: MAX_MISSES
    }
  };
}

function viewHangman(session, viewerId) {
  const pub = session.public || {};
  const finished = session.status === "finished";
  const isPlayer = isSessionPlayer(session, viewerId);
  return {
    length: pub.length,
    pattern: Array.isArray(pub.pattern) ? pub.pattern : [],
    guessed: Array.isArray(pub.guessed) ? pub.guessed : [],
    misses: Number(pub.misses) || 0,
    maxMisses: Number(pub.maxMisses) || MAX_MISSES,
    word: finished && isPlayer ? String(session.secret?.word || "") : undefined
  };
}

function moveHangman(session, playerId, move = {}) {
  if (session.status !== "active") {
    throw gameError("This game is not in play.");
  }
  if (String(session.currentClientId || "") !== String(playerId || "")) {
    throw gameError("It is not your turn.");
  }
  const word = String(session.secret?.word || "");
  const guessed = Array.isArray(session.public?.guessed) ? [...session.public.guessed] : [];
  const letter = normalizeLetter(move.letter);
  if (guessed.includes(letter)) {
    throw gameError("That letter was already guessed.");
  }
  guessed.push(letter);
  const hit = word.includes(letter);
  const misses = (Number(session.public?.misses) || 0) + (hit ? 0 : 1);
  const pattern = patternFor(word, guessed);
  const maxMisses = Number(session.public?.maxMisses) || MAX_MISSES;
  session.public = {
    length: word.length,
    pattern,
    guessed,
    misses,
    maxMisses
  };
  if (isRevealed(pattern)) {
    session.status = "finished";
    session.winnerClientId = playerId;
    session.result = "complete";
    session.currentClientId = "";
    return session;
  }
  if (misses >= maxMisses) {
    const opponent = playerId === session.hostClientId ? session.guestClientId : session.hostClientId;
    session.status = "finished";
    session.winnerClientId = opponent;
    session.result = "hanged";
    session.currentClientId = "";
    return session;
  }
  session.currentClientId = playerId === session.hostClientId ? session.guestClientId : session.hostClientId;
  return session;
}

module.exports = {
  WORDS,
  MAX_MISSES,
  createHangman,
  moveHangman,
  viewHangman
};
