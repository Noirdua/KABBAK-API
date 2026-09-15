const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  "apikey",
  "api_key",
  "x-api-key",
  "token"
]);

function sanitizeRequestUrl(rawUrl) {
  const normalizedUrl = String(rawUrl || "").trim();
  if (!normalizedUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(normalizedUrl, "http://localhost");
    let didSanitize = false;

    Array.from(parsedUrl.searchParams.keys()).forEach((key) => {
      if (!SENSITIVE_QUERY_PARAM_NAMES.has(String(key || "").trim().toLowerCase())) {
        return;
      }

      parsedUrl.searchParams.set(key, "[redacted]");
      didSanitize = true;
    });

    if (!didSanitize) {
      return normalizedUrl;
    }

    return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return normalizedUrl.replace(/([?&](?:apiKey|api_key|x-api-key)=)[^&#]*/ig, "$1[redacted]");
  }
}

module.exports = {
  sanitizeRequestUrl
};