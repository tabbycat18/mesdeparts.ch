import { performance } from "node:perf_hooks";

import { readTripUpdatesFeedFromCache } from "../../loaders/loadRealtime.js";

const DEFAULT_RT_FRESH_MAX_AGE_MS = Math.max(
  5_000,
  Number(process.env.STATIONBOARD_RT_FRESH_MAX_AGE_MS || "45000")
);
const DEFAULT_RT_SCOPE_MAX_PROCESS_MS = Math.max(
  20,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_PROCESS_MS || "250")
);
const DEFAULT_RT_SCOPE_MAX_SCANNED_ENTITIES = Math.max(
  100,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_SCANNED_ENTITIES || "35000")
);
const DEFAULT_RT_SCOPE_MAX_SCOPED_ENTITIES = Math.max(
  10,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_SCOPED_ENTITIES || "900")
);
const DEFAULT_RT_SCOPE_MAX_SCOPED_STOP_UPDATES = Math.max(
  100,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_SCOPED_STOP_UPDATES || "20000")
);

const EMPTY_SCOPED_RT = Object.freeze({ entities: [], entity: [] });

function text(value) {
  return String(value || "").trim();
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const out = Number(value);
    return Number.isFinite(out) ? out : null;
  }
  return null;
}

function toIsoOrNull(value) {
  const ms = value == null ? NaN : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function stopIdVariants(stopId) {
  const base = text(stopId);
  if (!base) return [];

  const out = new Set([base]);
  const parts = base.split(":");
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (last.length <= 2) {
      out.add(parts.slice(0, -1).join(":"));
    }
  }
  return Array.from(out);
}

function stopScopeSet(stopIds = []) {
  const out = new Set();
  for (const stopId of stopIds) {
    for (const variant of stopIdVariants(stopId)) {
      out.add(variant);
    }
  }
  return out;
}

function getTripUpdate(entity) {
  if (!entity || typeof entity !== "object") return null;
  return entity.trip_update || entity.tripUpdate || null;
}

function getTripDescriptor(tripUpdate) {
  if (!tripUpdate || typeof tripUpdate !== "object") return null;
  return tripUpdate.trip || null;
}

function getTripId(tripUpdate) {
  const trip = getTripDescriptor(tripUpdate);
  return text(trip?.trip_id || trip?.tripId);
}

function getTripScheduleRelationship(tripUpdate) {
  const trip = getTripDescriptor(tripUpdate);
  const raw = trip?.schedule_relationship ?? trip?.scheduleRelationship;
  if (typeof raw === "string") return raw.toUpperCase();
  const n = asNumber(raw);
  switch (n) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "ADDED";
    case 2:
      return "UNSCHEDULED";
    case 3:
      return "CANCELED";
    case 4:
      return "DUPLICATED";
    default:
      return "";
  }
}

function getStopTimeUpdates(tripUpdate) {
  const updates = tripUpdate?.stop_time_update || tripUpdate?.stopTimeUpdate;
  return Array.isArray(updates) ? updates : [];
}

function getStopId(stopTimeUpdate) {
  return text(stopTimeUpdate?.stop_id || stopTimeUpdate?.stopId);
}

function getDepartureEpoch(stopTimeUpdate) {
  const dep = stopTimeUpdate?.departure;
  if (!dep || typeof dep !== "object") return null;
  return asNumber(dep.time);
}

function getEntityCount(feed) {
  const entities = Array.isArray(feed?.entities)
    ? feed.entities
    : Array.isArray(feed?.entity)
      ? feed.entity
      : [];
  return entities.length;
}

function baseMeta(nowMs) {
  return {
    applied: false,
    reason: "missing_cache",
    available: false,
    fetchedAt: null,
    ageSeconds: null,
    freshnessMaxAgeSeconds: Math.round(DEFAULT_RT_FRESH_MAX_AGE_MS / 1000),
    cacheStatus: "MISS",
    hasPayload: false,
    lastStatus: null,
    lastError: null,
    etag: null,
    entityCount: 0,
    scannedEntities: 0,
    scopedEntities: 0,
    scopedStopUpdates: 0,
    processingMs: 0,
    nowIso: new Date(nowMs).toISOString(),
  };
}

function isWithinWindow(epochSec, windowStartEpochSec, windowEndEpochSec) {
  if (!Number.isFinite(epochSec)) return false;
  if (!Number.isFinite(windowStartEpochSec) || !Number.isFinite(windowEndEpochSec)) return true;
  return epochSec >= windowStartEpochSec && epochSec <= windowEndEpochSec;
}

function guardTripped(processingMs, scannedEntities, scopedEntities, scopedStopUpdates, limits) {
  if (processingMs > limits.maxProcessMs) return true;
  if (scannedEntities > limits.maxScannedEntities) return true;
  if (scopedEntities > limits.maxScopedEntities) return true;
  if (scopedStopUpdates > limits.maxScopedStopUpdates) return true;
  return false;
}

export async function loadScopedRtFromCache(options = {}) {
  const {
    enabled = true,
    nowMs = Date.now(),
    windowStartEpochSec = null,
    windowEndEpochSec = null,
    scopeTripIds = [],
    scopeStopIds = [],
    readCacheLike = readTripUpdatesFeedFromCache,
  } = options;

  const limits = {
    maxProcessMs: Math.max(
      20,
      Number(options.maxProcessMs || DEFAULT_RT_SCOPE_MAX_PROCESS_MS)
    ),
    maxScannedEntities: Math.max(
      100,
      Number(options.maxScannedEntities || DEFAULT_RT_SCOPE_MAX_SCANNED_ENTITIES)
    ),
    maxScopedEntities: Math.max(
      10,
      Number(options.maxScopedEntities || DEFAULT_RT_SCOPE_MAX_SCOPED_ENTITIES)
    ),
    maxScopedStopUpdates: Math.max(
      100,
      Number(options.maxScopedStopUpdates || DEFAULT_RT_SCOPE_MAX_SCOPED_STOP_UPDATES)
    ),
  };

  const meta = baseMeta(nowMs);
  if (!enabled) {
    meta.reason = "disabled";
    meta.cacheStatus = "BYPASS";
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  const startedAt = performance.now();
  let cache;
  try {
    cache = await readCacheLike();
  } catch (err) {
    meta.reason = "decode_failed";
    meta.lastError = text(err?.message || err) || "read_cache_failed";
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  const fetchedAtMs = cache?.fetchedAtMs;
  const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, nowMs - fetchedAtMs) : null;
  meta.fetchedAt = toIsoOrNull(fetchedAtMs);
  meta.ageSeconds = Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null;
  meta.hasPayload = cache?.hasPayload === true;
  meta.lastStatus = Number.isFinite(Number(cache?.lastStatus)) ? Number(cache.lastStatus) : null;
  meta.lastError = text(cache?.lastError) || null;
  meta.etag = text(cache?.etag) || null;
  meta.entityCount = getEntityCount(cache?.feed);

  if (!cache?.hasPayload) {
    meta.reason = "missing_cache";
    meta.cacheStatus = "MISS";
    meta.available = false;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  if (cache?.decodeError) {
    meta.reason = "decode_failed";
    meta.cacheStatus = "ERROR";
    meta.available = true;
    meta.lastError = text(cache.decodeError?.message || cache.decodeError) || meta.lastError;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  if (!cache?.feed || meta.entityCount <= 0) {
    meta.reason = "decode_failed";
    meta.cacheStatus = "ERROR";
    meta.available = true;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  if (!Number.isFinite(ageMs) || ageMs > DEFAULT_RT_FRESH_MAX_AGE_MS) {
    meta.reason = "stale_cache";
    meta.cacheStatus = "STALE";
    meta.available = true;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_SCOPED_RT, meta };
  }

  const scopeTrips = new Set((scopeTripIds || []).map(text).filter(Boolean));
  const scopeStops = stopScopeSet(scopeStopIds || []);

  const allEntities = Array.isArray(cache.feed?.entities)
    ? cache.feed.entities
    : Array.isArray(cache.feed?.entity)
      ? cache.feed.entity
      : [];

  const scopedEntities = [];
  let scannedEntities = 0;
  let scopedStopUpdates = 0;

  for (const entity of allEntities) {
    scannedEntities += 1;
    const elapsedAfterIncludeMs = performance.now() - startedAt;
    if (
      guardTripped(
        elapsedAfterIncludeMs,
        scannedEntities,
        scopedEntities.length,
        scopedStopUpdates,
        limits
      )
    ) {
      meta.reason = "guard_tripped";
      meta.cacheStatus = "GUARD";
      meta.available = true;
      meta.scannedEntities = scannedEntities;
      meta.scopedEntities = scopedEntities.length;
      meta.scopedStopUpdates = scopedStopUpdates;
      meta.processingMs = Number(elapsedAfterIncludeMs.toFixed(1));
      return { tripUpdates: EMPTY_SCOPED_RT, meta };
    }

    const tripUpdate = getTripUpdate(entity);
    if (!tripUpdate) continue;

    const tripId = getTripId(tripUpdate);
    const scheduleRelationship = getTripScheduleRelationship(tripUpdate);
    const stopUpdates = getStopTimeUpdates(tripUpdate);

    let includeEntity = scopeTrips.has(tripId);

    if (!includeEntity) {
      for (const stopUpdate of stopUpdates) {
        const rawStopId = getStopId(stopUpdate);
        if (!rawStopId) continue;

        const variants = stopIdVariants(rawStopId);
        const matchesStop = variants.some((variant) => scopeStops.has(variant));
        if (!matchesStop) continue;

        const depEpoch = getDepartureEpoch(stopUpdate);
        if (scheduleRelationship === "ADDED") {
          if (!isWithinWindow(depEpoch, windowStartEpochSec, windowEndEpochSec)) {
            continue;
          }
        }

        includeEntity = true;
        break;
      }
    }

    if (!includeEntity) continue;

    scopedEntities.push(entity);
    scopedStopUpdates += stopUpdates.length;

    const elapsedMs = performance.now() - startedAt;
    if (
      guardTripped(
        elapsedMs,
        scannedEntities,
        scopedEntities.length,
        scopedStopUpdates,
        limits
      )
    ) {
      meta.reason = "guard_tripped";
      meta.cacheStatus = "GUARD";
      meta.available = true;
      meta.scannedEntities = scannedEntities;
      meta.scopedEntities = scopedEntities.length;
      meta.scopedStopUpdates = scopedStopUpdates;
      meta.processingMs = Number(elapsedAfterIncludeMs.toFixed(1));
      return { tripUpdates: EMPTY_SCOPED_RT, meta };
    }
  }

  meta.available = true;
  meta.applied = true;
  meta.reason = "applied";
  meta.cacheStatus = "FRESH";
  meta.scannedEntities = scannedEntities;
  meta.scopedEntities = scopedEntities.length;
  meta.scopedStopUpdates = scopedStopUpdates;
  meta.processingMs = Number((performance.now() - startedAt).toFixed(1));

  return {
    tripUpdates: {
      entities: scopedEntities,
      entity: scopedEntities,
    },
    meta,
  };
}
