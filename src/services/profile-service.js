const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
  MAX_ATTACHMENT_SIZE_BYTES,
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
  MAX_EVENT_OCCURRENCES,
  MAX_EVENT_RANGE_DAYS,
  FEED_TOKEN_PREFIX
} = require("../config/profile-storage");

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

const NOTE_KINDS = new Set(["dream", "waking"]);

function dateFromIso(iso) {
  const parsed = new Date(String(iso || ""));
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function isValidOccurredOn(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.getUTCFullYear() === year
    && utcDate.getUTCMonth() === month - 1
    && utcDate.getUTCDate() === day;
}

function normalizeStoredKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return NOTE_KINDS.has(normalized) ? normalized : "waking";
}

function normalizeStoredOccurredOn(value, fallbackIso) {
  const raw = String(value || "").trim();
  if (isValidOccurredOn(raw)) {
    return raw;
  }
  return dateFromIso(fallbackIso);
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

function normalizeStoredAttachment(att, options = {}) {
  if (!att || typeof att !== "object") return null;
  const name = String(att.name || "attachment").trim().slice(0, 255);
  const type = String(att.type || "application/octet-stream").trim();
  let data = "";
  if (typeof att.data === "string") {
    data = att.data;
  }
  const maxBytes = resolveAttachmentBytesLimit(options);
  const size = Math.max(0, Number(att.size) || (data.length * 0.75)); // rough for base64
  if (size > maxBytes) {
    // drop too large instead of crashing load
    return null;
  }
  return {
    id: String(att.id || `att_${crypto.randomBytes(6).toString("hex")}`),
    name,
    type,
    size: Math.min(size, maxBytes),
    data
  };
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
  return {
    latitude,
    longitude,
    label: String(location.label || "").trim().slice(0, 200),
    placeId: String(location.placeId || "").trim(),
    countryId: String(location.countryId || "").trim(),
    regionId: String(location.regionId || "").trim(),
    cityId: String(location.cityId || "").trim()
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

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, toStore + "\n", "utf8");
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
    displayName: profile.displayName || "",
    location: profile.location || null,
    preferredDeck: profile.preferredDeck || "",
    storage: usage,
    counts: {
      notes: profile.notes.length,
      events: Array.isArray(profile.events) ? profile.events.length : 0,
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

function resolveAttachmentBytesLimit(options = {}) {
  const numericValue = Number(options.maxAttachmentBytes);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.floor(numericValue);
  }
  return MAX_ATTACHMENT_SIZE_BYTES;
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

function createProfileEvent(clientId, input, options = {}) {
  const profile = readProfile(clientId, options);
  const limit = resolveEventsLimit(options);
  if ((profile.events || []).length >= limit) {
    throw new ProfileStorageError("events_limit_reached", `A profile can hold at most ${limit} events for your access level.`);
  }
  const nowIso = new Date().toISOString();
  const event = normalizeEventInput(input, { createdAt: nowIso });
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
  summary.noteLength = String(summary.notes || "").length;
  delete summary.notes;
  return {
    ...summary,
    eventId: event.id,
    id: `${event.id}#${date}`,
    date,
    segmentCount: Array.isArray(summary.segments) ? summary.segments.length : 0,
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
  return {
    enabled: source.enabled === true && Boolean(token),
    token,
    createdAt: String(source.createdAt || "").trim(),
    updatedAt: String(source.updatedAt || "").trim()
  };
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
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt
  };
}

function updateProfileCalendarFeed(clientId, input, options = {}) {
  const action = String(input?.action || "").trim().toLowerCase();
  if (!["enable", "disable", "rotate"].includes(action)) {
    throw new ProfileStorageError("invalid_feed_action", "Feed action must be enable, disable, or rotate.");
  }
  const profile = readProfile(clientId, options);
  const existing = normalizeStoredCalendarFeed(profile.calendarFeed);
  const nowIso = new Date().toISOString();
  let token = existing.token;
  if (action === "rotate" || (action === "enable" && !token)) {
    token = generateCalendarFeedToken(clientId);
  }
  profile.calendarFeed = {
    enabled: action !== "disable",
    token,
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

  return {
    overall: {
      attempts: attempts.length,
      totalQuestions,
      totalCorrect,
      accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 1000) / 1000 : 0
    },
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
  const location = {
    latitude,
    longitude,
    label: String(input?.label || place?.label || "").trim().slice(0, 200),
    placeId: String(input?.placeId || place?.id || "").trim(),
    countryId: String(input?.countryId || input?.country || place?.countryId || "").trim(),
    regionId: String(input?.regionId || input?.region || place?.regionId || "").trim(),
    cityId: String(input?.cityId || input?.city || place?.cityId || "").trim()
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
  getProfileBio,
  getProfileCalendarFeed,
  getProfileEvent,
  getProfileLibrary,
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
  updateProfileQuickNote,
  recordQuizAttempt,
  resetProfile,
  updateProfileBio,
  updateProfileCalendarFeed,
  updateProfileDisplayName,
  updateProfileEvent,
  updateProfileLibrary,
  updateProfileLocation,
  updateProfileNote,
  updateProfilePluginState,
  updateProfilePreferredDeck
};
