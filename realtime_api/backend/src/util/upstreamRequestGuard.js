const BLOCKED_HOST_PATTERNS = [
  /(^|\.)opentransportdata\.swiss$/i,
  /(^|\.)transport\.opendata\.ch$/i,
];

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return String(parsed.hostname || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export function isBlockedStationboardUpstreamUrl(url) {
  const host = hostnameFromUrl(url);
  if (!host) return false;
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

export function guardStationboardRequestPathUpstream(url, options = {}) {
  const {
    scope = "api/stationboard",
    env = process.env.NODE_ENV || "development",
    logger = console,
  } = options;

  if (!isBlockedStationboardUpstreamUrl(url)) {
    return true;
  }

  const message = `request_path_upstream_blocked scope=${scope} url=${String(url || "")}`;
  if (String(env).toLowerCase() !== "production") {
    const err = new Error(message);
    err.code = "request_path_upstream_blocked";
    err.url = String(url || "");
    err.scope = scope;
    throw err;
  }

  logger?.error?.("[upstream-guard] blocked request-path upstream", {
    scope,
    url: String(url || ""),
  });
  return false;
}
