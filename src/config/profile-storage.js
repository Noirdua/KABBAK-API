const path = require("node:path");

const { storageRoot } = require("./paths");

const profilesRoot = path.join(storageRoot, "profiles");

// Placeholder per-profile storage quota. Tune later once real usage patterns land.
const PROFILE_STORAGE_QUOTA_BYTES = 50 * 1024 * 1024;

const MAX_NOTES_PER_PROFILE = 2000;
const MAX_NOTE_TITLE_LENGTH = 300;
const MAX_QUIZ_ATTEMPTS_PER_PROFILE = 5000;
const MAX_SCENES_PER_NOTE = 100;
const MAX_SCENE_TIME_LENGTH = 120;
const MAX_SCENE_PLACE_LENGTH = 200;
const MAX_SCENE_MOOD_LENGTH = 200;
const MAX_SCENE_THOUGHTS_LENGTH = 20 * 1024;
const MAX_SCENE_NOTES_LENGTH = 20 * 1024;
const MAX_ATTACHMENTS_PER_SCENE = 10;
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per attachment (base64 will be ~1.33x)
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_QUICK_NOTES_PER_PROFILE = 200;
const MAX_QUICK_NOTE_TEXT_LENGTH = 1000;
const MAX_QUICK_NOTE_SKY_LENGTH = 400;

const MAX_EVENTS_PER_PROFILE = 2000;
const MAX_EVENT_TITLE_LENGTH = 300;
const MAX_EVENT_NOTES_LENGTH = 20 * 1024;
const MAX_EVENT_LOCATION_LENGTH = 200;
const MAX_EVENT_COLOR_LENGTH = 32;
const MAX_EVENT_ID_LENGTH = 64;
const MAX_EVENT_REMINDER_MINUTES = 7 * 24 * 60; // one week ahead
const MAX_EVENT_SEGMENTS = 12; // time blocks per split-time event
const MAX_ATTACHMENTS_PER_EVENT = 6;
const MAX_EVENT_OCCURRENCE_OVERRIDES = 366;
const MAX_LINKS_PER_PROFILE = 200;
const MAX_ATTACHMENTS_PER_LINK = 12;
const MAX_LINK_TITLE_LENGTH = 200;
const MAX_LINK_DESCRIPTION_LENGTH = 20 * 1024;
const SHARE_TOKEN_PREFIX = "lk1";
const SHARE_SIGNED_PREFIX = "s1";
const MESSAGE_BROADCAST_PREFIX = "bc1";
const MESSAGE_DIRECT_PREFIX = "dm1";
const MAX_MESSAGES_PER_PROFILE = 500;
const MAX_FRIENDS_PER_PROFILE = 500;
const MAX_FRIEND_REQUESTS_PER_PROFILE = 200;
const MAX_BROADCASTS = 500;
const MAX_EVENT_OCCURRENCES = 1000; // per event per range query
const MAX_EVENT_RANGE_DAYS = 1100; // ~3 years of expanded occurrences
const FEED_TOKEN_PREFIX = "kbf1";
// Calendar feed subscription layers. `moon` is the four principal phases;
// `astrology` is the decan changes (sun crossing each 10° of the zodiac);
// `sun` is the sunrise/sunset day boundaries (later the angel hours).
const CALENDAR_FEED_LAYERS = Object.freeze([
  "user",
  "notes",
  "holidays",
  "moon",
  "astrology",
  "planetary",
  "sun"
]);
const DEFAULT_CALENDAR_FEED_LAYERS = Object.freeze(["user", "moon", "holidays"]);
// Per-calendar subscription options. Moon phases are the four principal phases;
// astrology detail picks the boundary size (10° decans, 1° steps, or sign starts);
// sun events picks the sunrise/sunset boundaries to include.
const CALENDAR_MOON_PHASES = Object.freeze(["new", "first-quarter", "full", "last-quarter"]);
const CALENDAR_ASTROLOGY_DETAILS = Object.freeze(["decan", "degree", "sign"]);
const CALENDAR_SUN_EVENTS = Object.freeze(["sunrise", "sunset"]);
// Separate subscription calendars. Calendar apps color a whole ICS URL, not
// events inside it, so each curated calendar gets its own token and URL.
const MAX_FEED_CALENDARS = 16;
const MAX_FEED_CALENDAR_NAME = 80;
const CALENDAR_FEED_LAYER_META = Object.freeze({
  user: Object.freeze({ label: "My events", color: "#6366F1" }),
  notes: Object.freeze({ label: "Notes & journals", color: "#818CF8" }),
  holidays: Object.freeze({ label: "Holidays", color: "#FDE68A" }),
  moon: Object.freeze({ label: "Moon phases", color: "#C7D2FE" }),
  astrology: Object.freeze({ label: "Astrology", color: "#FCD34D" }),
  planetary: Object.freeze({ label: "Planetary hours", color: "#52525B" }),
  sun: Object.freeze({ label: "Sunrise & sunset", color: "#FB923C" })
});
// Who may read a profile's journal: private (owner only), friends, or anyone.
const JOURNAL_VISIBILITY = Object.freeze(["private", "friends", "public"]);
const DEFAULT_JOURNAL_VISIBILITY = "private";
// Short profile status line.
const MAX_TAGLINE_LENGTH = 120;
// Shared journal posts (feed items with comments).
const MAX_POSTS_PER_PROFILE = 200;
const MAX_POST_COMMENTS = 200;
const MAX_POST_BODY_LENGTH = 20_000;
const MAX_POST_COMMENT_LENGTH = 2_000;
// Free posts (threads) and their appended items are short.
const MAX_POST_TEXT_LENGTH = 999;
const MAX_POST_ITEMS = 200;
const MAX_POST_ENTRIES = 400;
const MAX_POST_ATTACHMENTS = 10;

module.exports = {
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
  SHARE_SIGNED_PREFIX,
  MESSAGE_BROADCAST_PREFIX,
  MESSAGE_DIRECT_PREFIX,
  MAX_MESSAGES_PER_PROFILE,
  MAX_FRIENDS_PER_PROFILE,
  MAX_FRIEND_REQUESTS_PER_PROFILE,
  MAX_BROADCASTS,
  MAX_EVENT_RANGE_DAYS,
  FEED_TOKEN_PREFIX,
  CALENDAR_FEED_LAYERS,
  DEFAULT_CALENDAR_FEED_LAYERS,
  CALENDAR_MOON_PHASES,
  CALENDAR_ASTROLOGY_DETAILS,
  CALENDAR_SUN_EVENTS,
  MAX_FEED_CALENDARS,
  MAX_FEED_CALENDAR_NAME,
  CALENDAR_FEED_LAYER_META,
  JOURNAL_VISIBILITY,
  DEFAULT_JOURNAL_VISIBILITY,
  MAX_TAGLINE_LENGTH,
  MAX_POSTS_PER_PROFILE,
  MAX_POST_COMMENTS,
  MAX_POST_BODY_LENGTH,
  MAX_POST_COMMENT_LENGTH,
  MAX_POST_TEXT_LENGTH,
  MAX_POST_ITEMS,
  MAX_POST_ENTRIES,
  MAX_POST_ATTACHMENTS
};
