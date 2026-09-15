const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");

// Community reports: a user flags a board topic/reply and admins triage it from
// the admin panel. Internal bookkeeping only, never public.
const DEFAULT_PATH = path.join(storageConfigRoot, "board-reports.json");
const MAX_REPORTS = 500;
const MAX_REASON_LENGTH = 500;

function resolvePath(options = {}) {
  return options.filePath || DEFAULT_PATH;
}

function readReports(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePath(options), "utf8"));
    return Array.isArray(parsed?.reports) ? parsed.reports : [];
  } catch (_error) {
    return [];
  }
}

function writeReports(reports, options = {}) {
  const filePath = resolvePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, reports }, null, 2)}\n`, "utf8");
}

function normalizeReport(report) {
  if (!report || typeof report !== "object") {
    return null;
  }
  const createdAt = String(report.createdAt || new Date().toISOString());
  return {
    id: String(report.id || `report_${crypto.randomBytes(6).toString("hex")}`),
    topicId: String(report.topicId || "").slice(0, 80),
    replyId: String(report.replyId || "").slice(0, 80),
    topicTitle: String(report.topicTitle || "").slice(0, 200),
    reporterClientId: String(report.reporterClientId || "").slice(0, 120),
    reporterName: String(report.reporterName || "").slice(0, 80),
    reason: String(report.reason || "").slice(0, MAX_REASON_LENGTH),
    status: report.status === "resolved" ? "resolved" : "open",
    createdAt,
    resolvedAt: String(report.resolvedAt || "")
  };
}

function addReport(input = {}, reporter = {}, options = {}) {
  const topicId = String(input?.topicId || "").trim();
  if (!topicId) {
    const error = new Error("A topic id is required to report.");
    error.code = "invalid_report";
    throw error;
  }
  const reason = String(input?.reason || "").trim();
  if (!reason) {
    const error = new Error("A short reason is required.");
    error.code = "invalid_report";
    throw error;
  }
  if (reason.length > MAX_REASON_LENGTH) {
    const error = new Error(`A reason cannot exceed ${MAX_REASON_LENGTH} characters.`);
    error.code = "invalid_report";
    throw error;
  }

  const reports = readReports(options);
  const report = normalizeReport({
    id: `report_${crypto.randomBytes(6).toString("hex")}`,
    topicId,
    replyId: String(input?.replyId || "").trim(),
    topicTitle: String(input?.topicTitle || "").slice(0, 200),
    reporterClientId: reporter?.clientId || "",
    reporterName: reporter?.name || "",
    reason,
    status: "open",
    createdAt: new Date().toISOString()
  });
  reports.push(report);
  writeReports(reports.slice(-MAX_REPORTS), options);
  return report;
}

function listReports({ status } = {}, options = {}) {
  const wanted = String(status || "").trim().toLowerCase();
  return readReports(options)
    .map((report) => normalizeReport(report))
    .filter(Boolean)
    .filter((report) => !wanted || report.status === wanted)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function resolveReport(reportId, options = {}) {
  const reports = readReports(options);
  const index = reports.findIndex((report) => String(report?.id || "") === String(reportId || "").trim());
  if (index === -1) {
    const error = new Error(`Report '${reportId}' was not found.`);
    error.code = "report_not_found";
    throw error;
  }
  const report = normalizeReport(reports[index]);
  report.status = "resolved";
  report.resolvedAt = new Date().toISOString();
  reports[index] = report;
  writeReports(reports, options);
  return report;
}

function deleteReport(reportId, options = {}) {
  const reports = readReports(options);
  const next = reports.filter((report) => String(report?.id || "") !== String(reportId || "").trim());
  writeReports(next, options);
  return { removed: reports.length - next.length };
}

function clearReports(options = {}) {
  const reports = readReports(options);
  writeReports([], options);
  return { removed: reports.length };
}

module.exports = {
  addReport,
  clearReports,
  deleteReport,
  listReports,
  resolveReport
};
