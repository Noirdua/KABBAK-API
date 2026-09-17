"use strict";

// Shared session predicates for game engines and the game service, so
// ownership rules and hidden-state disclosure cannot drift apart.

function isSessionPlayer(session, clientId) {
  const id = String(clientId || "");
  if (!id) return false;
  return id === String(session?.hostClientId || "") || id === String(session?.guestClientId || "");
}

function opponentClientId(session, clientId) {
  const id = String(clientId || "");
  if (id === String(session?.hostClientId || "")) return String(session?.guestClientId || "");
  if (id === String(session?.guestClientId || "")) return String(session?.hostClientId || "");
  return "";
}

module.exports = { isSessionPlayer, opponentClientId };
