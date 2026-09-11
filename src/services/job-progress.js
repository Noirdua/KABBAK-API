"use strict";

const jobs = new Map();

function cloneJob(job) {
  return job ? { ...job } : null;
}

function upsertJob(id, patch = {}) {
  const key = String(id || "").trim();
  if (!key) {
    return null;
  }
  const previous = jobs.get(key) || {
    id: key,
    state: "idle",
    label: key,
    current: "",
    done: 0,
    total: 0,
    generated: 0,
    message: "",
    updatedAt: ""
  };
  const next = {
    ...previous,
    ...patch,
    id: key,
    done: Number.isFinite(Number(patch.done)) ? Number(patch.done) : previous.done,
    total: Number.isFinite(Number(patch.total)) ? Number(patch.total) : previous.total,
    generated: Number.isFinite(Number(patch.generated)) ? Number(patch.generated) : previous.generated,
    updatedAt: new Date().toISOString()
  };
  jobs.set(key, next);
  return cloneJob(next);
}

function ingestStructured(structured) {
  if (!structured || typeof structured !== "object") {
    return null;
  }
  if (String(structured.event || "") !== "kabbak_job") {
    return null;
  }
  const id = String(structured.job || "").trim();
  if (!id) {
    return null;
  }
  return upsertJob(id, {
    state: String(structured.state || "running"),
    label: String(structured.label || id),
    current: String(structured.deck || structured.current || ""),
    done: structured.done,
    total: structured.total,
    generated: structured.generated,
    message: String(structured.message || "")
  });
}

function getJob(id) {
  return cloneJob(jobs.get(String(id || "").trim()) || null);
}

function listJobs() {
  return [...jobs.values()].map((job) => cloneJob(job));
}

module.exports = {
  getJob,
  ingestStructured,
  listJobs,
  upsertJob
};
