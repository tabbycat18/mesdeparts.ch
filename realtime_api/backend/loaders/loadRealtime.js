// backend/loaders/loadRealtime.js
import { pool } from "../db.js";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  getRtCache,
  getRtCacheMeta,
  getRtCachePayloadSha,
  LA_TRIPUPDATES_FEED_KEY,
} from "../src/db/rtCache.js";
import { computeDepartureDelayDisplayFromSeconds } from "../src/util/departureDelay.js";

// Set DEBUG_RT=1 if you want logs
const DEBUG_RT = process.env.DEBUG_RT === "1";

const rawTtl = Number(process.env.GTFS_RT_CACHE_MS || "30000");
const CACHE_TTL_MS = Math.max(Number.isFinite(rawTtl) ? rawTtl : 30000, 1000);
const rawDecodedFeedTtl = Number(process.env.RT_DECODED_FEED_CACHE_MS || "10000");
const DECODED_FEED_CACHE_TTL_MS = Math.min(
  15_000,
  Math.max(Number.isFinite(rawDecodedFeedTtl) ? rawDecodedFeedTtl : 10_000, 10_000)
);

const RT_RETENTION_HOURS = Number(process.env.RT_RETENTION_HOURS || "12");
const RT_RETENTION_MS = Math.max(1, RT_RETENTION_HOURS) * 60 * 60 * 1000;
const RT_STATE_MAX_AGE_MINUTES = Math.max(
  30,
  Number(process.env.RT_STATE_MAX_AGE_MINUTES || "240")
);
const RT_STATE_MAX_AGE_MS = RT_STATE_MAX_AGE_MINUTES * 60 * 1000;
const RT_STATE_POST_DEPARTURE_GRACE_MINUTES = Math.max(
  1,
  Number(process.env.RT_STATE_POST_DEPARTURE_GRACE_MINUTES || "30")
);
const RT_STATE_POST_DEPARTURE_GRACE_MS =
  RT_STATE_POST_DEPARTURE_GRACE_MINUTES * 60 * 1000;

let rtTableReady = false;
let lastCleanupTs = 0;
const decodedFeedCache = new Map();

async function ensureRtUpdatesTable() {
  if (rtTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.rt_updates (
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER,
      departure_epoch BIGINT,
      delay_sec INTEGER,
      seen_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS rt_updates_unique_idx
      ON public.rt_updates (trip_id, stop_id, stop_sequence, departure_epoch);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rt_updates_stop_time_idx
      ON public.rt_updates (stop_id, departure_epoch);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rt_updates_trip_seq_idx
      ON public.rt_updates (trip_id, stop_sequence);
  `);
  rtTableReady = true;
}

async function persistRtUpdates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    await ensureRtUpdatesTable();
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = [];
      const params = [];
      let p = 1;
      for (const r of chunk) {
        values.push(
          r.tripId,
          r.stopId,
          typeof r.stopSequence === "number" ? r.stopSequence : -1,
          r.departureEpoch,
          typeof r.delaySec === "number" ? r.delaySec : null
        );
        params.push(
          `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`
        );
        p += 5;
      }
      const sql = `
        INSERT INTO public.rt_updates
          (trip_id, stop_id, stop_sequence, departure_epoch, delay_sec)
        VALUES ${params.join(", ")}
        ON CONFLICT (trip_id, stop_id, stop_sequence, departure_epoch)
        DO UPDATE SET
          delay_sec = EXCLUDED.delay_sec,
          seen_at = now();
      `;
      await pool.query(sql, values);
    }

    const now = Date.now();
    if (now - lastCleanupTs > RT_RETENTION_MS) {
      lastCleanupTs = now;
      await pool.query(
        `DELETE FROM public.rt_updates WHERE seen_at < now() - ($1 || ' milliseconds')::interval;`,
        [RT_RETENTION_MS]
      );
    }
  } catch (err) {
    if (DEBUG_RT) {
      console.warn("[GTFS-RT] persistRtUpdates failed", err?.message || err);
    }
  }
}

/**
 * Some feeds may use stop_id without platform suffix.
 * Example DB: 8501037:0:3  (platform 3)
 * Feed may use: 8501037:0   (no platform)
 */
function stopIdVariants(stopId) {
  if (!stopId) return [];
  const v = new Set([stopId]);

  const parts = String(stopId).split(":");
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (String(last).length <= 2) {
      v.add(parts.slice(0, parts.length - 1).join(":"));
    }
  }
  return Array.from(v);
}

function seqKeyPart(stopSequence) {
  if (stopSequence === undefined || stopSequence === null) return "";
  const n = Number(stopSequence);
  return Number.isFinite(n) ? String(n) : "";
}

function normalizeTripStartDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return "";
  return digits;
}

function buildTripStartKey(tripId, tripStartDate = "") {
  const id = String(tripId || "").trim();
  if (!id) return "";
  const start = normalizeTripStartDate(tripStartDate);
  return start ? `${id}|${start}` : `${id}|`;
}

function buildStopRealtimeKey(tripId, stopId, seqPart, tripStartDate = "") {
  const base = `${tripId}|${stopId}|${seqPart}`;
  const start = normalizeTripStartDate(tripStartDate);
  return start ? `${base}|${start}` : base;
}

function upsertTripFallbackCandidate(byTripStart, candidate) {
  if (!byTripStart || typeof byTripStart !== "object") return;
  const tripId = String(candidate?.tripId || "").trim();
  if (!tripId) return;
  const tripStartDate = normalizeTripStartDate(candidate?.tripStartDate);
  const stopSequence = Number(candidate?.stopSequence);
  if (!Number.isFinite(stopSequence)) return;

  const delaySecRaw =
    typeof candidate?.delaySec === "number" && Number.isFinite(candidate.delaySec)
      ? Number(candidate.delaySec)
      : typeof candidate?.delayMin === "number" && Number.isFinite(candidate.delayMin)
        ? Number(candidate.delayMin) * 60
        : null;
  if (!Number.isFinite(delaySecRaw)) return;

  const key = tripStartDate ? `${tripId}|${tripStartDate}` : `${tripId}|`;
  if (!byTripStart[key]) byTripStart[key] = [];
  const list = byTripStart[key];
  const next = {
    tripId,
    tripStartDate,
    stopSequence,
    delaySec: delaySecRaw,
    delayMin:
      typeof candidate?.delayMin === "number" && Number.isFinite(candidate.delayMin)
        ? Number(candidate.delayMin)
        : null,
    updatedDepartureEpoch:
      typeof candidate?.updatedDepartureEpoch === "number" &&
      Number.isFinite(candidate.updatedDepartureEpoch)
        ? Number(candidate.updatedDepartureEpoch)
        : null,
  };

  const existingIndex = list.findIndex((row) => Number(row?.stopSequence) === stopSequence);
  if (existingIndex < 0) {
    list.push(next);
    return;
  }
  const prev = list[existingIndex];
  const prevEpoch =
    typeof prev?.updatedDepartureEpoch === "number" && Number.isFinite(prev.updatedDepartureEpoch)
      ? Number(prev.updatedDepartureEpoch)
      : null;
  const nextEpoch = next.updatedDepartureEpoch;
  if (prevEpoch !== null && nextEpoch !== null && prevEpoch > nextEpoch) return;
  if (prevEpoch !== null && nextEpoch === null) return;
  list[existingIndex] = next;
}

function deriveTripFallbackByTripStartFromByKey(byKey) {
  const out = Object.create(null);
  for (const value of Object.values(byKey || {})) {
    upsertTripFallbackCandidate(out, value);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => Number(a?.stopSequence || 0) - Number(b?.stopSequence || 0));
  }
  return out;
}

function cloneTripFlags(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    hasSuppressedStop: src.hasSuppressedStop === true,
    maxSuppressedStopSequence: Number.isFinite(src.maxSuppressedStopSequence)
      ? Number(src.maxSuppressedStopSequence)
      : null,
    minSuppressedStopSequence: Number.isFinite(src.minSuppressedStopSequence)
      ? Number(src.minSuppressedStopSequence)
      : null,
    hasUnknownSuppressedSequence: src.hasUnknownSuppressedSequence === true,
    tripStartDate: normalizeTripStartDate(src.tripStartDate),
    _lastSeenAtMs: Number.isFinite(src._lastSeenAtMs) ? Number(src._lastSeenAtMs) : null,
  };
}

function mergeTripFlags(prevRaw, nextRaw) {
  const prev = cloneTripFlags(prevRaw);
  const next = cloneTripFlags(nextRaw);
  return {
    hasSuppressedStop: prev.hasSuppressedStop || next.hasSuppressedStop,
    maxSuppressedStopSequence:
      Number.isFinite(prev.maxSuppressedStopSequence) &&
      Number.isFinite(next.maxSuppressedStopSequence)
        ? Math.max(prev.maxSuppressedStopSequence, next.maxSuppressedStopSequence)
        : Number.isFinite(prev.maxSuppressedStopSequence)
          ? prev.maxSuppressedStopSequence
          : Number.isFinite(next.maxSuppressedStopSequence)
            ? next.maxSuppressedStopSequence
            : null,
    minSuppressedStopSequence:
      Number.isFinite(prev.minSuppressedStopSequence) &&
      Number.isFinite(next.minSuppressedStopSequence)
        ? Math.min(prev.minSuppressedStopSequence, next.minSuppressedStopSequence)
        : Number.isFinite(prev.minSuppressedStopSequence)
          ? prev.minSuppressedStopSequence
          : Number.isFinite(next.minSuppressedStopSequence)
            ? next.minSuppressedStopSequence
            : null,
    hasUnknownSuppressedSequence:
      prev.hasUnknownSuppressedSequence || next.hasUnknownSuppressedSequence,
    tripStartDate: next.tripStartDate || prev.tripStartDate || "",
    _lastSeenAtMs:
      Number.isFinite(next._lastSeenAtMs)
        ? next._lastSeenAtMs
        : Number.isFinite(prev._lastSeenAtMs)
          ? prev._lastSeenAtMs
          : null,
  };
}

function ensureLastSeenMs(value, fallbackMs) {
  if (!value || typeof value !== "object") return null;
  const seen = Number(value._lastSeenAtMs);
  if (Number.isFinite(seen) && seen > 0) return seen;
  return Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : Date.now();
}

function hasExpiredByAge(value, nowMs) {
  const seenAt = ensureLastSeenMs(value, nowMs);
  return nowMs - seenAt > RT_STATE_MAX_AGE_MS;
}

function hasExpiredByDeparture(value, nowMs) {
  const depEpoch = Number(value?.updatedDepartureEpoch ?? value?.departureEpoch);
  if (!Number.isFinite(depEpoch)) return false;
  return nowMs > depEpoch * 1000 + RT_STATE_POST_DEPARTURE_GRACE_MS;
}

function shouldKeepRealtimeState(value, nowMs) {
  if (!value || typeof value !== "object") return false;
  if (hasExpiredByAge(value, nowMs)) return false;
  if (hasExpiredByDeparture(value, nowMs)) return false;
  return true;
}

function shouldReplaceRealtimeEntry(prev, next) {
  const prevEpoch =
    prev && Number.isFinite(prev.updatedDepartureEpoch)
      ? prev.updatedDepartureEpoch
      : null;
  const nextEpoch =
    next && Number.isFinite(next.updatedDepartureEpoch)
      ? next.updatedDepartureEpoch
      : null;
  if (prevEpoch !== null && nextEpoch !== null) {
    if (nextEpoch > prevEpoch) return true;
    if (nextEpoch < prevEpoch) return false;
  }
  if (prevEpoch !== null && nextEpoch === null) return false;
  if (prevEpoch === null && nextEpoch !== null) return true;

  const prevSeen = ensureLastSeenMs(prev, 0);
  const nextSeen = ensureLastSeenMs(next, 0);
  if (nextSeen > prevSeen) return true;
  return false;
}

/* =========================
   A) Helpers you requested
   ========================= */
function pick(obj, a, b) {
  if (!obj) return undefined;
  if (obj[a] !== undefined) return obj[a];
  if (b && obj[b] !== undefined) return obj[b];
  return undefined;
}

function asNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parsedTimestampMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeFeedKey(feedKey) {
  const key = String(feedKey || "").trim();
  return key || LA_TRIPUPDATES_FEED_KEY;
}

function getOrCreateDecodedFeedCacheEntry(feedKey) {
  const key = normalizeFeedKey(feedKey);
  if (!decodedFeedCache.has(key)) {
    decodedFeedCache.set(key, {
      cachedAtMs: 0,
      value: null,
      refreshPromise: null,
    });
  }
  return decodedFeedCache.get(key);
}

function normalizeTripUpdatesFeedFromJson(raw) {
  const header = raw?.header || {};
  const entities = Array.isArray(raw?.entity)
    ? raw.entity
    : Array.isArray(raw?.entities)
      ? raw.entities
      : [];
  const feedVersion =
    pick(header, "feed_version", "feedVersion") ||
    pick(raw, "feed_version", "feedVersion") ||
    pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion") ||
    "";

  return {
    feedVersion,
    gtfsRealtimeVersion:
      pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion") || "",
    headerTimestamp: asNumber(pick(header, "timestamp", "headerTimestamp")),
    entities,
    entity: entities,
  };
}

function normalizeTripUpdatesFeedFromProtobuf(feedMessage) {
  const header = feedMessage?.header || {};
  const entities = Array.isArray(feedMessage?.entity) ? feedMessage.entity : [];
  return {
    feedVersion:
      String(feedMessage?.header?.feedVersion || "").trim() ||
      String(feedMessage?.feedVersion || "").trim() ||
      String(feedMessage?.header?.gtfsRealtimeVersion || "").trim() ||
      "",
    gtfsRealtimeVersion: String(feedMessage?.header?.gtfsRealtimeVersion || "").trim(),
    headerTimestamp: asNumber(feedMessage?.header?.timestamp),
    header,
    entities,
    entity: entities,
  };
}

export function decodeTripUpdatesFeedPayload(payloadBytes) {
  const payloadBuffer = Buffer.isBuffer(payloadBytes)
    ? payloadBytes
    : Buffer.from(payloadBytes || []);
  if (!payloadBuffer.length) {
    return { feed: null, decodeError: new Error("rt_cache_payload_empty") };
  }

  try {
    const feedMessage =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(payloadBuffer);
    return { feed: normalizeTripUpdatesFeedFromProtobuf(feedMessage), decodeError: null };
  } catch (protobufErr) {
    try {
      const json = JSON.parse(payloadBuffer.toString("utf8"));
      return { feed: normalizeTripUpdatesFeedFromJson(json), decodeError: null };
    } catch (jsonErr) {
      const error = new Error(
        `rt_cache_payload_decode_failed: ${String(
          protobufErr?.message || jsonErr?.message || "unknown_error"
        )}`
      );
      return { feed: null, decodeError: error };
    }
  }
}

async function readTripUpdatesFeedFromDb(feedKey, getRtCacheLike) {
  const normalizedFeedKey = normalizeFeedKey(feedKey);
  const cacheRow = await getRtCacheLike(normalizedFeedKey);
  const fetchedAtMs = parsedTimestampMs(cacheRow?.fetched_at);
  const payloadBytes = Buffer.isBuffer(cacheRow?.payloadBytes)
    ? cacheRow.payloadBytes.length
    : 0;
  if (!cacheRow?.payloadBytes) {
    return {
      feed: null,
      feedKey: normalizedFeedKey,
      fetchedAtMs,
      payloadBytes,
      lastStatus: Number.isFinite(Number(cacheRow?.last_status))
        ? Number(cacheRow.last_status)
        : null,
      lastError: cacheRow?.last_error || null,
      etag: cacheRow?.etag || null,
      hasPayload: false,
      decodeError: null,
      rtReadSource: "db",
      rtCacheHit: false,
      rtDecodeMs: null,
      rtPayloadFetchCountThisRequest: 1,
    };
  }

  const decodeStartedAt = Date.now();
  const decoded = decodeTripUpdatesFeedPayload(cacheRow.payloadBytes);
  const rtDecodeMs = Math.max(0, Date.now() - decodeStartedAt);
  return {
    feed: decoded.feed,
    feedKey: normalizedFeedKey,
    fetchedAtMs,
    payloadBytes,
    lastStatus: Number.isFinite(Number(cacheRow?.last_status))
      ? Number(cacheRow.last_status)
      : null,
    lastError: cacheRow?.last_error || null,
    etag: cacheRow?.etag || null,
    hasPayload: !!decoded.feed,
    decodeError: decoded.decodeError || null,
    rtReadSource: "db",
    rtCacheHit: false,
    rtDecodeMs,
    rtPayloadFetchCountThisRequest: 1,
  };
}

function normalizeRtCacheMeta(metaRow) {
  const fetchedAtMs = parsedTimestampMs(metaRow?.fetched_at);
  const payloadBytesRaw = Number(metaRow?.payload_bytes);
  const payloadBytes = Number.isFinite(payloadBytesRaw) ? payloadBytesRaw : 0;
  return {
    fetchedAtMs,
    payloadBytes,
    hasPayload: payloadBytes > 0,
    lastStatus: Number.isFinite(Number(metaRow?.last_status))
      ? Number(metaRow.last_status)
      : null,
    lastError: metaRow?.last_error || null,
    etag: metaRow?.etag || null,
  };
}

function normalizePayloadSha(value) {
  const out = String(value || "").trim().toLowerCase();
  if (!out) return null;
  return /^[0-9a-f]{64}$/.test(out) ? out : null;
}

function contentKeyFromMeta(meta = {}) {
  const etag = String(meta?.etag || "").trim();
  if (etag) return `etag:${etag}`;
  const sha = normalizePayloadSha(meta?.payloadSha);
  if (sha) return `sha:${sha}`;
  const fetchedAtMs = Number(meta?.fetchedAtMs);
  if (Number.isFinite(fetchedAtMs)) return `fetched_at:${fetchedAtMs}`;
  return "unknown";
}

async function readTripUpdatesFeedFromCacheStore({
  feedKey,
  getRtCacheMetaLike,
  getRtCachePayloadShaLike,
  getRtCacheLike,
  previousValue,
}) {
  const normalizedFeedKey = normalizeFeedKey(feedKey);
  const metaRow = await getRtCacheMetaLike(normalizedFeedKey);
  const meta = normalizeRtCacheMeta(metaRow);
  meta.payloadSha = await getRtCachePayloadShaLike(normalizedFeedKey).catch(() => null);
  const contentKey = contentKeyFromMeta(meta);

  const previousContentKey = String(previousValue?.contentKey || "").trim();
  const contentUnchanged =
    previousValue?.feedKey === normalizedFeedKey &&
    previousContentKey &&
    contentKey &&
    previousContentKey === contentKey;

  if (contentUnchanged) {
    if (meta.hasPayload && previousValue?.hasPayload === true && previousValue?.feed) {
      return {
        ...previousValue,
        feedKey: normalizedFeedKey,
        contentKey,
        fetchedAtMs: meta.fetchedAtMs,
        payloadBytes: meta.payloadBytes,
        hasPayload: true,
        lastStatus: meta.lastStatus,
        lastError: meta.lastError,
        etag: meta.etag,
        decodeError: previousValue.decodeError || null,
        rtReadSource: "memory",
        rtCacheHit: true,
        rtPayloadFetchCountThisRequest: 0,
      };
    }
    if (!meta.hasPayload) {
      return {
        feed: null,
        feedKey: normalizedFeedKey,
        contentKey,
        fetchedAtMs: meta.fetchedAtMs,
        payloadBytes: meta.payloadBytes,
        lastStatus: meta.lastStatus,
        lastError: meta.lastError,
        etag: meta.etag,
        hasPayload: false,
        decodeError: null,
        rtReadSource: "memory",
        rtCacheHit: true,
        rtDecodeMs: null,
        rtPayloadFetchCountThisRequest: 0,
      };
    }
  }

  if (!meta.hasPayload) {
    return {
      feed: null,
      feedKey: normalizedFeedKey,
      contentKey,
      fetchedAtMs: meta.fetchedAtMs,
      payloadBytes: meta.payloadBytes,
      lastStatus: meta.lastStatus,
      lastError: meta.lastError,
      etag: meta.etag,
      hasPayload: false,
      decodeError: null,
      rtReadSource: "db",
      rtCacheHit: false,
      rtDecodeMs: null,
      rtPayloadFetchCountThisRequest: 0,
    };
  }

  const result = await readTripUpdatesFeedFromDb(normalizedFeedKey, getRtCacheLike);
  return {
    ...result,
    contentKey,
  };
}

export async function readTripUpdatesFeedFromCache(options = {}) {
  const normalizedOptions =
    options && typeof options === "object" && !Buffer.isBuffer(options)
      ? options
      : { feedKey: options };
  const feedKey = normalizeFeedKey(normalizedOptions.feedKey || LA_TRIPUPDATES_FEED_KEY);
  const getRtCacheLike =
    typeof normalizedOptions.getRtCacheLike === "function"
      ? normalizedOptions.getRtCacheLike
      : getRtCache;
  const getRtCacheMetaLike =
    typeof normalizedOptions.getRtCacheMetaLike === "function"
      ? normalizedOptions.getRtCacheMetaLike
      : getRtCacheMeta;
  const getRtCachePayloadShaLike =
    typeof normalizedOptions.getRtCachePayloadShaLike === "function"
      ? normalizedOptions.getRtCachePayloadShaLike
      : getRtCachePayloadSha;

  const cacheEntry = getOrCreateDecodedFeedCacheEntry(feedKey);
  const nowMs = Date.now();
  const hasFreshValue =
    cacheEntry.value && nowMs - Number(cacheEntry.cachedAtMs || 0) < DECODED_FEED_CACHE_TTL_MS;
  if (hasFreshValue) {
    return {
      ...cacheEntry.value,
      rtReadSource: "memory",
      rtCacheHit: true,
      rtPayloadFetchCountThisRequest: 0,
    };
  }

  if (cacheEntry.refreshPromise) {
    const result = await cacheEntry.refreshPromise;
    return {
      ...result,
      rtReadSource: "memory",
      rtCacheHit: true,
      rtPayloadFetchCountThisRequest: 0,
    };
  }

  const refreshPromise = readTripUpdatesFeedFromCacheStore({
    feedKey,
    getRtCacheMetaLike,
    getRtCachePayloadShaLike,
    getRtCacheLike,
    previousValue: cacheEntry.value,
  })
    .then((result) => {
      cacheEntry.value = result;
      cacheEntry.cachedAtMs = Date.now();
      return result;
    })
    .finally(() => {
      if (cacheEntry.refreshPromise === refreshPromise) {
        cacheEntry.refreshPromise = null;
      }
    });

  cacheEntry.refreshPromise = refreshPromise;
  return refreshPromise;
}

function getTripUpdate(entity) {
  return pick(entity, "trip_update", "tripUpdate") || null;
}

function getTripScheduleRelationship(tripUpdate) {
  const tripObj = pick(tripUpdate, "trip", "trip") || null;
  const rel = tripObj ? pick(tripObj, "schedule_relationship", "scheduleRelationship") : null;
  if (typeof rel === "string") return rel.toUpperCase();
  const relNum = asNumber(rel);
  switch (relNum) {
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
  const u = pick(tripUpdate, "stop_time_update", "stopTimeUpdate");
  return Array.isArray(u) ? u : [];
}

function getStopId(stu) {
  return pick(stu, "stop_id", "stopId") || null;
}

function getStopSequence(stu) {
  const v = pick(stu, "stop_sequence", "stopSequence");
  const n = asNumber(v);
  return n === null ? null : n;
}

function getStopTimeScheduleRelationship(stu) {
  const rel = pick(stu, "schedule_relationship", "scheduleRelationship");
  if (typeof rel === "string") return rel.toUpperCase();
  const relNum = asNumber(rel);
  switch (relNum) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "SKIPPED";
    case 2:
      return "NO_DATA";
    case 3:
      return "UNSCHEDULED";
    default:
      return "";
  }
}

function getTripDescriptor(update) {
  return pick(update, "trip", "trip") || null;
}

function getTripDescriptorField(update, ...keys) {
  const trip = getTripDescriptor(update);
  if (!trip) return null;
  const value = pick(trip, ...keys);
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function relationshipRank(rel) {
  if (rel === "SKIPPED") return 3;
  if (rel === "NO_DATA") return 2;
  if (rel === "SCHEDULED") return 1;
  return 0;
}

function shouldReplaceRelationship(prev, next) {
  const prevEpoch =
    prev && Number.isFinite(prev.updatedDepartureEpoch)
      ? prev.updatedDepartureEpoch
      : null;
  const nextEpoch =
    next && Number.isFinite(next.updatedDepartureEpoch)
      ? next.updatedDepartureEpoch
      : null;
  if (prevEpoch !== null && nextEpoch !== null) {
    if (nextEpoch > prevEpoch) return true;
    if (nextEpoch < prevEpoch) return false;
  }
  if (prevEpoch !== null && nextEpoch === null) return false;
  if (prevEpoch === null && nextEpoch !== null) return true;
  return relationshipRank(next?.relationship || "") >= relationshipRank(prev?.relationship || "");
}

function getDelaySeconds(stu) {
  const dep = pick(stu, "departure", "departure") || null;
  const depDelay = dep ? asNumber(pick(dep, "delay", "delay")) : null;
  if (depDelay !== null) return depDelay;
  return null;
}

function getUpdatedEpoch(stu) {
  const dep = pick(stu, "departure", "departure") || null;
  const depTime = dep ? asNumber(pick(dep, "time", "time")) : null;
  if (depTime !== null) return depTime;
  return null;
}

async function loadRealtimeDelayIndexFromSharedCache() {
  const feedResult = await readTripUpdatesFeedFromCache();
  if (!feedResult.feed) {
    return {
      index: emptyDelayIndex(),
      feedResult,
    };
  }
  return {
    index: buildDelayIndex(feedResult.feed),
    feedResult,
  };
}

/**
 * Build an index of delays keyed by (trip_id, stop_id_variant, stop_sequence).
 */
export function buildDelayIndex(gtfsRtFeed) {
  const byKey = Object.create(null);
  const cancelledTripIds = new Set();
  const cancelledTripByStartKey = Object.create(null);
  const cancelledTripStartDatesByTripId = Object.create(null);
  const stopStatusByKey = Object.create(null);
  const tripFlagsByTripId = Object.create(null);
  const tripFlagsByTripStartKey = Object.create(null);
  const tripFallbackByTripStart = Object.create(null);
  const addedTripStopUpdates = [];
  const addedTripStopUpdateSeen = new Set();
  const rtRows = [];
  const entities = Array.isArray(gtfsRtFeed?.entities)
    ? gtfsRtFeed.entities
    : Array.isArray(gtfsRtFeed?.entity)
      ? gtfsRtFeed.entity
      : [];

  if (!gtfsRtFeed || entities.length === 0) {
    if (DEBUG_RT)
      console.warn("[GTFS-RT] Unexpected feed shape (no entity array).");
    return {
      byKey,
      cancelledTripIds,
      cancelledTripByStartKey,
      cancelledTripStartDatesByTripId,
      stopStatusByKey,
      tripFlagsByTripId,
      tripFlagsByTripStartKey,
      addedTripStopUpdates,
      tripFallbackByTripStart,
      entityCount: entities.length,
    };
  }

  /* ==========================================
     B) Replace inner loop (your requested loop)
     ========================================== */
  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;

    const tripObj = pick(tu, "trip", "trip");
    const tripId = tripObj ? pick(tripObj, "trip_id", "tripId") || null : null;
    if (!tripId) continue;
    const tripStartDate = normalizeTripStartDate(
      getTripDescriptorField(tu, "start_date", "startDate")
    );
    const tripStartKey = buildTripStartKey(tripId, tripStartDate);
    const tripScheduleRelationship = getTripScheduleRelationship(tu);
    if (tripScheduleRelationship === "CANCELED") {
      cancelledTripIds.add(String(tripId));
      cancelledTripByStartKey[tripStartKey] = {
        tripId: String(tripId),
        tripStartDate,
      };
      if (!cancelledTripStartDatesByTripId[String(tripId)]) {
        cancelledTripStartDatesByTripId[String(tripId)] = new Set();
      }
      cancelledTripStartDatesByTripId[String(tripId)].add(tripStartDate);
    }

    const updates = getStopTimeUpdates(tu);
    for (const stu of updates) {
      const rawStopId = getStopId(stu);
      if (!rawStopId) continue;

      const stopSequence = getStopSequence(stu);
      const seqPart = seqKeyPart(stopSequence);

      const delaySec = getDelaySeconds(stu);
      const delayDisplay = computeDepartureDelayDisplayFromSeconds(delaySec);
      const updatedEpoch = getUpdatedEpoch(stu);
      const stopScheduleRelationship = getStopTimeScheduleRelationship(stu);
      upsertTripFallbackCandidate(tripFallbackByTripStart, {
        tripId,
        tripStartDate,
        stopSequence,
        delaySec,
        delayMin: delayDisplay.delayMinAfterClamp,
        updatedDepartureEpoch: updatedEpoch,
      });

      if (stopScheduleRelationship === "SKIPPED") {
        const keyTrip = String(tripId);
        const keyTripStart = buildTripStartKey(tripId, tripStartDate);
        const prevFlags = tripFlagsByTripStartKey[keyTripStart] || {
          hasSuppressedStop: false,
          maxSuppressedStopSequence: null,
          minSuppressedStopSequence: null,
          hasUnknownSuppressedSequence: false,
          tripStartDate,
        };
        prevFlags.hasSuppressedStop = true;
        if (Number.isFinite(stopSequence)) {
          const seq = Number(stopSequence);
          if (
            prevFlags.maxSuppressedStopSequence === null ||
            seq > prevFlags.maxSuppressedStopSequence
          ) {
            prevFlags.maxSuppressedStopSequence = seq;
          }
          if (
            prevFlags.minSuppressedStopSequence === null ||
            seq < prevFlags.minSuppressedStopSequence
          ) {
            prevFlags.minSuppressedStopSequence = seq;
          }
        } else {
          prevFlags.hasUnknownSuppressedSequence = true;
        }
        prevFlags.tripStartDate = tripStartDate;
        tripFlagsByTripStartKey[keyTripStart] = prevFlags;
        tripFlagsByTripId[keyTrip] = mergeTripFlags(tripFlagsByTripId[keyTrip], prevFlags);
      }

      if (updatedEpoch !== null) {
        rtRows.push({
          tripId,
          stopId: rawStopId,
          stopSequence: typeof stopSequence === "number" ? stopSequence : null,
          departureEpoch: updatedEpoch,
          delaySec,
        });
      }

      for (const stopId of stopIdVariants(rawStopId)) {
        const key = buildStopRealtimeKey(tripId, stopId, seqPart, tripStartDate);
        const keyNoSeq =
          seqPart === ""
            ? null
            : buildStopRealtimeKey(tripId, stopId, "", tripStartDate);
        const delayKeys = keyNoSeq ? [key, keyNoSeq] : [key];
        // Keep stop-status index only for non-default relationships.
        // "SCHEDULED" at stop level is the default and duplicates the delay index,
        // inflating memory significantly without adding behavior.
        if (
          stopScheduleRelationship &&
          stopScheduleRelationship !== "SCHEDULED"
        ) {
          const nextStatus = {
            relationship: stopScheduleRelationship,
            updatedDepartureEpoch: updatedEpoch,
            tripStartDate,
          };
          const prevStatus = stopStatusByKey[key];
          if (!prevStatus || shouldReplaceRelationship(prevStatus, nextStatus)) {
            stopStatusByKey[key] = nextStatus;
          }
        }

        for (const delayKey of delayKeys) {
          const prev = byKey[delayKey];
          if (prev) {
            const prevEpoch = prev.updatedDepartureEpoch ?? null;
            if (
              prevEpoch !== null &&
              updatedEpoch !== null &&
              prevEpoch >= updatedEpoch
            )
              continue;
            if (prevEpoch !== null && updatedEpoch === null) continue;
          }

          byKey[delayKey] = {
            tripId,
            stopId,
            stopSequence: seqPart === "" ? null : Number(seqPart),
            delaySec,
            delayMin: delayDisplay.delayMinAfterClamp,
            updatedDepartureEpoch: updatedEpoch,
            tripStartDate,
          };
        }
      }

      if (tripScheduleRelationship === "ADDED") {
        if (updatedEpoch === null) continue;
        if (stopScheduleRelationship === "SKIPPED") {
          continue;
        }

        const dedupeKey = `${tripId}|${rawStopId}|${seqPart}|${updatedEpoch}`;
        if (addedTripStopUpdateSeen.has(dedupeKey)) continue;
        addedTripStopUpdateSeen.add(dedupeKey);

        addedTripStopUpdates.push({
          tripId: String(tripId),
          routeId: getTripDescriptorField(tu, "route_id", "routeId") || "",
          stopId: String(rawStopId),
          stopSequence: Number.isFinite(stopSequence) ? Number(stopSequence) : null,
          departureEpoch: updatedEpoch,
          delaySec,
          delayMin: delayDisplay.delayMinAfterClamp,
          tripStartDate,
          tripStartTime:
            getTripDescriptorField(tu, "start_time", "startTime") || "",
          tripShortName:
            getTripDescriptorField(tu, "trip_short_name", "tripShortName") || "",
          tripHeadsign:
            getTripDescriptorField(tu, "trip_headsign", "tripHeadsign") || "",
        });
      }
    }
  }

  if (DEBUG_RT) {
    console.log(`[GTFS-RT] Indexed ${Object.keys(byKey).length} delay entries`);
  }

  // Best-effort persistence; do not block GTFS-RT processing if the DB write fails.
  void persistRtUpdates(rtRows).catch((err) => {
    if (DEBUG_RT) console.warn("[GTFS-RT] persistRtUpdates error", err?.message || err);
  });

  return {
    byKey,
    cancelledTripIds,
    cancelledTripByStartKey,
    cancelledTripStartDatesByTripId,
    stopStatusByKey,
    tripFlagsByTripId,
    tripFlagsByTripStartKey,
    tripFallbackByTripStart,
    addedTripStopUpdates,
    entityCount: entities.length,
  };
}

function deriveCancelledTripState(cancelledTripByStartKey) {
  const byTripId = Object.create(null);
  const cancelledTripIds = new Set();

  for (const item of Object.values(cancelledTripByStartKey || {})) {
    const tripId = String(item?.tripId || "").trim();
    if (!tripId) continue;
    cancelledTripIds.add(tripId);
    if (!byTripId[tripId]) byTripId[tripId] = new Set();
    byTripId[tripId].add(normalizeTripStartDate(item?.tripStartDate));
  }

  return { cancelledTripIds, cancelledTripStartDatesByTripId: byTripId };
}

function deriveTripFlagsByTripId(tripFlagsByTripStartKey) {
  const out = Object.create(null);
  for (const item of Object.values(tripFlagsByTripStartKey || {})) {
    const tripId = String(item?.tripId || "").trim();
    if (!tripId) continue;
    out[tripId] = mergeTripFlags(out[tripId], item);
  }
  return out;
}

function copyWithSeen(value, seenAtMs) {
  if (!value || typeof value !== "object") return null;
  return {
    ...value,
    _lastSeenAtMs: ensureLastSeenMs(value, seenAtMs),
  };
}

function mergeByKeyState(prevByKey, nextByKey, nowMs, prevSeenAtMs = nowMs) {
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(prevByKey || {})) {
    const item = copyWithSeen(raw, prevSeenAtMs);
    if (!item) continue;
    out[key] = item;
  }
  for (const [key, raw] of Object.entries(nextByKey || {})) {
    const next = copyWithSeen(raw, nowMs);
    if (!next) continue;
    const prev = out[key];
    if (!prev || shouldReplaceRealtimeEntry(prev, next)) {
      out[key] = next;
    }
  }

  for (const [key, value] of Object.entries(out)) {
    if (!shouldKeepRealtimeState(value, nowMs)) {
      delete out[key];
    }
  }
  return out;
}

function mergeStopStatusState(prevByKey, nextByKey, nowMs, prevSeenAtMs = nowMs) {
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(prevByKey || {})) {
    const item = copyWithSeen(raw, prevSeenAtMs);
    if (!item) continue;
    out[key] = item;
  }
  for (const [key, raw] of Object.entries(nextByKey || {})) {
    const next = copyWithSeen(raw, nowMs);
    if (!next) continue;
    const prev = out[key];
    if (!prev) {
      out[key] = next;
      continue;
    }
    if (shouldReplaceRelationship(prev, next)) {
      out[key] = next;
      continue;
    }
    const prevSeen = ensureLastSeenMs(prev, 0);
    const nextSeen = ensureLastSeenMs(next, 0);
    if (nextSeen > prevSeen) out[key] = next;
  }
  for (const [key, value] of Object.entries(out)) {
    if (!shouldKeepRealtimeState(value, nowMs)) {
      delete out[key];
    }
  }
  return out;
}

function mergeTripFlagsState(
  prevByStartKey,
  nextByStartKey,
  nowMs,
  prevSeenAtMs = nowMs
) {
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(prevByStartKey || {})) {
    const item = cloneTripFlags(raw);
    item._lastSeenAtMs = ensureLastSeenMs(raw, prevSeenAtMs);
    out[key] = item;
  }
  for (const [key, raw] of Object.entries(nextByStartKey || {})) {
    const next = cloneTripFlags(raw);
    next._lastSeenAtMs = nowMs;
    next.tripStartDate = normalizeTripStartDate(next.tripStartDate);
    out[key] = mergeTripFlags(out[key], next);
  }

  for (const [key, value] of Object.entries(out)) {
    if (hasExpiredByAge(value, nowMs)) {
      delete out[key];
    }
  }
  return out;
}

function mergeCancelledState(
  prevByStartKey,
  nextByStartKey,
  nowMs,
  prevSeenAtMs = nowMs
) {
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(prevByStartKey || {})) {
    const item = copyWithSeen(raw, prevSeenAtMs);
    if (!item) continue;
    out[key] = {
      ...item,
      tripId: String(item.tripId || "").trim(),
      tripStartDate: normalizeTripStartDate(item.tripStartDate),
    };
  }
  for (const [key, raw] of Object.entries(nextByStartKey || {})) {
    const tripId = String(raw?.tripId || "").trim();
    if (!tripId) continue;
    out[key] = {
      tripId,
      tripStartDate: normalizeTripStartDate(raw?.tripStartDate),
      _lastSeenAtMs: nowMs,
    };
  }
  for (const [key, value] of Object.entries(out)) {
    if (hasExpiredByAge(value, nowMs)) {
      delete out[key];
    }
  }
  return out;
}

function mergeAddedTripsState(prevRows, nextRows, nowMs, prevSeenAtMs = nowMs) {
  const out = new Map();
  const upsert = (row, seenAtMs) => {
    if (!row || typeof row !== "object") return;
    const tripId = String(row.tripId || "").trim();
    const stopId = String(row.stopId || "").trim();
    const stopSeq = seqKeyPart(row.stopSequence);
    const depEpoch = Number(row.departureEpoch);
    if (!tripId || !stopId || !Number.isFinite(depEpoch)) return;
    const tripStartDate = normalizeTripStartDate(row.tripStartDate);
    const key = `${tripId}|${stopId}|${stopSeq}|${depEpoch}|${tripStartDate}`;
    const next = {
      ...row,
      tripId,
      stopId,
      tripStartDate,
      _lastSeenAtMs: Number.isFinite(seenAtMs) ? seenAtMs : ensureLastSeenMs(row, nowMs),
    };
    const prev = out.get(key);
    if (!prev || shouldReplaceRealtimeEntry(prev, next)) {
      out.set(key, next);
    }
  };

  for (const row of prevRows || []) upsert(row, ensureLastSeenMs(row, prevSeenAtMs));
  for (const row of nextRows || []) upsert(row, nowMs);

  const kept = [];
  for (const row of out.values()) {
    if (!shouldKeepRealtimeState(row, nowMs)) continue;
    kept.push(row);
  }

  kept.sort((a, b) => {
    const ax = Number(a?.departureEpoch) || 0;
    const bx = Number(b?.departureEpoch) || 0;
    return ax - bx;
  });
  return kept;
}

export function mergeDelayIndexes(previous, incoming, options = {}) {
  const nowMs = Number.isFinite(options?.nowMs) ? Number(options.nowMs) : Date.now();
  const prevSeenAtMs = Number.isFinite(options?.prevSeenAtMs)
    ? Number(options.prevSeenAtMs)
    : nowMs;
  const prev = previous || emptyDelayIndex();
  const next = incoming || emptyDelayIndex();

  const mergedByKey = mergeByKeyState(prev.byKey, next.byKey, nowMs, prevSeenAtMs);
  const mergedStopStatus = mergeStopStatusState(
    prev.stopStatusByKey,
    next.stopStatusByKey,
    nowMs,
    prevSeenAtMs
  );
  const mergedCancelledByStart = mergeCancelledState(
    prev.cancelledTripByStartKey,
    next.cancelledTripByStartKey,
    nowMs,
    prevSeenAtMs
  );
  const mergedTripFlagsByStart = mergeTripFlagsState(
    prev.tripFlagsByTripStartKey,
    next.tripFlagsByTripStartKey,
    nowMs,
    prevSeenAtMs
  );
  const mergedAddedTrips = mergeAddedTripsState(
    prev.addedTripStopUpdates,
    next.addedTripStopUpdates,
    nowMs,
    prevSeenAtMs
  );
  const mergedTripFallback = deriveTripFallbackByTripStartFromByKey(mergedByKey);

  const cancelledState = deriveCancelledTripState(mergedCancelledByStart);
  return {
    byKey: mergedByKey,
    cancelledTripIds: cancelledState.cancelledTripIds,
    cancelledTripByStartKey: mergedCancelledByStart,
    cancelledTripStartDatesByTripId: cancelledState.cancelledTripStartDatesByTripId,
    stopStatusByKey: mergedStopStatus,
    tripFlagsByTripStartKey: mergedTripFlagsByStart,
    tripFlagsByTripId: deriveTripFlagsByTripId(mergedTripFlagsByStart),
    tripFallbackByTripStart: mergedTripFallback,
    addedTripStopUpdates: mergedAddedTrips,
  };
}

export function getDelayForStop(
  delayIndex,
  tripId,
  stopId,
  stopSequence,
  tripStartDate = ""
) {
  if (!delayIndex?.byKey) return null;
  if (!tripId || !stopId) return null;

  const seqPart = seqKeyPart(stopSequence);
  const start = normalizeTripStartDate(tripStartDate);

  for (const sid of stopIdVariants(stopId)) {
    const k1 = buildStopRealtimeKey(tripId, sid, seqPart, start);
    if (delayIndex.byKey[k1]) return delayIndex.byKey[k1];

    const k2 = buildStopRealtimeKey(tripId, sid, "", start);
    if (delayIndex.byKey[k2]) return delayIndex.byKey[k2];

    if (start) {
      const legacyWithSeq = `${tripId}|${sid}|${seqPart}`;
      const legacyNoSeq = `${tripId}|${sid}|`;
      const legacyCandidate = delayIndex.byKey[legacyWithSeq] || delayIndex.byKey[legacyNoSeq];
      if (legacyCandidate) {
        const candidateStart = normalizeTripStartDate(legacyCandidate.tripStartDate);
        if (!candidateStart || candidateStart === start) return legacyCandidate;
      }
    }
  }
  return null;
}

export async function loadRealtimeDelayIndex() {
  const { index } = await loadRealtimeDelayIndexFromSharedCache();
  return index;
}

function emptyDelayIndex() {
  return {
    byKey: Object.create(null),
    cancelledTripIds: new Set(),
    cancelledTripByStartKey: Object.create(null),
    cancelledTripStartDatesByTripId: Object.create(null),
    stopStatusByKey: Object.create(null),
    tripFlagsByTripId: Object.create(null),
    tripFlagsByTripStartKey: Object.create(null),
    tripFallbackByTripStart: Object.create(null),
    addedTripStopUpdates: [],
  };
}

function shortErrorText(value) {
  const text = String(value?.message || value || "").trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function defaultRefreshMeta() {
  return {
    fetchMs: null,
    entityCount: null,
    hadError: false,
    error: null,
    lastAttemptAtMs: null,
    lastStatus: null,
    lastError: null,
  };
}

function cacheStatusForSnapshot({ hasValue, isFresh, bypass = false } = {}) {
  if (bypass) return "BYPASS";
  if (isFresh) return "HIT";
  if (hasValue) return "STALE";
  return "MISS";
}

function buildTripUpdatesDebugSnapshot({ overrideStatus } = {}) {
  const now = Date.now();
  const hasValue = !!(cached.value && typeof cached.value === "object");
  const ageMs = cached.ts ? now - cached.ts : null;
  const isFresh = hasValue && ageMs !== null && ageMs < CACHE_TTL_MS;
  const refreshMeta = cached.refreshMeta || defaultRefreshMeta();
  const status = overrideStatus || cacheStatusForSnapshot({ hasValue, isFresh, bypass: false });

  return {
    cacheStatus: status,
    fetchedAtUtc: cached.ts ? new Date(cached.ts).toISOString() : null,
    ageSec: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
    ttlSec: Math.max(1, Math.round(CACHE_TTL_MS / 1000)),
    fetchMs: Number.isFinite(refreshMeta.fetchMs) ? Number(refreshMeta.fetchMs) : null,
    entityCount: Number.isFinite(refreshMeta.entityCount)
      ? Number(refreshMeta.entityCount)
      : null,
    hadError:
      refreshMeta.hadError === true ||
      (Number.isFinite(Number(refreshMeta.lastStatus)) &&
        Number(refreshMeta.lastStatus) >= 400),
    error: shortErrorText(refreshMeta.error || refreshMeta.lastError),
  };
}

let cached = {
  value: null,
  ts: 0,
  refreshPromise: null,
  refreshMeta: defaultRefreshMeta(),
};

function runRefresh() {
  const startedAt = Date.now();
  cached.refreshMeta = {
    ...defaultRefreshMeta(),
    ...cached.refreshMeta,
    lastAttemptAtMs: startedAt,
    hadError: false,
    error: null,
  };
  const refreshPromise = loadRealtimeDelayIndexFromSharedCache()
    .then(({ index: next, feedResult }) => {
      const fetchMs = Date.now() - startedAt;
      const nextNowMs = Date.now();
      const nextFetchedAtMs = Number.isFinite(feedResult?.fetchedAtMs)
        ? Number(feedResult.fetchedAtMs)
        : 0;
      const hasFeedPayload = feedResult?.hasPayload === true;
      const merged = hasFeedPayload
        ? mergeDelayIndexes(cached.value, next, {
            nowMs: nextNowMs,
            prevSeenAtMs: cached.ts || nextNowMs,
          })
        : emptyDelayIndex();
      cached.value = merged;
      cached.ts = nextFetchedAtMs;
      cached.refreshMeta = {
        fetchMs,
        entityCount: Number.isFinite(next?.entityCount)
          ? Number(next.entityCount)
          : hasFeedPayload
            ? 0
            : null,
        hadError: !!feedResult?.decodeError,
        error: shortErrorText(feedResult?.decodeError),
        lastAttemptAtMs: startedAt,
        lastStatus: Number.isFinite(Number(feedResult?.lastStatus))
          ? Number(feedResult.lastStatus)
          : null,
        lastError: shortErrorText(feedResult?.lastError),
      };
      return merged;
    })
    .catch((err) => {
      const fetchMs = Date.now() - startedAt;
      cached.refreshMeta = {
        fetchMs,
        entityCount: null,
        hadError: true,
        error: shortErrorText(err),
        lastAttemptAtMs: startedAt,
        lastStatus: null,
        lastError: null,
      };
      if (DEBUG_RT) {
        console.warn("[GTFS-RT] refresh failed; serving stale/empty index", err?.message || err);
      }
      return cached.value || emptyDelayIndex();
    })
    .finally(() => {
      if (cached.refreshPromise === refreshPromise) {
        cached.refreshPromise = null;
      }
      if (DEBUG_RT) {
        console.log(`[GTFS-RT] refresh completed in ${Date.now() - startedAt}ms`);
      }
    });

  cached.refreshPromise = refreshPromise;
  return refreshPromise;
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  const ms = Math.max(1, Number(timeoutMs) || 0);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), ms);
    }),
  ]);
}

export function getRealtimeDelayIndexSnapshot() {
  return cached.value;
}

export function getRealtimeTripUpdatesDebugSnapshot() {
  return buildTripUpdatesDebugSnapshot();
}

export function loadRealtimeDelayIndexOnce(options = {}) {
  const { allowStale = true, maxWaitMs = 0 } = options || {};
  const now = Date.now();
  const hasValue = cached.value && typeof cached.value === "object";
  const age = cached.ts ? now - cached.ts : null;
  const isFresh = hasValue && age !== null && age < CACHE_TTL_MS;
  if (isFresh) return Promise.resolve(cached.value);

  if (allowStale && hasValue) {
    if (!cached.refreshPromise) {
      if (DEBUG_RT) {
        console.log(
          `[GTFS-RT] stale-while-refresh (ttl=${CACHE_TTL_MS}ms, age=${age}ms)`
        );
      }
      void runRefresh();
    }
    return Promise.resolve(cached.value);
  }

  if (!cached.refreshPromise) {
    if (DEBUG_RT) {
      console.log(
        `[GTFS-RT] refresh-from-db-cache (ttl=${CACHE_TTL_MS}ms, age=${
          age === null ? "n/a" : age + "ms"
        })`
      );
    }
    runRefresh();
  }

  const fallback = cached.value || emptyDelayIndex();
  // On cold MISS do not return an empty fallback due to a short timeout.
  if (!hasValue) {
    return cached.refreshPromise;
  }
  if (maxWaitMs > 0) {
    return withTimeout(cached.refreshPromise, maxWaitMs, fallback);
  }
  return cached.refreshPromise;
}

export function __resetRealtimeDelayIndexCacheForTests() {
  cached = {
    value: null,
    ts: 0,
    refreshPromise: null,
    refreshMeta: defaultRefreshMeta(),
  };
}

export function __resetDecodedRtFeedMemoryCacheForTests() {
  decodedFeedCache.clear();
}

export function __expireDecodedRtFeedMemoryCacheForTests(feedKey = LA_TRIPUPDATES_FEED_KEY) {
  const cacheEntry = getOrCreateDecodedFeedCacheEntry(feedKey);
  cacheEntry.cachedAtMs = 0;
}

export function __seedRealtimeDelayIndexCacheForTests(value, ts = Date.now()) {
  cached.value = value;
  cached.ts = Number.isFinite(ts) ? Number(ts) : Date.now();
  cached.refreshPromise = null;
}

export async function loadRealtimeDelayIndexOnceWithDebug(options = {}) {
  const {
    allowStale = true,
    maxWaitMs = 0,
    bypassCache = false,
  } = options || {};

  if (bypassCache) {
    return {
      index: cached.value || emptyDelayIndex(),
      tripUpdates: buildTripUpdatesDebugSnapshot({ overrideStatus: "BYPASS" }),
    };
  }

  const now = Date.now();
  const hasValue = cached.value && typeof cached.value === "object";
  const age = cached.ts ? now - cached.ts : null;
  const isFresh = hasValue && age !== null && age < CACHE_TTL_MS;
  const cacheStatus = cacheStatusForSnapshot({ hasValue, isFresh, bypass: false });

  let index;
  let callError = null;
  try {
    index = await loadRealtimeDelayIndexOnce({ allowStale, maxWaitMs });
  } catch (err) {
    callError = err;
    index = cached.value || emptyDelayIndex();
  }

  const debugMeta = buildTripUpdatesDebugSnapshot({ overrideStatus: cacheStatus });
  if (callError) {
    debugMeta.hadError = true;
    debugMeta.error = shortErrorText(callError);
  }

  return {
    index,
    tripUpdates: debugMeta,
  };
}
