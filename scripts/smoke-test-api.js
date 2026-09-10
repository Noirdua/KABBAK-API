function parseArguments(argv) {
  const values = {
    baseUrl: "http://127.0.0.1:3100",
    apiKey: "",
    basicApiKey: "",
    adminApiKey: "",
    allowedOrigin: "http://localhost:8080",
    blockedOrigin: "http://evil.example"
  };

  const keyMap = new Map([
    ["-baseurl", "baseUrl"],
    ["--base-url", "baseUrl"],
    ["--baseurl", "baseUrl"],
    ["-apikey", "apiKey"],
    ["--api-key", "apiKey"],
    ["--apikey", "apiKey"],
    ["-basicapikey", "basicApiKey"],
    ["--basic-api-key", "basicApiKey"],
    ["--basicapikey", "basicApiKey"],
    ["-adminapikey", "adminApiKey"],
    ["--admin-api-key", "adminApiKey"],
    ["--adminapikey", "adminApiKey"],
    ["-allowedorigin", "allowedOrigin"],
    ["--allowed-origin", "allowedOrigin"],
    ["--allowedorigin", "allowedOrigin"],
    ["-blockedorigin", "blockedOrigin"],
    ["--blocked-origin", "blockedOrigin"],
    ["--blockedorigin", "blockedOrigin"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const rawKey = String(argv[index] || "").trim();
    const normalizedKey = rawKey.toLowerCase();
    if (!keyMap.has(normalizedKey)) {
      continue;
    }

    const nextValue = String(argv[index + 1] || "").trim();
    values[keyMap.get(normalizedKey)] = nextValue;
    index += 1;
  }

  return values;
}

function joinApiUrl(root, path) {
  const normalizedRoot = String(root || "").trim().replace(/\/+$/, "");
  if (!normalizedRoot) {
    throw new Error("BaseUrl is required.");
  }

  const normalizedPath = String(path || "").trim();
  if (/^https?:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }

  return `${normalizedRoot}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

async function invokeSmokeRequest(baseUrl, caseName, path, headers = {}) {
  const uri = joinApiUrl(baseUrl, path);
  try {
    const response = await fetch(uri, { headers });
    const content = await response.text();
    const contentType = String(response.headers.get("content-type") || "");
    let json = null;
    if (/application\/json/i.test(contentType)) {
      try {
        json = JSON.parse(content);
      } catch (error) {
        console.error(`[smoke] Failed to parse JSON response for ${caseName} at ${uri}: ${error.message}`);
      }
    }

    return {
      caseName,
      uri,
      status: response.status,
      headers: response.headers,
      content,
      json
    };
  } catch (networkError) {
    return {
      caseName,
      uri,
      status: 0,
      headers: new Headers(),
      content: "",
      json: null,
      networkError: networkError.message
    };
  }
}

function addResult(results, caseName, passed, detail) {
  results.push({
    Case: caseName,
    Passed: passed,
    Detail: detail
  });
}

function hasObjectProperty(value, propertyName) {
  return Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, propertyName);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = [];

  const health = await invokeSmokeRequest(options.baseUrl, "health-no-auth", "/api/v1/health");
  const healthPassed = health.status === 200 && health.json?.ok === true;
  addResult(results, "health-no-auth", healthPassed, `status=${health.status} apiKeyRequired=${health.json?.apiKeyRequired}`);

  if (!healthPassed) {
    console.table(results);
    throw new Error("Health check failed.");
  }

  const readiness = await invokeSmokeRequest(options.baseUrl, "health-ready-no-auth", "/api/v1/health/ready");
  addResult(
    results,
    "health-ready-no-auth",
    readiness.status === 200 && readiness.json?.ready === true && readiness.json?.storage?.ready === true,
    `status=${readiness.status} ready=${readiness.json?.ready}`
  );

  const apiKeyRequired = Boolean(health.json?.apiKeyRequired);
  if (apiKeyRequired && !options.apiKey) {
    console.table(results);
    throw new Error("The API requires a key. Re-run with -ApiKey <value>.");
  }

  const protectedNoAuth = await invokeSmokeRequest(options.baseUrl, "decks-options-no-auth", "/api/v1/decks/options");
  const expectedNoAuthStatus = apiKeyRequired ? 401 : 200;
  addResult(
    results,
    "decks-options-no-auth",
    protectedNoAuth.status === expectedNoAuthStatus,
    `status=${protectedNoAuth.status} expected=${expectedNoAuthStatus}`
  );

  const authHeaders = options.apiKey ? { "x-api-key": options.apiKey } : {};
  const protectedWithHeader = await invokeSmokeRequest(
    options.baseUrl,
    "decks-options-header-auth",
    "/api/v1/decks/options",
    authHeaders
  );
  addResult(
    results,
    "decks-options-header-auth",
    protectedWithHeader.status === 200 && Array.isArray(protectedWithHeader.json?.data?.decks),
    `status=${protectedWithHeader.status}`
  );

  if (options.basicApiKey) {
    const basicHeaders = { "x-api-key": options.basicApiKey };
    const basicAllowed = await invokeSmokeRequest(
      options.baseUrl,
      "basic-non-tarot-allowed",
      "/api/v1/astrology/planets",
      basicHeaders
    );
    addResult(
      results,
      "basic-non-tarot-allowed",
      basicAllowed.status === 200,
      `status=${basicAllowed.status}`
    );

    const basicTarotForbidden = await invokeSmokeRequest(
      options.baseUrl,
      "basic-tarot-forbidden",
      "/api/v1/tarot/spreads",
      basicHeaders
    );
    addResult(
      results,
      "basic-tarot-forbidden",
      basicTarotForbidden.status === 403 && basicTarotForbidden.json?.error === "insufficient_access_level",
      `status=${basicTarotForbidden.status} error=${basicTarotForbidden.json?.error || ""}`
    );

    const basicTarotAssetForbidden = await invokeSmokeRequest(
      options.baseUrl,
      "basic-tarot-asset-forbidden",
      "/api/v1/assets/tarot%20deck/decks.json",
      basicHeaders
    );
    addResult(
      results,
      "basic-tarot-asset-forbidden",
      basicTarotAssetForbidden.status === 403 && basicTarotAssetForbidden.json?.error === "insufficient_access_level",
      `status=${basicTarotAssetForbidden.status} error=${basicTarotAssetForbidden.json?.error || ""}`
    );
  }

  if (options.apiKey) {
    const protectedWithBearer = await invokeSmokeRequest(
      options.baseUrl,
      "decks-options-bearer-auth",
      "/api/v1/decks/options",
      { authorization: `Bearer ${options.apiKey}` }
    );
    addResult(
      results,
      "decks-options-bearer-auth",
      protectedWithBearer.status === 200,
      `status=${protectedWithBearer.status}`
    );
  }

  const bootstrap = await invokeSmokeRequest(
    options.baseUrl,
    "bootstrap-reference-data",
    "/api/v1/bootstrap/reference-data",
    authHeaders
  );
  addResult(
    results,
    "bootstrap-reference-data",
    bootstrap.status === 200 && hasObjectProperty(bootstrap.json?.data || bootstrap.json, "planets"),
    `status=${bootstrap.status}`
  );

  const publicAsset = await invokeSmokeRequest(
    options.baseUrl,
    "public-asset",
    "/api/v1/assets/img/enochian/char(65).png"
  );
  addResult(
    results,
    "public-asset",
    publicAsset.status === 200 && Boolean(String(publicAsset.content || "").trim()),
    `status=${publicAsset.status}`
  );

  const premiumTarotAsset = await invokeSmokeRequest(
    options.baseUrl,
    "premium-tarot-asset",
    "/api/v1/assets/tarot%20deck/decks.json",
    authHeaders
  );
  addResult(
    results,
    "premium-tarot-asset",
    premiumTarotAsset.status === 200 && Boolean(String(premiumTarotAsset.content || "").trim()),
    `status=${premiumTarotAsset.status}`
  );

  if (options.adminApiKey) {
    const premiumAdminForbidden = await invokeSmokeRequest(
      options.baseUrl,
      "premium-admin-route-forbidden",
      "/api/v1/admin/api-clients",
      authHeaders
    );
    addResult(
      results,
      "premium-admin-route-forbidden",
      premiumAdminForbidden.status === 403 && premiumAdminForbidden.json?.error === "insufficient_admin_capability",
      `status=${premiumAdminForbidden.status} error=${premiumAdminForbidden.json?.error || ""}`
    );

    const adminClientList = await invokeSmokeRequest(
      options.baseUrl,
      "admin-client-list",
      "/api/v1/admin/api-clients",
      { "x-api-key": options.adminApiKey }
    );
    addResult(
      results,
      "admin-client-list",
      adminClientList.status === 200 && Number(adminClientList.json?.count || 0) >= 1,
      `status=${adminClientList.status} count=${adminClientList.json?.count || 0}`
    );
  }

  const metrics = await invokeSmokeRequest(
    options.baseUrl,
    "metrics-authenticated",
    "/api/v1/metrics",
    authHeaders
  );
  addResult(
    results,
    "metrics-authenticated",
    metrics.status === 200 && Number(metrics.json?.requests?.total || 0) >= 1,
    `status=${metrics.status} total=${metrics.json?.requests?.total || 0}`
  );

  const invalidGeo = await invokeSmokeRequest(
    options.baseUrl,
    "calendar-invalid-geo",
    "/api/v1/calendar/week-events?latitude=500&longitude=0",
    authHeaders
  );
  addResult(
    results,
    "calendar-invalid-geo",
    invalidGeo.status === 400 && invalidGeo.json?.error === "invalid_coordinates",
    `status=${invalidGeo.status} error=${invalidGeo.json?.error || ""}`
  );

  const allowedCors = await invokeSmokeRequest(
    options.baseUrl,
    "health-allowed-origin",
    "/api/v1/health",
    { origin: options.allowedOrigin }
  );
  const allowedCorsOrigin = String(allowedCors.headers.get("access-control-allow-origin") || "");
  addResult(
    results,
    "health-allowed-origin",
    allowedCors.status === 200 && allowedCorsOrigin === options.allowedOrigin,
    `status=${allowedCors.status} origin=${allowedCorsOrigin}`
  );

  const blockedCors = await invokeSmokeRequest(
    options.baseUrl,
    "health-blocked-origin",
    "/api/v1/health",
    { origin: options.blockedOrigin }
  );
  addResult(
    results,
    "health-blocked-origin",
    blockedCors.status === 403 && blockedCors.json?.error === "forbidden_origin",
    `status=${blockedCors.status} error=${blockedCors.json?.error || ""}`
  );

  console.table(results);

  if (results.some((entry) => !entry.Passed)) {
    process.exitCode = 1;
    return;
  }

  console.log(`Smoke test passed for ${options.baseUrl}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});