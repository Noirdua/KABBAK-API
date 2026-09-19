function applyApiSecurityHeaders(_request, response, next) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  if (String(_request.headers["access-control-request-private-network"] || "").toLowerCase() === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  if (process.env.NODE_ENV === "production" || _request.secure || _request.protocol === "https") {
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  next();
}

module.exports = {
  applyApiSecurityHeaders
};