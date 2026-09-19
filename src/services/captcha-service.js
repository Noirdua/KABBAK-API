/* captcha-service.js — lightweight custom captcha.
 * The server signs a small arithmetic challenge (answer hash + expiry) with the
 * auth secret; the client posts the token back with its answer. No third-party
 * service and no server-side state. Email verification plus rate limiting are
 * the primary abuse controls; this just makes scripted signup a little harder. */
const crypto = require("node:crypto");

const { signToken, verifyToken } = require("./auth-secret");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function buildChoices(answer) {
  const choices = new Set([answer]);
  let guard = 0;
  while (choices.size < 4 && guard < 40) {
    guard += 1;
    const candidate = answer + randomInt(1, 9) * (crypto.randomInt(0, 1) === 0 ? -1 : 1);
    if (candidate >= 0) {
      choices.add(candidate);
    }
  }

  const list = [...choices];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index);
    [list[index], list[swap]] = [list[swap], list[index]];
  }
  return list;
}

function createChallenge() {
  let left = randomInt(2, 19);
  let right = randomInt(2, 19);
  let answer = left + right;
  let prompt = `What is ${left} + ${right}?`;

  if (crypto.randomInt(0, 1) === 1) {
    if (right > left) {
      [left, right] = [right, left];
    }
    answer = left - right;
    prompt = `What is ${left} − ${right}?`;
  }

  const id = crypto.randomBytes(8).toString("hex");
  const token = signToken({ id, purpose: "captcha", answerHash: sha256(answer) }, { ttlMs: CHALLENGE_TTL_MS });

  return {
    id,
    prompt,
    choices: buildChoices(answer),
    token,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
  };
}

function verifyChallenge({ token, answer } = {}) {
  const payload = verifyToken(token);
  if (!payload || payload.purpose !== "captcha") {
    return false;
  }
  const expected = Buffer.from(String(payload.answerHash || ""));
  const actual = Buffer.from(sha256(String(answer ?? "").trim()));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  CHALLENGE_TTL_MS,
  createChallenge,
  verifyChallenge
};
