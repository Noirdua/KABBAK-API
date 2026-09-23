const fs = require("node:fs");
const { writeFileAtomicSync } = require("../lib/atomic-file");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Generic in-process scheduler shared by the API and plugins. Jobs are named,
// either recurring daily at a time or at a fixed interval, and each job's last
// run is persisted so a restart never double-runs it (and a missed daily run is
// caught up on the next tick).
const DEFAULT_STATE_PATH = path.join(storageConfigRoot, "scheduler-state.json");
const DEFAULT_TICK_MS = 60 * 1000;

const jobs = new Map();
let timer = null;

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
  writeFileAtomicSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function registerJob(id, job) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) {
    throw new Error("A job id is required.");
  }
  const kind = job?.kind === "daily" ? "daily" : (job?.kind === "interval" ? "interval" : "");
  if (!kind) {
    throw new Error("Job kind must be 'daily' or 'interval'.");
  }
  if (typeof job.run !== "function") {
    throw new Error("Job requires a run function.");
  }
  jobs.set(normalizedId, {
    id: normalizedId,
    kind,
    hour: Math.max(0, Math.min(23, Number(job.hour) || 0)),
    minute: Math.max(0, Math.min(59, Number(job.minute) || 0)),
    intervalMs: Math.max(1000, Number(job.intervalMs) || 60000),
    run: job.run
  });
  return { id: normalizedId, kind };
}

function cancelJob(id) {
  return jobs.delete(String(id || "").trim());
}

function cancelJobsForPrefix(prefix) {
  const normalized = String(prefix || "");
  let removed = 0;
  for (const id of [...jobs.keys()]) {
    if (id.startsWith(normalized)) {
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function listJobs() {
  return [...jobs.values()].map(({ run, ...rest }) => rest);
}

function isDue(job, now, state) {
  const last = state[job.id];
  if (job.kind === "daily") {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < job.hour * 60 + job.minute) {
      return false;
    }
    return String(last || "").slice(0, 10) !== localDateKey(now);
  }
  if (job.kind === "interval") {
    const lastMs = last ? Date.parse(last) : 0;
    if (!Number.isFinite(lastMs) || lastMs <= 0) {
      return true;
    }
    return (now.getTime() - lastMs) >= job.intervalMs;
  }
  return false;
}

function runDueJobs({ now = new Date(), options = {}, log = () => {} } = {}) {
  const state = readState(options);
  let ran = 0;
  for (const job of jobs.values()) {
    if (!isDue(job, now, state)) {
      continue;
    }
    try {
      job.run({ now, id: job.id });
    } catch (error) {
      log(`[scheduler] job '${job.id}' failed: ${error?.message || error}`);
    }
    state[job.id] = now.toISOString();
    ran += 1;
  }
  if (ran) {
    writeState(state, options);
  }
  return { ran };
}

function startScheduler({ tickMs = DEFAULT_TICK_MS, log = () => {} } = {}) {
  if (timer) {
    return timer;
  }
  timer = setInterval(() => {
    runDueJobs({ log });
  }, tickMs);
  timer.unref?.();
  // A short delay lets boot finish before the first pass.
  const bootTimer = setTimeout(() => {
    runDueJobs({ log });
  }, 5000);
  bootTimer.unref?.();
  return timer;
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  cancelJob,
  cancelJobsForPrefix,
  listJobs,
  registerJob,
  runDueJobs,
  startScheduler,
  stopScheduler
};
