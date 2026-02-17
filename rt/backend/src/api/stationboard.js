import { buildStationboard } from "../../logic/buildStationboard.js";
import { pool } from "../../db.js";
import { query as dbQuery } from "../db/query.js";
import { resolveStop } from "../resolve/resolveStop.js";
import { fetchServiceAlerts } from "../rt/fetchServiceAlerts.js";
import { attachAlerts } from "../merge/attachAlerts.js";
import { synthesizeFromAlerts } from "../merge/synthesizeFromAlerts.js";
import { supplementFromOtdStationboard } from "../merge/supplementFromOtdStationboard.js";
import { pickPreferredMergedDeparture } from "../merge/pickPreferredDeparture.js";
import { createCancellationTracer } from "../debug/cancellationTrace.js";

const ALERTS_CACHE_MS = Math.max(
  1_000,
  Number(process.env.SERVICE_ALERTS_CACHE_MS || "30000")
);
const ALERTS_FETCH_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.SERVICE_ALERTS_FETCH_TIMEOUT_MS || "3000")
);
const OTD_STATIONBOARD_URL = "https://transport.opendata.ch/v1/stationboard";
const OTD_STATIONBOARD_FETCH_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.OTD_STATIONBOARD_FETCH_TIMEOUT_MS || "4000")
);

let alertsCacheValue = null;
let alertsCacheTs = 0;
let alertsInflight = null;

function resolveServiceAlertsApiKey() {
  return (
    process.env.OPENTDATA_GTFS_SA_KEY ||
    process.env.OPENTDATA_API_KEY ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    ""
  );
}

async function refreshAlertsCache() {
  const next = await fetchServiceAlerts({
    apiKey: resolveServiceAlertsApiKey(),
    timeoutMs: ALERTS_FETCH_TIMEOUT_MS,
  });
  alertsCacheValue = next;
  alertsCacheTs = Date.now();
  return next;
}

async function getServiceAlertsCached() {
  const now = Date.now();
  const fresh = alertsCacheValue && now - alertsCacheTs <= ALERTS_CACHE_MS;
  if (fresh) return alertsCacheValue;

  if (alertsInflight) {
    if (alertsCacheValue) return alertsCacheValue;
    return alertsInflight;
  }

  alertsInflight = refreshAlertsCache()
    .catch((err) => {
      if (alertsCacheValue) return alertsCacheValue;
      throw err;
    })
    .finally(() => {
      alertsInflight = null;
    });

  if (alertsCacheValue) {
    // Stale-while-revalidate: do not block stationboard on refresh.
    return alertsCacheValue;
  }

  return alertsInflight;
}

function resolveOtdApiKey() {
  return (
    process.env.OPENTDATA_API_KEY ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    process.env.OPENTDATA_GTFS_SA_KEY ||
    ""
  );
}

function buildOtdStationboardCandidates(stopId, stationName) {
  const requested = String(stopId || "").trim();
  const name = String(stationName || "").trim();
  const root = requested.startsWith("Parent")
    ? requested.slice("Parent".length)
    : requested.split(":")[0];

  const out = [];
  const seen = new Set();
  function push(params) {
    const entries = Object.entries(params).filter(([, v]) => String(v || "").trim() !== "");
    if (entries.length === 0) return;
    const key = entries
      .map(([k, v]) => `${k}=${String(v).trim()}`)
      .sort()
      .join("&");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(params);
  }

  if (requested) push({ id: requested });
  if (root) push({ id: root });
  if (name) push({ station: name });
  return out;
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOtdReplacementSupplement({
  stopId,
  stationName,
  now,
  windowMinutes,
  limit,
} = {}) {
  const enableSupplement = process.env.OTD_EV_SUPPLEMENT !== "0";
  if (!enableSupplement) return [];

  const candidates = buildOtdStationboardCandidates(stopId, stationName);
  if (candidates.length === 0) return [];

  const apiKey = resolveOtdApiKey();
  const headers = {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const merged = [];
  const seen = new Set();
  let hadSuccessfulResponse = false;
  let lastFetchError = null;
  for (const candidate of candidates) {
    const url = new URL(OTD_STATIONBOARD_URL);
    url.searchParams.set("limit", String(Math.max(80, Number(limit || 120) * 2)));
    for (const [k, v] of Object.entries(candidate)) {
      const val = String(v || "").trim();
      if (!val) continue;
      url.searchParams.set(k, val);
    }

    let payload;
    try {
      payload = await fetchJsonWithTimeout(
        url.toString(),
        OTD_STATIONBOARD_FETCH_TIMEOUT_MS,
        headers
      );
    } catch (err) {
      lastFetchError = err;
      continue;
    }
    hadSuccessfulResponse = true;

    const extra = supplementFromOtdStationboard({
      data: payload,
      stationStopId: stopId,
      stationName,
      now,
      windowMinutes,
      departedGraceSeconds: Number(process.env.DEPARTED_GRACE_SECONDS || "45"),
      limit: Math.max(10, Number(limit || 120)),
    });

    for (const row of extra) {
      const key = `${row.trip_id}|${row.stop_id}|${row.scheduledDeparture}|${row.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }

    const hasRows = Array.isArray(payload?.stationboard) && payload.stationboard.length > 0;
    if (hasRows) {
      // Stop after the first successful stationboard payload to keep latency low.
      break;
    }
  }

  if (!hadSuccessfulResponse && lastFetchError && process.env.NODE_ENV !== "production") {
    console.warn("[OTD EV] supplement fetch failed", {
      stopId,
      message: String(lastFetchError?.message || lastFetchError),
    });
  }

  merged.sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    const ax = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bx = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return ax - bx;
  });

  return merged.slice(0, Math.max(10, Number(limit || 120)));
}

function hasReplacementDeparture(departures) {
  const rows = Array.isArray(departures) ? departures : [];
  return rows.some((dep) => {
    const line = String(dep?.line || "");
    const tags = Array.isArray(dep?.tags) ? dep.tags : [];
    return (
      /^EV/i.test(line) ||
      tags.includes("replacement") ||
      String(dep?.source || "") === "synthetic_alert"
    );
  });
}

function uniqueStopIds(values) {
  return Array.from(
    new Set((values || []).map((v) => String(v || "").trim()).filter(Boolean))
  );
}

async function loadStationScopeStopIds(requestedStopId, stationGroupId) {
  const requested = String(requestedStopId || "").trim();
  const group = String(stationGroupId || requestedStopId || "").trim();
  if (!group && !requested) return [];

  const roots = Array.from(new Set([requested, group].filter(Boolean)));
  if (roots.length === 0) return [];

  try {
    const res = await pool.query(
      `
      SELECT stop_id
      FROM public.gtfs_stops s
      WHERE
        s.stop_id = ANY($1::text[])
        OR COALESCE(to_jsonb(s) ->> 'parent_station', s.stop_id) = ANY($1::text[])
      `,
      [roots]
    );
    return Array.from(
      new Set((res.rows || []).map((row) => String(row?.stop_id || "").trim()).filter(Boolean))
    );
  } catch {
    return [];
  }
}

export async function getStationboard({
  stopId,
  stationId,
  stationName,
  fromTs,
  toTs,
  limit,
  windowMinutes,
  includeAlerts,
} = {}) {
  void fromTs;
  void toTs;
  const shouldIncludeAlerts = includeAlerts !== false;
  const traceCancellation = createCancellationTracer("api/stationboard", {
    enabled: process.env.DEBUG === "1",
  });

  const resolved = await resolveStop(
    {
      stop_id: stopId,
      stationId,
      stationName,
    },
    {
      db: { query: dbQuery },
    }
  );

  const locationId = String(resolved?.canonical?.id || "").trim();
  if (!locationId) {
    const err = new Error("unknown_stop");
    err.code = "unknown_stop";
    err.status = 400;
    err.tried = Array.isArray(resolved?.tried) ? resolved.tried : [];
    throw err;
  }

  const boundedLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
  const requestedWindow = Number(windowMinutes);
  const baseWindowMinutes =
    Number.isFinite(requestedWindow) && requestedWindow > 0
      ? Math.max(30, Math.min(Math.trunc(requestedWindow), 720))
      : 180;
  const sparseRetryMin = Math.max(
    0,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_MIN_DEPS || "2")
  );
  const sparseRetryWindowMinutes = Math.max(
    baseWindowMinutes,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_WINDOW_MINUTES || "360")
  );
  const alertsPromise = shouldIncludeAlerts ? getServiceAlertsCached() : null;
  let board = await buildStationboard(locationId, {
    limit: boundedLimit,
    windowMinutes: baseWindowMinutes,
  });
  if (
    sparseRetryMin > 0 &&
    Array.isArray(board?.departures) &&
    board.departures.length < sparseRetryMin &&
    sparseRetryWindowMinutes > baseWindowMinutes
  ) {
    const expanded = await buildStationboard(locationId, {
      limit: boundedLimit,
      windowMinutes: sparseRetryWindowMinutes,
    });
    if ((expanded?.departures?.length || 0) > (board?.departures?.length || 0)) {
      board = expanded;
    }
  }

  const departures = Array.isArray(board?.departures) ? board.departures : [];
  const scopeStopIds = uniqueStopIds([
    ...(resolved?.children || []).map((child) => child?.id),
    ...(await loadStationScopeStopIds(locationId, board?.station?.id)),
  ]);
  const canonicalName =
    String(resolved?.displayName || resolved?.canonical?.name || stationName || "").trim() ||
    String(board?.station?.name || locationId).trim();
  const baseResponse = {
    ...board,
    station: {
      id: locationId,
      name: canonicalName,
    },
    resolved: {
      canonicalId: locationId,
      source: String(resolved?.source || "fallback"),
      childrenCount: Array.isArray(resolved?.children) ? resolved.children.length : 0,
    },
    banners: [],
    departures: departures.map((dep) =>
      ({
        ...dep,
        source: dep?.source || "scheduled",
        tags: Array.isArray(dep?.tags) ? dep.tags : [],
        alerts: Array.isArray(dep?.alerts) ? dep.alerts : [],
      })
    ),
  };
  traceCancellation("after_base_stationboard", baseResponse.departures);

  if (!shouldIncludeAlerts) return baseResponse;

  try {
    const alerts = await alertsPromise;
    const syntheticDepartures = synthesizeFromAlerts({
      alerts,
      stopId: locationId,
      departures: baseResponse.departures,
      scopeStopIds,
      stationName: canonicalName,
      now: new Date(),
      windowMinutes: baseWindowMinutes,
      departedGraceSeconds: Number(process.env.DEPARTED_GRACE_SECONDS || "45"),
      limit: Math.max(10, boundedLimit),
    });

    const byKey = new Map();
    for (const dep of [...baseResponse.departures, ...syntheticDepartures]) {
      const key = `${dep.trip_id || ""}|${dep.stop_id || ""}|${dep.stop_sequence || ""}|${
        dep.scheduledDeparture || ""
      }|${dep.source || ""}`;
      const previous = byKey.get(key);
      byKey.set(key, pickPreferredMergedDeparture(previous, dep));
    }
    const mergedDepartures = Array.from(byKey.values())
      .sort((a, b) => {
        const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
        const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
        const ax = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
        const bx = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
        return ax - bx;
      })
      .slice(0, 1000);
    traceCancellation("after_alert_synthesis_merge", mergedDepartures);
    const routeIds = mergedDepartures.map((dep) => dep?.route_id).filter(Boolean);
    const tripIds = mergedDepartures.map((dep) => dep?.trip_id).filter(Boolean);

    const attached = attachAlerts({
      stopId: locationId,
      scopeStopIds,
      routeIds,
      tripIds,
      departures: mergedDepartures,
      alerts,
      now: new Date(),
    });
    traceCancellation("after_attach_alerts", attached.departures);

    let finalDepartures = attached.departures;
    if (!hasReplacementDeparture(finalDepartures)) {
      const supplement = await fetchOtdReplacementSupplement({
        stopId: locationId,
        stationName: canonicalName,
        now: new Date(),
        windowMinutes: baseWindowMinutes,
        limit: boundedLimit,
      });
      if (supplement.length > 0) {
        const bySuppKey = new Map();
        for (const dep of [...finalDepartures, ...supplement]) {
          const key = `${dep.trip_id || ""}|${dep.stop_id || ""}|${dep.stop_sequence || ""}|${
            dep.scheduledDeparture || ""
          }|${dep.source || ""}`;
          const previous = bySuppKey.get(key);
          bySuppKey.set(key, pickPreferredMergedDeparture(previous, dep));
        }
        finalDepartures = Array.from(bySuppKey.values())
          .sort((a, b) => {
            const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
            const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
            const ax = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
            const bx = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
            return ax - bx;
          })
          .slice(0, 1000);
      }
    }
    traceCancellation("after_otd_supplement", finalDepartures);

    return {
      ...baseResponse,
      banners: attached.banners,
      departures: finalDepartures,
    };
  } catch (err) {
    const response = {
      ...baseResponse,
      banners: [],
    };
    if (process.env.NODE_ENV !== "production") {
      response.debug = {
        ...(response.debug || {}),
        alerts_error: String(err?.message || err),
      };
    }
    return response;
  }
}
