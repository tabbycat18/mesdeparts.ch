import { buildStationboard } from "../logic/buildStationboard.js";
import { pool } from "../../db.js";
import { query as dbQuery } from "../db/query.js";
import { resolveStop } from "../resolve/resolveStop.js";
import { fetchServiceAlerts } from "../loaders/fetchServiceAlerts.js";
import { attachAlerts } from "../merge/attachAlerts.js";
import { supplementFromOtdStationboard } from "../merge/supplementFromOtdStationboard.js";
import { pickPreferredMergedDeparture } from "../merge/pickPreferredDeparture.js";
import { normalizeDeparture } from "../models/stationboard.js";
import { pickTranslation, resolveLangPrefs } from "../util/i18n.js";
import { filterRenderableDepartures } from "../util/departureFilter.js";
import { createCancellationTracer } from "../debug/cancellationTrace.js";
import {
  createStationboardDebugLogger,
  summarizeCancellation,
  shouldEnableStationboardDebug,
} from "../debug/stationboardDebug.js";

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

function localizeServiceAlerts(alerts, langPrefs) {
  const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];
  return {
    ...(alerts || {}),
    entities: entities.map((alert) => ({
      ...alert,
      headerText:
        pickTranslation(alert?.headerTranslations || alert?.headerText, langPrefs) ||
        null,
      descriptionText:
        pickTranslation(
          alert?.descriptionTranslations || alert?.descriptionText,
          langPrefs
        ) || null,
    })),
  };
}

function canonicalizeDepartures(departures, { stopId, debugLog, debugState } = {}) {
  const rows = Array.isArray(departures) ? departures : [];
  const { kept, dropped } = filterRenderableDepartures(rows);

  if (dropped.length > 0 && debugState && Array.isArray(debugState.stageCounts)) {
    const stage = {
      stage: "after_departure_validity_filter",
      count: kept.length,
      dropped: dropped.length,
      cancelled: countCancelled(kept),
    };
    debugState.stageCounts.push(stage);
    if (typeof debugLog === "function") {
      debugLog("stage_counts", stage);
      debugLog("departure_filter_dropped_sample", dropped.slice(0, 5));
    }
  }

  return kept.map((dep) => normalizeDeparture(dep, { stopId }));
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

function countCancelled(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => acc + (row?.cancelled === true ? 1 : 0),
    0
  );
}

function randomRequestId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `sb-${Date.now().toString(36)}-${rand}`;
}

function deriveDebugSource(dep) {
  const source = String(dep?.source || "");
  if (source === "scheduled") return "scheduled";
  if (source === "rt_added") return "added_trip";
  if (source === "synthetic_alert") {
    const cancelReasons = Array.isArray(dep?.cancelReasons) ? dep.cancelReasons : [];
    if (cancelReasons.includes("otd_prognosis_status_cancelled")) return "supplement";
    const tripId = String(dep?.trip_id || "");
    if (tripId.startsWith("otd-ev:")) return "supplement";
    return "synthesized";
  }
  return source || "unknown";
}

function withDebugDepartureFlags(departures) {
  const rows = Array.isArray(departures) ? departures : [];
  return rows.map((dep) => {
    const debugFlags = [];
    const debugSource = deriveDebugSource(dep);
    debugFlags.push(`source:${debugSource}`);

    const cancelReasons = Array.isArray(dep?.cancelReasons)
      ? dep.cancelReasons.map((value) => String(value)).filter(Boolean)
      : [];
    for (const reason of cancelReasons) {
      debugFlags.push(`cancel:${reason}`);
    }

    return {
      ...dep,
      debugSource,
      debugFlags,
    };
  });
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
  lang,
  acceptLanguage,
  fromTs,
  toTs,
  limit,
  windowMinutes,
  includeAlerts,
  debug,
} = {}) {
  void fromTs;
  void toTs;
  const alertsFeatureEnabled = process.env.STATIONBOARD_ENABLE_M2 !== "0";
  const includeAlertsRequested = includeAlerts !== false;
  const includeAlertsApplied = alertsFeatureEnabled && includeAlertsRequested;
  const debugEnabled =
    debug === true || shouldEnableStationboardDebug(process.env.STATIONBOARD_DEBUG_JSON);
  const requestId = randomRequestId();
  const debugLog = createStationboardDebugLogger({
    enabled: debugEnabled,
    requestId,
    scope: "api/stationboard",
  });
  const debugState = {
    requestId,
    stopResolution: {},
    timeWindow: null,
    stageCounts: [],
    langPrefs: [],
  };
  const langPrefs = resolveLangPrefs({
    queryLang: lang,
    acceptLanguageHeader: acceptLanguage,
  });
  debugState.langPrefs = langPrefs;
  const traceCancellation = createCancellationTracer("api/stationboard", {
    enabled: process.env.DEBUG === "1",
  });

  debugLog("request", {
    requested: {
      stopId: String(stopId || ""),
      stationId: String(stationId || ""),
      stationName: String(stationName || ""),
      lang: String(lang || ""),
      limit: Number(limit || 0),
      windowMinutes: Number(windowMinutes || 0),
      includeAlertsRequested,
      includeAlertsApplied,
      requestedIncludeAlerts: includeAlertsRequested,
      alertsFeatureEnabled,
      includeAlerts: includeAlertsApplied,
      langPrefs,
    },
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
      : 120;
  const sparseRetryMin = Math.max(
    0,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_MIN_DEPS || "2")
  );
  const sparseRetryWindowMinutes = Math.max(
    baseWindowMinutes,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_WINDOW_MINUTES || "360")
  );
  const alertsPromise = includeAlertsApplied ? getServiceAlertsCached() : null;
  let board = await buildStationboard(locationId, {
    limit: boundedLimit,
    windowMinutes: baseWindowMinutes,
    debug: debugEnabled,
    debugLog: (event, payload) => {
      debugLog(event, payload);
    },
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
      debug: debugEnabled,
      debugLog: (event, payload) => {
        debugLog(event, payload);
      },
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
  debugState.stopResolution = {
    requestedStopId: String(stopId || stationId || ""),
    canonicalId: locationId,
    resolvedChildren: (resolved?.children || []).map((child) => child?.id).filter(Boolean),
    scopeStopIds,
    queryStopIds: Array.isArray(board?.debugMeta?.stops?.queryStopIds)
      ? board.debugMeta.stops.queryStopIds
      : [],
  };
  debugState.timeWindow = board?.debugMeta?.timeWindow || null;
  debugLog("resolved_scope", {
    stopResolution: debugState.stopResolution,
    timeWindow: debugState.timeWindow,
  });

  const boardStageCounts = Array.isArray(board?.debugMeta?.stageCounts)
    ? board.debugMeta.stageCounts
    : [];
  for (const stageCount of boardStageCounts) {
    debugState.stageCounts.push(stageCount);
  }
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
  delete baseResponse.debugMeta;
  debugState.stageCounts.push({
    stage: "after_base_stationboard",
    count: baseResponse.departures.length,
    cancelled: countCancelled(baseResponse.departures),
  });
  debugLog("stage_counts", debugState.stageCounts[debugState.stageCounts.length - 1]);
  debugLog("cancelled_details", {
    stage: "after_base_stationboard",
    ...summarizeCancellation(baseResponse.departures),
  });
  traceCancellation("after_base_stationboard", baseResponse.departures);

  if (!includeAlertsApplied) {
    baseResponse.departures = canonicalizeDepartures(baseResponse.departures, {
      stopId: locationId,
      debugLog,
      debugState,
    });
    if (debugEnabled) {
      baseResponse.debug = {
        requestId,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        stageCounts: debugState.stageCounts,
        langPrefs,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
      };
    }
    return baseResponse;
  }

  try {
    const alerts = localizeServiceAlerts(await alertsPromise, langPrefs);
    const syntheticDepartures = [];

    const byKey = new Map();
    for (const dep of [...baseResponse.departures, ...syntheticDepartures]) {
      const key = `${dep.trip_id || ""}|${dep.stop_id || ""}|${dep.stop_sequence || ""}|${
        dep.scheduledDeparture || ""
      }`;
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
    debugState.stageCounts.push({
      stage: "after_alert_synthesis_dedup",
      count: mergedDepartures.length,
      cancelled: countCancelled(mergedDepartures),
      syntheticCandidates: syntheticDepartures.length,
    });
    debugLog("stage_counts", debugState.stageCounts[debugState.stageCounts.length - 1]);
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
    debugState.stageCounts.push({
      stage: "after_alerts_attached",
      count: attached.departures.length,
      cancelled: countCancelled(attached.departures),
      banners: Array.isArray(attached?.banners) ? attached.banners.length : 0,
    });
    debugLog("stage_counts", debugState.stageCounts[debugState.stageCounts.length - 1]);
    debugLog("cancelled_details", {
      stage: "after_alerts_attached",
      ...summarizeCancellation(attached.departures),
    });
    traceCancellation("after_attach_alerts", attached.departures);

    let finalDepartures = attached.departures;
    let supplementCount = 0;
    if (!hasReplacementDeparture(finalDepartures)) {
      const supplement = await fetchOtdReplacementSupplement({
        stopId: locationId,
        stationName: canonicalName,
        now: new Date(),
        windowMinutes: baseWindowMinutes,
        limit: boundedLimit,
      });
      supplementCount = supplement.length;
      if (supplement.length > 0) {
        const bySuppKey = new Map();
        for (const dep of [...finalDepartures, ...supplement]) {
          const key = `${dep.trip_id || ""}|${dep.stop_id || ""}|${dep.stop_sequence || ""}|${
            dep.scheduledDeparture || ""
          }`;
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
    debugState.stageCounts.push({
      stage: "after_supplement",
      count: finalDepartures.length,
      cancelled: countCancelled(finalDepartures),
      supplementAdded: supplementCount,
      banners: Array.isArray(attached?.banners) ? attached.banners.length : 0,
    });
    debugLog("stage_counts", debugState.stageCounts[debugState.stageCounts.length - 1]);
    debugLog("cancelled_details", {
      stage: "after_supplement",
      ...summarizeCancellation(finalDepartures),
    });
    traceCancellation("after_otd_supplement", finalDepartures);

    const response = {
      ...baseResponse,
      banners: attached.banners,
      departures: canonicalizeDepartures(finalDepartures, {
        stopId: locationId,
        debugLog,
        debugState,
      }),
    };
    if (debugEnabled) {
      response.debug = {
        requestId,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        stageCounts: debugState.stageCounts,
        langPrefs,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
      };
    }
    return response;
  } catch (err) {
    const response = {
      ...baseResponse,
      banners: [],
      departures: canonicalizeDepartures(baseResponse.departures, {
        stopId: locationId,
        debugLog,
        debugState,
      }),
    };
    if (process.env.NODE_ENV !== "production") {
      response.debug = {
        ...(response.debug || {}),
        alerts_error: String(err?.message || err),
      };
    }
    if (debugEnabled) {
      response.debug = {
        ...(response.debug || {}),
        requestId,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        stageCounts: debugState.stageCounts,
        langPrefs,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
      };
    }
    return response;
  }
}
