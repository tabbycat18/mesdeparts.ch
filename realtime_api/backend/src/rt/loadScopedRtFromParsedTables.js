import { performance } from "node:perf_hooks";

import { query as dbQuery } from "../db/query.js";
import { getRtCacheMeta, LA_TRIPUPDATES_FEED_KEY } from "../db/rtCache.js";

const DEFAULT_RT_FRESH_MAX_AGE_MS = Math.max(
  5_000,
  Number(process.env.STATIONBOARD_RT_FRESH_MAX_AGE_MS || "45000")
);
const DEFAULT_RT_SCOPE_MAX_PROCESS_MS = Math.max(
  20,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_PROCESS_MS || "250")
);
const DEFAULT_RT_SCOPE_MAX_SCANNED_ROWS = Math.max(
  100,
  Number(process.env.STATIONBOARD_RT_SCOPE_MAX_SCANNED_ENTITIES || "35000")
);
const DEFAULT_RT_PARSED_STOP_SCOPE_LOOKBACK_MS = Math.max(
  60_000,
  Number(process.env.STATIONBOARD_RT_PARSED_STOP_SCOPE_LOOKBACK_MS || "3600000")
);

const EMPTY_PARSED_RT = Object.freeze({
  byKey: Object.freeze({}),
  tripFallbackByTripStart: Object.freeze({}),
  cancelledTripIds: new Set(),
  cancelledTripStartDatesByTripId: Object.freeze({}),
  stopStatusByKey: Object.freeze({}),
  tripFlagsByTripId: Object.freeze({}),
  tripFlagsByTripStartKey: Object.freeze({}),
  addedTripStopUpdates: Object.freeze([]),
});

// Swiss platform stop IDs in static GTFS are typically like "8587387:0:A".
// We only derive parent/root variants for this tight shape to avoid broad matches.
const SWISS_PLATFORM_CHILD_STOP_ID_RE = /^(\d{7}):0:([A-Za-z0-9]{1,2})$/;
const SWISS_PLATFORM_PARENT_STOP_ID_RE = /^(\d{7}):0$/;

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

function seqKeyPart(stopSequence) {
  if (stopSequence === undefined || stopSequence === null) return "";
  const n = Number(stopSequence);
  return Number.isFinite(n) ? String(n) : "";
}

function normalizeTripStartDate(value) {
  const raw = text(value);
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return "";
  return digits;
}

function buildStopKey(tripId, stopId, seqPart, tripStartDate = "") {
  const start = normalizeTripStartDate(tripStartDate);
  const base = `${tripId}|${stopId}|${seqPart}`;
  return start ? `${base}|${start}` : base;
}

function buildTripStartKey(tripId, tripStartDate = "") {
  const id = text(tripId);
  if (!id) return "";
  const start = normalizeTripStartDate(tripStartDate);
  return start ? `${id}|${start}` : `${id}|`;
}

function stopIdVariants(stopId) {
  const base = text(stopId);
  if (!base) return [];

  const out = [base];
  const childMatch = base.match(SWISS_PLATFORM_CHILD_STOP_ID_RE);
  if (childMatch) {
    const root = childMatch[1];
    out.push(`${root}:0`);
    out.push(root);
    return out;
  }

  const parentMatch = base.match(SWISS_PLATFORM_PARENT_STOP_ID_RE);
  if (parentMatch) out.push(parentMatch[1]);
  return out;
}

function toIsoOrNull(value) {
  const ms = value == null ? NaN : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parsedTimestampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeTripRelationship(raw) {
  if (typeof raw === "string") {
    const normalized = raw.toUpperCase();
    return normalized === "CANCELLED" ? "CANCELED" : normalized;
  }
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

function normalizeStopRelationship(raw) {
  if (typeof raw === "string") {
    const normalized = raw.toUpperCase();
    return normalized === "CANCELLED" ? "CANCELED" : normalized;
  }
  const n = asNumber(raw);
  switch (n) {
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

function makeEmptyMeta(nowMs, freshnessThresholdMs) {
  return {
    available: false,
    applied: false,
    reason: "missing_cache",
    rtSource: "parsed",
    feedKey: "rt_parsed_tables",
    fetchedAt: null,
    cacheFetchedAt: null,
    cacheAgeMs: null,
    ageSeconds: null,
    lastPollAt: null,
    lastSuccessfulPollAt: null,
    pollAgeMs: null,
    pollAgeSeconds: null,
    freshnessAgeSource: "last_successful_poll",
    freshnessThresholdMs,
    freshnessMaxAgeSeconds: Math.round(freshnessThresholdMs / 1000),
    cacheStatus: "MISS",
    hasPayload: false,
    payloadBytes: null,
    rtPayloadBytes: null,
    lastStatus: null,
    lastError: null,
    etag: null,
    entityCount: 0,
    scannedEntities: 0,
    scopedEntities: 0,
    scopedStopUpdates: 0,
    rtReadSource: "db",
    rtCacheHit: false,
    rtPayloadFetchCountThisRequest: 0,
    rtDecodeMs: 0,
    processingMs: 0,
    nowIso: new Date(nowMs).toISOString(),
  };
}

function uniqueValues(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = text(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function expandStopIds(stopIds = []) {
  const out = [];
  const seen = new Set();
  for (const stopId of stopIds) {
    for (const variant of stopIdVariants(stopId)) {
      if (!variant || seen.has(variant)) continue;
      seen.add(variant);
      out.push(variant);
    }
  }
  return out;
}

function updateLatestMs(current, ...candidates) {
  let out = Number.isFinite(current) ? current : null;
  for (const value of candidates) {
    const ms = parsedTimestampMs(value);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(out) || ms > out) out = ms;
  }
  return out;
}

function upsertTripFallbackCandidate(byTripStart, candidate) {
  const tripId = text(candidate?.tripId);
  if (!tripId) return;
  const tripStartDate = normalizeTripStartDate(candidate?.tripStartDate);
  const stopSequence = asNumber(candidate?.stopSequence);
  if (!Number.isFinite(stopSequence)) return;

  const delaySec = asNumber(candidate?.delaySec);
  if (!Number.isFinite(delaySec)) return;

  const key = tripStartDate ? `${tripId}|${tripStartDate}` : `${tripId}|`;
  if (!Array.isArray(byTripStart[key])) byTripStart[key] = [];

  const next = {
    tripId,
    tripStartDate,
    stopSequence: Number(stopSequence),
    delaySec: Number(delaySec),
    delayMin: Number(delaySec) / 60,
    updatedDepartureEpoch: asNumber(candidate?.updatedDepartureEpoch),
  };

  const list = byTripStart[key];
  const existingIndex = list.findIndex(
    (item) => Number(item?.stopSequence) === Number(stopSequence)
  );
  if (existingIndex < 0) {
    list.push(next);
    return;
  }

  const prev = list[existingIndex];
  const prevEpoch = asNumber(prev?.updatedDepartureEpoch);
  const nextEpoch = asNumber(next.updatedDepartureEpoch);
  if (Number.isFinite(prevEpoch) && Number.isFinite(nextEpoch) && prevEpoch > nextEpoch) {
    return;
  }
  if (Number.isFinite(prevEpoch) && !Number.isFinite(nextEpoch)) return;
  list[existingIndex] = next;
}

function stopIdsToScopeSet(stopIds = []) {
  const out = new Set();
  for (const stopId of stopIds) {
    for (const variant of stopIdVariants(stopId)) out.add(variant);
  }
  return out;
}

const SQL_STOP_UPDATES_BY_TRIP_IDS = `
  SELECT
    stu.trip_id,
    stu.stop_id,
    stu.stop_sequence,
    stu.departure_delay,
    stu.departure_time_rt,
    stu.schedule_relationship AS stop_schedule_relationship,
    stu.updated_at AS stop_updated_at,
    tu.start_date,
    tu.route_id,
    tu.schedule_relationship AS trip_schedule_relationship,
    tu.updated_at AS trip_updated_at
  FROM public.rt_stop_time_updates stu
  LEFT JOIN public.rt_trip_updates tu ON tu.trip_id = stu.trip_id
  WHERE stu.trip_id = ANY($1::text[])
  ORDER BY stu.updated_at DESC NULLS LAST
  LIMIT $2
`;

const SQL_STOP_UPDATES_BY_STOP_IDS = `
  SELECT
    stu.trip_id,
    stu.stop_id,
    stu.stop_sequence,
    stu.departure_delay,
    stu.departure_time_rt,
    stu.schedule_relationship AS stop_schedule_relationship,
    stu.updated_at AS stop_updated_at,
    tu.start_date,
    tu.route_id,
    tu.schedule_relationship AS trip_schedule_relationship,
    tu.updated_at AS trip_updated_at
  FROM public.rt_stop_time_updates stu
  LEFT JOIN public.rt_trip_updates tu ON tu.trip_id = stu.trip_id
  WHERE stu.stop_id = ANY($1::text[])
    AND stu.updated_at >= NOW() - ($2::bigint * INTERVAL '1 millisecond')
  ORDER BY stu.updated_at DESC NULLS LAST
  LIMIT $3
`;

const SQL_TRIP_ROWS_BY_TRIP_IDS = `
  SELECT
    trip_id,
    route_id,
    start_date,
    schedule_relationship AS trip_schedule_relationship,
    updated_at AS trip_updated_at
  FROM public.rt_trip_updates
  WHERE trip_id = ANY($1::text[])
  ORDER BY updated_at DESC NULLS LAST
  LIMIT $2
`;

export async function loadScopedRtFromParsedTables(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const enabled = options.enabled !== false;
  const freshnessThresholdMs = Math.max(
    5_000,
    Number(options.freshnessThresholdMs || DEFAULT_RT_FRESH_MAX_AGE_MS)
  );
  const maxProcessMs = Math.max(
    20,
    Number(options.maxProcessMs || DEFAULT_RT_SCOPE_MAX_PROCESS_MS)
  );
  const maxScannedRows = Math.max(
    100,
    Number(options.maxScannedRows || DEFAULT_RT_SCOPE_MAX_SCANNED_ROWS)
  );
  const stopScopeLookbackMs = Math.max(
    60_000,
    Number(options.stopScopeLookbackMs || DEFAULT_RT_PARSED_STOP_SCOPE_LOOKBACK_MS)
  );
  const queryLike = typeof options.queryLike === "function" ? options.queryLike : dbQuery;
  const getRtCacheMetaLike =
    typeof options.getRtCacheMetaLike === "function" ? options.getRtCacheMetaLike : getRtCacheMeta;
  const rtMetadataFeedKey = text(options.rtMetadataFeedKey) || LA_TRIPUPDATES_FEED_KEY;
  const scopeTripIds = uniqueValues(options.scopeTripIds || []);
  const scopeStopIds = expandStopIds(options.scopeStopIds || []);

  const meta = makeEmptyMeta(nowMs, freshnessThresholdMs);
  if (!enabled) {
    meta.reason = "disabled";
    meta.cacheStatus = "BYPASS";
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  if (scopeTripIds.length === 0 && scopeStopIds.length === 0) {
    meta.reason = "missing_cache";
    meta.cacheStatus = "MISS";
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  const startedAt = performance.now();
  const scopedStopSet = stopIdsToScopeSet(scopeStopIds);
  const stopRowsMap = new Map();
  let latestUpdatedAtMs = null;
  let scannedRows = 0;

  try {
    if (scopeTripIds.length > 0) {
      const tripRes = await queryLike(SQL_STOP_UPDATES_BY_TRIP_IDS, [scopeTripIds, maxScannedRows], {
        queryTimeoutMs: Math.max(120, maxProcessMs + 200),
      });
      const rows = Array.isArray(tripRes?.rows) ? tripRes.rows : [];
      for (const row of rows) {
        scannedRows += 1;
        const tripId = text(row?.trip_id);
        const stopId = text(row?.stop_id);
        if (!tripId || !stopId) continue;
        const tripStartDate = normalizeTripStartDate(row?.start_date);
        const seqPart = seqKeyPart(row?.stop_sequence);
        const key = `${tripId}|${stopId}|${seqPart}|${tripStartDate}`;
        stopRowsMap.set(key, row);
        latestUpdatedAtMs = updateLatestMs(
          latestUpdatedAtMs,
          row?.stop_updated_at,
          row?.trip_updated_at
        );
      }
    }

    if (scopeStopIds.length > 0 && stopRowsMap.size < maxScannedRows) {
      const remaining = Math.max(1, maxScannedRows - stopRowsMap.size);
      const stopRes = await queryLike(
        SQL_STOP_UPDATES_BY_STOP_IDS,
        [scopeStopIds, stopScopeLookbackMs, remaining],
        {
          queryTimeoutMs: Math.max(120, maxProcessMs + 200),
        }
      );
      const rows = Array.isArray(stopRes?.rows) ? stopRes.rows : [];
      for (const row of rows) {
        scannedRows += 1;
        const tripId = text(row?.trip_id);
        const stopId = text(row?.stop_id);
        if (!tripId || !stopId) continue;
        const tripStartDate = normalizeTripStartDate(row?.start_date);
        const seqPart = seqKeyPart(row?.stop_sequence);
        const key = `${tripId}|${stopId}|${seqPart}|${tripStartDate}`;
        if (!stopRowsMap.has(key)) stopRowsMap.set(key, row);
        latestUpdatedAtMs = updateLatestMs(
          latestUpdatedAtMs,
          row?.stop_updated_at,
          row?.trip_updated_at
        );
      }
    }
  } catch (err) {
    meta.reason = err?.code === "42P01" ? "parsed_unavailable" : "query_failed";
    meta.cacheStatus = "ERROR";
    meta.lastError = text(err?.message || err) || "parsed_query_failed";
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  const stopRows = Array.from(stopRowsMap.values());
  const allTripIds = uniqueValues([
    ...scopeTripIds,
    ...stopRows.map((row) => row?.trip_id),
  ]);

  let tripRows = [];
  try {
    if (allTripIds.length > 0) {
      const tripRes = await queryLike(SQL_TRIP_ROWS_BY_TRIP_IDS, [allTripIds, maxScannedRows], {
        queryTimeoutMs: Math.max(120, maxProcessMs + 200),
      });
      tripRows = Array.isArray(tripRes?.rows) ? tripRes.rows : [];
      for (const row of tripRows) {
        latestUpdatedAtMs = updateLatestMs(latestUpdatedAtMs, row?.trip_updated_at);
      }
    }
  } catch (err) {
    meta.reason = err?.code === "42P01" ? "parsed_unavailable" : "query_failed";
    meta.cacheStatus = "ERROR";
    meta.lastError = text(err?.message || err) || "parsed_query_failed";
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  const cacheFetchedAt = toIsoOrNull(latestUpdatedAtMs);
  const cacheAgeMs = Number.isFinite(latestUpdatedAtMs)
    ? Math.max(0, nowMs - latestUpdatedAtMs)
    : null;
  let lastPollAt = null;
  let pollAgeMs = null;
  try {
    const rtFeedMeta = await Promise.resolve(getRtCacheMetaLike(rtMetadataFeedKey));
    lastPollAt = toIsoOrNull(
      rtFeedMeta?.last_successful_poll_at || rtFeedMeta?.lastSuccessfulPollAt || null
    );
    const lastPollMs = parsedTimestampMs(lastPollAt);
    pollAgeMs = Number.isFinite(lastPollMs) ? Math.max(0, nowMs - lastPollMs) : null;
  } catch {}
  const hasPollAge = Number.isFinite(pollAgeMs);
  const freshnessAgeMs = hasPollAge ? Number(pollAgeMs) : cacheAgeMs;
  meta.fetchedAt = cacheFetchedAt;
  meta.cacheFetchedAt = cacheFetchedAt;
  meta.cacheAgeMs = Number.isFinite(cacheAgeMs) ? Math.round(cacheAgeMs) : null;
  meta.ageSeconds = Number.isFinite(cacheAgeMs) ? Math.floor(cacheAgeMs / 1000) : null;
  meta.lastPollAt = lastPollAt;
  meta.lastSuccessfulPollAt = lastPollAt;
  meta.pollAgeMs = hasPollAge ? Math.round(Number(pollAgeMs)) : null;
  meta.pollAgeSeconds = hasPollAge ? Math.floor(Number(pollAgeMs) / 1000) : null;
  meta.freshnessAgeSource = hasPollAge ? "last_successful_poll" : "last_write";
  meta.scannedEntities = scannedRows;
  meta.entityCount = stopRows.length;
  meta.scopedStopUpdates = stopRows.length;
  meta.scopedEntities = allTripIds.length;

  if (stopRows.length === 0 && tripRows.length === 0) {
    meta.reason = "missing_cache";
    meta.cacheStatus = "MISS";
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  if (!Number.isFinite(freshnessAgeMs) || freshnessAgeMs > freshnessThresholdMs) {
    meta.reason = "stale_cache";
    meta.cacheStatus = "STALE";
    meta.available = true;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  if (performance.now() - startedAt > maxProcessMs || scannedRows > maxScannedRows) {
    meta.reason = "guard_tripped";
    meta.cacheStatus = "GUARD";
    meta.available = true;
    meta.processingMs = Number((performance.now() - startedAt).toFixed(1));
    return { tripUpdates: EMPTY_PARSED_RT, meta };
  }

  const byKey = Object.create(null);
  const tripFallbackByTripStart = Object.create(null);
  const cancelledTripIds = new Set();
  const cancelledTripStartDatesByTripId = Object.create(null);
  const stopStatusByKey = Object.create(null);
  const tripFlagsByTripId = Object.create(null);
  const tripFlagsByTripStartKey = Object.create(null);
  const addedTripStopUpdates = [];
  const addedSeen = new Set();

  for (const row of tripRows) {
    const tripId = text(row?.trip_id);
    if (!tripId) continue;
    const tripStartDate = normalizeTripStartDate(row?.start_date);
    const rel = normalizeTripRelationship(row?.trip_schedule_relationship);
    if (rel !== "CANCELED") continue;
    cancelledTripIds.add(tripId);
    if (!cancelledTripStartDatesByTripId[tripId]) {
      cancelledTripStartDatesByTripId[tripId] = new Set();
    }
    cancelledTripStartDatesByTripId[tripId].add(tripStartDate);
  }

  for (const row of stopRows) {
    const tripId = text(row?.trip_id);
    const rawStopId = text(row?.stop_id);
    if (!tripId || !rawStopId) continue;
    const stopSequence = asNumber(row?.stop_sequence);
    const seqPart = seqKeyPart(stopSequence);
    const tripStartDate = normalizeTripStartDate(row?.start_date);
    const delaySec = asNumber(row?.departure_delay);
    const updatedDepartureEpoch = asNumber(row?.departure_time_rt);
    const stopRelationship = normalizeStopRelationship(row?.stop_schedule_relationship);
    const tripRelationship = normalizeTripRelationship(row?.trip_schedule_relationship);
    const routeId = text(row?.route_id);

    upsertTripFallbackCandidate(tripFallbackByTripStart, {
      tripId,
      tripStartDate,
      stopSequence,
      delaySec,
      updatedDepartureEpoch,
    });

    const statusPayload = {
      relationship: stopRelationship,
      updatedDepartureEpoch: Number.isFinite(updatedDepartureEpoch)
        ? Number(updatedDepartureEpoch)
        : null,
      tripStartDate,
    };

    for (const stopId of stopIdVariants(rawStopId)) {
      const keyWithSeq = buildStopKey(tripId, stopId, seqPart, tripStartDate);
      const keyNoSeq = buildStopKey(tripId, stopId, "", tripStartDate);
      const delayPayload = {
        tripId,
        stopId,
        rtStopId: rawStopId,
        stopSequence: seqPart === "" ? null : Number(seqPart),
        delaySec: Number.isFinite(delaySec) ? Number(delaySec) : null,
        delayMin: Number.isFinite(delaySec) ? Number(delaySec) / 60 : null,
        updatedDepartureEpoch: Number.isFinite(updatedDepartureEpoch)
          ? Number(updatedDepartureEpoch)
          : null,
        tripStartDate,
      };
      byKey[keyWithSeq] = delayPayload;
      if (seqPart !== "") {
        byKey[keyNoSeq] = delayPayload;
      }

      if (stopRelationship && stopRelationship !== "SCHEDULED") {
        stopStatusByKey[keyWithSeq] = statusPayload;
        if (seqPart !== "") stopStatusByKey[keyNoSeq] = statusPayload;
      }
    }

    if (stopRelationship === "SKIPPED") {
      const tripFlags = tripFlagsByTripId[tripId] || {
        hasSuppressedStop: false,
        maxSuppressedStopSequence: null,
        minSuppressedStopSequence: null,
        hasUnknownSuppressedSequence: false,
      };
      tripFlags.hasSuppressedStop = true;
      if (Number.isFinite(stopSequence)) {
        const seqNum = Number(stopSequence);
        if (
          tripFlags.maxSuppressedStopSequence === null ||
          seqNum > tripFlags.maxSuppressedStopSequence
        ) {
          tripFlags.maxSuppressedStopSequence = seqNum;
        }
        if (
          tripFlags.minSuppressedStopSequence === null ||
          seqNum < tripFlags.minSuppressedStopSequence
        ) {
          tripFlags.minSuppressedStopSequence = seqNum;
        }
      } else {
        tripFlags.hasUnknownSuppressedSequence = true;
      }
      tripFlagsByTripId[tripId] = tripFlags;

      const tripStartKey = buildTripStartKey(tripId, tripStartDate);
      const tripStartFlags = tripFlagsByTripStartKey[tripStartKey] || {
        tripId,
        tripStartDate,
        hasSuppressedStop: false,
        maxSuppressedStopSequence: null,
        minSuppressedStopSequence: null,
        hasUnknownSuppressedSequence: false,
      };
      tripStartFlags.hasSuppressedStop = true;
      if (Number.isFinite(stopSequence)) {
        const seqNum = Number(stopSequence);
        if (
          tripStartFlags.maxSuppressedStopSequence === null ||
          seqNum > tripStartFlags.maxSuppressedStopSequence
        ) {
          tripStartFlags.maxSuppressedStopSequence = seqNum;
        }
        if (
          tripStartFlags.minSuppressedStopSequence === null ||
          seqNum < tripStartFlags.minSuppressedStopSequence
        ) {
          tripStartFlags.minSuppressedStopSequence = seqNum;
        }
      } else {
        tripStartFlags.hasUnknownSuppressedSequence = true;
      }
      tripFlagsByTripStartKey[tripStartKey] = tripStartFlags;
    }

    if (
      tripRelationship === "ADDED" &&
      Number.isFinite(updatedDepartureEpoch) &&
      stopRelationship !== "SKIPPED"
    ) {
      if (scopedStopSet.size > 0) {
        const matchesScopedStop = stopIdVariants(rawStopId).some((variant) =>
          scopedStopSet.has(variant)
        );
        if (!matchesScopedStop) continue;
      }
      const dedupeKey = `${tripId}|${rawStopId}|${seqPart}|${updatedDepartureEpoch}`;
      if (addedSeen.has(dedupeKey)) continue;
      addedSeen.add(dedupeKey);
      addedTripStopUpdates.push({
        tripId,
        routeId,
        stopId: rawStopId,
        stopSequence: Number.isFinite(stopSequence) ? Number(stopSequence) : null,
        departureEpoch: Number(updatedDepartureEpoch),
        delaySec: Number.isFinite(delaySec) ? Number(delaySec) : null,
        delayMin: Number.isFinite(delaySec) ? Number(delaySec) / 60 : 0,
        tripStartDate,
        tripStartTime: "",
        tripShortName: "",
        tripHeadsign: "",
      });
    }
  }

  for (const list of Object.values(tripFallbackByTripStart)) {
    if (!Array.isArray(list)) continue;
    list.sort((a, b) => Number(a?.stopSequence || 0) - Number(b?.stopSequence || 0));
  }

  meta.available = true;
  meta.applied = true;
  meta.reason = "applied";
  meta.cacheStatus = "FRESH";
  meta.processingMs = Number((performance.now() - startedAt).toFixed(1));

  return {
    tripUpdates: {
      byKey,
      tripFallbackByTripStart,
      cancelledTripIds,
      cancelledTripStartDatesByTripId,
      stopStatusByKey,
      tripFlagsByTripId,
      tripFlagsByTripStartKey,
      addedTripStopUpdates,
    },
    meta,
  };
}
