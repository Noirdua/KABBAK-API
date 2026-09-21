/* account-service.js — self-serve trial accounts.
 *
 * KABBAK identity stays the API key. An account exists so a person can sign up
 * with a public username, a private email (for verification), and a password;
 * once the email is verified the account receives one trial API key and can sign
 * back in to retrieve it. Each account owns exactly one trial client, minted as
 * a hidden managed client with `expiresAt` so the trial ends on its own.
 *
 * Accounts live at storage/config/accounts.json as a JSON array. Passwords are
 * scrypt hashed. The raw verification code is never persisted (HMAC only) and
 * the raw API key is never stored here (it lives in the managed-client registry).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

const { accountsPath } = require("../config/paths");
const {
  getDefaultCapabilitiesForAccessLevel,
  normalizeAccessLevel
} = require("../config/api-access");
const { createHttpError } = require("../lib/http-errors");
const { writeFileAtomicSync } = require("../lib/atomic-file");
const { getAuthSecret, signToken, verifyToken } = require("./auth-secret");
const {
  generateManagedApiClientId,
  generateManagedApiClientKey,
  readManagedApiClients,
  removeManagedApiClient,
  rotateManagedApiClientKey,
  upsertManagedApiClient
} = require("./api-client-registry");

const ACCOUNT_ID_PREFIX = "acc_";
const ACCOUNT_ID_BYTES = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "kabbak", "support", "help",
  "moderator", "mod", "guest", "anonymous", "user", "null", "undefined", "me"
]);
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRIAL_DEFAULTS = Object.freeze({ days: 30, accessLevel: "premium" });
const VERIFICATION_TTL_MS = 30 * 60 * 1000;
const VERIFICATION_MAX_ATTEMPTS = 5;
const VERIFICATION_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// Admin panel edits are stored in runtime-settings and win over the env vars.
function runtimeValue(key) {
  try {
    return require("./runtime-settings").getRuntimeSettingValue(key);
  } catch (_error) {
    return undefined;
  }
}

function isSignupEnabled() {
  const runtime = runtimeValue("signupEnabled");
  if (typeof runtime === "boolean") {
    return runtime;
  }
  const raw = String(process.env.KABBAK_SIGNUP_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no"].includes(raw);
}

function getTrialPolicy() {
  const runtimeDays = Number(runtimeValue("trialDays"));
  const daysRaw = Number.isFinite(runtimeDays) && runtimeDays > 0
    ? runtimeDays
    : Number(String(process.env.KABBAK_TRIAL_DAYS ?? "").trim());
  const days = Number.isFinite(daysRaw) && daysRaw > 0
    ? Math.min(365, Math.floor(daysRaw))
    : TRIAL_DEFAULTS.days;

  let accessLevel = TRIAL_DEFAULTS.accessLevel;
  try {
    accessLevel = normalizeAccessLevel(
      runtimeValue("trialAccessLevel") || process.env.KABBAK_TRIAL_ACCESS_LEVEL || TRIAL_DEFAULTS.accessLevel
    );
  } catch (_error) {}

  return { days, accessLevel };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function assertEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function assertUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw createHttpError(400, "invalid_username", "Username must be 3-24 letters, numbers, or underscores.");
  }
  if (RESERVED_USERNAMES.has(normalizeUsername(username))) {
    throw createHttpError(400, "invalid_username", "That username is reserved. Choose another.");
  }
  return username;
}

function assertPassword(value) {
  const password = String(value || "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw createHttpError(400, "weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw createHttpError(400, "weak_password", "Password is too long.");
  }
  return password;
}

function scryptHash(password, salt, params = SCRYPT_PARAMS) {
  const N = Number(params?.N) || SCRYPT_PARAMS.N;
  const r = Number(params?.r) || SCRYPT_PARAMS.r;
  const p = Number(params?.p) || SCRYPT_PARAMS.p;
  const keylen = Number(params?.keylen) || SCRYPT_KEYLEN;
  return crypto.scryptSync(Buffer.from(String(password), "utf8"), salt, keylen, {
    N,
    r,
    p,
    maxmem: 256 * N * r
  });
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16);
  const hash = scryptHash(password, salt, { ...SCRYPT_PARAMS, keylen: SCRYPT_KEYLEN });
  return {
    algo: "scrypt",
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    keylen: SCRYPT_KEYLEN,
    salt: salt.toString("hex"),
    hash: hash.toString("hex")
  };
}

function verifyPasswordRecord(record, password) {
  if (!record || record.algo !== "scrypt" || !record.salt || !record.hash) {
    return false;
  }
  const expected = Buffer.from(String(record.hash), "hex");
  const actual = scryptHash(password, Buffer.from(String(record.salt), "hex"), record);
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashVerificationCode(accountId, code) {
  return crypto
    .createHmac("sha256", getAuthSecret())
    .update(`${accountId}:${String(code || "").trim()}`, "utf8")
    .digest("hex");
}

function generateVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function createVerificationRecord(accountId, code) {
  const now = Date.now();
  return {
    codeHash: hashVerificationCode(accountId, code),
    sentAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VERIFICATION_TTL_MS).toISOString(),
    attempts: 0
  };
}

function createVerificationLinkToken(accountId) {
  return signToken({ purpose: "email-verify", accountId }, { ttlMs: VERIFICATION_LINK_TTL_MS });
}

// Accounts created before usernames existed derive one from the email local
// part and count as verified, so they keep working.
function normalizeAccountRecord(account) {
  const next = { ...account };
  if (!next.username) {
    const local = String(next.email || "").split("@")[0].replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
    next.username = local || `user${String(next.id || "").slice(-6)}`;
  }
  next.usernameNormalized = normalizeUsername(next.usernameNormalized || next.username);
  if (typeof next.emailVerified !== "boolean") {
    next.emailVerified = true;
  }
  if (!next.status) {
    next.status = next.emailVerified ? "active" : "pending";
  }
  return next;
}

function readAccounts({ filePath = accountsPath } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((account) => account && typeof account === "object").map(normalizeAccountRecord)
      : [];
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function writeAccounts(accounts, { filePath = accountsPath } = {}) {
  writeFileAtomicSync(filePath, `${JSON.stringify(accounts, null, 2)}\n`);
  return accounts;
}

function generateAccountId(existingAccounts = []) {
  const taken = new Set(
    (Array.isArray(existingAccounts) ? existingAccounts : []).map((account) => account?.id).filter(Boolean)
  );
  let accountId = "";
  do {
    accountId = `${ACCOUNT_ID_PREFIX}${crypto.randomBytes(ACCOUNT_ID_BYTES).toString("hex")}`;
  } while (taken.has(accountId));
  return accountId;
}

// Public shape: never expose the email to clients.
function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    status: account.status || "active",
    emailVerified: account.emailVerified === true,
    createdAt: account.createdAt || "",
    lastLoginAt: account.lastLoginAt || "",
    trial: account.trial || null
  };
}

function findAccountByUsername(username, { filePath = accountsPath } = {}) {
  const normalizedUsername = normalizeUsername(username);
  return readAccounts({ filePath }).find((account) => account.usernameNormalized === normalizedUsername) || null;
}

function findAccountByEmail(email, { filePath = accountsPath } = {}) {
  const normalizedEmail = normalizeEmail(email);
  return readAccounts({ filePath }).find((account) => account.emailNormalized === normalizedEmail) || null;
}

function findAccountByIdentifier(identifier, { filePath = accountsPath } = {}) {
  const value = String(identifier || "").trim();
  if (!value) {
    return null;
  }
  return value.includes("@")
    ? findAccountByEmail(value, { filePath })
    : findAccountByUsername(value, { filePath });
}

function getAccountById(accountId, { filePath = accountsPath } = {}) {
  return readAccounts({ filePath }).find((account) => account.id === accountId) || null;
}

function updateAccount(accountId, patch, { filePath = accountsPath } = {}) {
  const accounts = readAccounts({ filePath });
  const index = accounts.findIndex((account) => account.id === accountId);
  if (index < 0) {
    return null;
  }
  const nextAccount = {
    ...accounts[index],
    ...patch,
    id: accounts[index].id,
    updatedAt: new Date().toISOString()
  };
  accounts[index] = nextAccount;
  writeAccounts(accounts, { filePath });
  return nextAccount;
}

function issueTrial(account, { filePath = accountsPath, clientsFilePath } = {}) {
  const policy = getTrialPolicy();
  const nowMs = Date.now();
  const existingClientId = account?.trial?.clientId || "";

  if (existingClientId) {
    const clients = readManagedApiClients({ filePath: clientsFilePath });
    const existingClient = clients.find((client) => client.id === existingClientId) || null;
    if (existingClient) {
      const expiresMs = Date.parse(existingClient.expiresAt || "");
      const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
      return {
        clientId: existingClient.id,
        apiKey: existingClient.key,
        accessLevel: existingClient.accessLevel,
        expiresAt: existingClient.expiresAt || "",
        active: !expired,
        reused: true
      };
    }
  }

  const clients = readManagedApiClients({ filePath: clientsFilePath });
  const clientId = generateManagedApiClientId(clients);
  const apiKey = generateManagedApiClientKey(clients);
  const expiresAt = new Date(nowMs + policy.days * MS_PER_DAY).toISOString();
  const capabilities = getDefaultCapabilitiesForAccessLevel(policy.accessLevel);

  upsertManagedApiClient({
    id: clientId,
    key: apiKey,
    name: account.username || account.id,
    accountId: account.id,
    accessLevel: policy.accessLevel,
    roles: capabilities.roles,
    scopes: capabilities.scopes,
    hidden: true,
    expiresAt
  }, { filePath: clientsFilePath });

  const trial = {
    clientId,
    accessLevel: policy.accessLevel,
    days: policy.days,
    startsAt: new Date(nowMs).toISOString(),
    expiresAt,
    issuedAt: new Date(nowMs).toISOString()
  };
  updateAccount(account.id, { trial }, { filePath });

  return {
    clientId,
    apiKey,
    accessLevel: policy.accessLevel,
    expiresAt,
    active: true,
    reused: false
  };
}

function signUp({ username, email, password, filePath = accountsPath } = {}) {
  const validUsername = assertUsername(username);
  const normalizedEmail = assertEmail(email);
  const validPassword = assertPassword(password);
  const normalizedUsername = normalizeUsername(validUsername);

  const accounts = readAccounts({ filePath });
  if (accounts.some((account) => account.usernameNormalized === normalizedUsername)) {
    throw createHttpError(409, "username_taken", "That username is taken. Try another.");
  }
  if (accounts.some((account) => account.emailNormalized === normalizedEmail)) {
    throw createHttpError(409, "email_taken", "An account already exists for that email. Try signing in instead.");
  }

  const now = new Date().toISOString();
  const accountId = generateAccountId(accounts);
  const code = generateVerificationCode();
  const account = {
    id: accountId,
    username: validUsername,
    usernameNormalized: normalizedUsername,
    email: String(email || "").trim(),
    emailNormalized: normalizedEmail,
    password: createPasswordRecord(validPassword),
    status: "pending",
    emailVerified: false,
    verification: createVerificationRecord(accountId, code),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
    trial: null
  };

  accounts.push(account);
  writeAccounts(accounts, { filePath });

  return {
    account: publicAccount(account),
    email: account.email,
    code,
    expiresAt: account.verification.expiresAt
  };
}

function resendVerification({ username, filePath = accountsPath } = {}) {
  const accounts = readAccounts({ filePath });
  const normalizedUsername = normalizeUsername(username);
  const index = accounts.findIndex((account) => account.usernameNormalized === normalizedUsername);
  if (index < 0) {
    throw createHttpError(404, "account_not_found", "No account with that username.");
  }
  if (accounts[index].emailVerified) {
    throw createHttpError(409, "already_verified", "That account is already verified. Just sign in.");
  }

  const code = generateVerificationCode();
  accounts[index] = {
    ...accounts[index],
    verification: createVerificationRecord(accounts[index].id, code),
    updatedAt: new Date().toISOString()
  };
  writeAccounts(accounts, { filePath });

  return {
    account: publicAccount(accounts[index]),
    email: accounts[index].email,
    code,
    expiresAt: accounts[index].verification.expiresAt
  };
}

// Forgot password: always report "sent" to avoid account enumeration; only an
// existing account actually gets a code.
function invalidResetCode() {
  return createHttpError(400, "invalid_code", "That code is not correct.");
}

// Operator/admin reset: set a new password without the emailed code. The caller
// is responsible for rotating the account's API key if it should be invalidated.
function setAccountPassword(accountId, password, { filePath = accountsPath } = {}) {
  const account = getAccountById(accountId, { filePath });
  if (!account) {
    return { updated: false };
  }
  const validPassword = assertPassword(password);
  updateAccount(accountId, {
    password: createPasswordRecord(validPassword),
    passwordReset: null
  }, { filePath });
  return {
    updated: true,
    account: publicAccount(getAccountById(accountId, { filePath }) || account)
  };
}

function requestPasswordReset({ identifier, filePath = accountsPath } = {}) {
  const account = findAccountByIdentifier(identifier, { filePath });
  if (!account) {
    return { found: false };
  }

  const existing = account.passwordReset;
  if (existing?.codeHash && Date.parse(existing.expiresAt || "") > Date.now()) {
    return { found: true, throttled: true };
  }

  const code = generateVerificationCode();
  updateAccount(account.id, {
    passwordReset: createVerificationRecord(account.id, code)
  }, { filePath });

  const updated = getAccountById(account.id, { filePath }) || account;
  return {
    found: true,
    account: publicAccount(updated),
    email: account.email,
    code,
    expiresAt: updated.passwordReset.expiresAt
  };
}

function resetPassword({ identifier, code, password, filePath = accountsPath, clientsFilePath } = {}) {
  const validPassword = assertPassword(password);
  const account = findAccountByIdentifier(identifier, { filePath });
  if (!account) {
    throw invalidResetCode();
  }

  const record = account.passwordReset;
  if (!record || !record.codeHash || Date.parse(record.expiresAt || "") <= Date.now()) {
    throw invalidResetCode();
  }
  if (Number(record.attempts || 0) >= VERIFICATION_MAX_ATTEMPTS) {
    throw createHttpError(429, "too_many_attempts", "Too many incorrect codes. Request a new one.");
  }

  const provided = hashVerificationCode(account.id, code);
  if (!timingSafeEqualHex(record.codeHash, provided)) {
    updateAccount(account.id, {
      passwordReset: { ...record, attempts: Number(record.attempts || 0) + 1 }
    }, { filePath });
    throw invalidResetCode();
  }

  let rotated = false;
  if (account.trial?.clientId) {
    rotateManagedApiClientKey(account.trial.clientId, { filePath: clientsFilePath });
    rotated = true;
  }

  updateAccount(account.id, {
    password: createPasswordRecord(validPassword),
    emailVerified: true,
    status: "active",
    passwordReset: null,
    verification: null
  }, { filePath });

  const updated = getAccountById(account.id, { filePath }) || account;
  const trial = issueTrial(updated, { filePath, clientsFilePath });
  return {
    account: publicAccount(getAccountById(account.id, { filePath }) || updated),
    trial,
    rotated
  };
}

function completeVerification(account, { filePath, clientsFilePath } = {}) {
  updateAccount(account.id, { emailVerified: true, status: "active", verification: null }, { filePath });
  const verified = getAccountById(account.id, { filePath }) || account;
  const trial = issueTrial(verified, { filePath, clientsFilePath });
  if (!trial.active) {
    throw createHttpError(403, "trial_expired", "This trial has ended. Contact the operator to continue.");
  }
  return {
    account: publicAccount(getAccountById(account.id, { filePath }) || verified),
    trial
  };
}

function verifyEmail({ username, code, filePath = accountsPath, clientsFilePath } = {}) {
  const account = findAccountByUsername(username, { filePath });
  if (!account) {
    throw createHttpError(404, "account_not_found", "No account with that username.");
  }

  if (account.emailVerified) {
    return completeVerification(account, { filePath, clientsFilePath });
  }

  const record = account.verification;
  if (!record || !record.codeHash) {
    throw createHttpError(400, "verification_expired", "Request a new verification code.");
  }
  if (Date.parse(record.expiresAt || "") <= Date.now()) {
    throw createHttpError(400, "verification_expired", "That code has expired. Request a new one.");
  }
  if (Number(record.attempts || 0) >= VERIFICATION_MAX_ATTEMPTS) {
    throw createHttpError(429, "too_many_attempts", "Too many incorrect codes. Request a new one.");
  }

  const provided = hashVerificationCode(account.id, code);
  if (!timingSafeEqualHex(record.codeHash, provided)) {
    updateAccount(account.id, {
      verification: { ...record, attempts: Number(record.attempts || 0) + 1 }
    }, { filePath });
    throw createHttpError(400, "invalid_code", "That code is not correct.");
  }

  return completeVerification(account, { filePath, clientsFilePath });
}

function verifyEmailByToken({ token, filePath = accountsPath, clientsFilePath } = {}) {
  const payload = verifyToken(token);
  if (!payload || payload.purpose !== "email-verify" || !payload.accountId) {
    throw createHttpError(400, "invalid_token", "This verification link is not valid.");
  }
  const account = getAccountById(payload.accountId, { filePath });
  if (!account) {
    throw createHttpError(404, "account_not_found", "This verification link is not valid.");
  }
  return completeVerification(account, { filePath, clientsFilePath });
}

function authenticate({ username, password, filePath = accountsPath } = {}) {
  const account = findAccountByUsername(username, { filePath });
  if (!account || !verifyPasswordRecord(account.password, String(password || ""))) {
    throw createHttpError(401, "invalid_credentials", "Username or password is incorrect.");
  }
  return account;
}

function login({ username, password, filePath = accountsPath, clientsFilePath } = {}) {
  const account = authenticate({ username, password, filePath });
  if (!account.emailVerified) {
    throw createHttpError(403, "email_not_verified", "Verify your email before signing in.");
  }

  const trial = issueTrial(account, { filePath, clientsFilePath });
  updateAccount(account.id, { lastLoginAt: new Date().toISOString() }, { filePath });

  if (!trial.active) {
    throw createHttpError(403, "trial_expired", "This trial has ended. Contact the operator to continue.");
  }

  return {
    account: publicAccount(getAccountById(account.id, { filePath }) || account),
    trial
  };
}

function trialPayload(result) {
  return {
    account: result.account,
    apiKey: result.trial.apiKey,
    clientId: result.trial.clientId,
    accessLevel: result.trial.accessLevel,
    expiresAt: result.trial.expiresAt
  };
}

function listAccounts({ filePath = accountsPath, clientsFilePath } = {}) {
  const clients = readManagedApiClients({ filePath: clientsFilePath });
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const nowMs = Date.now();

  return readAccounts({ filePath }).map((account) => {
    const client = account.trial?.clientId ? clientsById.get(account.trial.clientId) || null : null;
    const expiresMs = Date.parse(client?.expiresAt || "");
    return {
      ...publicAccount(account),
      email: account.email,
      trialActive: Boolean(client) && (!Number.isFinite(expiresMs) || expiresMs > nowMs),
      keyPresent: Boolean(client)
    };
  });
}

function removeAccount(accountId, { filePath = accountsPath, clientsFilePath } = {}) {
  const accounts = readAccounts({ filePath });
  const account = accounts.find((entry) => entry.id === accountId) || null;
  if (!account) {
    return { removed: false };
  }

  if (account.trial?.clientId) {
    try {
      removeManagedApiClient(account.trial.clientId, { filePath: clientsFilePath });
    } catch (_error) {}
  }

  writeAccounts(accounts.filter((entry) => entry.id !== accountId), { filePath });
  return { removed: true, account: publicAccount(account) };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  VERIFICATION_TTL_MS,
  getTrialPolicy,
  isSignupEnabled,
  normalizeEmail,
  normalizeUsername,
  createVerificationLinkToken,
  trialPayload,
  readAccounts,
  signUp,
  resendVerification,
  verifyEmail,
  verifyEmailByToken,
  requestPasswordReset,
  resetPassword,
  setAccountPassword,
  login,
  authenticate,
  issueTrial,
  findAccountByUsername,
  findAccountByEmail,
  findAccountByIdentifier,
  getAccountById,
  listAccounts,
  removeAccount,
  publicAccount,
  verifyPasswordRecord
};
