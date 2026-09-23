const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomicSync } = require("../lib/atomic-file");

const {
  profilesRoot,
  PROFILE_STORAGE_QUOTA_BYTES,
  MAX_NOTES_PER_PROFILE,
  MAX_NOTE_TITLE_LENGTH,
  MAX_QUIZ_ATTEMPTS_PER_PROFILE,
  MAX_SCENES_PER_NOTE,
  MAX_SCENE_TIME_LENGTH,
  MAX_SCENE_PLACE_LENGTH,
  MAX_SCENE_MOOD_LENGTH,
  MAX_SCENE_THOUGHTS_LENGTH,
  MAX_SCENE_NOTES_LENGTH,
  MAX_ATTACHMENTS_PER_SCENE,
  MAX_PROFILE_IMAGE_BYTES,
  MAX_QUICK_NOTES_PER_PROFILE,
  MAX_QUICK_NOTE_TEXT_LENGTH,
  MAX_QUICK_NOTE_SKY_LENGTH,
  MAX_EVENTS_PER_PROFILE,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_NOTES_LENGTH,
  MAX_EVENT_LOCATION_LENGTH,
  MAX_EVENT_COLOR_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_EVENT_REMINDER_MINUTES,
  MAX_EVENT_SEGMENTS,
  MAX_ATTACHMENTS_PER_EVENT,
  MAX_EVENT_OCCURRENCE_OVERRIDES,
  MAX_EVENT_OCCURRENCES,
  MAX_LINKS_PER_PROFILE,
  MAX_ATTACHMENTS_PER_LINK,
  MAX_LINK_TITLE_LENGTH,
  MAX_LINK_DESCRIPTION_LENGTH,
  SHARE_TOKEN_PREFIX,
  MESSAGE_DIRECT_PREFIX,
  MAX_MESSAGES_PER_PROFILE,
  MAX_FRIENDS_PER_PROFILE,
  MAX_FRIEND_REQUESTS_PER_PROFILE,
  MAX_EVENT_RANGE_DAYS,
  FEED_TOKEN_PREFIX,
  CALENDAR_FEED_LAYERS,
  DEFAULT_CALENDAR_FEED_LAYERS,
  CALENDAR_MOON_PHASES,
  CALENDAR_ASTROLOGY_DETAILS,
  JOURNAL_VISIBILITY,
  DEFAULT_JOURNAL_VISIBILITY,
  MAX_TAGLINE_LENGTH,
  MAX_POSTS_PER_PROFILE,
  MAX_POST_COMMENTS,
  MAX_POST_BODY_LENGTH,
  MAX_POST_COMMENT_LENGTH,
  MAX_POST_TEXT_LENGTH,
  MAX_POST_ITEMS,
  MAX_POST_ENTRIES
} = require("../config/profile-storage");
const { isSharedDemoClientId } = require("../lib/demo-client");

const {
  buildSignedShareToken,
  resolveSignedShareTokenContext
} = require("./share-service");
const { sanitizeMessageHtml, MAX_HTML_LENGTH } = require("../lib/html-sanitize");
const {
  NOTE_KINDS,
  dateFromIso,
  hasPostItemContent,
  isValidOccurredOn,
  noteToPlainText,
  normalizePostAttachments,
  normalizeStoredAttachment,
  normalizeStoredKind,
  normalizeStoredOccurredOn,
  normalizeStoredPostEntry,
  normalizeStoredPostItem,
  normalizeStoredPosts,
  plainTextFromHtml,
  presentPost,
  resolveAttachmentBytesLimit
} = require("./post-model");

class ProfileStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileStorageError";
    this.code = code;
  }
}

function resolveRootPath(options = {}) {
  return String(options.rootPath || options.profilesRoot || profilesRoot || "").trim();
}

function resolveQuotaBytes(options = {}) {
  const numericValue = Number(options.quotaBytes);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return PROFILE_STORAGE_QUOTA_BYTES;
}

function normalizeClientId(clientId) {
  const normalized = String(clientId || "").trim();
  if (!normalized) {
    throw new ProfileStorageError("invalid_client_id", "A client id is required.");
  }
  return normalized;
}

function getProfileFileName(clientId) {
  const normalized = normalizeClientId(clientId);
  const safePart = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "client";
  const hashPart = crypto.createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8);
  return `profile-${safePart}-${hashPart}.json`;
}

function getProfileFilePath(clientId, options = {}) {
  return path.join(resolveRootPath(options), getProfileFileName(clientId));
}

function createEmptyProfile(clientId) {
  const nowIso = new Date().toISOString();
  return {
    clientId,
    createdAt: nowIso,
    updatedAt: nowIso,
    bio: "",
    displayName: "",
    location: null,
    preferredDeck: "",
    notes: [],
    quickNotes: [],
    events: [],
    pluginState: {},
    library: { bookmarks: [], notes: [] },
    quiz: {
      attempts: []
    }
  };
}

function normalizeSceneTime(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = match[3] == null ? null : Number(match[3]);
    if (hours <= 23 && minutes <= 59 && (seconds == null || seconds <= 59)) {
      const hh = String(hours).padStart(2, "0");
      const mm = String(minutes).padStart(2, "0");
      return seconds == null ? `${hh}:${mm}` : `${hh}:${mm}:${String(seconds).padStart(2, "0")}`;
    }
  }

  return raw;
}

function normalizeStoredScene(scene, fallbackCreatedAt, options = {}) {
  const maxPerScene = resolveAttachmentsPerSceneLimit(options);
  const attachments = Array.isArray(scene.attachments)
    ? scene.attachments
        .filter((a) => a && typeof a === "object")
        .map((att) => normalizeStoredAttachment(att, options))
        .filter(Boolean)
        .slice(0, maxPerScene)
    : [];
  return {
    id: String(scene.id || `scene_${crypto.randomBytes(8).toString("hex")}`),
    time: normalizeSceneTime(scene.time || ""),
    endTime: normalizeSceneTime(scene.endTime || ""),
    place: String(scene.place || ""),
    scenario: String(scene.scenario || ""),
    mood: String(scene.mood || ""),
    emotion: String(scene.emotion || ""),
    atmosphere: String(scene.atmosphere || ""),
    steps: String(scene.steps || ""),
    thoughts: String(scene.thoughts || ""),
    notes: String(scene.notes || ""),
    attachments,
    createdAt: String(scene.createdAt || fallbackCreatedAt)
  };
}

function normalizeStoredNote(note, options = {}) {
  const nowIso = new Date().toISOString();
  const hasScenes = Array.isArray(note.scenes);
  const legacyBody = typeof note.body === "string" ? note.body : "";

  let scenes = hasScenes
    ? note.scenes
        .filter((scene) => scene && typeof scene === "object")
        .map((scene) => normalizeStoredScene(scene, note.createdAt || nowIso, options))
    : [{
        id: `scene_${crypto.randomBytes(8).toString("hex")}`,
        time: "",
        endTime: "",
        place: "",
        scenario: "",
        mood: "",
        emotion: "",
        atmosphere: "",
        steps: "",
        thoughts: "",
        notes: legacyBody,
        attachments: [],
        createdAt: note.createdAt || nowIso
      }];

  if (!scenes.length) {
    scenes = [{
      id: `scene_${crypto.randomBytes(8).toString("hex")}`,
      time: "",
      endTime: "",
        place: "",
        scenario: "",
        mood: "",
        emotion: "",
        atmosphere: "",
        steps: "",
        thoughts: "",
        notes: "",
        attachments: [],
        createdAt: nowIso
    }];
  }

  const createdAt = note.createdAt || nowIso;
  return {
    id: note.id,
    title: String(note.title || "").trim() || "Untitled",
    kind: normalizeStoredKind(note.kind),
    occurredOn: normalizeStoredOccurredOn(note.occurredOn, createdAt),
    sleptAt: normalizeSceneTime(note.sleptAt || ""),
    awokeAt: normalizeSceneTime(note.awokeAt || ""),
    scenes,
    createdAt,
    updatedAt: note.updatedAt || nowIso
  };
}

function normalizeStoredLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }
  const latitude = Number(location.latitude ?? location.lat);
  const longitude = Number(location.longitude ?? location.lng ?? location.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180) {
    return null;
  }
  const rawOffset = Number(location.utcOffsetMinutes);
  const utcOffsetMinutes = Number.isFinite(rawOffset) && rawOffset >= -720 && rawOffset <= 840
    ? Math.round(rawOffset)
    : null;
  return {
    latitude,
    longitude,
    label: String(location.label || "").trim().slice(0, 200),
    placeId: String(location.placeId || "").trim(),
    countryId: String(location.countryId || "").trim(),
    regionId: String(location.regionId || "").trim(),
    cityId: String(location.cityId || "").trim(),
    timeZone: normalizeTimeZoneId(location.timeZone),
    utcOffsetMinutes
  };
}

function normalizeProfile(rawProfile, clientId, options = {}) {
  const source = rawProfile && typeof rawProfile === "object" ? rawProfile : {};
  const nowIso = new Date().toISOString();
  const bio = String(source.bio || "").trim().slice(0, 2000);
  return {
    clientId,
    createdAt: String(source.createdAt || nowIso).trim() || nowIso,
    updatedAt: String(source.updatedAt || nowIso).trim() || nowIso,
    bio,
    displayName: String(source.displayName || "").trim().slice(0, 100),
    location: normalizeStoredLocation(source.location),
    preferredDeck: String(source.preferredDeck || "").trim().slice(0, 100),
    pluginState: normalizeStoredPluginState(source.pluginState),
    library: normalizeStoredLibrary(source.library),
    notes: Array.isArray(source.notes)
      ? source.notes.filter((note) => note && typeof note === "object").map((note) => normalizeStoredNote(note, options))
      : [],
    quickNotes: Array.isArray(source.quickNotes)
      ? source.quickNotes
          .filter((note) => note && typeof note === "object")
          .map((note) => normalizeQuickNote(note))
          .filter(Boolean)
          .slice(-MAX_QUICK_NOTES_PER_PROFILE)
      : [],
    events: Array.isArray(source.events)
      ? source.events
          .filter((event) => event && typeof event === "object")
          .map((event) => normalizeStoredEvent(event))
          .filter(Boolean)
          .slice(-MAX_EVENTS_PER_PROFILE)
      : [],
    // Only persisted once the profile actually uses the subscription feed, so
    // profiles that never touch it keep their stored shape (and quota) stable.
    ...(source.calendarFeed && typeof source.calendarFeed === "object"
      ? { calendarFeed: normalizeStoredCalendarFeed(source.calendarFeed) }
      : {}),
    ...(Array.isArray(source.links) ? { links: normalizeStoredLinks(source.links) } : {}),
    ...(Array.isArray(source.messages) ? { messages: normalizeStoredMessages(source.messages) } : {}),
    ...(source.inboxRead && typeof source.inboxRead === "object" && !Array.isArray(source.inboxRead)
      ? { inboxRead: normalizeInboxRead(source.inboxRead) }
      : {}),
    ...(source.quietHours && typeof source.quietHours === "object" && !Array.isArray(source.quietHours)
      ? { quietHours: normalizeStoredQuietHours(source.quietHours) }
      : {}),
    ...(typeof source.directoryVisibility === "string"
      ? { directoryVisibility: normalizeDirectoryVisibility(source.directoryVisibility, "private") }
      : {}),
    ...(typeof source.pageHtml === "string" ? { pageHtml: sanitizeMessageHtml(source.pageHtml) } : {}),
    ...(normalizeProfileImage(source.avatar) ? { avatar: normalizeProfileImage(source.avatar) } : {}),
    ...(normalizeProfileImage(source.banner) ? { banner: normalizeProfileImage(source.banner) } : {}),
    ...(source.journalVisibility !== undefined
      ? { journalVisibility: normalizeJournalVisibility(source.journalVisibility, DEFAULT_JOURNAL_VISIBILITY) }
      : {}),
    ...(Array.isArray(source.posts) ? { posts: normalizeStoredPosts(source.posts) } : {}),
    ...(Array.isArray(source.evidenceStore)
      ? { evidenceStore: source.evidenceStore.map(normalizeStoredPostItem).filter(Boolean).slice(0, MAX_POST_ITEMS) }
      : {}),
    ...(source.tagline !== undefined
      ? { tagline: String(source.tagline || "").trim().slice(0, MAX_TAGLINE_LENGTH) }
      : {}),
    ...(Array.isArray(source.boardWatch) ? { boardWatch: normalizeBoardWatch(source.boardWatch) } : {}),
    ...(source.friends !== undefined ? { friends: normalizeFriends(source.friends) } : {}),
    ...(source.friendRequests && typeof source.friendRequests === "object" && !Array.isArray(source.friendRequests)
      ? { friendRequests: normalizeFriendRequests(source.friendRequests) }
      : {}),
    quiz: {
      attempts: Array.isArray(source.quiz?.attempts) ? source.quiz.attempts.filter((attempt) => attempt && typeof attempt === "object") : []
    }
  };
}

function resolveProfileEncryptionSecret(options = {}) {
  const fromOpt = options.encryptionSecret;
  if (fromOpt != null) {
    return String(fromOpt).trim();
  }
  try {
    const { getProfileEncryptionSecret } = require("./runtime-settings");
    return getProfileEncryptionSecret();
  } catch {
    return "";
  }
}

const encryptionKeyCache = new Map();
const ENCRYPTION_KEY_CACHE_MAX = 64;

function getProfileEncryptionKey(clientId, secret) {
  if (!secret) return null;
  const cacheKey = `${clientId}\0${secret}`;
  const cached = encryptionKeyCache.get(cacheKey);
  if (cached) return cached;
  const key = crypto.scryptSync(secret, "kabbak-profile-v1:" + clientId, 32);
  encryptionKeyCache.set(cacheKey, key);
  if (encryptionKeyCache.size > ENCRYPTION_KEY_CACHE_MAX) {
    const oldest = encryptionKeyCache.keys().next().value;
    encryptionKeyCache.delete(oldest);
  }
  return key;
}

function encryptData(plainText, clientId, secret) {
  const key = getProfileEncryptionKey(clientId, secret);
  if (!key) {
    return plainText; // plaintext if no secret
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plainText, "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");
  return JSON.stringify({
    v: 1,
    clientId,
    iv: iv.toString("base64"),
    tag,
    data: encrypted
  });
}

function decryptData(maybeEncrypted, clientId, secret) {
  if (!maybeEncrypted || typeof maybeEncrypted !== "string") {
    return maybeEncrypted;
  }
  let parsed;
  try {
    parsed = JSON.parse(maybeEncrypted);
  } catch {
    return maybeEncrypted; // not json, assume plaintext
  }
  if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) {
    return maybeEncrypted; // plaintext or unknown format
  }
  const key = getProfileEncryptionKey(clientId, secret);
  if (!key) {
    throw new ProfileStorageError("encryption_required", "Profile data is encrypted but no encryption secret is configured.");
  }
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(parsed.data, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function readProfile(clientId, options = {}) {
  const filePath = getProfileFilePath(clientId, options);
  try {
    let rawValue = fs.readFileSync(filePath, "utf8").trim();
    const clientIdNorm = normalizeClientId(clientId);
    const secret = resolveProfileEncryptionSecret(options);
    let content = rawValue;
    if (secret) {
      try {
        content = decryptData(rawValue, clientIdNorm, secret);
      } catch (decErr) {
        if (decErr instanceof ProfileStorageError) {
          throw decErr;
        }
        throw new ProfileStorageError("decryption_failed", "Failed to decrypt profile data (wrong secret or corrupted).");
      }
    } else if (rawValue.includes('"iv"') && rawValue.includes('"tag"') && rawValue.includes('"data"')) {
      // Looks encrypted but no secret available
      throw new ProfileStorageError("encryption_required", "Profile is encrypted; set KABBAK_PROFILE_ENCRYPTION_SECRET to read it.");
    }
    return normalizeProfile(JSON.parse(content), clientIdNorm, options);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return createEmptyProfile(normalizeClientId(clientId));
    }
    throw error;
  }
}

// Bumped on every successful write so derived caches (e.g. the calendar feed)
// can key off the current revision instead of waiting out a TTL.
const profileWriteRevisions = new Map();

// Generic helper: every profile that exists on disk. Plugins use this to fan
// out daily reports without knowing the storage layout. Encrypted/unreadable
// profiles are skipped.
const storedProfileCache = new Map();
const STORED_PROFILE_CACHE_MAX = 200;

function clientIdFromProfileFileName(fileName) {
  const match = /^profile-(.+)-([0-9a-f]{8})\.json$/i.exec(fileName);
  if (!match) return "";
  const safePart = match[1];
  const hashPart = match[2].toLowerCase();
  const expected = crypto.createHash("sha1").update(safePart, "utf8").digest("hex").slice(0, 8);
  return expected === hashPart ? safePart : "";
}

function dropStoredProfileCache(filePath) {
  const prefix = `${filePath}\0`;
  for (const key of storedProfileCache.keys()) {
    if (key.startsWith(prefix)) storedProfileCache.delete(key);
  }
}

function readStoredProfileFile(fileName, options = {}) {
  if (!String(fileName).startsWith("profile-") || !String(fileName).endsWith(".json")) return null;
  const filePath = path.join(resolveRootPath(options), fileName);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_error) {
    return null;
  }
  const cacheKey = `${filePath}\0${stat.mtimeMs}\0${stat.size}`;
  if (storedProfileCache.has(cacheKey)) return storedProfileCache.get(cacheKey);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
  const encrypted = parsed && parsed.v === 1 && typeof parsed.data === "string";
  const clientId = String(parsed?.clientId || "").trim() || clientIdFromProfileFileName(fileName);
  if (!clientId) return null;
  let profile = null;
  try {
    profile = encrypted
      ? readProfile(clientId, options)
      : normalizeProfile(parsed, clientId, options);
  } catch (_error) {
    profile = null;
  }
  if (!profile) return null;
  storedProfileCache.set(cacheKey, profile);
  if (storedProfileCache.size > STORED_PROFILE_CACHE_MAX) {
    const oldest = storedProfileCache.keys().next().value;
    storedProfileCache.delete(oldest);
  }
  return profile;
}

function forEachStoredProfile(visitor, options = {}) {
  const root = resolveRootPath(options);
  let files = [];
  try {
    files = fs.readdirSync(root);
  } catch (_error) {
    return;
  }
  for (const file of files) {
    const profile = readStoredProfileFile(file, options);
    if (profile?.clientId) visitor(profile);
  }
}

function listProfileClientIds(options = {}) {
  const ids = [];
  forEachStoredProfile((profile) => {
    const clientId = String(profile.clientId || "").trim();
    if (clientId) ids.push(clientId);
  }, options);
  return ids.sort();
}

// "public" profiles are listed in the public directory; "private" (default)
// keeps a profile out of it entirely.
function normalizeDirectoryVisibility(value, fallback = "private") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "public" || raw === "private") {
    return raw;
  }
  return fallback;
}

function updateProfileDirectory(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  profile.directoryVisibility = normalizeDirectoryVisibility(input?.visibility, "private");
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { visibility: profile.directoryVisibility, usage };
}

function listPublicDirectoryEntries(options = {}) {
  const entries = [];
  forEachStoredProfile((profile) => {
    const clientId = String(profile?.clientId || "").trim();
    if (!clientId || isSharedDemoClientId(clientId)) {
      return;
    }
    if (normalizeDirectoryVisibility(profile.directoryVisibility, "private") !== "public") {
      return;
    }
    const username = resolveAccountUsername(clientId);
    const displayName = String(profile.displayName || "").trim().slice(0, 80);
    entries.push({
      clientId,
      username,
      displayName: displayName || (username ? `@${username}` : ""),
      tagline: String(profile.tagline || "").slice(0, 120),
      bio: String(profile.bio || "").slice(0, 300),
      memberSince: String(profile.createdAt || ""),
      hasAvatar: Boolean(profile.avatar?.data)
    });
  }, options);
  entries.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return entries;
}

// Public profile view for a directory listing (never includes email, location,
// or any journal content).
function getPublicDirectoryProfile(targetClientId, options = {}) {
  const targetId = normalizeClientId(targetClientId);
  const profile = readProfile(targetId, options);
  if (!isPublicDirectoryProfile(profile)) {
    throw new ProfileStorageError("not_in_directory", "That user is not listed in the public directory.");
  }
  const username = resolveAccountUsername(targetId);
  const displayName = String(profile.displayName || "").trim();
  return {
    clientId: targetId,
    username,
    displayName: displayName || (username ? `@${username}` : ""),
    bio: String(profile.bio || "").slice(0, 600),
    tagline: String(profile.tagline || "").slice(0, 120),
    memberSince: String(profile.createdAt || ""),
    hasAvatar: Boolean(profile.avatar?.data),
    hasBanner: Boolean(profile.banner?.data),
    journalVisibility: normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY),
    postsCount: (Array.isArray(profile.posts) ? profile.posts : []).filter((post) => post?.type === "post").length
  };
}

// Avatar/banner for a publicly listed profile. Gated the same way, so a private
// profile's images stay private.
function getPublicDirectoryImage(targetClientId, kind, options = {}) {
  const targetId = normalizeClientId(targetClientId);
  const profile = readProfile(targetId, options);
  if (!isPublicDirectoryProfile(profile)) {
    throw new ProfileStorageError("not_in_directory", "That user is not listed in the public directory.");
  }
  return getProfileImage(targetId, kind, options);
}

// --- Friends + directory social actions --------------------------------------
// Friendships are mutual: accepting a request writes both profiles. Requests are
// stored per profile as incoming/outgoing, and only profiles that opted into the
// public directory can be added or messaged by strangers.

function normalizeFriends(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const raw of value) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { clientId: raw };
    const clientId = String(source.clientId || "").trim().slice(0, 120);
    if (!clientId || seen.has(clientId)) {
      continue;
    }
    seen.add(clientId);
    entries.push({
      clientId,
      name: String(source.name || "").trim().slice(0, 80),
      at: String(source.at || "").trim()
    });
  }
  return entries.slice(0, MAX_FRIENDS_PER_PROFILE);
}

// Each profile has its own tiered storage limits. Writes to the other side of a
// relationship must not inherit the caller's quota/attachment options, which
// would otherwise truncate or drop the other user's stored data.
function counterpartWriteOptions(options = {}) {
  return {
    rootPath: options.rootPath,
    profilesRoot: options.profilesRoot,
    encryptionSecret: options.encryptionSecret
  };
}

// Two-profile mutation. The counterpart is persisted before the actor so a
// failed second write cannot leave the actor with a relationship the other side
// never recorded.
function updateMutualRelation(actorId, otherId, options, mutate) {
  const actorProfile = readProfile(actorId, options);
  const otherProfile = readProfile(otherId, options);
  mutate(actorProfile, otherProfile);
  const nowIso = new Date().toISOString();
  actorProfile.updatedAt = nowIso;
  otherProfile.updatedAt = nowIso;
  writeProfile(otherId, otherProfile, counterpartWriteOptions(options));
  writeProfile(actorId, actorProfile, options);
}

function normalizeFriendRequestEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const clientId = String(value.clientId || "").trim().slice(0, 120);
  if (!clientId) {
    return null;
  }
  return {
    clientId,
    name: String(value.name || "").trim().slice(0, 80),
    at: String(value.at || value.createdAt || "").trim()
  };
}

function normalizeFriendRequests(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const dedupe = (list) => {
    const seen = new Set();
    const result = [];
    (Array.isArray(list) ? list : []).forEach((entry) => {
      const normalized = normalizeFriendRequestEntry(entry);
      if (!normalized || seen.has(normalized.clientId)) {
        return;
      }
      seen.add(normalized.clientId);
      result.push(normalized);
    });
    return result.slice(0, MAX_FRIEND_REQUESTS_PER_PROFILE);
  };
  return { incoming: dedupe(source.incoming), outgoing: dedupe(source.outgoing) };
}

function isPublicDirectoryProfile(profile) {
  return normalizeDirectoryVisibility(profile?.directoryVisibility, "private") === "public";
}

function areFriends(profile, otherClientId) {
  const wanted = String(otherClientId || "").trim();
  return Boolean(wanted) && normalizeFriends(profile?.friends).some((entry) => entry.clientId === wanted);
}

// Names are captured when a request/friendship is created, so listing friends
// needs no per-friend profile reads.
// The public username that owns a client id (trial accounts). Never the email.
function resolveAccountUsername(clientId) {
  const id = String(clientId || "").trim();
  if (!id) {
    return "";
  }
  try {
    const account = require("./account-service").findAccountByClientId(id);
    return String(account?.username || "").trim();
  } catch (_error) {
    return "";
  }
}

// Prefer a real display name, then the public username; only fall back to the
// raw client id when neither exists.
function resolvePeerName(clientId, storedName = "", options = {}) {
  const id = String(clientId || "").trim();
  const stored = String(storedName || "").trim();
  if (stored && stored !== id && !stored.startsWith("cli_")) {
    return stored;
  }
  try {
    const displayName = String(readProfile(id, options)?.displayName || "").trim();
    if (displayName) {
      return displayName;
    }
  } catch (_error) {}
  return resolveAccountUsername(id) || id;
}

function getProfileFriends(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  const requests = normalizeFriendRequests(profile.friendRequests);
  const withName = (entry) => ({
    ...entry,
    name: resolvePeerName(entry.clientId, entry.name, options)
  });
  return {
    friends: normalizeFriends(profile.friends).map((entry) => ({
      clientId: entry.clientId,
      name: resolvePeerName(entry.clientId, entry.name, options)
    })),
    incoming: requests.incoming.map(withName),
    outgoing: requests.outgoing.map(withName)
  };
}

function sendFriendRequest(fromClientId, targetClientId, options = {}) {
  const fromId = normalizeClientId(fromClientId);
  const targetId = normalizeClientId(targetClientId);
  if (fromId === targetId) {
    throw new ProfileStorageError("invalid_friend_request", "You cannot add yourself as a friend.");
  }
  const fromProfile = readProfile(fromId, options);
  const targetProfile = readProfile(targetId, options);
  if (areFriends(fromProfile, targetId) || areFriends(targetProfile, fromId)) {
    return { status: "friends", friends: getProfileFriends(fromId, options) };
  }
  if (!isPublicDirectoryProfile(targetProfile)) {
    throw new ProfileStorageError("not_in_directory", "That user is not listed in the public directory.");
  }
  const fromRequests = normalizeFriendRequests(fromProfile.friendRequests);
  const targetRequests = normalizeFriendRequests(targetProfile.friendRequests);
  if (targetRequests.outgoing.some((entry) => entry.clientId === fromId)) {
    return acceptFriendRequest(fromId, targetId, options);
  }
  if (fromRequests.outgoing.some((entry) => entry.clientId === targetId)) {
    return { status: "requested", friends: getProfileFriends(fromId, options) };
  }
  if (fromRequests.outgoing.length >= MAX_FRIEND_REQUESTS_PER_PROFILE
    || targetRequests.incoming.length >= MAX_FRIEND_REQUESTS_PER_PROFILE) {
    throw new ProfileStorageError("friend_requests_limit_reached", "Too many pending friend requests.");
  }

  const fromName = String(fromProfile.displayName || "").trim() || fromId;
  const targetName = String(targetProfile.displayName || "").trim() || targetId;
  updateMutualRelation(fromId, targetId, options, (actor, other) => {
    const nowIso = new Date().toISOString();
    const actorRequests = normalizeFriendRequests(actor.friendRequests);
    const otherRequests = normalizeFriendRequests(other.friendRequests);
    actorRequests.outgoing.push({ clientId: targetId, name: targetName, at: nowIso });
    otherRequests.incoming.push({ clientId: fromId, name: fromName, at: nowIso });
    actor.friendRequests = actorRequests;
    other.friendRequests = otherRequests;
  });

  try {
    addProfileMessage(targetId, {
      kind: "message",
      title: `${fromName} (@${fromId}) wants to add you as a friend`,
      description: "Open your profile to accept or decline the request.",
      visibility: "internal"
    }, { sender: `${fromName} (@${fromId})` }, counterpartWriteOptions(options));
  } catch (_error) {
    // Notification is best-effort; the request itself is already stored.
  }
  return { status: "requested", friends: getProfileFriends(fromId, options) };
}

function acceptFriendRequest(clientId, requesterClientId, options = {}) {
  const id = normalizeClientId(clientId);
  const otherId = normalizeClientId(requesterClientId);
  if (id === otherId) {
    throw new ProfileStorageError("invalid_friend_request", "You cannot befriend yourself.");
  }
  const existing = readProfile(id, options);
  if (areFriends(existing, otherId)) {
    return { status: "friends", friends: getProfileFriends(id, options) };
  }
  updateMutualRelation(id, otherId, options, (actor, other) => {
    const requests = normalizeFriendRequests(actor.friendRequests);
    if (!requests.incoming.some((entry) => entry.clientId === otherId)) {
      throw new ProfileStorageError("friend_request_not_found", "There is no pending friend request from that user.");
    }
    if (normalizeFriends(actor.friends).length >= MAX_FRIENDS_PER_PROFILE
      || normalizeFriends(other.friends).length >= MAX_FRIENDS_PER_PROFILE) {
      throw new ProfileStorageError("friends_limit_reached", "A friends list is already full.");
    }
    const otherRequests = normalizeFriendRequests(other.friendRequests);
    const nowIso = new Date().toISOString();
    const actorName = String(actor.displayName || "").trim() || id;
    const otherName = String(other.displayName || "").trim() || otherId;
    actor.friends = normalizeFriends([
      ...normalizeFriends(actor.friends),
      { clientId: otherId, name: otherName, at: nowIso }
    ]);
    other.friends = normalizeFriends([
      ...normalizeFriends(other.friends),
      { clientId: id, name: actorName, at: nowIso }
    ]);
    requests.incoming = requests.incoming.filter((entry) => entry.clientId !== otherId);
    otherRequests.outgoing = otherRequests.outgoing.filter((entry) => entry.clientId !== id);
    actor.friendRequests = requests;
    other.friendRequests = otherRequests;
  });
  return { status: "friends", friends: getProfileFriends(id, options) };
}

function declineFriendRequest(clientId, requesterClientId, options = {}) {
  const id = normalizeClientId(clientId);
  const otherId = normalizeClientId(requesterClientId);
  if (id === otherId) {
    throw new ProfileStorageError("invalid_friend_request", "You cannot decline your own request.");
  }
  updateMutualRelation(id, otherId, options, (actor, other) => {
    const requests = normalizeFriendRequests(actor.friendRequests);
    if (!requests.incoming.some((entry) => entry.clientId === otherId)) {
      throw new ProfileStorageError("friend_request_not_found", "There is no pending friend request from that user.");
    }
    const otherRequests = normalizeFriendRequests(other.friendRequests);
    requests.incoming = requests.incoming.filter((entry) => entry.clientId !== otherId);
    otherRequests.outgoing = otherRequests.outgoing.filter((entry) => entry.clientId !== id);
    actor.friendRequests = requests;
    other.friendRequests = otherRequests;
  });
  return { status: "none", friends: getProfileFriends(id, options) };
}

function cancelFriendRequest(clientId, targetClientId, options = {}) {
  const id = normalizeClientId(clientId);
  const targetId = normalizeClientId(targetClientId);
  if (id === targetId) {
    throw new ProfileStorageError("invalid_friend_request", "You cannot cancel a request to yourself.");
  }
  updateMutualRelation(id, targetId, options, (actor, other) => {
    const requests = normalizeFriendRequests(actor.friendRequests);
    if (!requests.outgoing.some((entry) => entry.clientId === targetId)) {
      throw new ProfileStorageError("friend_request_not_found", "There is no outgoing friend request to that user.");
    }
    const otherRequests = normalizeFriendRequests(other.friendRequests);
    requests.outgoing = requests.outgoing.filter((entry) => entry.clientId !== targetId);
    otherRequests.incoming = otherRequests.incoming.filter((entry) => entry.clientId !== id);
    actor.friendRequests = requests;
    other.friendRequests = otherRequests;
  });
  return { status: "none", friends: getProfileFriends(id, options) };
}

function removeFriend(clientId, friendClientId, options = {}) {
  const id = normalizeClientId(clientId);
  const friendId = normalizeClientId(friendClientId);
  if (id === friendId) {
    throw new ProfileStorageError("invalid_friend_request", "You cannot remove yourself.");
  }
  updateMutualRelation(id, friendId, options, (actor, other) => {
    if (!normalizeFriends(actor.friends).some((entry) => entry.clientId === friendId)) {
      throw new ProfileStorageError("friend_not_found", "That user is not in your friends list.");
    }
    actor.friends = normalizeFriends(actor.friends).filter((entry) => entry.clientId !== friendId);
    other.friends = normalizeFriends(other.friends).filter((entry) => entry.clientId !== id);
  });
  return { status: "none", friends: getProfileFriends(id, options) };
}

// Deliver a direct inbox message to another user. Only public-directory users
// (or existing friends) accept messages so private profiles stay unreachable.
function sendDirectoryMessage(fromClientId, targetClientId, input = {}, options = {}) {
  const fromId = normalizeClientId(fromClientId);
  const targetId = normalizeClientId(targetClientId);
  if (fromId === targetId) {
    throw new ProfileStorageError("invalid_message", "You cannot message yourself.");
  }
  const fromProfile = readProfile(fromId, options);
  const targetProfile = readProfile(targetId, options);
  const friends = areFriends(targetProfile, fromId) || areFriends(fromProfile, targetId);
  if (!isPublicDirectoryProfile(targetProfile) && !friends) {
    throw new ProfileStorageError("not_in_directory", "That user is not accepting public messages.");
  }
  const body = String(input?.body ?? input?.description ?? "").trim();
  if (!body) {
    throw new ProfileStorageError("invalid_message", "Write a message first.");
  }
  const fromName = String(fromProfile.displayName || "").trim() || fromId;
  // Attribution includes the stable client id so a self-set display name cannot
  // be used to impersonate another user or a system sender.
  const sender = `${fromName} (@${fromId})`;
  const subject = String(input?.title || "").trim() || `Message from ${fromName}`;
  const result = addProfileMessage(targetId, {
    kind: "message",
    title: subject.slice(0, MAX_LINK_TITLE_LENGTH),
    description: body.slice(0, MAX_LINK_DESCRIPTION_LENGTH),
    visibility: "internal"
  }, { sender }, counterpartWriteOptions(options));
  return {
    sender,
    message: { id: result.message.id, title: result.message.title }
  };
}

// Internal quiz leaderboard. Only profiles that opted into the public directory
// (and have actually played) are ranked, so private players stay invisible.
function getQuizLeaderboard(options = {}) {
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
  const entries = [];
  forEachStoredProfile((profile) => {
    const clientId = String(profile?.clientId || "").trim();
    if (!clientId) {
      return;
    }
    if (normalizeDirectoryVisibility(profile.directoryVisibility, "private") !== "public") {
      return;
    }
    const attempts = Array.isArray(profile.quiz?.attempts) ? profile.quiz.attempts : [];
    if (!attempts.length) {
      return;
    }

    const stats = computeQuizStats(attempts);
    const bestByDifficulty = {};
    let bestAccuracy = 0;
    stats.byDifficulty.forEach((entry) => {
      if (entry.best) {
        bestByDifficulty[entry.difficulty] = entry.best.accuracy;
        bestAccuracy = Math.max(bestAccuracy, entry.best.accuracy);
      }
    });

    entries.push({
      clientId,
      displayName: String(profile.displayName || "").trim().slice(0, 80),
      attempts: stats.overall.attempts,
      totalQuestions: stats.overall.totalQuestions,
      totalCorrect: stats.overall.totalCorrect,
      accuracy: stats.overall.accuracy,
      bestAccuracy,
      bestByDifficulty
    });
  }, options);

  return entries
    .sort((left, right) => (
      (right.accuracy - left.accuracy)
      || (right.totalCorrect - left.totalCorrect)
      || String(left.displayName || left.clientId).localeCompare(String(right.displayName || right.clientId))
    ))
    .slice(0, limit);
}

function normalizeBoardWatch(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const ids = [];
  for (const entry of value) {
    const id = String(entry || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(-200);
}

// Board "watching": topic ids a profile follows. Notifications are delivered as
// inbox messages when someone replies.
function getProfileBoardWatch(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return normalizeBoardWatch(profile.boardWatch);
}

function updateProfileBoardWatch(clientId, topicId, watching, options = {}) {
  const topic = String(topicId || "").trim();
  if (!topic) {
    throw new ProfileStorageError("invalid_watch", "A topic id is required.");
  }
  const profile = readProfile(clientId, options);
  const current = normalizeBoardWatch(profile.boardWatch);
  const next = watching === true
    ? normalizeBoardWatch([...current, topic])
    : current.filter((entry) => entry !== topic);
  profile.boardWatch = next;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { watching: next.includes(topic), watch: next, usage };
}

function listTopicWatchers(topicId, options = {}) {
  const wanted = String(topicId || "").trim();
  if (!wanted) {
    return [];
  }
  const watchers = [];
  forEachStoredProfile((profile) => {
    const clientId = String(profile?.clientId || "").trim();
    if (clientId && normalizeBoardWatch(profile.boardWatch).includes(wanted)) {
      watchers.push(clientId);
    }
  }, options);
  return watchers;
}

function getProfileRevision(clientId) {
  return profileWriteRevisions.get(normalizeClientId(clientId)) || 0;
}

function writeProfile(clientId, profile, options = {}) {
  const filePath = getProfileFilePath(clientId, options);
  const quotaBytes = resolveQuotaBytes(options);
  const normalizedProfile = normalizeProfile(profile, normalizeClientId(clientId), options);
  normalizedProfile.updatedAt = new Date().toISOString();

  const serialized = `${JSON.stringify(normalizedProfile)}\n`.trim();
  const secret = resolveProfileEncryptionSecret(options);
  const toStore = encryptData(serialized, normalizeClientId(clientId), secret);
  const usedBytes = Buffer.byteLength(toStore, "utf8");

  let previousBytes = 0;
  try {
    previousBytes = fs.statSync(filePath).size;
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  // Shrinking writes are always allowed so a profile that ended up over the
  // quota can still delete or edit its way back under it.
  if (usedBytes > quotaBytes && usedBytes >= previousBytes) {
    throw new ProfileStorageError(
      "quota_exceeded",
      `Profile storage quota exceeded (${usedBytes} of ${quotaBytes} bytes).`
    );
  }

  writeFileAtomicSync(filePath, `${toStore}\n`);
  dropStoredProfileCache(filePath);
  const revisionKey = normalizeClientId(clientId);
  profileWriteRevisions.set(revisionKey, (profileWriteRevisions.get(revisionKey) || 0) + 1);
  // Return usage (attachments are embedded in the JSON)
  return getProfileUsage(clientId, options);
}

function getProfileUsage(clientId, options = {}) {
  const filePath = getProfileFilePath(clientId, options);
  const quotaBytes = resolveQuotaBytes(options);
  let jsonBytes = 0;
  try {
    jsonBytes = fs.statSync(filePath).size;
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  // Attachments are embedded as base64 data inside the profile JSON,
  // so jsonBytes already accounts for their size. No separate attachment files.
  const usedBytes = jsonBytes;

  return {
    usedBytes,
    quotaBytes,
    quotaPercent: Math.round((usedBytes / quotaBytes) * 1000) / 10,
    jsonBytes,
    attachmentsBytes: 0
  };
}

function getProfileSummary(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  const usage = getProfileUsage(clientId, options);
  const attachmentCount = (profile.notes || []).reduce((sum, note) => {
    return sum + (note.scenes || []).reduce((s, scene) => s + (scene.attachments || []).length, 0);
  }, 0);

  return {
    clientId: profile.clientId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    bio: profile.bio || "",
    tagline: profile.tagline || "",
    hasPage: Boolean(String(profile.pageHtml || "").trim()),
    hasAvatar: Boolean(profile.avatar?.data),
    hasBanner: Boolean(profile.banner?.data),
    journalVisibility: normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY),
    displayName: profile.displayName || "",
    location: profile.location || null,
    preferredDeck: profile.preferredDeck || "",
    quietHours: normalizeStoredQuietHours(profile.quietHours),
    directoryVisibility: normalizeDirectoryVisibility(profile.directoryVisibility, "private"),
    storage: usage,
    counts: {
      notes: profile.notes.length,
      events: Array.isArray(profile.events) ? profile.events.length : 0,
      links: Array.isArray(profile.links) ? profile.links.length : 0,
      messages: Array.isArray(profile.messages) ? profile.messages.length : 0,
      friends: normalizeFriends(profile.friends).length,
      posts: Array.isArray(profile.posts) ? profile.posts.length : 0,
      quizAttempts: profile.quiz.attempts.length,
      attachments: attachmentCount
    }
  };
}

function cloneNote(note) {
  return {
    id: note.id,
    title: note.title,
    kind: note.kind,
    occurredOn: note.occurredOn,
    scenes: (Array.isArray(note.scenes) ? note.scenes : []).map((scene) => ({ ...scene })),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

function normalizeNoteTitle(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ProfileStorageError("invalid_note", "A note title is required.");
  }
  if (normalized.length > MAX_NOTE_TITLE_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A note title cannot exceed ${MAX_NOTE_TITLE_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeNoteKindInput(value, { required = false, fallback = "waking" } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) {
      throw new ProfileStorageError("invalid_note", "An entry must be a dream or waking note.");
    }
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (!NOTE_KINDS.has(normalized)) {
    throw new ProfileStorageError("invalid_note", "An entry must be a dream or waking note.");
  }
  return normalized;
}

function normalizeOccurredOnInput(value, fallbackIso) {
  const raw = String(value || "").trim();
  if (!raw) {
    return dateFromIso(fallbackIso);
  }
  if (!isValidOccurredOn(raw)) {
    throw new ProfileStorageError("invalid_note", "An entry date must be a valid calendar date.");
  }
  return raw;
}

function createEmptyScene(nowIso = new Date().toISOString()) {
  return {
    id: `scene_${crypto.randomBytes(8).toString("hex")}`,
    time: "",
    endTime: "",
    place: "",
    scenario: "",
    mood: "",
    emotion: "",
    atmosphere: "",
    steps: "",
    thoughts: "",
    notes: "",
    attachments: [],
    createdAt: nowIso
  };
}

function normalizeSceneInput(rawScene) {
  if (!rawScene || typeof rawScene !== "object" || Array.isArray(rawScene)) {
    throw new ProfileStorageError("invalid_note", "Each scene must be an object.");
  }

  const nowIso = new Date().toISOString();
  const scene = {
    id: String(rawScene.id || "").trim() || `scene_${crypto.randomBytes(8).toString("hex")}`,
    time: normalizeSceneTime(rawScene.time || ""),
    endTime: normalizeSceneTime(rawScene.endTime || ""),
    place: String(rawScene.place || "").trim(),
    scenario: String(rawScene.scenario || "").trim(),
    mood: String(rawScene.mood || "").trim(),
    emotion: String(rawScene.emotion || "").trim(),
    atmosphere: String(rawScene.atmosphere || "").trim(),
    steps: String(rawScene.steps || ""),
    thoughts: String(rawScene.thoughts || ""),
    notes: String(rawScene.notes || ""),
    attachments: Array.isArray(rawScene.attachments) ? rawScene.attachments : [],
    createdAt: String(rawScene.createdAt || nowIso).trim() || nowIso
  };

  if (scene.time.length > MAX_SCENE_TIME_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene time cannot exceed ${MAX_SCENE_TIME_LENGTH} characters.`);
  }
  if (scene.endTime.length > MAX_SCENE_TIME_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene end time cannot exceed ${MAX_SCENE_TIME_LENGTH} characters.`);
  }
  if (scene.emotion.length > MAX_SCENE_MOOD_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene emotion cannot exceed ${MAX_SCENE_MOOD_LENGTH} characters.`);
  }
  if (scene.atmosphere.length > MAX_SCENE_MOOD_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene atmosphere cannot exceed ${MAX_SCENE_MOOD_LENGTH} characters.`);
  }
  if (scene.steps.length > MAX_SCENE_NOTES_LENGTH) {
    throw new ProfileStorageError("invalid_note", `Scene steps cannot exceed ${MAX_SCENE_NOTES_LENGTH} characters.`);
  }
  if (scene.place.length > MAX_SCENE_PLACE_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene scenery cannot exceed ${MAX_SCENE_PLACE_LENGTH} characters.`);
  }
  if (scene.scenario.length > MAX_SCENE_PLACE_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene scenario cannot exceed ${MAX_SCENE_PLACE_LENGTH} characters.`);
  }
  if (scene.mood.length > MAX_SCENE_MOOD_LENGTH) {
    throw new ProfileStorageError("invalid_note", `A scene mood cannot exceed ${MAX_SCENE_MOOD_LENGTH} characters.`);
  }
  if (scene.thoughts.length > MAX_SCENE_THOUGHTS_LENGTH) {
    throw new ProfileStorageError("invalid_note", `Scene thoughts cannot exceed ${MAX_SCENE_THOUGHTS_LENGTH} characters.`);
  }
  if (scene.notes.length > MAX_SCENE_NOTES_LENGTH) {
    throw new ProfileStorageError("invalid_note", `Scene notes cannot exceed ${MAX_SCENE_NOTES_LENGTH} characters.`);
  }

  return scene;
}

function normalizeScenesInput(rawScenes) {
  if (rawScenes === undefined) {
    return [createEmptyScene()];
  }

  if (rawScenes === null) {
    throw new ProfileStorageError("invalid_note", "Scenes must be an array.");
  }

  if (!Array.isArray(rawScenes)) {
    throw new ProfileStorageError("invalid_note", "Scenes must be an array.");
  }
  if (!rawScenes.length) {
    throw new ProfileStorageError("invalid_note", "An entry needs at least one scene.");
  }
  if (rawScenes.length > MAX_SCENES_PER_NOTE) {
    throw new ProfileStorageError("invalid_note", `An entry can hold at most ${MAX_SCENES_PER_NOTE} scenes.`);
  }

  return rawScenes.map((scene) => normalizeSceneInput(scene));
}

function listProfileNotes(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return profile.notes
    .map((note) => ({
      id: note.id,
      title: note.title,
      kind: note.kind,
      occurredOn: note.occurredOn,
      sceneCount: (Array.isArray(note.scenes) ? note.scenes : []).length,
      attachmentCount: (note.scenes || []).reduce((sum, s) => sum + ((s.attachments || []).length || 0), 0),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    }))
    .sort((left, right) => {
      const dateCmp = String(right.occurredOn || "").localeCompare(String(left.occurredOn || ""));
      if (dateCmp) {
        return dateCmp;
      }
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
}

function getProfileNote(clientId, noteId, options = {}) {
  const profile = readProfile(clientId, options);
  const note = profile.notes.find((entry) => entry.id === noteId) || null;
  if (!note) {
    throw new ProfileStorageError("note_not_found", `Note '${noteId}' was not found.`);
  }
  return cloneNote(note);
}

function resolveNotesLimit(options = {}) {
  const numericValue = Number(options.maxNotes);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return MAX_NOTES_PER_PROFILE;
}

function resolveAttachmentsPerSceneLimit(options = {}) {
  const numericValue = Number(options.maxAttachmentsPerScene);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return MAX_ATTACHMENTS_PER_SCENE;
}

function parseSceneTimeToMinutesInternal(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Waking scenes must not overlap in time. Only scenes with BOTH a start and an
// end participate; missing ends are treated as point-in-time (no range).
function assertNoSceneTimeOverlaps(scenes, kind) {
  if (kind === "dream") return;
  const ranges = [];
  (Array.isArray(scenes) ? scenes : []).forEach((scene, index) => {
    const start = parseSceneTimeToMinutesInternal(scene?.time);
    let end = parseSceneTimeToMinutesInternal(scene?.endTime);
    if (start == null || end == null) return;
    if (end <= start) end += 24 * 60; // crossed midnight
    ranges.push({ index, start, end, time: String(scene.time || ""), endTime: String(scene.endTime || "") });
  });
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.start < b.end && b.start < a.end) {
        throw new ProfileStorageError(
          "scene_time_overlap",
          `Scene ${a.index + 1} (${a.time}–${a.endTime}) overlaps Scene ${b.index + 1} (${b.time}–${b.endTime}).`
        );
      }
    }
  }
}

function assertSceneAttachmentLimits(scenes, options = {}) {  const maxPerScene = resolveAttachmentsPerSceneLimit(options);
  const maxBytes = resolveAttachmentBytesLimit(options);
  for (const scene of scenes || []) {
    const attachments = Array.isArray(scene?.attachments) ? scene.attachments : [];
    if (attachments.length > maxPerScene) {
      throw new ProfileStorageError(
        "attachments_limit_reached",
        `A scene can hold at most ${maxPerScene} attachments for your access level.`
      );
    }
    for (const attachment of attachments) {
      const dataLength = typeof attachment?.data === "string" ? Buffer.byteLength(attachment.data, "utf8") : 0;
      const effectiveSize = Math.max(0, Number(attachment?.size) || Math.ceil(dataLength * 0.75));
      if (effectiveSize > maxBytes) {
        throw new ProfileStorageError(
          "attachment_too_large",
          `Attachments are limited to ${Math.round(maxBytes / (1024 * 1024))}MB for your access level.`
        );
      }
    }
  }
}

function createProfileNote(clientId, input, options = {}) {
  const nowIso = new Date().toISOString();
  const title = normalizeNoteTitle(input?.title);
  const kind = normalizeNoteKindInput(input?.kind);
  const occurredOn = normalizeOccurredOnInput(input?.occurredOn, nowIso);
  const scenes = normalizeScenesInput(input?.scenes);
  assertSceneAttachmentLimits(scenes, options);
  assertNoSceneTimeOverlaps(scenes, kind);

  const profile = readProfile(clientId, options);
  const notesLimit = resolveNotesLimit(options);
  if (profile.notes.length >= notesLimit) {
    throw new ProfileStorageError("notes_limit_reached", `A profile can hold at most ${notesLimit} notes for your access level.`);
  }

  const note = {
    id: `note_${crypto.randomBytes(8).toString("hex")}`,
    title,
    kind,
    occurredOn,
    sleptAt: normalizeSceneTime(input?.sleptAt || ""),
    awokeAt: normalizeSceneTime(input?.awokeAt || ""),
    scenes,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  profile.notes.push(note);

  const usage = writeProfile(clientId, profile, options);
  return {
    note: cloneNote(note),
    usage
  };
}

function updateProfileNote(clientId, noteId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const note = profile.notes.find((entry) => entry.id === noteId) || null;
  if (!note) {
    throw new ProfileStorageError("note_not_found", `Note '${noteId}' was not found.`);
  }

  if (Object.prototype.hasOwnProperty.call(input || {}, "title")) {
    note.title = normalizeNoteTitle(input.title);
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "kind")) {
    note.kind = normalizeNoteKindInput(input.kind, { required: true });
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "occurredOn")) {
    note.occurredOn = normalizeOccurredOnInput(input.occurredOn, note.createdAt);
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "sleptAt")) {
    note.sleptAt = normalizeSceneTime(input.sleptAt || "");
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "awokeAt")) {
    note.awokeAt = normalizeSceneTime(input.awokeAt || "");
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "scenes")) {
    note.scenes = normalizeScenesInput(input.scenes);
    assertSceneAttachmentLimits(note.scenes, options);
    assertNoSceneTimeOverlaps(note.scenes, note.kind);
  }
  note.updatedAt = new Date().toISOString();

  const usage = writeProfile(clientId, profile, options);
  return {
    note: cloneNote(note),
    usage
  };
}

function deleteProfileNote(clientId, noteId, options = {}) {
  const profile = readProfile(clientId, options);
  const noteIndex = profile.notes.findIndex((entry) => entry.id === noteId);
  if (noteIndex === -1) {
    throw new ProfileStorageError("note_not_found", `Note '${noteId}' was not found.`);
  }

  profile.notes.splice(noteIndex, 1);
  const usage = writeProfile(clientId, profile, options);
  return {
    removed: true,
    usage
  };
}

// Wipe a client's entire profile (notes, quiz, bio, settings). Generic helper
// also used by plugins (e.g. the Demo Users plugin's profile reset).
function resetProfile(clientId, options = {}) {
  const filePath = getProfileFilePath(clientId, options);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

// --- Quick notes --------------------------------------------------------------

function normalizeQuickNote(rawNote) {
  if (!rawNote || typeof rawNote !== "object") return null;
  const text = String(rawNote.text || "").trim().slice(0, MAX_QUICK_NOTE_TEXT_LENGTH);
  if (!text) return null;
  const createdAt = String(rawNote.createdAt || new Date().toISOString()).trim();
  let sky = null;
  if (rawNote.sky && typeof rawNote.sky === "object") {
    sky = {
      hourPlanet: String(rawNote.sky.hourPlanet || "").trim().slice(0, 60),
      hourTarot: String(rawNote.sky.hourTarot || "").trim().slice(0, 80),
      isDaylight: rawNote.sky.isDaylight === true,
      summary: String(rawNote.sky.summary || "").trim().slice(0, MAX_QUICK_NOTE_SKY_LENGTH)
    };
  }
  return {
    id: String(rawNote.id || `quick_${crypto.randomBytes(6).toString("hex")}`),
    text,
    createdAt,
    sky
  };
}

function parseQuickNoteCreatedAt(value, fallbackIso) {
  if (value == null || String(value).trim() === "") {
    return fallbackIso || new Date().toISOString();
  }
  const parsed = new Date(String(value).trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new ProfileStorageError("invalid_quick_note_time", "Quick note time must be a valid date.");
  }
  return parsed.toISOString();
}

function addProfileQuickNote(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const quickNote = normalizeQuickNote({
    text: input?.text,
    sky: input?.sky,
    createdAt: parseQuickNoteCreatedAt(input?.createdAt)
  });
  if (!quickNote) {
    throw new ProfileStorageError("invalid_quick_note", "Quick note text is required.");
  }
  profile.quickNotes = [...(profile.quickNotes || []), quickNote].slice(-MAX_QUICK_NOTES_PER_PROFILE);
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    quickNote,
    count: profile.quickNotes.length,
    usage
  };
}

function listProfileQuickNotes(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return [...(profile.quickNotes || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function updateProfileQuickNote(clientId, quickNoteId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const notes = profile.quickNotes || [];
  const index = notes.findIndex((note) => note.id === String(quickNoteId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("quick_note_not_found", "No such quick note.");
  }
  const existing = notes[index];
  const nextText = input?.text !== undefined ? input.text : existing.text;
  const nextCreatedAt = input?.createdAt !== undefined
    ? parseQuickNoteCreatedAt(input.createdAt, existing.createdAt)
    : existing.createdAt;
  const nextSky = input?.sky !== undefined ? input.sky : existing.sky;
  const quickNote = normalizeQuickNote({
    id: existing.id,
    text: nextText,
    createdAt: nextCreatedAt,
    sky: nextSky
  });
  if (!quickNote) {
    throw new ProfileStorageError("invalid_quick_note", "Quick note text is required.");
  }
  notes[index] = quickNote;
  profile.quickNotes = notes;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    quickNote,
    count: profile.quickNotes.length,
    usage
  };
}

function deleteProfileQuickNote(clientId, quickNoteId, options = {}) {
  const profile = readProfile(clientId, options);
  const index = (profile.quickNotes || []).findIndex((note) => note.id === quickNoteId);
  if (index === -1) {
    return { removed: false, usage: getProfileUsage(clientId, options) };
  }
  profile.quickNotes.splice(index, 1);
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { removed: true, usage };
}

// --- Calendar events ----------------------------------------------------------

const EVENT_CATEGORIES = new Set(["personal", "ritual", "study", "work", "health", "travel", "other"]);
const RECURRENCE_FREQUENCIES = new Set(["none", "daily", "weekly", "monthly", "yearly"]);
const EVENT_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function eventError(message) {
  return new ProfileStorageError("invalid_event", message);
}

function normalizeEventCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "personal";
  }
  if (!EVENT_CATEGORIES.has(raw)) {
    throw eventError(`Event category must be one of: ${[...EVENT_CATEGORIES].join(", ")}.`);
  }
  return raw;
}

function normalizeEventColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  if (raw.length > MAX_EVENT_COLOR_LENGTH || !EVENT_COLOR_PATTERN.test(raw)) {
    throw eventError("Event colour must be a hex value such as #3b82f6.");
  }
  return raw;
}

function normalizeEventTime(value, label = "Start time") {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) {
    return "";
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw eventError(`${label} must be HH:MM.`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw eventError(`${label} must be a valid 24-hour time.`);
  }
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function normalizeEventReminder(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_EVENT_REMINDER_MINUTES) {
    throw eventError(`Reminder must be whole minutes between 0 and ${MAX_EVENT_REMINDER_MINUTES}.`);
  }
  return numeric;
}

function normalizeEventRecurrence(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const freq = String(raw.freq || "none").trim().toLowerCase() || "none";
  if (!RECURRENCE_FREQUENCIES.has(freq)) {
    throw eventError(`Recurrence must be one of: ${[...RECURRENCE_FREQUENCIES].join(", ")}.`);
  }
  if (freq === "none") {
    return { freq: "none", interval: 1, until: "", byWeekday: [] };
  }
  const intervalValue = Number(raw.interval);
  const interval = Number.isFinite(intervalValue) && intervalValue >= 1
    ? Math.min(365, Math.floor(intervalValue))
    : 1;
  const untilRaw = String(raw.until || "").trim();
  if (untilRaw && !isValidOccurredOn(untilRaw)) {
    throw eventError("Recurrence end date must be a valid calendar date (YYYY-MM-DD).");
  }
  const byWeekday = Array.isArray(raw.byWeekday)
    ? Array.from(new Set(raw.byWeekday
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6)))
        .sort((left, right) => left - right)
    : [];
  return { freq, interval, until: untilRaw, byWeekday };
}

function safeStoredEventTime(value) {
  try {
    return normalizeEventTime(value, "Event time");
  } catch {
    return "";
  }
}

// A timed event holds one or more time blocks (segments) on its date. A plain
// event is simply a single block; split events use several.
function normalizeEventSegments(raw, allDay) {
  if (allDay) {
    return [];
  }
  let source;
  if (Array.isArray(raw.segments)) {
    if (raw.segments.length > MAX_EVENT_SEGMENTS) {
      throw eventError(`An event can have at most ${MAX_EVENT_SEGMENTS} time blocks.`);
    }
    source = raw.segments;
  } else {
    source = [{ startTime: raw.startTime, endTime: raw.endTime }];
  }

  const segments = [];
  for (const entry of source) {
    const item = entry && typeof entry === "object" ? entry : {};
    const startTime = normalizeEventTime(item.startTime, "Time block start");
    const endTime = normalizeEventTime(item.endTime, "Time block end");
    if (!startTime && !endTime) {
      continue; // ignore a blank row
    }
    if (!startTime) {
      throw eventError("Each time block needs a start time.");
    }
    segments.push({ startTime, endTime });
  }
  if (!segments.length) {
    throw eventError("A timed event needs a start time.");
  }
  return segments;
}

function normalizeStoredEventSegments(value, allDay, startTime, endTime) {
  if (allDay) {
    return [];
  }
  const source = Array.isArray(value) ? value : [];
  const segments = [];
  for (const entry of source.slice(0, MAX_EVENT_SEGMENTS)) {
    const item = entry && typeof entry === "object" ? entry : {};
    const blockStart = safeStoredEventTime(item.startTime);
    if (!blockStart) {
      continue;
    }
    segments.push({ startTime: blockStart, endTime: safeStoredEventTime(item.endTime) });
  }
  if (segments.length) {
    return segments;
  }
  if (startTime) {
    return [{ startTime, endTime: endTime || "" }];
  }
  return [];
}

// Event attachments reuse the note/scene shape: base64 data URLs embedded in
// the profile JSON ({ id, name, type, size, data }).
function normalizeEventAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((att) => att && typeof att === "object" && typeof att.data === "string" && att.data)
    // Hard sanity cap only; the per-tier limit is enforced afterwards so an
    // over-limit request errors instead of silently dropping attachments.
    .slice(0, 64)
    .map((att) => ({
      id: String(att.id || `att_${crypto.randomBytes(6).toString("hex")}`),
      name: String(att.name || "attachment").trim().slice(0, 255) || "attachment",
      type: String(att.type || "application/octet-stream").trim().slice(0, 120) || "application/octet-stream",
      size: Math.max(0, Number(att.size) || 0),
      data: att.data
    }));
}

function normalizeStoredEventAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((att) => att && typeof att === "object")
    .map((att) => normalizeStoredAttachment(att))
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS_PER_EVENT);
}

function summarizeEventAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((att) => ({ id: att.id, name: att.name, type: att.type, size: att.size }))
    : [];
}

function assertEventAttachmentLimits(attachments, options = {}, occurrenceOverrides = []) {
  const maxPerEvent = Math.max(1, Number(options.maxAttachmentsPerEvent) || MAX_ATTACHMENTS_PER_EVENT);
  const maxBytes = resolveAttachmentBytesLimit(options);
  const lists = [Array.isArray(attachments) ? attachments : []];
  for (const override of Array.isArray(occurrenceOverrides) ? occurrenceOverrides : []) {
    lists.push(Array.isArray(override?.attachments) ? override.attachments : []);
  }
  for (const list of lists) {
    if (list.length > maxPerEvent) {
      throw new ProfileStorageError(
        "attachments_limit_reached",
        `An event can hold at most ${maxPerEvent} attachments for your access level.`
      );
    }
    for (const attachment of list) {
      const dataLength = typeof attachment?.data === "string" ? Buffer.byteLength(attachment.data, "utf8") : 0;
      const effectiveSize = Math.max(0, Number(attachment?.size) || Math.ceil(dataLength * 0.75));
      if (effectiveSize > maxBytes) {
        throw new ProfileStorageError(
          "attachment_too_large",
          `Attachments are limited to ${Math.round(maxBytes / (1024 * 1024))}MB for your access level.`
        );
      }
    }
  }
}

// Occurrence overrides let a single date of a recurring event carry its own
// attachments (e.g. that day's card draw) while the series keeps a default.
function normalizeOccurrenceOverrides(value, attachmentNormalizer) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const date = String(entry.date || "").trim();
    if (!isValidOccurredOn(date) || seen.has(date)) {
      continue;
    }
    const attachments = attachmentNormalizer(entry.attachments);
    if (!attachments.length) {
      continue; // an override with no attachments is just the series default
    }
    seen.add(date);
    result.push({ date, attachments });
  }
  result.sort((left, right) => left.date.localeCompare(right.date));
  return result.slice(0, MAX_EVENT_OCCURRENCE_OVERRIDES);
}

function normalizeStoredEventOccurrenceOverrides(value) {
  return normalizeOccurrenceOverrides(value, normalizeStoredEventAttachments);
}

function normalizeEventOccurrenceOverrides(value) {
  return normalizeOccurrenceOverrides(value, normalizeEventAttachments);
}

function findEventOccurrenceOverride(event, date) {
  const target = String(date || "").trim();
  if (!target || !Array.isArray(event?.occurrenceOverrides)) {
    return null;
  }
  return event.occurrenceOverrides.find((entry) => entry.date === target) || null;
}

// Effective attachments for one occurrence: the override if present, else the series default.
function resolveEventOccurrenceAttachments(event, date) {
  const override = findEventOccurrenceOverride(event, date);
  if (override && Array.isArray(override.attachments) && override.attachments.length) {
    return { attachments: override.attachments, hasOverride: true };
  }
  return { attachments: Array.isArray(event?.attachments) ? event.attachments : [], hasOverride: false };
}

function normalizeStoredEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const nowIso = new Date().toISOString();
  const createdAt = String(event.createdAt || nowIso).trim() || nowIso;
  let date = String(event.date || "").trim();
  if (!isValidOccurredOn(date)) {
    date = dateFromIso(createdAt);
  }
  let allDay = event.allDay === true;
  const legacyStart = allDay ? "" : safeStoredEventTime(event.startTime);
  const legacyEnd = allDay ? "" : safeStoredEventTime(event.endTime);
  let segments = normalizeStoredEventSegments(event.segments, allDay, legacyStart, legacyEnd);
  // Keep the stored event self-consistent with the strict writer validator:
  // a timed event without a usable time block degrades to all-day instead of
  // becoming un-editable on the next PATCH.
  if (!allDay && !segments.length) {
    allDay = true;
  }
  if (allDay) {
    segments = [];
  }
  const startTime = allDay ? "" : segments[0].startTime;
  const endTime = allDay ? "" : segments[0].endTime;
  const category = String(event.category || "personal").trim().toLowerCase();
  const color = String(event.color || "").trim().toLowerCase();
  return {
    id: String(event.id || `event_${crypto.randomBytes(8).toString("hex")}`),
    title: String(event.title || "").trim().slice(0, MAX_EVENT_TITLE_LENGTH) || "Untitled",
    notes: String(event.notes || "").slice(0, MAX_EVENT_NOTES_LENGTH),
    date,
    allDay,
    startTime,
    endTime,
    segments,
    attachments: normalizeStoredEventAttachments(event.attachments),
    occurrenceOverrides: normalizeStoredEventOccurrenceOverrides(event.occurrenceOverrides),
    location: String(event.location || "").trim().slice(0, MAX_EVENT_LOCATION_LENGTH),
    category: EVENT_CATEGORIES.has(category) ? category : "personal",
    color: EVENT_COLOR_PATTERN.test(color) ? color : "",
    linkedNoteId: String(event.linkedNoteId || "").trim().slice(0, MAX_EVENT_ID_LENGTH),
    recurrence: normalizeStoredEventRecurrence(event.recurrence),
    reminderMinutes: normalizeStoredEventReminder(event.reminderMinutes),
    createdAt,
    updatedAt: String(event.updatedAt || createdAt).trim() || createdAt
  };
}

function normalizeStoredEventRecurrence(value) {
  try {
    return normalizeEventRecurrence(value);
  } catch {
    return { freq: "none", interval: 1, until: "", byWeekday: [] };
  }
}

function normalizeStoredEventReminder(value) {
  try {
    return normalizeEventReminder(value);
  } catch {
    return null;
  }
}

function normalizeEventInput(input, { id, createdAt } = {}) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const nowIso = new Date().toISOString();
  const title = String(raw.title || "").trim();
  if (!title) {
    throw eventError("An event title is required.");
  }
  if (title.length > MAX_EVENT_TITLE_LENGTH) {
    throw eventError(`An event title cannot exceed ${MAX_EVENT_TITLE_LENGTH} characters.`);
  }
  const date = String(raw.date || "").trim();
  if (!isValidOccurredOn(date)) {
    throw eventError("An event date must be a valid calendar date (YYYY-MM-DD).");
  }
  const notes = String(raw.notes || "");
  if (notes.length > MAX_EVENT_NOTES_LENGTH) {
    throw eventError(`Event notes cannot exceed ${MAX_EVENT_NOTES_LENGTH} characters.`);
  }
  const location = String(raw.location || "").trim();
  if (location.length > MAX_EVENT_LOCATION_LENGTH) {
    throw eventError(`An event location cannot exceed ${MAX_EVENT_LOCATION_LENGTH} characters.`);
  }
  const linkedNoteId = String(raw.linkedNoteId || "").trim();
  if (linkedNoteId.length > MAX_EVENT_ID_LENGTH) {
    throw eventError(`A linked note id cannot exceed ${MAX_EVENT_ID_LENGTH} characters.`);
  }
  const allDay = raw.allDay === true;
  const segments = normalizeEventSegments(raw, allDay);
  const startTime = allDay ? "" : segments[0].startTime;
  const endTime = allDay ? "" : segments[0].endTime;
  const createdAtIso = String(createdAt || raw.createdAt || nowIso).trim() || nowIso;
  return {
    id: String(id || raw.id || `event_${crypto.randomBytes(8).toString("hex")}`),
    title,
    notes,
    date,
    allDay,
    startTime,
    endTime,
    segments,
    attachments: normalizeEventAttachments(raw.attachments),
    occurrenceOverrides: normalizeEventOccurrenceOverrides(raw.occurrenceOverrides),
    location,
    category: normalizeEventCategory(raw.category),
    color: normalizeEventColor(raw.color),
    linkedNoteId,
    recurrence: normalizeEventRecurrence(raw.recurrence),
    reminderMinutes: normalizeEventReminder(raw.reminderMinutes),
    createdAt: createdAtIso,
    updatedAt: nowIso
  };
}

function resolveEventsLimit(options = {}) {
  const numericValue = Number(options.maxEvents);
  const resolved = Number.isFinite(numericValue) && numericValue > 0
    ? Math.floor(numericValue)
    : MAX_EVENTS_PER_PROFILE;
  // The read normalizer holds at most MAX_EVENTS_PER_PROFILE, so a higher
  // configured limit would accept events that the write then discards.
  return Math.min(resolved, MAX_EVENTS_PER_PROFILE);
}

function cloneEvent(event) {
  return {
    ...event,
    segments: Array.isArray(event.segments)
      ? event.segments.map((segment) => ({ startTime: segment.startTime, endTime: segment.endTime }))
      : [],
    attachments: Array.isArray(event.attachments)
      ? event.attachments.map((att) => ({
          id: att.id,
          name: att.name,
          type: att.type,
          size: att.size,
          data: att.data
        }))
      : [],
    occurrenceOverrides: Array.isArray(event.occurrenceOverrides)
      ? event.occurrenceOverrides.map((override) => ({
          date: override.date,
          attachments: Array.isArray(override.attachments)
            ? override.attachments.map((att) => ({
                id: att.id,
                name: att.name,
                type: att.type,
                size: att.size,
                data: att.data
              }))
            : []
        }))
      : [],
    recurrence: {
      ...(event.recurrence || {}),
      byWeekday: Array.isArray(event.recurrence?.byWeekday) ? [...event.recurrence.byWeekday] : []
    }
  };
}

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const dateCmp = String(left.date || "").localeCompare(String(right.date || ""));
    if (dateCmp) {
      return dateCmp;
    }
    const leftTime = left.allDay ? "" : String(left.startTime || "");
    const rightTime = right.allDay ? "" : String(right.startTime || "");
    if (leftTime !== rightTime) {
      return leftTime.localeCompare(rightTime);
    }
    return String(left.title || "").localeCompare(String(right.title || ""));
  });
}

// Event notes can be up to 20KB each, so the list stays lightweight like
// listProfileNotes; use getProfileEvent for the full record.
function summarizeEvent(event) {
  const summary = cloneEvent(event);
  summary.noteLength = String(summary.notes || "").length;
  delete summary.notes;
  summary.attachmentCount = Array.isArray(summary.attachments) ? summary.attachments.length : 0;
  summary.attachments = summarizeEventAttachments(summary.attachments);
  return summary;
}

function listProfileEvents(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return sortEvents(profile.events || []).map(summarizeEvent);
}

function getProfileEvent(clientId, eventId, options = {}) {
  const profile = readProfile(clientId, options);
  const event = (profile.events || []).find((entry) => entry.id === String(eventId || "").trim()) || null;
  if (!event) {
    throw new ProfileStorageError("event_not_found", `Event '${eventId}' was not found.`);
  }
  return cloneEvent(event);
}

function findEventAttachment(profile, eventId, attachmentId) {
  const event = (profile?.events || []).find((entry) => entry.id === String(eventId || "").trim()) || null;
  if (!event) {
    return null;
  }
  const targetId = String(attachmentId || "").trim();
  const base = (event.attachments || []).find((entry) => entry.id === targetId);
  if (base) {
    return base;
  }
  for (const override of event.occurrenceOverrides || []) {
    const found = (override.attachments || []).find((entry) => entry.id === targetId);
    if (found) {
      return found;
    }
  }
  return null;
}

function findNoteAttachment(profile, noteId, sceneId, attachmentId) {
  const note = (profile?.notes || []).find((entry) => entry.id === String(noteId || "").trim()) || null;
  if (!note) {
    return null;
  }
  const scene = (note.scenes || []).find((entry) => entry.id === String(sceneId || "").trim()) || null;
  if (!scene) {
    return null;
  }
  return (scene.attachments || []).find((entry) => entry.id === String(attachmentId || "").trim()) || null;
}

function getProfileEventAttachment(clientId, eventId, attachmentId, options = {}) {
  const profile = readProfile(clientId, options);
  const event = (profile.events || []).find((entry) => entry.id === String(eventId || "").trim()) || null;
  if (!event) {
    throw new ProfileStorageError("event_not_found", `Event '${eventId}' was not found.`);
  }
  const attachment = findEventAttachment(profile, eventId, attachmentId);
  if (!attachment) {
    throw new ProfileStorageError("attachment_not_found", `Attachment '${attachmentId}' was not found.`);
  }
  return attachment;
}

// Attachments are stored as data URLs; decode to bytes for HTTP responses and
// for the ICS feed's download links.
function decodeAttachmentPayload(attachment) {
  const data = String(attachment?.data || "");
  const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(data);
  if (match) {
    return {
      type: match[1] || attachment?.type || "application/octet-stream",
      buffer: Buffer.from(match[3] || "", match[2] ? "base64" : "utf8")
    };
  }
  return {
    type: attachment?.type || "application/octet-stream",
    buffer: Buffer.from(data, "base64")
  };
}

const INLINE_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav"
]);

function sendStoredAttachment(response, attachment, options = {}) {
  const decoded = decodeAttachmentPayload(attachment);
  const type = String(decoded.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const imageOnly = options.imagesOnly === true;
  const safeType = INLINE_ATTACHMENT_TYPES.has(type) || type === "application/pdf";
  const inline = imageOnly
    ? type === "image/jpeg" || type === "image/png" || type === "image/gif" || type === "image/webp"
    : INLINE_ATTACHMENT_TYPES.has(type);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Content-Type", safeType ? type : "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment?.name || "file")}"`
  );
  response.setHeader("Cache-Control", options.cacheControl || "private, max-age=300");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.send(decoded.buffer);
}

function createProfileEvent(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const limit = resolveEventsLimit(options);
  if ((profile.events || []).length >= limit) {
    throw new ProfileStorageError("events_limit_reached", `A profile can hold at most ${limit} events for your access level.`);
  }
  const nowIso = new Date().toISOString();
  const event = normalizeEventInput(input, { createdAt: nowIso });
  assertEventAttachmentLimits(event.attachments, options, event.occurrenceOverrides);
  profile.events = [...(profile.events || []), event];
  profile.updatedAt = nowIso;
  const usage = writeProfile(clientId, profile, options);
  return { event: cloneEvent(event), usage };
}

function updateProfileEvent(clientId, eventId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const events = profile.events || [];
  const index = events.findIndex((entry) => entry.id === String(eventId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("event_not_found", `Event '${eventId}' was not found.`);
  }
  const existing = events[index];
  const overrides = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const merged = { ...existing, ...overrides };
  // Nested recurrence is merged field-wise so a partial PATCH (e.g. only
  // `freq`) keeps the stored interval/until/byWeekday.
  if (overrides.recurrence && typeof overrides.recurrence === "object" && !Array.isArray(overrides.recurrence)) {
    merged.recurrence = { ...(existing.recurrence || {}), ...overrides.recurrence };
  }
  const event = normalizeEventInput(merged, { id: existing.id, createdAt: existing.createdAt });
  assertEventAttachmentLimits(event.attachments, options, event.occurrenceOverrides);
  events[index] = event;
  profile.events = events;
  profile.updatedAt = event.updatedAt;
  const usage = writeProfile(clientId, profile, options);
  return { event: cloneEvent(event), usage };
}

function deleteProfileEvent(clientId, eventId, options = {}) {
  const profile = readProfile(clientId, options);
  const index = (profile.events || []).findIndex((entry) => entry.id === String(eventId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("event_not_found", `Event '${eventId}' was not found.`);
  }
  profile.events.splice(index, 1);
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { removed: true, usage };
}

// --- Calendar range expansion -------------------------------------------------

function parseIsoDateUtc(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatIsoDateUtc(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function diffUtcDays(left, right) {
  return Math.round((left.getTime() - right.getTime()) / 86400000);
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Expand an event's recurrence into concrete dates within [from, to] (inclusive).
function expandEventOccurrences(event, fromIso, toIso) {
  const from = parseIsoDateUtc(fromIso);
  const to = parseIsoDateUtc(toIso);
  const start = parseIsoDateUtc(event?.date);
  if (!event || !from || !to || !start || to < from) {
    return [];
  }

  const until = event.recurrence?.until ? parseIsoDateUtc(event.recurrence.until) : null;
  const hardEnd = until && until < to ? until : to;
  const freq = event.recurrence?.freq || "none";
  const intervalRaw = Number(event.recurrence?.interval);
  const interval = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.floor(intervalRaw) : 1;
  const occurrences = [];

  if (freq === "none") {
    if (start >= from && start <= to) {
      occurrences.push(event.date);
    }
    return occurrences;
  }

  const push = (date) => {
    if (occurrences.length >= MAX_EVENT_OCCURRENCES) {
      return false;
    }
    occurrences.push(formatIsoDateUtc(date));
    return true;
  };

  if (freq === "daily") {
    let cursor = start < from ? from : start;
    const offset = diffUtcDays(cursor, start) % interval;
    if (offset !== 0) {
      cursor = addUtcDays(cursor, interval - offset);
    }
    for (; cursor <= hardEnd; cursor = addUtcDays(cursor, interval)) {
      if (!push(cursor)) break;
    }
    return occurrences;
  }

  if (freq === "weekly") {
    const weekdays = Array.isArray(event.recurrence?.byWeekday) && event.recurrence.byWeekday.length
      ? event.recurrence.byWeekday
      : [start.getUTCDay()];
    const anchor = addUtcDays(start, -start.getUTCDay()); // Sunday of the event's week
    let cursor = start < from ? from : start;
    for (; cursor <= hardEnd; cursor = addUtcDays(cursor, 1)) {
      if (!weekdays.includes(cursor.getUTCDay())) continue;
      const weekOffset = Math.floor(diffUtcDays(cursor, anchor) / 7);
      if (weekOffset % interval !== 0) continue;
      if (!push(cursor)) break;
    }
    return occurrences;
  }

  if (freq === "monthly") {
    const day = start.getUTCDate();
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const fromMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (cursor < fromMonth) {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + interval, 1));
    }
    for (; cursor <= hardEnd; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + interval, 1))) {
      if (daysInUtcMonth(cursor.getUTCFullYear(), cursor.getUTCMonth()) < day) continue;
      const candidate = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day));
      if (candidate < start || candidate < from) continue;
      if (!push(candidate)) break;
    }
    return occurrences;
  }

  if (freq === "yearly") {
    const month = start.getUTCMonth();
    const day = start.getUTCDate();
    let year = start.getUTCFullYear();
    while (year < from.getUTCFullYear()) {
      year += interval;
    }
    for (;; year += interval) {
      if (daysInUtcMonth(year, month) < day) continue;
      const candidate = new Date(Date.UTC(year, month, day));
      if (candidate > hardEnd) break;
      if (candidate < start || candidate < from) continue;
      if (!push(candidate)) break;
    }
    return occurrences;
  }

  return occurrences;
}

function normalizeEventRangeBound(value, fallback) {
  const iso = String(value || "").trim();
  if (!iso) {
    return fallback;
  }
  if (!isValidOccurredOn(iso)) {
    throw new ProfileStorageError("invalid_event_range", "Event range dates must be valid calendar dates (YYYY-MM-DD).");
  }
  return iso;
}

function summarizeOccurrence(event, date) {
  const summary = cloneEvent(event);
  const resolved = resolveEventOccurrenceAttachments(summary, date);
  summary.attachments = resolved.attachments;
  summary.noteLength = String(summary.notes || "").length;
  delete summary.notes;
  summary.attachmentCount = Array.isArray(summary.attachments) ? summary.attachments.length : 0;
  summary.attachments = summarizeEventAttachments(summary.attachments);
  return {
    ...summary,
    eventId: event.id,
    id: `${event.id}#${date}`,
    date,
    segmentCount: Array.isArray(summary.segments) ? summary.segments.length : 0,
    hasOccurrenceOverride: resolved.hasOverride,
    isRecurring: (event.recurrence?.freq || "none") !== "none",
    source: "user"
  };
}

function listProfileEventsInRange(clientId, fromInput, toInput, options = {}) {
  const today = dateFromIso(new Date().toISOString());
  const from = normalizeEventRangeBound(fromInput, today);
  const to = normalizeEventRangeBound(toInput, from);
  const fromDate = parseIsoDateUtc(from);
  const toDate = parseIsoDateUtc(to);
  if (!fromDate || !toDate || toDate < fromDate) {
    throw new ProfileStorageError("invalid_event_range", "The end of the range must be on or after the start.");
  }
  if (diffUtcDays(toDate, fromDate) > MAX_EVENT_RANGE_DAYS) {
    throw new ProfileStorageError(
      "invalid_event_range",
      `Event ranges cannot exceed ${MAX_EVENT_RANGE_DAYS} days.`
    );
  }

  const profile = readProfile(clientId, options);
  const occurrences = [];
  for (const event of profile.events || []) {
    for (const date of expandEventOccurrences(event, from, to)) {
      occurrences.push(summarizeOccurrence(event, date));
    }
  }
  return sortEvents(occurrences);
}

// --- Calendar subscription feed ----------------------------------------------

function normalizeStoredCalendarFeed(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const token = String(source.token || "").trim();
  // Layers/notesFormat stay absent until the user saves a selection: the feed
  // uses their presence to tell a saved subscription from a legacy ?layers= URL.
  const hasLayers = Array.isArray(source.layers) || (typeof source.layers === "string" && source.layers.trim());
  const notesFormat = String(source.notesFormat || "").trim().toLowerCase();
  return {
    enabled: source.enabled === true && Boolean(token),
    token,
    ...(hasLayers ? { layers: normalizeCalendarFeedLayers(source.layers) } : {}),
    ...(notesFormat === "journal" || notesFormat === "events" ? { notesFormat } : {}),
    ...(source.options && typeof source.options === "object" ? { options: normalizeCalendarFeedOptions(source.options) } : {}),
    createdAt: String(source.createdAt || "").trim(),
    updatedAt: String(source.updatedAt || "").trim()
  };
}

// Per-calendar display options (moon phases to include, astrology boundary size).
// An explicit array is honoured even when empty (means "none"); only an absent
// value falls back to all phases.
function normalizeCalendarFeedOptions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hasPhases = Array.isArray(source.moonPhases);
  const phases = hasPhases
    ? [...new Set(source.moonPhases
        .map((phase) => String(phase || "").trim().toLowerCase())
        .filter((phase) => CALENDAR_MOON_PHASES.includes(phase)))]
    : [...CALENDAR_MOON_PHASES];
  const detailRaw = String(source.astrologyDetail || "").trim().toLowerCase();
  return {
    moonPhases: phases,
    astrologyDetail: CALENDAR_ASTROLOGY_DETAILS.includes(detailRaw) ? detailRaw : "decan"
  };
}

// Older feeds may carry the split sky layers; fold them into the simplified
// `moon` / `astrology` names instead of dropping them.
const CALENDAR_FEED_LAYER_ALIASES = Object.freeze({
  decan: "astrology",
  "moon-full": "moon",
  "moon-new": "moon",
  "planetary-hours": "planetary"
});

function aliasCalendarFeedLayer(layer) {
  const name = String(layer || "").trim().toLowerCase();
  return CALENDAR_FEED_LAYER_ALIASES[name] || name;
}

function profileFeedHasLayer(profile, layer) {
  const stored = profile?.calendarFeed && typeof profile.calendarFeed === "object" ? profile.calendarFeed : {};
  // No saved selection yet: a legacy feed still honors its URL, so do not revoke.
  if (!Array.isArray(stored.layers)) return true;
  const layers = normalizeCalendarFeedLayers(stored.layers);
  return layers.includes(aliasCalendarFeedLayer(layer));
}

function normalizeCalendarFeedLayers(value) {
  const known = new Set(CALENDAR_FEED_LAYERS);
  const explicit = Array.isArray(value) || (typeof value === "string" && value.trim() !== "");
  const requested = (Array.isArray(value) ? value : String(value || "").split(","))
    .map((entry) => aliasCalendarFeedLayer(entry))
    .filter((entry) => known.has(entry));
  const unique = [...new Set(requested)];
  if (unique.length) {
    return unique;
  }
  // An explicit empty selection means "no layers"; only an absent value falls
  // back to the defaults.
  return explicit ? [] : [...DEFAULT_CALENDAR_FEED_LAYERS];
}

function generateCalendarFeedToken(clientId) {
  const idPart = Buffer.from(String(clientId), "utf8").toString("base64url");
  const secret = crypto.randomBytes(24).toString("base64url");
  return `${FEED_TOKEN_PREFIX}.${idPart}.${secret}`;
}

function buildCalendarFeedPath(token) {
  return `/api/v1/calendar/feed.ics?token=${encodeURIComponent(token)}`;
}

function getProfileCalendarFeed(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  const feed = normalizeStoredCalendarFeed(profile.calendarFeed);
  return {
    enabled: feed.enabled,
    token: feed.token,
    path: feed.token ? buildCalendarFeedPath(feed.token) : "",
    layers: feed.layers || [...DEFAULT_CALENDAR_FEED_LAYERS],
    layersSaved: Array.isArray(feed.layers),
    notesFormat: feed.notesFormat || "events",
    options: feed.options || normalizeCalendarFeedOptions(null),
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt
  };
}

function updateProfileCalendarFeed(clientId, input, options = {}) {
  const action = String(input?.action || "").trim().toLowerCase();
  const hasLayers = input?.layers !== undefined;
  const hasFormat = input?.notesFormat !== undefined;
  const hasOptions = input?.options !== undefined;
  if (action && !["enable", "disable", "rotate"].includes(action)) {
    throw new ProfileStorageError("invalid_feed_action", "Feed action must be enable, disable, or rotate.");
  }
  if (!action && !hasLayers && !hasFormat && !hasOptions) {
    throw new ProfileStorageError("invalid_feed_action", "Provide an action or feed settings to update.");
  }
  const profile = readProfile(clientId, options);
  const existing = normalizeStoredCalendarFeed(profile.calendarFeed);
  const nowIso = new Date().toISOString();
  let token = existing.token;
  if (action === "rotate" || (action === "enable" && !token)) {
    token = generateCalendarFeedToken(clientId);
  }
  const enabled = action === "disable" ? false : action === "enable" ? true : existing.enabled;
  // Only persist a selection when one is given, so a feed that was merely
  // enabled keeps honoring a legacy ?layers= URL until the user saves one.
  const rawFeed = profile.calendarFeed && typeof profile.calendarFeed === "object" ? profile.calendarFeed : {};
  const previousLayers = Array.isArray(rawFeed.layers) ? normalizeCalendarFeedLayers(rawFeed.layers) : null;
  const previousFormat = rawFeed.notesFormat === "journal" ? "journal" : (rawFeed.notesFormat === "events" ? "events" : null);
  const nextLayers = hasLayers ? normalizeCalendarFeedLayers(input.layers) : previousLayers;
  const nextFormat = hasFormat
    ? (String(input.notesFormat || "").trim().toLowerCase() === "journal" ? "journal" : "events")
    : previousFormat;
  const previousOptions = rawFeed.options && typeof rawFeed.options === "object"
    ? normalizeCalendarFeedOptions(rawFeed.options)
    : null;
  const nextOptions = hasOptions ? normalizeCalendarFeedOptions(input.options) : previousOptions;
  profile.calendarFeed = {
    enabled,
    token,
    ...(nextLayers ? { layers: nextLayers } : {}),
    ...(nextFormat ? { notesFormat: nextFormat } : {}),
    ...(nextOptions ? { options: nextOptions } : {}),
    createdAt: existing.createdAt || nowIso,
    updatedAt: nowIso
  };
  profile.updatedAt = nowIso;
  const usage = writeProfile(clientId, profile, options);
  const feed = normalizeStoredCalendarFeed(profile.calendarFeed);
  return {
    feed: {
      enabled: feed.enabled,
      token: feed.token,
      path: buildCalendarFeedPath(feed.token),
    layers: feed.layers || [...DEFAULT_CALENDAR_FEED_LAYERS],
    layersSaved: Array.isArray(feed.layers),
      notesFormat: feed.notesFormat || "events",
      options: feed.options || normalizeCalendarFeedOptions(null),
      createdAt: feed.createdAt,
      updatedAt: feed.updatedAt
    },
    usage
  };
}

function resolveClientIdFromFeedToken(token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== FEED_TOKEN_PREFIX) {
    return "";
  }
  try {
    return Buffer.from(parts[1], "base64url").toString("utf8").trim();
  } catch {
    return "";
  }
}

// Returns the owning profile for a valid, enabled feed token, or null.
function resolveCalendarFeedToken(token, options = {}) {
  const rawToken = String(token || "").trim();
  const clientId = resolveClientIdFromFeedToken(rawToken);
  if (!clientId) {
    return null;
  }
  let profile;
  try {
    profile = readProfile(clientId, options);
  } catch {
    return null;
  }
  const feed = normalizeStoredCalendarFeed(profile.calendarFeed);
  if (!feed.enabled || feed.token !== rawToken) {
    return null;
  }
  return { clientId, profile };
}

// --- Share links -------------------------------------------------------------

const LINK_KINDS = new Set(["message", "calendar", "note", "widget", "other"]);

function normalizeLinkKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  return LINK_KINDS.has(raw) ? raw : "message";
}

// "internal" content is only reachable while authenticated (in the owner's
// inbox); "public" content can be opened by anyone holding the link token.
function normalizeVisibility(value, fallback = "internal") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "public" || raw === "internal") {
    return raw;
  }
  return fallback;
}

function normalizeLinkDescription(value) {
  const raw = String(value || "");
  if (raw.length > MAX_LINK_DESCRIPTION_LENGTH) {
    throw new ProfileStorageError("invalid_link", `A link description cannot exceed ${MAX_LINK_DESCRIPTION_LENGTH} characters.`);
  }
  return raw;
}

function normalizeLinkExpiresAt(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProfileStorageError("invalid_link", "Link expiry must be an ISO date-time.");
  }
  return parsed.toISOString();
}

function normalizeLinkInput(input, { id, token, createdAt } = {}) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const nowIso = new Date().toISOString();
  const title = String(raw.title || "").trim();
  if (!title) {
    throw new ProfileStorageError("invalid_link", "A link title is required.");
  }
  if (title.length > MAX_LINK_TITLE_LENGTH) {
    throw new ProfileStorageError("invalid_link", `A link title cannot exceed ${MAX_LINK_TITLE_LENGTH} characters.`);
  }
  return {
    id: String(id || raw.id || `lnk_${crypto.randomBytes(8).toString("hex")}`),
    kind: normalizeLinkKind(raw.kind),
    title,
    description: normalizeLinkDescription(raw.description),
    visibility: normalizeVisibility(raw.visibility, "internal"),
    attachments: normalizeEventAttachments(raw.attachments),
    token: String(token || raw.token || ""),
    expiresAt: normalizeLinkExpiresAt(raw.expiresAt),
    createdAt: String(createdAt || raw.createdAt || nowIso),
    updatedAt: nowIso
  };
}

function normalizeStoredLink(link) {
  if (!link || typeof link !== "object") {
    return null;
  }
  const createdAt = String(link.createdAt || new Date().toISOString());
  const kind = String(link.kind || "message").trim().toLowerCase();
  return {
    id: String(link.id || `lnk_${crypto.randomBytes(8).toString("hex")}`),
    kind: LINK_KINDS.has(kind) ? kind : "message",
    visibility: normalizeVisibility(link.visibility, "internal"),
    title: String(link.title || "").trim().slice(0, MAX_LINK_TITLE_LENGTH) || "Shared item",
    description: String(link.description || "").slice(0, MAX_LINK_DESCRIPTION_LENGTH),
    attachments: normalizeStoredEventAttachments(link.attachments).slice(0, MAX_ATTACHMENTS_PER_LINK),
    token: String(link.token || "").trim(),
    expiresAt: String(link.expiresAt || "").trim(),
    createdAt,
    updatedAt: String(link.updatedAt || createdAt)
  };
}

function normalizeStoredLinks(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeStoredLink(entry)).filter(Boolean).slice(-MAX_LINKS_PER_PROFILE);
}

function assertLinkAttachmentLimits(attachments, options = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length > MAX_ATTACHMENTS_PER_LINK) {
    throw new ProfileStorageError(
      "attachments_limit_reached",
      `A link can hold at most ${MAX_ATTACHMENTS_PER_LINK} attachments.`
    );
  }
  const maxBytes = resolveAttachmentBytesLimit(options);
  for (const attachment of list) {
    const dataLength = typeof attachment?.data === "string" ? Buffer.byteLength(attachment.data, "utf8") : 0;
    const effectiveSize = Math.max(0, Number(attachment?.size) || Math.ceil(dataLength * 0.75));
    if (effectiveSize > maxBytes) {
      throw new ProfileStorageError(
        "attachment_too_large",
        `Attachments are limited to ${Math.round(maxBytes / (1024 * 1024))}MB for your access level.`
      );
    }
  }
}

function cloneLink(link) {
  return {
    ...link,
    attachments: Array.isArray(link.attachments) ? link.attachments.map((att) => ({ ...att })) : []
  };
}

function summarizeLink(link) {
  const summary = cloneLink(link);
  summary.attachmentCount = summary.attachments.length;
  summary.attachments = summarizeEventAttachments(summary.attachments);
  summary.path = buildSharePath(summary.token);
  return summary;
}

function generateShareToken(clientId) {
  const idPart = Buffer.from(String(clientId), "utf8").toString("base64url");
  const secret = crypto.randomBytes(18).toString("base64url");
  return `${SHARE_TOKEN_PREFIX}.${idPart}.${secret}`;
}

function buildSharePath(token) {
  return `/api/v1/share/${encodeURIComponent(String(token || ""))}`;
}

function listProfileLinks(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return (profile.links || []).map(summarizeLink);
}

function getProfileLink(clientId, linkId, options = {}) {
  const profile = readProfile(clientId, options);
  const link = (profile.links || []).find((entry) => entry.id === String(linkId || "").trim()) || null;
  if (!link) {
    throw new ProfileStorageError("link_not_found", `Link '${linkId}' was not found.`);
  }
  return cloneLink(link);
}

function createProfileLink(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  if ((profile.links || []).length >= MAX_LINKS_PER_PROFILE) {
    throw new ProfileStorageError("links_limit_reached", `A profile can hold at most ${MAX_LINKS_PER_PROFILE} links.`);
  }
  const link = normalizeLinkInput(input, { token: generateShareToken(clientId) });
  assertLinkAttachmentLimits(link.attachments, options);
  profile.links = [...(profile.links || []), link];
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { link: cloneLink(link), usage };
}

function updateProfileLink(clientId, linkId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const links = profile.links || [];
  const index = links.findIndex((entry) => entry.id === String(linkId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("link_not_found", `Link '${linkId}' was not found.`);
  }
  const existing = links[index];
  const overrides = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const link = normalizeLinkInput({ ...existing, ...overrides }, {
    id: existing.id,
    token: existing.token,
    createdAt: existing.createdAt
  });
  assertLinkAttachmentLimits(link.attachments, options);
  links[index] = link;
  profile.links = links;
  profile.updatedAt = link.updatedAt;
  const usage = writeProfile(clientId, profile, options);
  return { link: cloneLink(link), usage };
}

function deleteProfileLink(clientId, linkId, options = {}) {
  const profile = readProfile(clientId, options);
  const links = profile.links || [];
  const index = links.findIndex((entry) => entry.id === String(linkId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("link_not_found", `Link '${linkId}' was not found.`);
  }
  links.splice(index, 1);
  profile.links = links;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { removed: true, usage };
}

function resolveProfileLinkToken(token, options = {}) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== SHARE_TOKEN_PREFIX) {
    return null;
  }
  let clientId = "";
  try {
    clientId = Buffer.from(parts[1], "base64url").toString("utf8").trim();
  } catch {
    return null;
  }
  if (!clientId) {
    return null;
  }
  let profile;
  try {
    profile = readProfile(clientId, options);
  } catch {
    return null;
  }
  const link = (profile.links || []).find((entry) => entry.token === raw) || null;
  if (!link) {
    return null;
  }
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) {
    return null;
  }
  return { clientId, profile, link };
}

// Share links are signed with the profile's feed token so rotating the feed URL
// also revokes every previously shared attachment link.
function resolveShareSecret(profile) {
  const feed = normalizeStoredCalendarFeed(profile?.calendarFeed);
  return feed.enabled && feed.token ? feed.token : "";
}

function buildAttachmentShareUrl(profile, ref) {
  const secret = resolveShareSecret(profile);
  if (!secret) {
    return "";
  }
  return buildSharePath(buildSignedShareToken(ref, secret));
}

function resolveSignedShareAttachment(token, options = {}) {
  const context = resolveSignedShareTokenContext(token, {
    loadProfile: (clientId) => readProfile(clientId, options),
    resolveSecret: resolveShareSecret
  });
  if (!context) {
    return null;
  }
  const { clientId, profile, verified } = context;

  if (verified.t === "e") {
    if (!profileFeedHasLayer(profile, "user")) {
      return null;
    }
    const event = (profile.events || []).find((entry) => entry.id === verified.e) || null;
    if (!event) {
      return null;
    }
    const attachment = findEventAttachment(profile, verified.e, verified.a);
    if (!attachment) {
      return null;
    }
    const time = event.allDay
      ? "All day"
      : [event.startTime, event.endTime].filter(Boolean).join("–");
    return {
      clientId,
      attachment,
      kind: event.category || "calendar",
      title: event.title,
      metaLines: [event.date, time]
    };
  }

  if (verified.t === "n") {
    if (!profileFeedHasLayer(profile, "notes") || normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY) !== "public") {
      return null;
    }
    const note = (profile.notes || []).find((entry) => entry.id === verified.n) || null;
    if (!note) {
      return null;
    }
    const scene = (note.scenes || []).find((entry) => entry.id === verified.s) || null;
    const attachment = findNoteAttachment(profile, verified.n, verified.s, verified.a);
    if (!attachment) {
      return null;
    }
    return {
      clientId,
      attachment,
      kind: note.kind === "dream" ? "dream" : "journal",
      title: note.title,
      metaLines: [
        note.occurredOn,
        scene?.place || "",
        scene?.time ? `${scene.time}${scene.endTime ? `–${scene.endTime}` : ""}` : ""
      ]
    };
  }

  return null;
}

// --- Inbox messages ----------------------------------------------------------

const MESSAGE_KINDS = new Set(["message", "report", "alert", "calendar", "note", "widget", "other"]);

function normalizeMessageFieldKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MESSAGE_KINDS.has(raw) ? raw : "message";
}

// Shared with the broadcast store so message shape stays consistent.
function normalizeMessageInputFields(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const title = String(source.title || "").trim();
  if (!title) {
    throw new ProfileStorageError("invalid_message", "A message title is required.");
  }
  if (title.length > MAX_LINK_TITLE_LENGTH) {
    throw new ProfileStorageError("invalid_message", `A message title cannot exceed ${MAX_LINK_TITLE_LENGTH} characters.`);
  }
  return {
    kind: normalizeMessageFieldKind(source.kind),
    title,
    description: normalizeLinkDescription(source.description),
    bodyHtml: sanitizeMessageHtml(source.bodyHtml),
    visibility: normalizeVisibility(source.visibility, "internal"),
    attachments: normalizeEventAttachments(source.attachments),
    publishAt: normalizeLinkExpiresAt(source.publishAt),
    expiresAt: normalizeLinkExpiresAt(source.expiresAt),
    requiresAck: source.requiresAck === true
  };
}

function normalizeStoredMessageFields(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const kind = String(source.kind || "message").trim().toLowerCase();
  return {
    kind: MESSAGE_KINDS.has(kind) ? kind : "message",
    title: String(source.title || "").trim().slice(0, MAX_LINK_TITLE_LENGTH) || "Message",
    description: String(source.description || "").slice(0, MAX_LINK_DESCRIPTION_LENGTH),
    bodyHtml: sanitizeMessageHtml(source.bodyHtml),
    visibility: normalizeVisibility(source.visibility, "internal"),
    attachments: normalizeStoredEventAttachments(source.attachments).slice(0, MAX_ATTACHMENTS_PER_LINK),
    publishAt: String(source.publishAt || "").trim(),
    expiresAt: String(source.expiresAt || "").trim(),
    requiresAck: source.requiresAck === true
  };
}

// --- Quiet hours --------------------------------------------------------------
// Unread alerts are held out of the inbox during a user's quiet window.

const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, start: "22:00", end: "07:00" });

function normalizeQuietHoursTime(value, label, fallback) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) {
    return fallback;
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new ProfileStorageError("invalid_quiet_hours", `${label} must be HH:MM.`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new ProfileStorageError("invalid_quiet_hours", `${label} must be a valid time.`);
  }
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function normalizeQuietHoursInput(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: raw.enabled === true,
    start: normalizeQuietHoursTime(raw.start, "Quiet hours start", DEFAULT_QUIET_HOURS.start),
    end: normalizeQuietHoursTime(raw.end, "Quiet hours end", DEFAULT_QUIET_HOURS.end)
  };
}

function normalizeStoredQuietHours(value) {
  try {
    return normalizeQuietHoursInput(value);
  } catch {
    return { ...DEFAULT_QUIET_HOURS };
  }
}

function updateProfileQuietHours(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  profile.quietHours = normalizeQuietHoursInput(input);
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { quietHours: profile.quietHours, usage };
}

function generateDirectMessageToken(clientId) {
  const idPart = Buffer.from(String(clientId), "utf8").toString("base64url");
  const secret = crypto.randomBytes(18).toString("base64url");
  return `${MESSAGE_DIRECT_PREFIX}.${idPart}.${secret}`;
}

function normalizeStoredMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const createdAt = String(message.createdAt || new Date().toISOString());
  return {
    id: String(message.id || `msg_${crypto.randomBytes(8).toString("hex")}`),
    ...normalizeStoredMessageFields(message),
    token: String(message.token || "").trim(),
    sender: String(message.sender || "").trim().slice(0, 120),
    createdAt,
    updatedAt: String(message.updatedAt || createdAt)
  };
}

function normalizeStoredMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeStoredMessage(entry)).filter(Boolean).slice(-MAX_MESSAGES_PER_PROFILE);
}

function normalizeInboxRead(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, iso] of Object.entries(source)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      continue;
    }
    result[normalizedKey] = String(iso || "").trim() || new Date().toISOString();
  }
  return result;
}

function cloneMessage(message) {
  return {
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments.map((att) => ({ ...att })) : []
  };
}

function summarizeMessage(message) {
  const summary = cloneMessage(message);
  summary.attachmentCount = summary.attachments.length;
  summary.attachments = summarizeEventAttachments(summary.attachments);
  return summary;
}

function listProfileMessages(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return (profile.messages || []).map(summarizeMessage);
}

function addProfileMessage(clientId, input, { sender = "" } = {}, options = {}) {
  const profile = readProfile(clientId, options);
  if ((profile.messages || []).length >= MAX_MESSAGES_PER_PROFILE) {
    throw new ProfileStorageError("messages_limit_reached", `An inbox can hold at most ${MAX_MESSAGES_PER_PROFILE} messages.`);
  }
  const nowIso = new Date().toISOString();
  const fields = normalizeMessageInputFields(input);
  assertEventAttachmentLimits(fields.attachments, options);
  const message = {
    id: `msg_${crypto.randomBytes(8).toString("hex")}`,
    ...fields,
    token: generateDirectMessageToken(clientId),
    sender: String(sender || "").trim().slice(0, 120),
    createdAt: nowIso,
    updatedAt: nowIso
  };
  profile.messages = [...(profile.messages || []), message];
  profile.updatedAt = nowIso;
  const usage = writeProfile(clientId, profile, options);
  return { message: cloneMessage(message), usage };
}

function deleteProfileMessage(clientId, messageId, options = {}) {
  const profile = readProfile(clientId, options);
  const messages = profile.messages || [];
  const index = messages.findIndex((entry) => entry.id === String(messageId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("message_not_found", `Message '${messageId}' was not found.`);
  }
  messages.splice(index, 1);
  profile.messages = messages;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { removed: true, usage };
}

function getProfileInboxReadMap(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return normalizeInboxRead(profile.inboxRead);
}

function markProfileInboxRead(clientId, keys, options = {}) {
  const profile = readProfile(clientId, options);
  const read = normalizeInboxRead(profile.inboxRead);
  const nowIso = new Date().toISOString();
  const list = Array.isArray(keys) ? keys : [keys];
  let changed = 0;
  for (const key of list) {
    const normalized = String(key || "").trim();
    if (!normalized || read[normalized]) {
      continue;
    }
    read[normalized] = nowIso;
    changed += 1;
  }
  if (changed) {
    profile.inboxRead = read;
    profile.updatedAt = nowIso;
    writeProfile(clientId, profile, options);
  }
  return { read: { ...read }, changed };
}

function resolveDirectMessageToken(token, options = {}) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== MESSAGE_DIRECT_PREFIX) {
    return null;
  }
  let clientId = "";
  try {
    clientId = Buffer.from(parts[1], "base64url").toString("utf8").trim();
  } catch {
    return null;
  }
  if (!clientId) {
    return null;
  }
  let profile;
  try {
    profile = readProfile(clientId, options);
  } catch {
    return null;
  }
  const message = (profile.messages || []).find((entry) => entry.token === raw) || null;
  if (!message) {
    return null;
  }
  return { clientId, profile, message };
}

function computeQuizStats(attempts) {
  const byCategory = new Map();

  attempts.forEach((attempt) => {
    const categoryId = String(attempt.categoryId || "");
    const entry = byCategory.get(categoryId) || {
      categoryId,
      attempts: 0,
      totalQuestions: 0,
      totalCorrect: 0,
      accuracy: 0,
      lastAttemptAt: ""
    };
    entry.attempts += 1;
    entry.totalQuestions += attempt.total;
    entry.totalCorrect += attempt.score;
    if (!entry.lastAttemptAt || String(attempt.completedAt) > String(entry.lastAttemptAt)) {
      entry.lastAttemptAt = attempt.completedAt;
    }
    byCategory.set(categoryId, entry);
  });

  const categories = [...byCategory.values()].map((entry) => ({
    ...entry,
    accuracy: entry.totalQuestions > 0
      ? Math.round((entry.totalCorrect / entry.totalQuestions) * 1000) / 1000
      : 0
  }));

  const totalQuestions = attempts.reduce((sum, attempt) => sum + attempt.total, 0);
  const totalCorrect = attempts.reduce((sum, attempt) => sum + attempt.score, 0);

  // High scores per difficulty: best accuracy first, then the larger run.
  const byDifficulty = ["easy", "normal", "hard"].map((difficulty) => {
    const list = attempts.filter((attempt) => String(attempt.difficulty || "normal").toLowerCase() === difficulty);
    const difficultyTotal = list.reduce((sum, attempt) => sum + attempt.total, 0);
    const difficultyCorrect = list.reduce((sum, attempt) => sum + attempt.score, 0);
    let best = null;
    list.forEach((attempt) => {
      const candidate = {
        score: attempt.score,
        total: attempt.total,
        accuracy: attempt.total > 0 ? Math.round((attempt.score / attempt.total) * 1000) / 1000 : 0,
        completedAt: attempt.completedAt
      };
      if (
        !best
        || candidate.accuracy > best.accuracy
        || (candidate.accuracy === best.accuracy && candidate.total > best.total)
      ) {
        best = candidate;
      }
    });
    return {
      difficulty,
      attempts: list.length,
      totalQuestions: difficultyTotal,
      totalCorrect: difficultyCorrect,
      accuracy: difficultyTotal > 0 ? Math.round((difficultyCorrect / difficultyTotal) * 1000) / 1000 : 0,
      best
    };
  });

  return {
    overall: {
      attempts: attempts.length,
      totalQuestions,
      totalCorrect,
      accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 1000) / 1000 : 0
    },
    byDifficulty,
    categories
  };
}

function getProfileQuizProgress(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  const attempts = [...profile.quiz.attempts].reverse();
  return {
    count: attempts.length,
    stats: computeQuizStats(profile.quiz.attempts),
    attempts: attempts.slice(0, 100)
  };
}

function recordQuizAttempt(clientId, input, options = {}) {
  const categoryId = String(input?.categoryId || "").trim();
  const templateKey = String(input?.templateKey || "").trim();
  const difficulty = String(input?.difficulty || "").trim();
  const score = Number(input?.score);
  const total = Number(input?.total);

  if (!Number.isInteger(score) || score < 0) {
    throw new ProfileStorageError("invalid_quiz_attempt", "A quiz attempt score must be a non-negative integer.");
  }
  if (!Number.isInteger(total) || total <= 0) {
    throw new ProfileStorageError("invalid_quiz_attempt", "A quiz attempt total must be a positive integer.");
  }
  if (score > total) {
    throw new ProfileStorageError("invalid_quiz_attempt", "A quiz attempt score cannot exceed its total.");
  }

  const nowIso = new Date().toISOString();
  const attempt = {
    id: `attempt_${crypto.randomBytes(8).toString("hex")}`,
    categoryId,
    templateKey,
    difficulty,
    score,
    total,
    accuracy: Math.round((score / total) * 1000) / 1000,
    completedAt: String(input?.completedAt || nowIso).trim() || nowIso
  };

  const profile = readProfile(clientId, options);
  profile.quiz.attempts.push(attempt);
  if (profile.quiz.attempts.length > MAX_QUIZ_ATTEMPTS_PER_PROFILE) {
    profile.quiz.attempts = profile.quiz.attempts.slice(-MAX_QUIZ_ATTEMPTS_PER_PROFILE);
  }

  const usage = writeProfile(clientId, profile, options);
  return {
    attempt,
    usage
  };
}

function getProfileBio(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return {
    clientId: profile.clientId,
    bio: profile.bio || ""
  };
}

function getProfilePage(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return {
    clientId: profile.clientId,
    pageHtml: profile.pageHtml || ""
  };
}

function updateProfilePage(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const pageHtml = sanitizeMessageHtml(input?.pageHtml ?? input?.html ?? "").slice(0, MAX_HTML_LENGTH);
  profile.pageHtml = pageHtml;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    pageHtml,
    usage
  };
}

const PROFILE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function normalizeProfileImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const type = String(value.type || "").trim().toLowerCase().split(";")[0];
  const data = String(value.data || "");
  if (!PROFILE_IMAGE_TYPES.has(type) || !data.startsWith("data:image/")) {
    return undefined;
  }
  const size = Math.max(0, Number(value.size) || Math.ceil(data.length * 0.75));
  if (size > MAX_PROFILE_IMAGE_BYTES) {
    return undefined;
  }
  return { type, data, size };
}

function getProfileImage(clientId, kind, options = {}) {
  const profile = readProfile(clientId, options);
  const image = kind === "banner" ? profile.banner : profile.avatar;
  if (!image?.data) {
    throw new ProfileStorageError("image_not_found", "No image uploaded.");
  }
  return image;
}

function updateProfileImage(clientId, kind, input, options = {}) {
  const profile = readProfile(clientId, options);
  const decoded = decodeAttachmentPayload({ data: input?.data || input?.image || "", type: input?.type });
  const type = String(decoded.type || "").toLowerCase().split(";")[0];
  if (!PROFILE_IMAGE_TYPES.has(type)) {
    throw new ProfileStorageError("invalid_image", "Upload a JPEG, PNG, WebP, or GIF.");
  }
  if (!decoded.buffer.length || decoded.buffer.length > MAX_PROFILE_IMAGE_BYTES) {
    throw new ProfileStorageError("image_too_large", "That image is too large (2MB max).");
  }
  const stored = {
    type,
    data: `data:${type};base64,${decoded.buffer.toString("base64")}`,
    size: decoded.buffer.length
  };
  if (kind === "banner") {
    profile.banner = stored;
  } else {
    profile.avatar = stored;
  }
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { type, size: stored.size, usage };
}

function deleteProfileImage(clientId, kind, options = {}) {
  const profile = readProfile(clientId, options);
  if (kind === "banner") {
    delete profile.banner;
  } else {
    delete profile.avatar;
  }
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { usage };
}

// --- Journal sharing ---------------------------------------------------------

function normalizeJournalVisibility(value, fallback = DEFAULT_JOURNAL_VISIBILITY) {
  const raw = String(value || "").trim().toLowerCase();
  return JOURNAL_VISIBILITY.includes(raw) ? raw : fallback;
}

function updateProfileJournalVisibility(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const visibility = normalizeJournalVisibility(
    input?.visibility ?? input?.journalVisibility,
    normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY)
  );
  profile.journalVisibility = visibility;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { visibility, usage };
}

function summarizeSharedNote(note) {
  return {
    id: note.id,
    title: note.title,
    kind: note.kind,
    occurredOn: note.occurredOn,
    sleptAt: note.sleptAt,
    awokeAt: note.awokeAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    scenes: (note.scenes || []).map((scene) => ({
      id: scene.id,
      time: scene.time,
      endTime: scene.endTime,
      place: scene.place,
      scenario: scene.scenario,
      mood: scene.mood,
      emotion: scene.emotion,
      atmosphere: scene.atmosphere,
      steps: scene.steps,
      thoughts: scene.thoughts,
      notes: scene.notes
    }))
  };
}

// Shared access check for a profile's journal + shared entries. Friends may see
// a "friends" profile; "public" is readable by anyone authenticated.
function assertProfileShareAllowed(targetClientId, viewerClientId, options = {}) {
  const targetId = normalizeClientId(targetClientId);
  const viewerId = normalizeClientId(viewerClientId);
  const profile = readProfile(targetId, options);
  const visibility = normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY);
  const isSelf = targetId === viewerId;
  let isFriend = false;
  if (!isSelf && visibility === "friends") {
    isFriend = normalizeFriends(profile.friends).some((entry) => entry.clientId === viewerId);
    if (!isFriend) {
      const viewerProfile = readProfile(viewerId, options);
      isFriend = normalizeFriends(viewerProfile.friends).some((entry) => entry.clientId === targetId);
    }
  }
  if (!isSelf && visibility !== "public" && !(visibility === "friends" && isFriend)) {
    throw new ProfileStorageError("journal_private", "That journal is not shared with you.");
  }
  return { profile, targetId, viewerId, visibility, isSelf };
}

function getJournalForViewer(targetClientId, viewerClientId, options = {}) {
  const { profile, visibility } = assertProfileShareAllowed(targetClientId, viewerClientId, options);
  const notes = (profile.notes || []).map(summarizeSharedNote);
  return {
    clientId: profile.clientId,
    displayName: profile.displayName || "",
    visibility,
    count: notes.length,
    notes
  };
}

// --- Shared journal entries (feed posts with comments) -----------------------

// --- Post share pages --------------------------------------------------------

function buildPostShareToken(profile, post) {
  const secret = resolveShareSecret(profile);
  if (!secret || !post) {
    return "";
  }
  return buildSignedShareToken({ c: profile.clientId, t: "p", p: post.id }, secret);
}

function buildPostSharePath(profile, post) {
  const token = buildPostShareToken(profile, post);
  return token ? buildSharePath(token) : "";
}

// Create a post: either a share of a journal entry (`noteId`) or a free post /
// thread (`body`, max 999 chars). Re-sharing a note refreshes its snapshot.
function createProfilePost(clientId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const noteId = String(input?.noteId || "").trim();
  const nowIso = new Date().toISOString();
  const posts = normalizeStoredPosts(profile.posts);
  const evidenceIds = (Array.isArray(input?.evidenceIds) ? input.evidenceIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  let requestedEntries = [];
  let post;

  if (noteId) {
    const note = (profile.notes || []).find((entry) => entry.id === noteId);
    if (!note) {
      throw new ProfileStorageError("note_not_found", "Journal entry not found.");
    }
    const body = noteToPlainText(note).slice(0, MAX_POST_BODY_LENGTH);
    post = posts.find((entry) => entry.noteId === noteId);
    if (post) {
      post.title = note.title;
      post.kind = note.kind;
      post.occurredOn = note.occurredOn;
      post.body = body;
      post.updatedAt = nowIso;
    } else {
      post = {
        id: `post_${crypto.randomBytes(8).toString("hex")}`,
        type: "journal",
        noteId,
        title: note.title,
        kind: note.kind,
        occurredOn: note.occurredOn,
        body,
        evidence: [],
        entries: [],
        comments: [],
        createdAt: nowIso,
        updatedAt: nowIso
      };
      posts.push(post);
    }
  } else {
    const body = String(input?.body ?? "").trim().slice(0, MAX_POST_TEXT_LENGTH);
    requestedEntries = (Array.isArray(input?.entries) ? input.entries : [])
      .map(normalizeStoredPostEntry)
      .filter(Boolean);
    if (requestedEntries.length > MAX_POST_ENTRIES) {
      throw new ProfileStorageError("post_entries_limit_reached", "This post has too many entries.");
    }
    const firstTextEntry = requestedEntries.find((entry) => entry.kind === "text" && entry.text);
    const hasUsableEntry = requestedEntries.some((entry) => (
      entry.kind === "text" ? Boolean(entry.text) : Boolean(entry.evidenceId)
    ));
    if (!body && !hasUsableEntry) {
      throw new ProfileStorageError("invalid_post", "Write something first (999 characters max).");
    }
    const title = String(input?.title || "").trim().slice(0, 300)
      || body.split("\n")[0].slice(0, 80)
      || (firstTextEntry ? plainTextFromHtml(firstTextEntry.text).slice(0, 80) : "")
      || "Post";
    post = {
      id: `post_${crypto.randomBytes(8).toString("hex")}`,
      type: "post",
      noteId: "",
      title,
      kind: "waking",
      occurredOn: nowIso.slice(0, 10),
      body,
      attachments: normalizePostAttachments(input?.attachments),
      evidence: [],
      entries: [],
      comments: [],
      createdAt: nowIso,
      updatedAt: nowIso
    };
    posts.push(post);
  }

  // Insert any evidence chosen while composing (store items join this post).
  // Evidence referenced only by an entry still joins the bucket and is resolved
  // here, so unknown ids fail with the usual store error instead of being dropped.
  const entryEvidenceIds = requestedEntries
    .map((entry) => (entry.kind === "evidence" ? entry.evidenceId : ""))
    .filter(Boolean);
  const allEvidenceIds = [...new Set([...evidenceIds, ...entryEvidenceIds])];
  allEvidenceIds.forEach((evidenceId) => {
    ensurePostEvidence(profile, post, evidenceId);
  });
  if (requestedEntries.length) {
    const evidenceIdSet = new Set((post.evidence || []).map((item) => item.id));
    post.entries = requestedEntries
      .filter((entry) => (entry.kind === "text" ? Boolean(entry.text) : evidenceIdSet.has(entry.evidenceId)))
      .slice(0, MAX_POST_ENTRIES);
  } else {
    allEvidenceIds.forEach((evidenceId) => {
      const entry = normalizeStoredPostEntry({
        kind: "evidence",
        evidenceId,
        createdAt: new Date().toISOString()
      });
      if (entry && (post.entries || []).length < MAX_POST_ENTRIES) {
        post.entries = [...(post.entries || []), entry];
      }
    });
  }

  profile.posts = posts.slice(-MAX_POSTS_PER_PROFILE);
  profile.updatedAt = nowIso;
  const usage = writeProfile(id, profile, options);
  return {
    post: presentPost(post, id, String(profile.displayName || "").trim(), buildPostSharePath(profile, post)),
    usage
  };
}

// Append an item to one of your own posts (e.g. an "add to post" from a
// bookmark/note control).
// --- Evidence store ----------------------------------------------------------
// "Add to post" collects proof into a per-profile store; posts then insert those
// items into their own evidence bucket and thread.

function addEvidenceToStore(clientId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const store = (Array.isArray(profile.evidenceStore) ? profile.evidenceStore : [])
    .map(normalizeStoredPostItem)
    .filter(Boolean);
  if (store.length >= MAX_POST_ITEMS) {
    throw new ProfileStorageError("evidence_store_limit_reached", "Your evidence store is full.");
  }
  if (!hasPostItemContent(input)) {
    throw new ProfileStorageError("invalid_post_item", "Nothing to add.");
  }
  const item = normalizeStoredPostItem({
    markType: input?.markType,
    markKey: input?.markKey,
    title: input?.title,
    body: input?.body,
    attachments: input?.attachments,
    createdAt: new Date().toISOString()
  });
  if (!item) {
    throw new ProfileStorageError("invalid_post_item", "Nothing to add.");
  }
  store.push(item);
  profile.evidenceStore = store;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(id, profile, options);
  return { item, count: store.length, usage };
}

function listEvidenceStore(clientId, options = {}) {
  const profile = readProfile(normalizeClientId(clientId), options);
  const store = (Array.isArray(profile.evidenceStore) ? profile.evidenceStore : [])
    .map(normalizeStoredPostItem)
    .filter(Boolean);
  return { count: store.length, evidence: store };
}

function deleteEvidenceFromStore(clientId, evidenceId, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(evidenceId || "").trim();
  const before = (Array.isArray(profile.evidenceStore) ? profile.evidenceStore : [])
    .map(normalizeStoredPostItem)
    .filter(Boolean);
  const store = before.filter((item) => item.id !== wanted);
  if (store.length === before.length) {
    throw new ProfileStorageError("post_item_not_found", "Evidence not found.");
  }
  profile.evidenceStore = store;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(id, profile, options);
  return { removed: true, count: store.length, usage };
}

// Resolve store evidence onto a post's bucket (idempotent).
function ensurePostEvidence(profile, post, evidenceId) {
  const wanted = String(evidenceId || "").trim();
  const existing = (post.evidence || []).find((item) => item.id === wanted);
  if (existing) {
    return existing;
  }
  const source = (Array.isArray(profile.evidenceStore) ? profile.evidenceStore : [])
    .map(normalizeStoredPostItem)
    .filter(Boolean)
    .find((item) => item.id === wanted);
  if (!source) {
    throw new ProfileStorageError("post_evidence_not_found", "That evidence is not in your store.");
  }
  post.evidence = [...(post.evidence || []), source];
  return source;
}

function addPostItem(clientId, postId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  if ((post.evidence || []).length >= MAX_POST_ITEMS) {
    throw new ProfileStorageError("post_items_limit_reached", "This post has too much evidence.");
  }
  if (!hasPostItemContent(input)) {
    throw new ProfileStorageError("invalid_post_item", "Nothing to add.");
  }
  const item = normalizeStoredPostItem({
    markType: input?.markType,
    markKey: input?.markKey,
    title: input?.title,
    body: input?.body,
    attachments: input?.attachments,
    createdAt: new Date().toISOString()
  });
  if (!item) {
    throw new ProfileStorageError("invalid_post_item", "Nothing to add.");
  }
  post.evidence = [...(post.evidence || []), item];
  post.updatedAt = new Date().toISOString();
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return { item, postId: post.id, evidenceCount: post.evidence.length, usage };
}

function deletePostItem(clientId, postId, itemId, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const wantedItem = String(itemId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  const before = (post.evidence || []).length;
  post.evidence = (post.evidence || []).filter((item) => item.id !== wantedItem);
  if (post.evidence.length === before) {
    throw new ProfileStorageError("post_item_not_found", "Evidence not found.");
  }
  // Drop any thread entries that referenced the removed evidence.
  post.entries = (post.entries || []).filter((entry) => entry.kind !== "evidence" || entry.evidenceId !== wantedItem);
  post.updatedAt = new Date().toISOString();
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return { removed: true, evidenceCount: post.evidence.length, usage };
}

// Edit the theory itself (claim / statement).
function updateProfilePost(clientId, postId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  if (input?.title !== undefined) {
    post.title = String(input.title || "").trim().slice(0, 300) || post.title;
  }
  if (input?.body !== undefined) {
    const limit = post.type === "journal" ? MAX_POST_BODY_LENGTH : MAX_POST_TEXT_LENGTH;
    const raw = String(input.body || "").slice(0, limit);
    post.body = post.type === "journal" ? raw : sanitizeMessageHtml(raw);
  }
  if (input?.attachments !== undefined) {
    post.attachments = normalizePostAttachments(input.attachments);
  }
  post.updatedAt = new Date().toISOString();
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return {
    post: presentPost(post, id, String(profile.displayName || "").trim(), buildPostSharePath(profile, post)),
    usage
  };
}

function clampEntryPosition(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return max;
  }
  return Math.max(0, Math.min(max, Math.trunc(number)));
}

// Insert a thread entry: prose, or a piece of evidence from the bucket.
function addPostEntry(clientId, postId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  if ((post.entries || []).length >= MAX_POST_ENTRIES) {
    throw new ProfileStorageError("post_entries_limit_reached", "This post has too many entries.");
  }
  const kind = input?.kind === "evidence" ? "evidence" : "text";
  const evidenceId = String(input?.evidenceId || "").trim();
  if (kind === "evidence") {
    // Evidence can come straight from the store; it joins the post bucket.
    ensurePostEvidence(profile, post, evidenceId);
  }
  const entry = normalizeStoredPostEntry({
    kind,
    text: kind === "text" ? input?.text : "",
    evidenceId: kind === "evidence" ? evidenceId : "",
    createdAt: new Date().toISOString()
  });
  if (!entry) {
    throw new ProfileStorageError("invalid_post_entry", "Write something first.");
  }
  const position = clampEntryPosition(input?.position, (post.entries || []).length);
  const entries = [...(post.entries || [])];
  entries.splice(position, 0, entry);
  post.entries = entries;
  post.updatedAt = entry.createdAt;
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return { entry, entries: post.entries.map((item) => ({ ...item })), usage };
}

function updatePostEntry(clientId, postId, entryId, input, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  const entries = [...(post.entries || [])];
  const index = entries.findIndex((entry) => entry.id === String(entryId || "").trim());
  if (index === -1) {
    throw new ProfileStorageError("post_entry_not_found", "Entry not found.");
  }
  const entry = entries[index];
  if (input?.text !== undefined && entry.kind === "text") {
    const text = sanitizeMessageHtml(String(input.text || "").trim()).slice(0, MAX_POST_TEXT_LENGTH);
    if (!text) {
      throw new ProfileStorageError("invalid_post_entry", "Write something first.");
    }
    entry.text = text;
  }
  if (input?.move === "up" || input?.move === "down") {
    const target = input.move === "up" ? index - 1 : index + 1;
    if (target >= 0 && target < entries.length) {
      entries.splice(index, 1);
      entries.splice(target, 0, entry);
    }
  }
  post.entries = entries;
  post.updatedAt = new Date().toISOString();
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return { entries: post.entries.map((item) => ({ ...item })), usage };
}

function deletePostEntry(clientId, postId, entryId, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Post not found.");
  }
  const before = (post.entries || []).length;
  post.entries = (post.entries || []).filter((entry) => entry.id !== String(entryId || "").trim());
  if (post.entries.length === before) {
    throw new ProfileStorageError("post_entry_not_found", "Entry not found.");
  }
  post.updatedAt = new Date().toISOString();
  profile.posts = posts;
  profile.updatedAt = post.updatedAt;
  const usage = writeProfile(id, profile, options);
  return { removed: true, entries: post.entries.map((item) => ({ ...item })), usage };
}

function listProfilePosts(clientId, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const authorName = String(profile.displayName || "").trim();
  return normalizeStoredPosts(profile.posts)
    .filter((post) => post.type === "post" || post.type === "journal")
    .map((post) => presentPost(post, id, authorName, buildPostSharePath(profile, post)))
    .reverse();
}

function deleteProfilePost(clientId, postId, options = {}) {
  const id = normalizeClientId(clientId);
  const profile = readProfile(id, options);
  const wanted = String(postId || "").trim();
  const before = normalizeStoredPosts(profile.posts);
  const posts = before.filter((post) => post.id !== wanted);
  if (posts.length === before.length) {
    throw new ProfileStorageError("post_not_found", "Shared entry not found.");
  }
  profile.posts = posts;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(id, profile, options);
  return { removed: true, usage };
}

function listPostsForViewer(targetClientId, viewerClientId, options = {}) {
  const { profile, targetId, visibility } = assertProfileShareAllowed(targetClientId, viewerClientId, options);
  const authorName = String(profile.displayName || "").trim();
  const posts = normalizeStoredPosts(profile.posts)
    .filter((post) => post.type === "post")
    .map((post) => presentPost(post, targetId, authorName))
    .reverse();
  return {
    clientId: profile.clientId,
    displayName: authorName,
    visibility,
    count: posts.length,
    posts
  };
}

// Combined feed: the viewer's own shares plus friends' and public shares.
// Visibility per author follows the same rule as the journal.
function getProfileFeed(viewerClientId, options = {}) {
  const viewerId = normalizeClientId(viewerClientId);
  const viewerProfile = readProfile(viewerId, options);
  const friendIds = new Set(normalizeFriends(viewerProfile.friends).map((entry) => entry.clientId));
  const candidates = new Set([viewerId, ...friendIds]);

  // Public journals join the feed even for non-friends.
  listProfileClientIds(options).forEach((clientId) => {
    try {
      const profile = readProfile(clientId, options);
      if (normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY) === "public") {
        candidates.add(clientId);
      }
    } catch (_error) {
      // Skip unreadable profiles.
    }
  });

  const entries = [];
  candidates.forEach((authorId) => {
    let profile;
    try {
      profile = readProfile(authorId, options);
    } catch (_error) {
      return;
    }
    const visibility = normalizeJournalVisibility(profile.journalVisibility, DEFAULT_JOURNAL_VISIBILITY);
    const isSelf = authorId === viewerId;
    const isFriend = friendIds.has(authorId)
      || normalizeFriends(profile.friends).some((entry) => entry.clientId === viewerId);
    if (!isSelf && visibility !== "public" && !(visibility === "friends" && isFriend)) {
      return;
    }
    const authorName = String(profile.displayName || "").trim();
    // Posts are their own thing; shared journal entries are not posts.
    normalizeStoredPosts(profile.posts)
      .filter((post) => post.type === "post")
      .forEach((post) => {
        entries.push(presentPost(post, authorId, authorName));
      });
  });

  entries.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
  return { count: entries.length, posts: entries.slice(0, 100) };
}

function addPostComment(targetClientId, postId, viewerClientId, input, options = {}) {
  const { profile, targetId, viewerId } = assertProfileShareAllowed(targetClientId, viewerClientId, options);
  const text = String(input?.text ?? input?.body ?? "").trim();
  if (!text) {
    throw new ProfileStorageError("invalid_comment", "Write a comment first.");
  }
  const wanted = String(postId || "").trim();
  const posts = normalizeStoredPosts(profile.posts);
  const post = posts.find((entry) => entry.id === wanted);
  if (!post) {
    throw new ProfileStorageError("post_not_found", "Shared entry not found.");
  }
  if (post.comments.length >= MAX_POST_COMMENTS) {
    throw new ProfileStorageError("post_comments_limit_reached", "This entry has too many comments.");
  }
  const viewerProfile = readProfile(viewerId, options);
  const comment = {
    id: `pcmt_${crypto.randomBytes(6).toString("hex")}`,
    clientId: viewerId,
    name: String(viewerProfile.displayName || "").trim() || viewerId,
    text: text.slice(0, MAX_POST_COMMENT_LENGTH),
    createdAt: new Date().toISOString()
  };
  post.comments.push(comment);
  profile.posts = posts;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(targetId, profile, counterpartWriteOptions(options));
  return { comment, usage };
}

function updateProfileTagline(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const tagline = String(input?.tagline ?? input?.status ?? "").trim().slice(0, MAX_TAGLINE_LENGTH);
  profile.tagline = tagline;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return { tagline, usage };
}

function updateProfileBio(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const bio = String((input && input.bio) || "").trim().slice(0, 2000);
  profile.bio = bio;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    bio,
    usage
  };
}

function normalizeTimeZoneId(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 80 || !/^[A-Za-z0-9_+\-\/]+$/.test(value)) {
    return "";
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch (_error) {
    return "";
  }
}

function offsetMinutesForTimeZone(timeZone, at = new Date()) {
  if (!String(timeZone || "").trim()) {
    return null;
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const offset = Math.round((asUtc - at.getTime()) / 60000);
    if (!Number.isFinite(offset) || offset < -720 || offset > 840) {
      return null;
    }
    return offset;
  } catch (_error) {
    return null;
  }
}

function updateProfileLocation(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  let latitude = Number(input?.latitude ?? input?.lat);
  let longitude = Number(input?.longitude ?? input?.lng ?? input?.lon);
  let place = null;
  try {
    place = require("./location-gazetteer").tryResolvePlace(input);
  } catch (error) {
    throw new ProfileStorageError(error.code || "invalid_location", error.message);
  }
  if (place) {
    latitude = place.latitude;
    longitude = place.longitude;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180) {
    throw new ProfileStorageError(
      "invalid_location",
      "Pick a country/region/city, or provide numeric latitude (-90..90) and longitude (-180..180)."
    );
  }
  // Offset powers location-aware calendar subscriptions (moon/decan civil dates).
  const timeZone = normalizeTimeZoneId(input?.timeZone);
  const fromZone = timeZone ? offsetMinutesForTimeZone(timeZone) : null;
  const rawOffset = Number(input?.utcOffsetMinutes);
  const utcOffsetMinutes = Number.isFinite(fromZone)
    ? fromZone
    : (Number.isFinite(rawOffset) && rawOffset >= -720 && rawOffset <= 840
      ? Math.round(rawOffset)
      : null);
  const location = {
    latitude,
    longitude,
    label: String(input?.label || place?.label || "").trim().slice(0, 200),
    placeId: String(input?.placeId || place?.id || "").trim(),
    countryId: String(input?.countryId || input?.country || place?.countryId || "").trim(),
    regionId: String(input?.regionId || input?.region || place?.regionId || "").trim(),
    cityId: String(input?.cityId || input?.city || place?.cityId || "").trim(),
    timeZone,
    utcOffsetMinutes
  };
  profile.location = location;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    location,
    usage
  };
}

function updateProfilePreferredDeck(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const preferredDeck = String(input?.preferredDeck ?? "").trim().slice(0, 100);
  profile.preferredDeck = preferredDeck;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    preferredDeck,
    usage
  };
}

const PLUGIN_STATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_PLUGIN_STATE_BYTES = 256 * 1024;

function normalizePluginStateId(pluginId) {
  const normalized = String(pluginId || "").trim().toLowerCase();
  if (!PLUGIN_STATE_ID_PATTERN.test(normalized)) {
    throw new ProfileStorageError("invalid_plugin_id", "Plugin id is required.");
  }
  return normalized;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeStoredPluginState(rawState) {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    return {};
  }
  const normalized = {};
  for (const [pluginId, state] of Object.entries(rawState)) {
    if (!PLUGIN_STATE_ID_PATTERN.test(pluginId)) continue;
    if (!state || typeof state !== "object" || Array.isArray(state)) continue;
    normalized[pluginId] = cloneJson(state);
  }
  return normalized;
}

function getProfilePluginState(clientId, pluginId, options = {}) {
  const normalizedPluginId = normalizePluginStateId(pluginId);
  const profile = readProfile(clientId, options);
  const state = profile.pluginState?.[normalizedPluginId];
  return {
    pluginId: normalizedPluginId,
    state: state && typeof state === "object" ? cloneJson(state) : {}
  };
}

function updateProfilePluginState(clientId, pluginId, input, options = {}) {
  const normalizedPluginId = normalizePluginStateId(pluginId);
  const hasStateField = input && typeof input === "object" && !Array.isArray(input)
    && Object.prototype.hasOwnProperty.call(input, "state");
  const nextState = hasStateField ? input.state : input;
  if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) {
    throw new ProfileStorageError("invalid_plugin_state", "Plugin state must be a JSON object.");
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(nextState), "utf8");
  if (serializedSize > MAX_PLUGIN_STATE_BYTES) {
    throw new ProfileStorageError(
      "invalid_plugin_state",
      `Plugin state exceeds ${MAX_PLUGIN_STATE_BYTES} bytes.`
    );
  }

  const profile = readProfile(clientId, options);
  profile.pluginState = profile.pluginState && typeof profile.pluginState === "object"
    ? profile.pluginState
    : {};
  profile.pluginState[normalizedPluginId] = cloneJson(nextState);
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    pluginId: normalizedPluginId,
    state: cloneJson(profile.pluginState[normalizedPluginId]),
    usage
  };
}

const MAX_LIBRARY_ITEMS = 500;
const MAX_LIBRARY_TITLE = 240;
const MAX_LIBRARY_BODY = 8000;
const MAX_LIBRARY_KEY = 400;
const MAX_LIBRARY_TYPE = 40;

function normalizeLibraryType(value) {
  return String(value || "").trim().toLowerCase().slice(0, MAX_LIBRARY_TYPE);
}

function normalizeLibraryKey(value) {
  return String(value || "").trim().slice(0, MAX_LIBRARY_KEY);
}

function normalizeLibraryItem(raw, { requireBody = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const type = normalizeLibraryType(raw.type);
  const key = normalizeLibraryKey(raw.key);
  if (!type || !key) return null;
  const title = String(raw.title || key).trim().slice(0, MAX_LIBRARY_TITLE) || key;
  const body = String(raw.body || "").trim().slice(0, MAX_LIBRARY_BODY);
  if (requireBody && !body) return null;
  const nowIso = new Date().toISOString();
  const meta = raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
    ? cloneJson(raw.meta)
    : {};
  return {
    id: String(raw.id || `mark_${crypto.randomBytes(6).toString("hex")}`),
    type,
    key,
    title,
    body,
    meta,
    createdAt: String(raw.createdAt || nowIso),
    updatedAt: String(raw.updatedAt || nowIso)
  };
}

function normalizeStoredLibrary(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const bookmarks = (Array.isArray(source.bookmarks) ? source.bookmarks : [])
    .map((item) => normalizeLibraryItem(item))
    .filter(Boolean)
    .slice(0, MAX_LIBRARY_ITEMS);
  const notes = (Array.isArray(source.notes) ? source.notes : [])
    .map((item) => normalizeLibraryItem(item, { requireBody: true }))
    .filter(Boolean)
    .slice(0, MAX_LIBRARY_ITEMS);
  return { bookmarks, notes };
}

function getProfileLibrary(clientId, options = {}) {
  const profile = readProfile(clientId, options);
  return cloneJson(profile.library || { bookmarks: [], notes: [] });
}

function updateProfileLibrary(clientId, input, options = {}) {
  const next = normalizeStoredLibrary(input && typeof input === "object" ? input : {});
  const profile = readProfile(clientId, options);
  profile.library = next;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    library: cloneJson(profile.library),
    usage
  };
}

function updateProfileDisplayName(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const displayName = String(input?.displayName ?? "").trim().slice(0, 100);
  profile.displayName = displayName;
  profile.updatedAt = new Date().toISOString();
  const usage = writeProfile(clientId, profile, options);
  return {
    displayName,
    usage
  };
}



module.exports = {
  ProfileStorageError,
  addProfileQuickNote,
  createProfileEvent,
  createProfileNote,
  deleteProfileEvent,
  deleteProfileNote,
  deleteProfileQuickNote,
  addProfileMessage,
  buildAttachmentShareUrl,
  buildPostSharePath,
  buildPostShareToken,
  buildSharePath,
  createProfileLink,
  decodeAttachmentPayload,
  sendStoredAttachment,
  aliasCalendarFeedLayer,
  profileFeedHasLayer,
  forEachStoredProfile,
  deleteProfileLink,
  deleteProfileMessage,
  getProfileInboxReadMap,
  listProfileMessages,
  markProfileInboxRead,
  normalizeMessageInputFields,
  normalizeStoredMessageFields,
  normalizeStoredQuietHours,
  resolveDirectMessageToken,
  updateProfileDirectory,
  updateProfileQuietHours,
  expandEventOccurrences,
  findEventAttachment,
  findNoteAttachment,
  getProfileLink,
  listProfileLinks,
  resolveProfileLinkToken,
  resolveShareSecret,
  resolveSignedShareAttachment,
  updateProfileLink,
  getProfileBio,
  getProfilePage,
  getProfileImage,
  getProfileCalendarFeed,
  normalizeCalendarFeedLayers,
  normalizeCalendarFeedOptions,
  getProfileEvent,
  getProfileBoardWatch,
  getProfileEventAttachment,
  getProfileFriends,
  getProfileLibrary,
  getQuizLeaderboard,
  listTopicWatchers,
  getProfileRevision,
  listProfileClientIds,
  listPublicDirectoryEntries,
  getPublicDirectoryProfile,
  getPublicDirectoryImage,
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  removeFriend,
  sendDirectoryMessage,
  sendFriendRequest,
  getProfileNote,
  getProfilePluginState,
  getProfileQuizProgress,
  getProfileSummary,
  getProfileUsage,
  listProfileEvents,
  listProfileEventsInRange,
  listProfileNotes,
  listProfileQuickNotes,
  readProfile,
  resolveCalendarFeedToken,
  resolveEventOccurrenceAttachments,
  updateProfileQuickNote,
  recordQuizAttempt,
  resetProfile,
  updateProfileBio,
  updateProfileTagline,
  updateProfilePage,
  updateProfileImage,
  deleteProfileImage,
  getJournalForViewer,
  normalizeJournalVisibility,
  updateProfileJournalVisibility,
  createProfilePost,
  listProfilePosts,
  deleteProfilePost,
  listPostsForViewer,
  getProfileFeed,
  addPostComment,
  addPostItem,
  deletePostItem,
  addEvidenceToStore,
  listEvidenceStore,
  deleteEvidenceFromStore,
  updateProfilePost,
  addPostEntry,
  updatePostEntry,
  deletePostEntry,
  updateProfileBoardWatch,
  updateProfileCalendarFeed,
  updateProfileDisplayName,
  updateProfileEvent,
  updateProfileLibrary,
  updateProfileLocation,
  updateProfileNote,
  updateProfilePluginState,
  updateProfilePreferredDeck
};
