export const LA_GTFS_RT_TRIP_UPDATES_URL = "https://api.opentransportdata.swiss/la/gtfs-rt";
const DEFAULT_TRIP_UPDATES_URL = `${LA_GTFS_RT_TRIP_UPDATES_URL}?format=JSON`;
const TRIP_UPDATES_FETCH_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.GTFS_RT_FETCH_TIMEOUT_MS || "8000")
);
const MIN_INTERVAL_MS = 12_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 10 * 60_000;

const fetchState = {
  inFlightPromise: null,
  lastSuccessfulFeed: null,
  lastSuccessfulAtMs: 0,
  nextAllowedAttemptMs: 0,
  consecutive429Count: 0,
};

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

export function resolveTripUpdatesApiKey(explicitApiKey) {
  return (
    explicitApiKey ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    ""
  );
}

function normalizeHeaderTimestamp(header) {
  // For M1 we keep unix seconds as number for downstream consistency.
  const raw = pick(header, "timestamp", "headerTimestamp");
  if (raw == null) return null;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  if (typeof raw === "object" && raw !== null && typeof raw.toNumber === "function") {
    const n = raw.toNumber();
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  return null;
}

function statusFromError(err) {
  const direct = Number(err?.status);
  if (Number.isFinite(direct)) return direct;
  const text = String(err?.message || "");
  const match = text.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryAfterMs(response) {
  const raw = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.max(0, Math.trunc(asSeconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function decisionLog(event, extra = {}) {
  const now = Date.now();
  const ageMs = fetchState.lastSuccessfulAtMs
    ? Math.max(0, now - fetchState.lastSuccessfulAtMs)
    : null;
  const waitMs = Math.max(0, fetchState.nextAllowedAttemptMs - now);
  console.log(`[GTFS-RT] ${event}`, {
    ageMs,
    ttlMs: MIN_INTERVAL_MS,
    nextAllowedInMs: waitMs,
    inFlight: fetchState.inFlightPromise !== null,
    ...extra,
  });
}

async function fetchTripUpdatesFromUpstream({ apiKey, urlOverride } = {}) {
  const token = resolveTripUpdatesApiKey(apiKey);
  if (!token) {
    throw new Error(
      "[GTFS-RT] Missing API token. Set GTFS_RT_TOKEN, OPENDATA_SWISS_TOKEN, or OPENTDATA_GTFS_RT_KEY."
    );
  }

  const url = urlOverride || DEFAULT_TRIP_UPDATES_URL;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TRIP_UPDATES_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `[GTFS-RT] fetch timeout after ${TRIP_UPDATES_FETCH_TIMEOUT_MS}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const err = new Error(
      `[GTFS-RT] HTTP ${response.status} when fetching trip updates: ${body.slice(0, 200)}`
    );
    err.status = response.status;
    const parsedRetryAfterMs = retryAfterMs(response);
    if (Number.isFinite(parsedRetryAfterMs)) {
      err.retryAfterMs = parsedRetryAfterMs;
    }
    throw err;
  }

  const raw = await response.json();
  const header = raw?.header || {};
  const entities = Array.isArray(raw?.entity)
    ? raw.entity
    : Array.isArray(raw?.entities)
      ? raw.entities
      : [];
  const feedVersion =
    pick(header, "feed_version", "feedVersion") ||
    pick(raw, "feed_version", "feedVersion") ||
    // Fallback only when Swiss feed_version is unavailable.
    pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion") ||
    "";

  return {
    feedVersion,
    gtfsRealtimeVersion:
      pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion") || "",
    headerTimestamp: normalizeHeaderTimestamp(header),
    entities,
    // Compatibility for existing code that still expects `entity`.
    entity: entities,
  };
}

export async function fetchTripUpdates({ apiKey, urlOverride } = {}) {
  const now = Date.now();
  const hasCached = !!fetchState.lastSuccessfulFeed;

  if (fetchState.inFlightPromise) {
    decisionLog("refresh_locked");
    return fetchState.inFlightPromise;
  }

  const hasFreshWithinMinInterval =
    fetchState.lastSuccessfulAtMs > 0 &&
    now - fetchState.lastSuccessfulAtMs < MIN_INTERVAL_MS;
  if (hasCached && hasFreshWithinMinInterval) {
    decisionLog("refresh_skipped_fresh");
    return fetchState.lastSuccessfulFeed;
  }

  if (now < fetchState.nextAllowedAttemptMs) {
    decisionLog("refresh_skipped_backoff");
    if (hasCached) return fetchState.lastSuccessfulFeed;
    const err = new Error(
      `[GTFS-RT] backoff active for ${Math.ceil(
        (fetchState.nextAllowedAttemptMs - now) / 1000
      )}s and no cached payload`
    );
    err.code = "GTFS_RT_BACKOFF_EMPTY";
    throw err;
  }

  // Hard floor between attempts, including non-429 errors.
  fetchState.nextAllowedAttemptMs = Math.max(
    fetchState.nextAllowedAttemptMs,
    now + MIN_INTERVAL_MS
  );
  decisionLog("refresh_started");

  const refreshPromise = fetchTripUpdatesFromUpstream({ apiKey, urlOverride })
    .then((feed) => {
      const completedAt = Date.now();
      fetchState.lastSuccessfulFeed = feed;
      fetchState.lastSuccessfulAtMs = completedAt;
      fetchState.nextAllowedAttemptMs = Math.max(
        fetchState.nextAllowedAttemptMs,
        completedAt + MIN_INTERVAL_MS
      );
      fetchState.consecutive429Count = 0;
      decisionLog("refresh_success", {
        entityCount: Array.isArray(feed?.entities) ? feed.entities.length : null,
      });
      return feed;
    })
    .catch((err) => {
      const completedAt = Date.now();
      const status = statusFromError(err);
      if (status === 429) {
        fetchState.consecutive429Count = Math.min(
          fetchState.consecutive429Count + 1,
          10
        );
        const expBackoffMs = Math.min(
          RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (fetchState.consecutive429Count - 1),
          RATE_LIMIT_BACKOFF_MAX_MS
        );
        const hintedRetryAfterMs = Number(err?.retryAfterMs);
        const backoffMs = Math.max(
          RATE_LIMIT_BACKOFF_BASE_MS,
          Number.isFinite(hintedRetryAfterMs) ? hintedRetryAfterMs : 0,
          expBackoffMs
        );
        fetchState.nextAllowedAttemptMs = Math.max(
          fetchState.nextAllowedAttemptMs,
          completedAt + backoffMs
        );
        decisionLog("refresh_429_backoff", { backoffMs });
      } else {
        fetchState.nextAllowedAttemptMs = Math.max(
          fetchState.nextAllowedAttemptMs,
          completedAt + MIN_INTERVAL_MS
        );
      }

      if (fetchState.lastSuccessfulFeed) {
        return fetchState.lastSuccessfulFeed;
      }
      throw err;
    })
    .finally(() => {
      if (fetchState.inFlightPromise === refreshPromise) {
        fetchState.inFlightPromise = null;
      }
    });

  fetchState.inFlightPromise = refreshPromise;
  return refreshPromise;
}

export function __resetTripUpdatesFetchStateForTests() {
  fetchState.inFlightPromise = null;
  fetchState.lastSuccessfulFeed = null;
  fetchState.lastSuccessfulAtMs = 0;
  fetchState.nextAllowedAttemptMs = 0;
  fetchState.consecutive429Count = 0;
}

export function __getTripUpdatesFetchStateForTests() {
  return {
    inFlight: fetchState.inFlightPromise !== null,
    lastSuccessfulAtMs: fetchState.lastSuccessfulAtMs,
    nextAllowedAttemptMs: fetchState.nextAllowedAttemptMs,
    consecutive429Count: fetchState.consecutive429Count,
    hasLastSuccessfulFeed: !!fetchState.lastSuccessfulFeed,
  };
}
