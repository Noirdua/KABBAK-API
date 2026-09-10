function normalizeIp(value) {
  return String(value || "")
    .trim()
    .replace(/^::ffff:/i, "");
}

// Loopback and private-range addresses are local/dev traffic, not public abuse.
function isLoopbackOrPrivateIp(ip) {
  const value = normalizeIp(ip);
  if (!value) {
    return false;
  }

  if (value === "::1" || value === "0.0.0.0") {
    return true;
  }

  if (/^127\./.test(value)) {
    return true;
  }

  if (/^10\./.test(value)) {
    return true;
  }
  if (/^192\.168\./.test(value)) {
    return true;
  }
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(value)) {
    return true;
  }
  // CGNAT (e.g. Tailscale 100.64.0.0/10), link-local, benchmark ranges.
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(value)) {
    return true;
  }
  if (/^169\.254\./.test(value)) {
    return true;
  }
  if (/^198\.(18|19)\./.test(value)) {
    return true;
  }
  if (/^(fc|fd)/.test(value)) {
    return true;
  }
  if (/^fe80/.test(value)) {
    return true;
  }

  return false;
}

module.exports = {
  isLoopbackOrPrivateIp,
  normalizeIp
};
