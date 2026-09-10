const packageJson = require("../../package.json");

const serviceName = String(packageJson.name || "kabbak-api").trim() || "kabbak-api";
const serviceVersion = String(packageJson.version || "0.0.0").trim() || "0.0.0";
const apiBasePath = "/api/v1";

module.exports = {
  serviceName,
  serviceVersion,
  apiBasePath
};