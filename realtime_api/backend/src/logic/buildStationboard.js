// backend/src/logic/buildStationboard.js
import { pool } from "../../db.js";
import { applyTripUpdates } from "../merge/applyTripUpdates.js";
import { applyAddedTrips } from "../merge/applyAddedTrips.js";
import { pickPreferredMergedDeparture } from "../merge/pickPreferredDeparture.js";
import { createCancellationTracer } from "../debug/cancellationTrace.js";
import { loadScopedRtFromCache } from "../rt/loadScopedRtFromCache.js";
import {
  addDaysToYmdInt,
  dateFromZurichServiceDateAndSeconds,
  dateFromZurichServiceDateAndTime,
  formatZurich,
  secondsSinceZurichMidnight,
  weekdayIndexInZurich,
  ymdIntInZurich,
  zonedWindowDebug,
} from "../time/zurichTime.js";

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readSqlFile(relativePath) {
  const abs = path.resolve(__dirname, relativePath);
  return fs.readFileSync(abs, "utf8");
}

// Main stationboard query extracted to /backend/src/sql/stationboard.sql
const STATIONBOARD_SQL = readSqlFile("../sql/stationboard.sql");
const STATIONBOARD_FALLBACK_SQL = `
SELECT
  st.trip_id,
  st.stop_id,
  st.stop_sequence,
  st.arrival_time,
  st.departure_time,
  COALESCE(st.departure_time, st.arrival_time) AS time_str,
  sec.dep_sec,
  t.route_id,
  t.service_id,
  t.trip_headsign,
  to_jsonb(t) ->> 'trip_short_name' AS trip_short_name,
  r.route_short_name,
  r.route_long_name,
  NULL::text AS route_desc,
  r.route_type::text AS route_type,
  r.agency_id
FROM public.gtfs_stop_times st
JOIN public.gtfs_trips t ON t.trip_id = st.trip_id
LEFT JOIN public.gtfs_routes r ON r.route_id = t.route_id
CROSS JOIN LATERAL (
  SELECT
    COALESCE(
      NULLIF(to_jsonb(st) ->> 'departure_time_seconds', '')::int,
      NULLIF(to_jsonb(st) ->> 'arrival_time_seconds', '')::int,
      CASE
        WHEN st.departure_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
          split_part(st.departure_time, ':', 1)::int * 3600 +
          split_part(st.departure_time, ':', 2)::int * 60 +
          COALESCE(NULLIF(split_part(st.departure_time, ':', 3), '')::int, 0)
        ELSE NULL
      END,
      CASE
        WHEN st.arrival_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
          split_part(st.arrival_time, ':', 1)::int * 3600 +
          split_part(st.arrival_time, ':', 2)::int * 60 +
          COALESCE(NULLIF(split_part(st.arrival_time, ':', 3), '')::int, 0)
        ELSE NULL
      END
    ) AS dep_sec,
    COALESCE(
      NULLIF(to_jsonb(st) ->> 'departure_time_seconds', '')::int,
      CASE
        WHEN st.departure_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
          split_part(st.departure_time, ':', 1)::int * 3600 +
          split_part(st.departure_time, ':', 2)::int * 60 +
          COALESCE(NULLIF(split_part(st.departure_time, ':', 3), '')::int, 0)
        ELSE NULL
      END
    ) AS departure_time_seconds
) sec
WHERE st.stop_id = ANY($1::text[])
  AND sec.dep_sec IS NOT NULL
  AND sec.departure_time_seconds IS NOT NULL
  AND (
    ($3::int < 86400 AND sec.dep_sec BETWEEN $2::int AND $3::int)
    OR
    ($3::int >= 86400 AND (
      sec.dep_sec BETWEEN $2::int AND $3::int
      OR ($2::int < 86400 AND sec.dep_sec BETWEEN 0 AND ($3::int - 86400))
    ))
  )
ORDER BY sec.dep_sec ASC
LIMIT $4
`;

async function runTimedQuery(sql, params, timeoutMs) {
  const effectiveTimeoutMs = Math.max(120, Math.trunc(Number(timeoutMs) || 0));
  return pool.query({
    text: sql,
    values: params,
    query_timeout: effectiveTimeoutMs,
  });
}

/**
 * Convert a GTFS time string "HH:MM:SS" to seconds since midnight.
 * Supports >24h values (e.g. "25:10:00").
 */
function gtfsTimeToSeconds(t) {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length < 2) return null;
  const h = Number(parts[0] || "0");
  const m = Number(parts[1] || "0");
  const s = Number(parts[2] || "0");
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * For windows crossing midnight, low dep_sec values are next-day departures.
 */
function normalizeDepartureSecondsForWindow(depSec, maxSecondsRaw) {
  if (!Number.isFinite(depSec)) return null;
  if (maxSecondsRaw < 86400) return depSec;
  if (depSec > 86400) return depSec;

  const spillSeconds = maxSecondsRaw - 86400;
  if (depSec >= 0 && depSec <= spillSeconds) {
    return depSec + 86400;
  }
  return depSec;
}

/**
 * For previous-service-day rows queried after midnight, low dep_sec values
 * (00:xx) belong to the next civil day of that service day.
 */
function normalizeDepartureSecondsForServiceDay(
  depSec,
  {
    maxSecondsRaw,
    nowSecondsRaw,
    windowMinutes,
    serviceDayOffset,
  }
) {
  const base = normalizeDepartureSecondsForWindow(depSec, maxSecondsRaw);
  if (!Number.isFinite(base)) return null;

  if (serviceDayOffset !== -1) return base;
  if (base >= 86400) return base;

  const spillMax = nowSecondsRaw + windowMinutes * 60;
  if (base >= 0 && base <= spillMax) {
    return base + 86400;
  }

  return base;
}

function countCancelled(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => acc + (row?.cancelled === true ? 1 : 0),
    0
  );
}

function safeDebugLog(fn, event, payload) {
  if (typeof fn !== "function") return;
  fn(event, payload);
}

/**
 * Rough category from route_type + names.
 */
function deriveCategoryFromRoute(routeType, routeShortName, routeId) {
  const short = routeShortName || "";
  const id = routeId || "";

  const n = Number(routeType);
  if (!Number.isNaN(n)) {
    if (n === 0) return "T"; // tram
    if (n === 1) return "M"; // metro
    if (n === 2) return "R"; // rail
    if (n === 3) return "B"; // bus
    if (n >= 200 && n < 900) return "B";
    if (n >= 900) return "B";
  }

  if (short && /^[A-Z]/i.test(short)) return short[0].toUpperCase();
  if (id && /^[A-Z]/i.test(id)) return id[0].toUpperCase();
  return "";
}

/**
 * For rail-like services, parse labels like "RE33", "IR90", "IC5", "S3", "R8".
 */
function parseTrainCategoryNumber(label) {
  if (!label) return null;
  const cleaned = String(label).trim().replace(/\s+/g, "");
  const m = cleaned.match(/^([A-Za-z]{1,4})(\d{1,4})$/);
  if (!m) return null;

  const cat = m[1].toUpperCase();
  const num = String(m[2]).replace(/^0+/, "") || "0";
  return { category: cat, number: num, full: cleaned };
}

function hasReplacementSignal(...values) {
  const text = values
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  return /\b(ev(?:\s*\d+)?|ersatz|replacement|remplacement|sostitutiv|substitute)\b/i.test(
    text
  );
}

function isRailLike(routeType, routeShortName, routeId) {
  const rt = Number(routeType);
  if (!Number.isNaN(rt)) {
    if (rt === 2) return true; // rail
  }

  const s = String(routeShortName || "").trim();
  const id = String(routeId || "").trim();
  return (
    /^(IC|IR|RE|R|S|EC|EN|ICE|RJX?|TGV)\s*\d+/i.test(s) ||
    /^(IC|IR|RE|R|S|EC|EN|ICE|RJX?|TGV)\s*\d+/i.test(id)
  );
}

/**
 * Build a stationboard from Neon + GTFS-RT.
 */
export async function buildStationboard(locationId, options = {}) {
  const {
    limit = 100,
    windowMinutes = 180,
    debug = false,
    debugLog,
    requestId = "",
    resolvedScope = null,
    scopeQueryMode = "mixed",
    rtDebugMode = "",
  } = options;
  const requestedLimit = Math.max(1, Number(limit) || 100);
  const debugEnabled = debug === true;
  const requestDebugLog = typeof debugLog === "function" ? debugLog : null;
  const requestStartMs = performance.now();
  const timings = {
    requestId: String(requestId || ""),
    stopScopeMs: 0,
    mainSqlMs: 0,
    terminusSqlMs: 0,
    rtLoadMs: 0,
    rtMergeMs: 0,
    totalMs: 0,
  };
  // Pull more SQL rows than the final response limit because we apply a
  // realtime/past-window filter afterwards.
  const queryLimit = Math.min(800, Math.max(requestedLimit * 6, requestedLimit + 80));
  const mainQueryTimeoutMs = Math.max(
    400,
    Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "3500")
  );
  const fallbackQueryTimeoutMs = Math.max(
    250,
    Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "1200")
  );
  const terminusQueryTimeoutMs = Math.max(
    180,
    Number(process.env.STATIONBOARD_TERMINUS_QUERY_TIMEOUT_MS || "700")
  );
  const stopScopeQueryTimeoutMs = Math.max(
    150,
    Number(process.env.STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS || "800")
  );
  const rtLoadTimeoutMs = Math.max(
    100,
    Number(process.env.STATIONBOARD_RT_LOAD_TIMEOUT_MS || "900")
  );

  const now = new Date();
  const traceCancellation = createCancellationTracer("buildStationboard", {
    enabled: process.env.DEBUG === "1",
  });
  const ENABLE_RT = process.env.ENABLE_RT === "1";

  if (debugEnabled) {
    console.log("[buildStationboard] start", {
      requestId: timings.requestId,
      locationId,
      limit,
      windowMinutes,
      nowISO: now.toISOString(),
    });
  }

  const nowSecondsRaw = secondsSinceZurichMidnight(now);

  // --- Late/RT-friendly windowing ---
  // We intentionally fetch a bit *before* "now" so late vehicles (scheduled in the past)
  // don't disappear from the board when they are delayed.
  // Tunables (via env):
  //  - PAST_LOOKBACK_MINUTES: how far back (scheduled) we still fetch from DB (default 60)
  //    Increased to 60 minutes to ensure trains with reasonable delays (up to ~60min)
  //    remain visible even after their scheduled departure time passes.
  //  - DEPARTED_GRACE_SECONDS: keep a departure on screen this long after it leaves (default 45)
  const PAST_LOOKBACK_MINUTES = Number(process.env.PAST_LOOKBACK_MINUTES || "60");
  const DEPARTED_GRACE_SECONDS = Number(
    process.env.DEPARTED_GRACE_SECONDS || "45"
  );

  const lookbackSeconds =
    Number.isFinite(PAST_LOOKBACK_MINUTES) && PAST_LOOKBACK_MINUTES > 0
      ? Math.round(PAST_LOOKBACK_MINUTES * 60)
      : 0;
  const PREV_SERVICE_DAY_CUTOFF_MINUTES = Number(
    process.env.PREV_SERVICE_DAY_CUTOFF_MINUTES || "360"
  );
  const prevServiceDayCutoffSeconds =
    Number.isFinite(PREV_SERVICE_DAY_CUTOFF_MINUTES) &&
    PREV_SERVICE_DAY_CUTOFF_MINUTES > 0
      ? Math.round(PREV_SERVICE_DAY_CUTOFF_MINUTES * 60)
      : windowMinutes * 60;

  // Clamp at 0 to stay within the day's GTFS seconds range.
  const queryFromSecondsRaw = Math.max(0, nowSecondsRaw - lookbackSeconds);

  const maxSecondsRaw = nowSecondsRaw + windowMinutes * 60;

  const todayYmdInt = ymdIntInZurich(now);
  const dow = weekdayIndexInZurich(now);
  const yesterdayYmdInt = addDaysToYmdInt(todayYmdInt, -1);
  const yesterdayDow = (dow + 6) % 7;
  const debugMeta = {
    locationId,
    timeWindow: zonedWindowDebug({
      now,
      lookbackMinutes: Math.round(lookbackSeconds / 60),
      windowMinutes,
    }),
    windowSeconds: {
      nowSecondsRaw,
      queryFromSecondsRaw,
      maxSecondsRaw,
    },
    stops: {
      requested: locationId,
      stationGroupId: "",
      queryStopIds: [],
      childStopIds: [],
    },
    rowSources: [],
    stageCounts: [],
  };
  safeDebugLog(requestDebugLog, "build.time_window", {
    timeWindow: debugMeta.timeWindow,
    windowSeconds: debugMeta.windowSeconds,
  });

  // 1) Resolve stop / station-group.
  const stopScopeStartedMs = performance.now();
  const scopeFromResolver =
    resolvedScope &&
    typeof resolvedScope === "object" &&
    String(resolvedScope?.stationGroupId || "").trim()
      ? {
          stationGroupId: String(resolvedScope.stationGroupId).trim(),
          stationName: String(resolvedScope.stationName || "").trim(),
          childStops: Array.isArray(resolvedScope.childStops) ? resolvedScope.childStops : [],
        }
      : null;

  let stationGroupId = "";
  let stationName = "";
  let childStops = [];

  if (scopeFromResolver) {
    stationGroupId = scopeFromResolver.stationGroupId;
    stationName = scopeFromResolver.stationName || locationId || stationGroupId;
    childStops = scopeFromResolver.childStops
      .map((child) => ({
        stop_id: String(child?.id || "").trim(),
        stop_name: String(child?.name || stationName || locationId || "").trim(),
        platform_code: String(child?.platform_code || "").trim(),
      }))
      .filter((row) => row.stop_id);

    if (childStops.length === 0) {
      childStops = [
        {
          stop_id: stationGroupId,
          stop_name: stationName,
          platform_code: "",
        },
      ];
    }

    if (debugEnabled) {
      console.log("[buildStationboard] using pre-resolved scope", {
        requestId: timings.requestId,
        requestedLocationId: locationId,
        stationGroupId,
        childCount: childStops.length,
      });
    }
  } else {
    const stopRes = await runTimedQuery(
      `
      SELECT
        stop_id,
        stop_name,
        s.platform_code,
        s.parent_station
      FROM public.gtfs_stops s
      WHERE stop_id = $1
         OR s.parent_station = $1
      ORDER BY
        CASE WHEN stop_id = $1 THEN 0 ELSE 1 END,
        CASE WHEN s.parent_station = $1 THEN 0 ELSE 1 END,
        stop_name
      LIMIT 1;
      `,
      [locationId],
      stopScopeQueryTimeoutMs
    );

    if (debugEnabled) {
      console.log("[buildStationboard] stop lookup result", {
        requestId: timings.requestId,
        requestedLocationId: locationId,
        rowCount: stopRes.rowCount,
        row: stopRes.rows[0] || null,
      });
    }

    if (stopRes.rowCount === 0) {
      console.warn("[buildStationboard] no stop found for locationId", {
        requestId: timings.requestId,
        locationId,
      });
      timings.stopScopeMs = Number((performance.now() - stopScopeStartedMs).toFixed(1));
      timings.totalMs = Number((performance.now() - requestStartMs).toFixed(1));
      debugMeta.timings = timings;
      return {
        station: { id: locationId || "", name: locationId || "" },
        departures: [],
        debugMeta,
      };
    }

    const primaryStop = stopRes.rows[0];
    const stationGroupIdFromInput =
      String(primaryStop?.parent_station || "") === String(locationId || "")
        ? locationId
        : null;

    if (debugEnabled) {
      console.log("[buildStationboard] resolved primaryStop", {
        requestId: timings.requestId,
        requestedLocationId: locationId,
        stationGroupIdFromInput,
        primaryStop,
      });
    }

    stationGroupId = primaryStop.parent_station || primaryStop.stop_id;
    stationName = primaryStop.stop_name || locationId || primaryStop.stop_id;

    const groupRes = await runTimedQuery(
      `
      SELECT
        stop_id,
        stop_name,
        s.platform_code
      FROM public.gtfs_stops s
      WHERE COALESCE(s.parent_station, s.stop_id) = $1
      ORDER BY platform_code, stop_name;
      `,
      [stationGroupId],
      stopScopeQueryTimeoutMs
    );

    childStops = groupRes.rows || [];
  }
  timings.stopScopeMs = Number((performance.now() - stopScopeStartedMs).toFixed(1));

  const platformByStopId = new Map(
    childStops.map((row) => [row.stop_id, row.platform_code || ""])
  );

  if (debugEnabled) {
    console.log("[buildStationboard] platformByStopId populated", {
      requestId: timings.requestId,
      count: platformByStopId.size,
      entries: Array.from(platformByStopId.entries()),
    });
  }

  const onlyChildren = childStops.filter((s) => s.stop_id !== stationGroupId);
  let childStopIds = onlyChildren.map((r) => r.stop_id);
  if (childStopIds.length === 0) childStopIds = [stationGroupId];

  let queryStopIds;
  if (scopeQueryMode === "children_only") {
    queryStopIds = Array.from(new Set(childStopIds.filter(Boolean)));
  } else if (scopeQueryMode === "parent_only") {
    queryStopIds = Array.from(new Set([stationGroupId].filter(Boolean)));
  } else {
    queryStopIds = Array.from(new Set([stationGroupId, ...childStopIds].filter(Boolean)));
  }

  if (debugEnabled) {
    console.log("[buildStationboard] station group", {
      requestId: timings.requestId,
      stationGroupId,
      childStopIds,
      stationName,
    });
  }
  debugMeta.stops = {
    requested: locationId,
    stationGroupId,
    childStopIds,
    queryStopIds,
    scopeQueryMode,
  };
  safeDebugLog(requestDebugLog, "build.stop_scope", {
    requestedStopId: locationId,
    stationGroupId,
    childStopIds,
    queryStopIds,
  });

  // 2) Stationboard rows (SQL extracted)
  async function queryRowsForStopIds(
    stopIds,
    fromSeconds,
    toSeconds,
    serviceDateInt,
    serviceDow,
    queryLabel
  ) {
    let rowsRes;
    let usedFallback = false;
    const queryStartedMs = performance.now();
    try {
      rowsRes = await runTimedQuery(
        STATIONBOARD_SQL,
        [stopIds, fromSeconds, toSeconds, queryLimit, serviceDateInt, serviceDow],
        mainQueryTimeoutMs
      );
    } catch (err) {
      usedFallback = true;
      console.warn(`[buildStationboard] ${queryLabel} main query failed, using fallback`, {
        message: String(err?.message || err),
      });
      rowsRes = await runTimedQuery(
        STATIONBOARD_FALLBACK_SQL,
        [stopIds, fromSeconds, toSeconds, queryLimit],
        fallbackQueryTimeoutMs
      );
    }
    const queryMs = Number((performance.now() - queryStartedMs).toFixed(1));
    timings.mainSqlMs += queryMs;
    return {
      rows: rowsRes.rows || [],
      rowCount: Number(rowsRes.rowCount) || 0,
      usedFallback,
      queryMs,
    };
  }

  async function queryRowsForServiceDay(
    fromSeconds,
    toSeconds,
    serviceDateInt,
    serviceDow,
    queryLabel,
    serviceDayOffset
  ) {
    const result = await queryRowsForStopIds(
      queryStopIds,
      fromSeconds,
      toSeconds,
      serviceDateInt,
      serviceDow,
      queryLabel
    );

    return {
      rows: result.rows.map((row) => ({
        ...row,
        _service_day_offset: serviceDayOffset,
        _service_date_int: serviceDateInt,
      })),
      rowCount: result.rowCount,
      usedFallback: result.usedFallback,
      queryMs: result.queryMs,
    };
  }

  const rowSources = [];

  const todayRowsResult = await queryRowsForServiceDay(
    queryFromSecondsRaw,
    maxSecondsRaw,
    todayYmdInt,
    dow,
    "today",
    0
  );
  rowSources.push({
    label: "today",
    serviceDate: todayYmdInt,
    fromSeconds: queryFromSecondsRaw,
    toSeconds: maxSecondsRaw,
    rowCount: todayRowsResult.rowCount,
    usedFallback: todayRowsResult.usedFallback,
    queryMs: todayRowsResult.queryMs,
  });
  debugMeta.rowSources = [...rowSources];

  const includePreviousServiceDay =
    nowSecondsRaw <
    Math.max(windowMinutes * 60, lookbackSeconds, prevServiceDayCutoffSeconds);

  let rows = todayRowsResult.rows;
  if (includePreviousServiceDay) {
    const serviceNowSeconds = nowSecondsRaw + 86400;
    const prevFromSeconds = Math.max(0, serviceNowSeconds - lookbackSeconds);
    const prevToSeconds = serviceNowSeconds + windowMinutes * 60;

    const yesterdayRowsResult = await queryRowsForServiceDay(
      prevFromSeconds,
      prevToSeconds,
      yesterdayYmdInt,
      yesterdayDow,
      "yesterday",
      -1
    );

    rowSources.push({
      label: "yesterday",
      serviceDate: yesterdayYmdInt,
      fromSeconds: prevFromSeconds,
      toSeconds: prevToSeconds,
      rowCount: yesterdayRowsResult.rowCount,
      usedFallback: yesterdayRowsResult.usedFallback,
      queryMs: yesterdayRowsResult.queryMs,
    });
    debugMeta.rowSources = [...rowSources];

    const mergedByKey = new Map();
    for (const row of [...todayRowsResult.rows, ...yesterdayRowsResult.rows]) {
      const key = `${row.trip_id || ""}|${row.stop_id || ""}|${row.stop_sequence || ""}|${row.dep_sec || ""}`;
      if (!mergedByKey.has(key)) mergedByKey.set(key, row);
    }
    rows = Array.from(mergedByKey.values()).sort(
      (a, b) => (Number(a.dep_sec) || 0) - (Number(b.dep_sec) || 0)
    );
  }

  console.log("[buildStationboard] rows fetched", {
    requestId: timings.requestId,
    stationGroupId,
    rowCount: rows.length,
    sources: rowSources,
  });
  safeDebugLog(requestDebugLog, "build.rows_fetched", {
    queryStopIds,
    rowCount: rows.length,
    rowSources,
  });

  if (!rows.length) {
    timings.mainSqlMs = Number(timings.mainSqlMs.toFixed(1));
    timings.totalMs = Number((performance.now() - requestStartMs).toFixed(1));
    debugMeta.timings = timings;
    safeDebugLog(requestDebugLog, "build.stage_counts", {
      stage: "scheduled_rows",
      count: 0,
      cancelled: 0,
    });
    return {
      station: { id: stationGroupId, name: stationName },
      departures: [],
      debugMeta,
    };
  }

  // Terminus map (sequence only; enough to suppress non-departing terminal rows).
  const tripIds = Array.from(
    new Set(rows.map((r) => r.trip_id).filter((x) => x != null && x !== ""))
  );

  const finalStopSeqByTripId = new Map();
  if (tripIds.length > 0) {
    const terminusStartedMs = performance.now();
    try {
      const termRes = await runTimedQuery(
        `
        SELECT DISTINCT ON (st.trip_id)
          st.trip_id,
          st.stop_sequence AS final_stop_sequence
        FROM public.gtfs_stop_times st
        WHERE st.trip_id = ANY($1::text[])
        ORDER BY st.trip_id, st.stop_sequence DESC;
        `,
        [tripIds],
        terminusQueryTimeoutMs
      );

      for (const r of termRes.rows || []) {
        if (!r || !r.trip_id) continue;
        const finalStopSeqRaw = Number(r.final_stop_sequence);
        if (!Number.isFinite(finalStopSeqRaw)) continue;
        finalStopSeqByTripId.set(r.trip_id, finalStopSeqRaw);
      }
    } catch (err) {
      console.warn("[buildStationboard] terminus lookup timed out, using trip headsign fallback", {
        message: String(err?.message || err),
      });
    } finally {
      timings.terminusSqlMs = Number((performance.now() - terminusStartedMs).toFixed(1));
    }
  }

  const baseRows = [];

  for (const row of rows) {
    const routeType = row.route_type;
    const routeShortName = row.route_short_name;
    const routeLongName = row.route_long_name;
    const routeId = row.route_id;
    const routeDesc = row.route_desc;

    const rsn = String(routeShortName || "").trim();
    const tsn = String(row.trip_short_name || "").trim();
    const rowTags = [];

    let lineLabel =
      rsn ||
      tsn ||
      String(routeDesc || "").trim() ||
      (routeId ? String(routeId) : "") ||
      (row.trip_id ? String(row.trip_id) : "");

    if (rsn && tsn) {
      const rsnIsPrefixOnly = /^[A-Za-z]{1,4}$/.test(rsn);
      const tsnIsDigitsOnly = /^\d{1,4}$/.test(tsn);
      if (rsnIsPrefixOnly && tsnIsDigitsOnly) lineLabel = `${rsn}${tsn}`;
    }

    let category = deriveCategoryFromRoute(routeType, routeShortName, routeId);
    let numberOut = lineLabel;
    if (
      hasReplacementSignal(
        lineLabel,
        row.route_desc,
        row.trip_headsign,
        row.route_long_name,
        row.route_id
      )
    ) {
      if (!rowTags.includes("replacement")) rowTags.push("replacement");
      category = "B";
    }

    if (isRailLike(routeType, routeShortName, routeId)) {
      const parsed = parseTrainCategoryNumber(lineLabel);
      if (parsed) {
        category = parsed.category;
        numberOut = parsed.number;
      }
    }

    const rowStopSeqRaw = Number(row.stop_sequence);
    const rowStopSeq = Number.isFinite(rowStopSeqRaw) ? rowStopSeqRaw : null;
    const finalStopSeq = Number(finalStopSeqByTripId.get(row.trip_id));
    if (
      Number.isFinite(finalStopSeq) &&
      rowStopSeq !== null &&
      rowStopSeq >= finalStopSeq
    ) {
      // Drop terminating rows from departures board.
      continue;
    }

    const destination = row.trip_headsign || routeLongName || stationName;

    const scheduledTimeStr = row.departure_time || row.arrival_time || row.time_str;
    const depSecRaw = Number(row.dep_sec);
    const depSec = Number.isFinite(depSecRaw) ? depSecRaw : null;
    const serviceDayOffsetRaw = Number(row._service_day_offset);
    const serviceDayOffset = Number.isFinite(serviceDayOffsetRaw) ? serviceDayOffsetRaw : 0;
    const serviceDateIntRaw = Number(row._service_date_int);
    const serviceDateInt = Number.isFinite(serviceDateIntRaw)
      ? serviceDateIntRaw
      : addDaysToYmdInt(todayYmdInt, serviceDayOffset);

    let scheduledDt = null;
    if (depSec !== null) {
      const depSecForWindow = normalizeDepartureSecondsForServiceDay(depSec, {
        maxSecondsRaw,
        nowSecondsRaw,
        windowMinutes,
        serviceDayOffset,
      });
      scheduledDt = dateFromZurichServiceDateAndSeconds(serviceDateInt, depSecForWindow);
    }
    if (!scheduledDt) {
      const fallbackSec = gtfsTimeToSeconds(scheduledTimeStr);
      if (Number.isFinite(fallbackSec)) {
        scheduledDt = dateFromZurichServiceDateAndSeconds(serviceDateInt, fallbackSec);
      } else {
        scheduledDt = dateFromZurichServiceDateAndTime(serviceDateInt, scheduledTimeStr);
      }
    }
    if (!scheduledDt) continue;

    const platform = platformByStopId.get(row.stop_id) || "";

    baseRows.push({
      trip_id: row.trip_id,
      route_id: row.route_id,
      stop_id: row.stop_id,
      stop_sequence: row.stop_sequence,

      category,
      number: numberOut,
      line: lineLabel,
      name: lineLabel,
      destination,
      operator: row.agency_id || "",
      scheduledDeparture: scheduledDt.toISOString(),
      realtimeDeparture: scheduledDt.toISOString(),
      serviceDate: String(serviceDateInt),
      delayMin: 0,
      minutesLeft: 0,
      platform,
      platformChanged: false,
      source: "scheduled",
      tags: rowTags,
    });
  }
  traceCancellation("after_base_rows", baseRows);
  debugMeta.stageCounts.push({
    stage: "scheduled_rows",
    count: baseRows.length,
    cancelled: countCancelled(baseRows),
  });
  safeDebugLog(requestDebugLog, "build.stage_counts", debugMeta.stageCounts[debugMeta.stageCounts.length - 1]);

  // 3) Realtime merge input from shared DB cache (scoped, guard-bounded).
  const rtLoadStartedMs = performance.now();
  const debugRtMode = String(rtDebugMode || "").trim().toLowerCase();
  const rtEnabledForRequest = ENABLE_RT && debugRtMode !== "disabled";
  const rtWindowStartEpochSec = Math.floor(
    (now.getTime() - DEPARTED_GRACE_SECONDS * 1000) / 1000
  );
  const rtWindowEndEpochSec = Math.floor(
    (now.getTime() + windowMinutes * 60 * 1000) / 1000
  );
  const rtLoadResult = await loadScopedRtFromCache({
    enabled: rtEnabledForRequest,
    nowMs: now.getTime(),
    windowStartEpochSec: rtWindowStartEpochSec,
    windowEndEpochSec: rtWindowEndEpochSec,
    scopeTripIds: tripIds,
    scopeStopIds: queryStopIds,
    maxProcessMs: rtLoadTimeoutMs,
  }).catch((err) => {
    console.warn("[GTFS-RT] scoped cache load failed, continuing without RT:", err);
    return {
      tripUpdates: { entities: [], entity: [] },
      meta: {
        applied: false,
        reason: "decode_failed",
        available: false,
        fetchedAt: null,
        ageSeconds: null,
        freshnessMaxAgeSeconds: 45,
        cacheStatus: "ERROR",
        hasPayload: false,
        lastStatus: null,
        lastError: String(err?.message || err),
        etag: null,
        entityCount: 0,
        scannedEntities: 0,
        scopedEntities: 0,
        scopedStopUpdates: 0,
        processingMs: 0,
      },
    };
  });
  const scopedTripUpdates =
    rtLoadResult?.tripUpdates && typeof rtLoadResult.tripUpdates === "object"
      ? rtLoadResult.tripUpdates
      : { entities: [], entity: [] };
  const rtMeta = rtLoadResult?.meta && typeof rtLoadResult.meta === "object"
    ? rtLoadResult.meta
    : {
        applied: false,
        reason: rtEnabledForRequest ? "missing_cache" : "disabled",
        available: false,
      };
  timings.rtLoadMs = Number((performance.now() - rtLoadStartedMs).toFixed(1));
  debugMeta.rtTripUpdates = {
    ...rtMeta,
    debugRtMode,
    scopedTripCount: tripIds.length,
    scopedStopCount: queryStopIds.length,
  };

  const rtMergeStartedMs = performance.now();
  const mergedScheduledRows = applyTripUpdates(baseRows, scopedTripUpdates, {
    platformByStopId,
  });
  traceCancellation("after_apply_trip_updates", mergedScheduledRows);
  debugMeta.stageCounts.push({
    stage: "after_trip_updates_applied",
    count: mergedScheduledRows.length,
    cancelled: countCancelled(mergedScheduledRows),
  });
  safeDebugLog(requestDebugLog, "build.stage_counts", debugMeta.stageCounts[debugMeta.stageCounts.length - 1]);
  const addedRows = rtMeta.applied
    ? applyAddedTrips({
        tripUpdates: scopedTripUpdates,
        stationStopIds: queryStopIds,
        platformByStopId,
        stationName,
        now,
        windowMinutes,
        departedGraceSeconds: DEPARTED_GRACE_SECONDS,
        limit: queryLimit,
      })
    : [];

  const mergedByKey = new Map();
  for (const row of [...mergedScheduledRows, ...addedRows]) {
    const key = `${row.trip_id || ""}|${row.stop_id || ""}|${row.stop_sequence || ""}|${
      row.scheduledDeparture || ""
    }`;
    const previous = mergedByKey.get(key);
    mergedByKey.set(key, pickPreferredMergedDeparture(previous, row));
  }
  const mergedRows = Array.from(mergedByKey.values());
  timings.rtMergeMs = Number((performance.now() - rtMergeStartedMs).toFixed(1));
  traceCancellation("after_added_trip_merge", mergedRows);
  debugMeta.stageCounts.push({
    stage: "after_dedup",
    count: mergedRows.length,
    cancelled: countCancelled(mergedRows),
    addedTrips: addedRows.length,
  });
  safeDebugLog(requestDebugLog, "build.stage_counts", debugMeta.stageCounts[debugMeta.stageCounts.length - 1]);

  const nonSuppressedRows = mergedRows;
  traceCancellation("after_suppressed_filter", nonSuppressedRows);

  const departures = [];

  for (const row of nonSuppressedRows) {
    const realtimeMs = Date.parse(row?.realtimeDeparture || "");
    const scheduledMs = Date.parse(row?.scheduledDeparture || "");
    const effectiveDepartureMs = Number.isFinite(realtimeMs) ? realtimeMs : scheduledMs;
    if (!Number.isFinite(effectiveDepartureMs)) continue;

    const effectiveDepartureIso = new Date(effectiveDepartureMs).toISOString();

    // --- Visibility filtering based on *effective* departure ---
    // We keep items according to realtime departure (if available), so late vehicles
    // remain visible even when their scheduled time is already in the past.
    // Also keep "0 min" items for a short grace period after departure.
    const msUntil = effectiveDepartureMs - now.getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const graceMs = DEPARTED_GRACE_SECONDS * 1000;

    if (msUntil < -graceMs) continue;
    if (msUntil > windowMs) continue;

    const minutesLeft = msUntil <= 0 ? 0 : Math.floor(msUntil / 60000);
    departures.push({
      ...row,
      realtimeDeparture: effectiveDepartureIso,
      source: row?.source || "scheduled",
      tags: Array.isArray(row?.tags) ? row.tags : [],
      minutesLeft,
    });
  }
  traceCancellation("after_time_window_filter", departures);
  debugMeta.stageCounts.push({
    stage: "after_time_window_filter",
    count: departures.length,
    cancelled: countCancelled(departures),
  });
  safeDebugLog(requestDebugLog, "build.stage_counts", debugMeta.stageCounts[debugMeta.stageCounts.length - 1]);

  departures.sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    const aNum = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bNum = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return aNum - bNum;
  });

  const finalDepartures = departures.slice(0, requestedLimit);
  traceCancellation("after_limit_slice", finalDepartures);
  debugMeta.stageCounts.push({
    stage: "after_limit_slice",
    count: finalDepartures.length,
    cancelled: countCancelled(finalDepartures),
  });
  safeDebugLog(requestDebugLog, "build.stage_counts", debugMeta.stageCounts[debugMeta.stageCounts.length - 1]);
  if (debugEnabled) {
    safeDebugLog(requestDebugLog, "build.time_window_confirm", {
      nowUTC: now.toISOString(),
      nowZurich: formatZurich(now),
      queryFromSecondsRaw,
      maxSecondsRaw,
    });
  }

  timings.mainSqlMs = Number(timings.mainSqlMs.toFixed(1));
  timings.totalMs = Number((performance.now() - requestStartMs).toFixed(1));
  debugMeta.timings = timings;
  safeDebugLog(requestDebugLog, "build.timings", timings);

  return {
    station: { id: stationGroupId, name: stationName },
    departures: finalDepartures,
    debugMeta,
  };
}
