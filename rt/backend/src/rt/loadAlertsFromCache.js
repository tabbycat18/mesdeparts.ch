import GtfsRealtimeBindings from "gtfs-realtime-bindings";

import { getRtCache, LA_SERVICEALERTS_FEED_KEY } from "../db/rtCache.js";
import { normalizeAlertEntity } from "../loaders/fetchServiceAlerts.js";

const DEFAULT_ALERTS_FRESH_MAX_AGE_MS = Math.max(
  5_000,
  Number(process.env.STATIONBOARD_ALERTS_FRESH_MAX_AGE_MS || "120000")
);

const EMPTY_ALERTS = Object.freeze({ entities: [] });

function text(value) {
  return String(value || "").trim();
}

function toFiniteNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function parsedTimestampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function baseMeta(nowMs) {
  return {
    available: false,
    applied: false,
    reason: "missing_cache",
    feedKey: LA_SERVICEALERTS_FEED_KEY,
    fetchedAt: null,
    cacheFetchedAt: null,
    cacheAgeMs: null,
    ageSeconds: null,
    freshnessThresholdMs: DEFAULT_ALERTS_FRESH_MAX_AGE_MS,
    freshnessMaxAgeSeconds: Math.round(DEFAULT_ALERTS_FRESH_MAX_AGE_MS / 1000),
    status: null,
    lastStatus: null,
    lastError: null,
    payloadBytes: null,
    cacheStatus: "MISS",
    nowIso: new Date(nowMs).toISOString(),
  };
}

export async function loadAlertsFromCache(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const enabled = options.enabled !== false;
  const feedKey = text(options.feedKey || LA_SERVICEALERTS_FEED_KEY) || LA_SERVICEALERTS_FEED_KEY;
  const freshnessThresholdMs = Math.max(
    5_000,
    Number(options.freshnessThresholdMs || DEFAULT_ALERTS_FRESH_MAX_AGE_MS)
  );
  const readCacheLike = typeof options.readCacheLike === "function" ? options.readCacheLike : getRtCache;

  const meta = baseMeta(nowMs);
  meta.feedKey = feedKey;
  meta.freshnessThresholdMs = freshnessThresholdMs;
  meta.freshnessMaxAgeSeconds = Math.round(freshnessThresholdMs / 1000);
  if (!enabled) {
    meta.reason = "disabled";
    meta.cacheStatus = "BYPASS";
    return { alerts: EMPTY_ALERTS, meta };
  }

  let cacheRow = null;
  try {
    cacheRow = await readCacheLike(feedKey);
  } catch (err) {
    meta.reason = "decode_failed";
    meta.cacheStatus = "ERROR";
    meta.lastError = text(err?.message || err) || "read_cache_failed";
    return { alerts: EMPTY_ALERTS, meta };
  }

  const fetchedAtMs = parsedTimestampMs(cacheRow?.fetched_at);
  const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, nowMs - fetchedAtMs) : null;
  const payloadBuffer = Buffer.isBuffer(cacheRow?.payloadBytes)
    ? cacheRow.payloadBytes
    : Buffer.from(cacheRow?.payloadBytes || []);

  meta.fetchedAt = toIsoOrNull(fetchedAtMs);
  meta.cacheFetchedAt = meta.fetchedAt;
  meta.cacheAgeMs = Number.isFinite(ageMs) ? Math.round(ageMs) : null;
  meta.ageSeconds = Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null;
  meta.status = toFiniteNumberOrNull(cacheRow?.last_status);
  meta.lastStatus = toFiniteNumberOrNull(cacheRow?.last_status);
  meta.lastError = text(cacheRow?.last_error) || null;
  meta.payloadBytes = payloadBuffer.length || 0;

  if (!payloadBuffer.length) {
    meta.reason = "missing_cache";
    meta.cacheStatus = "MISS";
    return { alerts: EMPTY_ALERTS, meta };
  }

  if (Number.isFinite(ageMs) && ageMs > freshnessThresholdMs) {
    meta.reason = "stale_cache";
    meta.cacheStatus = "STALE";
    return { alerts: EMPTY_ALERTS, meta };
  }

  let entitiesRaw = [];
  try {
    const feedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(payloadBuffer);
    entitiesRaw = Array.isArray(feedMessage?.entity) ? feedMessage.entity : [];
  } catch (err) {
    meta.reason = "decode_failed";
    meta.cacheStatus = "ERROR";
    meta.lastError = text(err?.message || err) || "decode_failed";
    return { alerts: EMPTY_ALERTS, meta };
  }

  const entities = entitiesRaw
    .map(normalizeAlertEntity)
    .filter((entity) => entity && text(entity.id));

  meta.available = entities.length > 0;
  meta.applied = entities.length > 0;
  meta.reason = entities.length > 0 ? "applied" : "no_alerts";
  meta.cacheStatus = "FRESH";
  return {
    alerts: { entities },
    meta,
  };
}
