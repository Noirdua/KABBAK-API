const fs = require("node:fs");
const path = require("node:path");

const { profilesRoot } = require("../config/profile-storage");
const { storageConfigRoot } = require("../config/paths");
const { getRuntimeSettings } = require("./runtime-settings");
const { listBroadcasts } = require("./message-store");
const { addProfileMessage } = require("./profile-service");
const { registerJob } = require("./scheduler");

const DIGEST_JOB_ID = "kabbak:digest";

// Nightly digest: once a day, each profile with unread broadcasts gets a single
// summary message in its inbox. Scheduled from server bootstrap; guarded by a
// date stamp so it can never deliver twice in a day.
const DEFAULT_STATE_PATH = path.join(storageConfigRoot, "digest-state.json");

function resolveStatePath(options = {}) {
  return options.statePath || DEFAULT_STATE_PATH;
}

function readState(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStatePath(options), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeState(state, options = {}) {
  const filePath = resolveStatePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function collectUnreadBroadcasts(profile, broadcasts, nowMs) {
  const read = profile?.inboxRead && typeof profile.inboxRead === "object" && !Array.isArray(profile.inboxRead)
    ? profile.inboxRead
    : {};
  return broadcasts.filter((broadcast) => {
    if (broadcast.expiresAt && Date.parse(broadcast.expiresAt) <= nowMs) {
      return false;
    }
    if (broadcast.publishAt && Date.parse(broadcast.publishAt) > nowMs) {
      return false;
    }
    return !read[`broadcast:${broadcast.id}`];
  });
}

function runDigest({ now = new Date(), options = {}, settings: settingsOverride } = {}) {
  const settings = settingsOverride || getRuntimeSettings();
  if (settings.digestEnabled !== true) {
    return { ran: false, reason: "disabled" };
  }
  if (now.getHours() !== Number(settings.digestHour)) {
    return { ran: false, reason: "not-due" };
  }

  const state = readState(options);
  const dateKey = localDateKey(now);
  if (state.lastRunDate === dateKey) {
    return { ran: false, reason: "already-ran" };
  }

  const broadcasts = listBroadcasts({ filePath: options.broadcastsFilePath });
  const root = options.profilesRoot || profilesRoot;
  let files = [];
  try {
    files = fs.readdirSync(root).filter((name) => name.startsWith("profile-") && name.endsWith(".json"));
  } catch (_error) {
    files = [];
  }

  let delivered = 0;
  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    } catch (_error) {
      continue; // unreadable/encrypted profiles are skipped
    }
    const clientId = String(profile?.clientId || "").trim();
    if (!clientId) {
      continue;
    }
    const unread = collectUnreadBroadcasts(profile, broadcasts, now.getTime());
    if (!unread.length) {
      continue;
    }
    const lines = unread.slice(0, 5).map((broadcast) => `• ${broadcast.title}`);
    if (unread.length > 5) {
      lines.push(`…and ${unread.length - 5} more`);
    }
    const description = `${unread.length} unread announcement${unread.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`;
    try {
      addProfileMessage(
        clientId,
        { kind: "report", title: `Daily digest · ${unread.length} unread`, description, visibility: "internal" },
        { sender: "KABBAK digest" },
        { rootPath: root }
      );
      delivered += 1;
    } catch (_error) {
      // Skip a profile that cannot be written (quota, etc.).
    }
  }

  writeState({ lastRunDate: dateKey, lastRunAt: now.toISOString(), delivered }, options);
  return { ran: true, delivered, date: dateKey };
}

// The digest is just a scheduled job on the shared scheduler; it self-guards on
// the runtime settings (enabled/hour) and a once-per-day date stamp.
function registerDigestJob({ intervalMs = 10 * 60 * 1000, log = () => {} } = {}) {
  return registerJob(DIGEST_JOB_ID, {
    kind: "interval",
    intervalMs,
    run: () => {
      try {
        const result = runDigest();
        if (result.ran) {
          log(`[digest] delivered ${result.delivered} digest message(s).`);
        }
      } catch (error) {
        log(`[digest] ${error?.message || error}`);
      }
    }
  });
}

module.exports = {
  registerDigestJob,
  runDigest
};
