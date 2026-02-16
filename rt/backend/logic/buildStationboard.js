// backend/logic/buildStationboard.js
import { pool } from "../db.js";
import {
  loadRealtimeDelayIndexOnce,
} from "../loaders/loadRealtime.js";
import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readSqlFile(relativePath) {
  const abs = path.resolve(__dirname, relativePath);
  return fs.readFileSync(abs, "utf8");
}

// Main stationboard query extracted to /backend/queries/stationboard.sql
// (relative to this file: ../queries/stationboard.sql)
const STATIONBOARD_SQL = readSqlFile("../queries/stationboard.sql");
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
  to_jsonb(r) ->> 'route_short_name' AS route_short_name,
  to_jsonb(r) ->> 'route_long_name' AS route_long_name,
  to_jsonb(r) ->> 'route_desc' AS route_desc,
  to_jsonb(r) ->> 'route_type' AS route_type,
  to_jsonb(r) ->> 'agency_id' AS agency_id
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
  const client = await pool.connect();
  const effectiveTimeoutMs = Math.max(500, Math.trunc(Number(timeoutMs) || 0));
  try {
    await client.query("BEGIN");
    if (Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = '${effectiveTimeoutMs}ms'`);
    }
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convert a JS Date to "YYYYMMDD".
 */
function toGtfsDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
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
 * Combine today's date with a GTFS time "HH:MM:SS" to a JS Date.
 * Handles times >24h by rolling into the next day.
 */
function buildDateFromTodayAndTime(now, timeStr) {
  const sec = gtfsTimeToSeconds(timeStr);
  if (sec == null) return null;

  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + sec * 1000);
}

/**
 * Combine today's date with GTFS seconds since midnight.
 * Supports >24h values (next service day rows).
 */
function buildDateFromTodayAndSeconds(now, seconds) {
  if (!Number.isFinite(seconds)) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + seconds * 1000);
}

/**
 * Combine a service-day base (today +/- offset days) with GTFS seconds.
 */
function buildDateFromServiceDayAndSeconds(now, seconds, serviceDayOffset = 0) {
  if (!Number.isFinite(seconds)) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + serviceDayOffset);
  return new Date(d.getTime() + seconds * 1000);
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
  const { limit = 100, windowMinutes = 180 } = options;
  const requestedLimit = Math.max(1, Number(limit) || 100);
  // Pull more SQL rows than the final response limit because we apply a
  // realtime/past-window filter afterwards.
  const queryLimit = Math.min(800, Math.max(requestedLimit * 6, requestedLimit + 80));
  const mainQueryTimeoutMs = Math.max(
    1000,
    Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "8000")
  );
  const fallbackQueryTimeoutMs = Math.max(
    1000,
    Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "4000")
  );
  const terminusQueryTimeoutMs = Math.max(
    1000,
    Number(process.env.STATIONBOARD_TERMINUS_QUERY_TIMEOUT_MS || "4000")
  );

  const now = new Date();
  const ENABLE_RT = process.env.ENABLE_RT === "1";

  console.log("[buildStationboard] start", {
    locationId,
    limit,
    windowMinutes,
    nowISO: now.toISOString(),
  });

  const nowSecondsRaw =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  // --- Late/RT-friendly windowing ---
  // We intentionally fetch a bit *before* "now" so late vehicles (scheduled in the past)
  // don't disappear from the board when they are delayed.
  // Tunables (via env):
  //  - PAST_LOOKBACK_MINUTES: how far back (scheduled) we still fetch from DB (default 120)
  //  - DEPARTED_GRACE_SECONDS: keep a departure on screen this long after it leaves (default 45)
  const PAST_LOOKBACK_MINUTES = Number(process.env.PAST_LOOKBACK_MINUTES || "120");
  const DEPARTED_GRACE_SECONDS = Number(
    process.env.DEPARTED_GRACE_SECONDS || "45"
  );

  const lookbackSeconds =
    Number.isFinite(PAST_LOOKBACK_MINUTES) && PAST_LOOKBACK_MINUTES > 0
      ? Math.round(PAST_LOOKBACK_MINUTES * 60)
      : 0;

  // Clamp at 0 to stay within the day's GTFS seconds range.
  const queryFromSecondsRaw = Math.max(0, nowSecondsRaw - lookbackSeconds);

  const maxSecondsRaw = nowSecondsRaw + windowMinutes * 60;

  const todayYmd = toGtfsDate(now);
  const todayYmdInt = Number(todayYmd);
  const dow = now.getDay(); // 0=Sun ... 6=Sat
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayYmdInt = Number(toGtfsDate(yesterday));
  const yesterdayDow = yesterday.getDay();

  // 1) Resolve stop / station-group (including RT-only via stops_union)
  const directGroupRes = await pool.query(
    `
    SELECT
      stop_id,
      stop_name,
      to_jsonb(s) ->> 'platform_code' AS platform_code,
      to_jsonb(s) ->> 'parent_station' AS parent_station
    FROM public.gtfs_stops s
    WHERE COALESCE(to_jsonb(s) ->> 'parent_station', s.stop_id) = $1
    ORDER BY stop_name
    LIMIT 1;
    `,
    [locationId]
  );

  let primaryStop = null;
  let stationGroupIdFromInput = null;

  if (directGroupRes.rowCount > 0) {
    primaryStop = directGroupRes.rows[0];
    stationGroupIdFromInput = locationId;
  } else {
    const stopRes = await pool.query(
      `
      SELECT
        stop_id,
        stop_name,
        to_jsonb(s) ->> 'platform_code' AS platform_code,
        to_jsonb(s) ->> 'parent_station' AS parent_station
      FROM public.gtfs_stops s
      WHERE stop_id = $1
         OR (to_jsonb(s) ->> 'parent_station') = $1
         OR LOWER(stop_name) LIKE LOWER($2)
      ORDER BY
        CASE WHEN stop_id = $1 THEN 0 ELSE 1 END,
        CASE WHEN (to_jsonb(s) ->> 'parent_station') = $1 THEN 0 ELSE 1 END,
        stop_name
      LIMIT 1;
      `,
      [locationId, `%${locationId || ""}%`]
    );

    console.log("[buildStationboard] stop lookup result", {
      requestedLocationId: locationId,
      rowCount: stopRes.rowCount,
      row: stopRes.rows[0] || null,
    });

    if (stopRes.rowCount === 0) {
      console.warn("[buildStationboard] no stop found for locationId", {
        locationId,
      });
      return {
        station: { id: locationId || "", name: locationId || "" },
        departures: [],
      };
    }

    primaryStop = stopRes.rows[0];
  }

  console.log("[buildStationboard] resolved primaryStop", {
    requestedLocationId: locationId,
    stationGroupIdFromInput,
    primaryStop,
  });

  const stationGroupId = primaryStop.parent_station || primaryStop.stop_id;

  const groupRes = await pool.query(
    `
    SELECT
      stop_id,
      stop_name,
      to_jsonb(s) ->> 'platform_code' AS platform_code
    FROM public.gtfs_stops s
    WHERE COALESCE(to_jsonb(s) ->> 'parent_station', s.stop_id) = $1
    ORDER BY platform_code, stop_name;
    `,
    [stationGroupId]
  );

  const childStops = groupRes.rows;

  const platformByStopId = new Map(
    childStops.map((row) => [row.stop_id, row.platform_code || ""])
  );

  const onlyChildren = childStops.filter((s) => s.stop_id !== stationGroupId);
  let childStopIds = onlyChildren.map((r) => r.stop_id);
  if (childStopIds.length === 0) childStopIds = [stationGroupId];

  const stationName =
    primaryStop.stop_name || locationId || primaryStop.stop_id;

  console.log("[buildStationboard] station group", {
    stationGroupId,
    childStopIds,
    stationName,
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
    return {
      rows: rowsRes.rows || [],
      rowCount: Number(rowsRes.rowCount) || 0,
      usedFallback,
    };
  }

  async function queryRowsWithParentRetry(
    fromSeconds,
    toSeconds,
    serviceDateInt,
    serviceDow,
    queryLabel,
    serviceDayOffset
  ) {
    let result = await queryRowsForStopIds(
      childStopIds,
      fromSeconds,
      toSeconds,
      serviceDateInt,
      serviceDow,
      queryLabel
    );

    // Some feeds reference parent station stop_ids in stop_times.
    // If platform-level lookup returns nothing, retry once with parent stop_id.
    if (result.rows.length === 0 && stationGroupId && !childStopIds.includes(stationGroupId)) {
      result = await queryRowsForStopIds(
        [stationGroupId],
        fromSeconds,
        toSeconds,
        serviceDateInt,
        serviceDow,
        `${queryLabel} parent retry`
      );
    }

    return {
      rows: result.rows.map((row) => ({ ...row, _service_day_offset: serviceDayOffset })),
      rowCount: result.rowCount,
      usedFallback: result.usedFallback,
    };
  }

  const rowSources = [];

  const todayRowsResult = await queryRowsWithParentRetry(
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
  });

  const includePreviousServiceDay =
    nowSecondsRaw < Math.max(windowMinutes * 60, lookbackSeconds);

  let rows = todayRowsResult.rows;
  if (includePreviousServiceDay) {
    const serviceNowSeconds = nowSecondsRaw + 86400;
    const prevFromSeconds = Math.max(0, serviceNowSeconds - lookbackSeconds);
    const prevToSeconds = serviceNowSeconds + windowMinutes * 60;

    const yesterdayRowsResult = await queryRowsWithParentRetry(
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
    });

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
    stationGroupId,
    queryFromSecondsRaw,
    nowSecondsRaw,
    maxSecondsRaw,
    rowCount: rows.length,
    sources: rowSources,
    sample: rows.slice(0, 5),
  });

  if (!rows.length) {
    return {
      station: { id: stationGroupId, name: stationName },
      departures: [],
    };
  }

  // Terminus map
  const tripIds = Array.from(
    new Set(rows.map((r) => r.trip_id).filter((x) => x != null && x !== ""))
  );

  const finalStopByTripId = new Map();
  if (tripIds.length > 0) {
    try {
      const termRes = await runTimedQuery(
        `
        SELECT DISTINCT ON (st.trip_id)
          st.trip_id,
          st.stop_id AS final_stop_id,
          st.stop_sequence AS final_stop_sequence,
          s.stop_name AS final_stop_name
        FROM public.gtfs_stop_times st
        JOIN public.gtfs_stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ANY($1::text[])
        ORDER BY st.trip_id, st.stop_sequence DESC;
        `,
        [tripIds],
        terminusQueryTimeoutMs
      );

      for (const r of termRes.rows || []) {
        if (!r || !r.trip_id) continue;
        const finalStopSeqRaw = Number(r.final_stop_sequence);
        finalStopByTripId.set(r.trip_id, {
          stopId: r.final_stop_id || "",
          stopSequence: Number.isFinite(finalStopSeqRaw) ? finalStopSeqRaw : null,
          name: r.final_stop_name || "",
        });
      }
    } catch (err) {
      console.warn("[buildStationboard] terminus lookup timed out, using trip headsign fallback", {
        message: String(err?.message || err),
      });
    }
  }

  // 3) Realtime delay index
  const delayIndex = ENABLE_RT
    ? await loadRealtimeDelayIndexOnce().catch((err) => {
        console.warn("[GTFS-RT] Failed to load delay index, continuing without RT:", err);
        return { byKey: {} };
      })
    : { byKey: {} };

  const baseRows = [];

  for (const row of rows) {
    const routeType = row.route_type;
    const routeShortName = row.route_short_name;
    const routeLongName = row.route_long_name;
    const routeId = row.route_id;
    const routeDesc = row.route_desc;

    const rsn = String(routeShortName || "").trim();
    const tsn = String(row.trip_short_name || "").trim();

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

    if (isRailLike(routeType, routeShortName, routeId)) {
      const parsed = parseTrainCategoryNumber(lineLabel);
      if (parsed) {
        category = parsed.category;
        numberOut = parsed.number;
      }
    }

    const finalStop = finalStopByTripId.get(row.trip_id) || null;
    if (finalStop) {
      const rowStopSeqRaw = Number(row.stop_sequence);
      const rowStopSeq = Number.isFinite(rowStopSeqRaw) ? rowStopSeqRaw : null;
      if (
        rowStopSeq !== null &&
        finalStop.stopSequence !== null &&
        rowStopSeq >= finalStop.stopSequence
      ) {
        // Drop terminating rows from departures board.
        continue;
      }
      if (
        rowStopSeq === null &&
        finalStop.stopId &&
        String(finalStop.stopId) === String(row.stop_id || "")
      ) {
        continue;
      }
    }

    const finalName = finalStop?.name || "";
    const destination = finalName || row.trip_headsign || routeLongName || stationName;

    const scheduledTimeStr = row.departure_time || row.arrival_time || row.time_str;
    const depSecRaw = Number(row.dep_sec);
    const depSec = Number.isFinite(depSecRaw) ? depSecRaw : null;
    const serviceDayOffsetRaw = Number(row._service_day_offset);
    const serviceDayOffset = Number.isFinite(serviceDayOffsetRaw) ? serviceDayOffsetRaw : 0;

    let scheduledDt = null;
    if (depSec !== null) {
      const depSecForWindow = normalizeDepartureSecondsForWindow(depSec, maxSecondsRaw);
      scheduledDt = buildDateFromServiceDayAndSeconds(now, depSecForWindow, serviceDayOffset);
    }
    if (!scheduledDt) {
      const serviceDayBase = new Date(now);
      serviceDayBase.setDate(serviceDayBase.getDate() + serviceDayOffset);
      scheduledDt = buildDateFromTodayAndTime(serviceDayBase, scheduledTimeStr);
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
      delayMin: 0,
      minutesLeft: 0,
      platform,
      platformChanged: false,
    });
  }

  const mergedRows = applyTripUpdates(baseRows, delayIndex);
  const departures = [];

  for (const row of mergedRows) {
    const realtimeDt = new Date(row.realtimeDeparture || row.scheduledDeparture);
    if (!Number.isFinite(realtimeDt.getTime())) continue;

    // --- Visibility filtering based on *effective* departure ---
    // We keep items according to realtime departure (if available), so late vehicles
    // remain visible even when their scheduled time is already in the past.
    // Also keep "0 min" items for a short grace period after departure.
    const msUntil = realtimeDt.getTime() - now.getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const graceMs = DEPARTED_GRACE_SECONDS * 1000;

    if (msUntil < -graceMs) continue;
    if (msUntil > windowMs) continue;

    const minutesLeft = msUntil <= 0 ? 0 : Math.floor(msUntil / 60000);
    departures.push({
      ...row,
      minutesLeft,
    });
  }

  departures.sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    const aNum = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bNum = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return aNum - bNum;
  });

  return {
    station: { id: stationGroupId, name: stationName },
    departures: departures.slice(0, requestedLimit),
  };
}
