// backend/logic/buildStationboard.js
import { pool } from "../db.js";
import {
  loadRealtimeDelayIndexOnce,
  getDelayForStop,
} from "../loaders/loadRealtime.js";

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

  // 1) Resolve stop / station-group
  const directGroupRes = await pool.query(
    `
    SELECT stop_id, stop_name, platform_code, parent_station
    FROM public.stops
    WHERE COALESCE(parent_station, stop_id) = $1
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
      SELECT stop_id, stop_name, platform_code, parent_station
      FROM public.stops
      WHERE stop_id = $1
         OR parent_station = $1
         OR LOWER(stop_name) LIKE LOWER($2)
      ORDER BY
        CASE WHEN stop_id = $1 THEN 0 ELSE 1 END,
        CASE WHEN parent_station = $1 THEN 0 ELSE 1 END,
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
    SELECT stop_id, stop_name, platform_code
    FROM public.stops
    WHERE COALESCE(parent_station, stop_id) = $1
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
  const rowsRes = await pool.query(STATIONBOARD_SQL, [
    childStopIds,
    queryFromSecondsRaw,
    maxSecondsRaw,
    limit,
    todayYmdInt,
    dow,
  ]);

  const rows = rowsRes.rows || [];

  console.log("[buildStationboard] rows fetched", {
    stationGroupId,
    queryFromSecondsRaw,
    nowSecondsRaw,
    maxSecondsRaw,
    rowCount: rowsRes.rowCount,
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
    const termRes = await pool.query(
      `
      SELECT DISTINCT ON (st.trip_id)
        st.trip_id,
        s.stop_name AS final_stop_name
      FROM public.stop_times st
      JOIN public.stops s ON s.stop_id = st.stop_id
      WHERE st.trip_id = ANY($1::text[])
      ORDER BY st.trip_id, st.stop_sequence DESC;
      `,
      [tripIds]
    );

    for (const r of termRes.rows || []) {
      if (r && r.trip_id) finalStopByTripId.set(r.trip_id, r.final_stop_name || "");
    }
  }

  // 3) Realtime delay index
  const delayIndex = ENABLE_RT
    ? await loadRealtimeDelayIndexOnce().catch((err) => {
        console.warn("[GTFS-RT] Failed to load delay index, continuing without RT:", err);
        return { byKey: {} };
      })
    : { byKey: {} };

  const departures = [];

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

    const finalName = finalStopByTripId.get(row.trip_id) || "";
    const destination = finalName || row.trip_headsign || routeLongName || stationName;

    const scheduledTimeStr = row.departure_time || row.arrival_time || row.time_str;
    const scheduledDt = buildDateFromTodayAndTime(now, scheduledTimeStr);
    if (!scheduledDt) continue;

    const delay = getDelayForStop(delayIndex, row.trip_id, row.stop_id, row.stop_sequence);

    let delayMin = 0;
    let realtimeDt = scheduledDt;

    if (delay) {
      if (typeof delay.updatedDepartureEpoch === "number") {
        realtimeDt = new Date(delay.updatedDepartureEpoch * 1000);
        delayMin = Math.round((realtimeDt.getTime() - scheduledDt.getTime()) / 60000);
      } else if (typeof delay.delayMin === "number") {
        delayMin = delay.delayMin;
        realtimeDt = new Date(scheduledDt.getTime() + delayMin * 60 * 1000);
      }
    }

    const platform = platformByStopId.get(row.stop_id) || "";

    // --- Visibility filtering based on *effective* departure ---
    // We keep items according to realtime departure (if available), so late vehicles
    // remain visible even when their scheduled time is already in the past.
    // Also keep "0 min" items for a short grace period after departure.
    const msUntil = realtimeDt.getTime() - now.getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const graceMs = DEPARTED_GRACE_SECONDS * 1000;

    // Too far in the past (already departed long ago)
    if (msUntil < -graceMs) continue;

    // Too far in the future (outside display window)
    if (msUntil > windowMs) continue;

    // Useful for UI (optional): minutes left until *effective* departure.
    //  - shows 0 when < 60s remaining, and stays 0 during the grace period.
    const minutesLeft = msUntil <= 0 ? 0 : Math.floor(msUntil / 60000);

    departures.push({
      trip_id: row.trip_id,
      stop_id: row.stop_id,
      stop_sequence: row.stop_sequence,

      category,
      number: numberOut,
      line: lineLabel,
      name: lineLabel,
      destination,
      operator: row.agency_id || "",
      scheduledDeparture: scheduledDt.toISOString(),
      realtimeDeparture: realtimeDt.toISOString(),
      delayMin,
      minutesLeft,
      platform,
      platformChanged: false,
    });
  }

  return {
    station: { id: stationGroupId, name: stationName },
    departures,
  };
}