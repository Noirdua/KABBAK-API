function resolveApiRouteGroup(pathname) {
  const cleanPath = String(pathname || "").split("?")[0].trim();
  const segments = cleanPath.split("/").filter(Boolean);

  if (segments[0] === "api" && /^v\d+$/i.test(segments[1] || "")) {
    return segments[2] || "root";
  }

  return segments[0] || "root";
}

module.exports = {
  resolveApiRouteGroup
};