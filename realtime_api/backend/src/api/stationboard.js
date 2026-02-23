import { buildStationboard } from "../logic/buildStationboard.js";
import { query as dbQuery } from "../db/query.js";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { resolveStop } from "../resolve/resolveStop.js";
import { attachAlerts } from "../merge/attachAlerts.js";
import { supplementFromOtdStationboard } from "../merge/supplementFromOtdStationboard.js";
import { pickPreferredMergedDeparture } from "../merge/pickPreferredDeparture.js";
import { normalizeDeparture } from "../models/stationboard.js";
import { pickTranslation, resolveLangPrefs } from "../util/i18n.js";
import { filterRenderableDepartures } from "../util/departureFilter.js";
import { stopKeySet } from "../util/stopScope.js";
import { createCancellationTracer } from "../debug/cancellationTrace.js";
import { buildDepartureAudit } from "../debug/departureAudit.js";
import {
  createStationboardDebugLogger,
  summarizeCancellation,
  shouldEnableStationboardDebug,
} from "../debug/stationboardDebug.js";
import { guardStationboardRequestPathUpstream } from "../util/upstreamRequestGuard.js";
import { LA_SERVICEALERTS_FEED_KEY, LA_TRIPUPDATES_FEED_KEY } from "../db/rtCache.js";
import { loadAlertsFromCache } from "../rt/loadAlertsFromCache.js";

const OTD_STATIONBOARD_URL = "https://transport.opendata.ch/v1/stationboard";
const OTD_STATIONBOARD_FETCH_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.OTD_STATIONBOARD_FETCH_TIMEOUT_MS || "1200")
);
const OTD_SUPPLEMENT_CACHE_MS = Math.max(
  1_000,
  Number(process.env.OTD_SUPPLEMENT_CACHE_MS || "30000")
);
const OTD_SUPPLEMENT_BLOCK_ON_COLD = process.env.OTD_EV_SUPPLEMENT_BLOCK_ON_COLD === "1";
const STATIONBOARD_DISABLE_REQUEST_PATH_UPSTREAM = true;
const INSTANCE_HOST = String(os.hostname() || "").trim() || "localhost";
const INSTANCE_ALLOC_ID = String(process.env.FLY_ALLOC_ID || "").trim();
const INSTANCE_ID = INSTANCE_ALLOC_ID || `${INSTANCE_HOST}:${process.pid}`;
function compactBuildVersion(raw) {
  const value = String(raw || "").trim();
  if (!value) return "dev";
  if (/^[0-9a-f]{7,40}$/i.test(value)) return value.slice(0, 12);
  if (value.length <= 32) return value;
  return value.slice(0, 32);
}
const BUILD_VERSION = compactBuildVersion(
  process.env.APP_VERSION ||
    process.env.RELEASE_VERSION ||
    process.env.FLY_IMAGE_REF ||
    process.env.GIT_SHA ||
    process.env.SOURCE_VERSION ||
    ""
);
const RT_INSTANCE_META = Object.freeze({
  id: INSTANCE_ID,
  allocId: INSTANCE_ALLOC_ID || null,
  host: INSTANCE_HOST,
  pid: process.pid,
  build: BUILD_VERSION,
});
const DEFAULT_STATIONBOARD_WINDOW_MINUTES = Math.max(
  30,
  Math.min(
    Math.trunc(Number(process.env.STATIONBOARD_DEFAULT_WINDOW_MINUTES || "210")),
    720
  )
);
const STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS || "60000")
);

const otdSupplementCache = new Map();
let alertsRequestCacheValue = null;
let alertsRequestCacheExpiresAtMs = 0;
let alertsRequestCacheInFlight = null;

function cloneAlertsMeta(meta) {
  return meta && typeof meta === "object" ? { ...meta } : {};
}

function cloneAlertsData(alerts) {
  const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];
  return { entities };
}

async function loadAlertsFromCacheThrottled({ nowMs } = {}) {
  const currentNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  if (alertsRequestCacheValue && currentNowMs < alertsRequestCacheExpiresAtMs) {
    return {
      alerts: cloneAlertsData(alertsRequestCacheValue.alerts),
      meta: {
        ...cloneAlertsMeta(alertsRequestCacheValue.meta),
        requestCacheStatus: "HIT",
        requestCacheFetchedAt:
          String(alertsRequestCacheValue.fetchedAtIso || "").trim() || null,
        requestCacheTtlMs: STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS,
      },
    };
  }

  if (!alertsRequestCacheInFlight) {
    alertsRequestCacheInFlight = (async () => {
      const loaded = (await loadAlertsFromCache({ enabled: true, nowMs: currentNowMs })) || {
        alerts: { entities: [] },
        meta: { reason: "missing_cache" },
      };
      alertsRequestCacheValue = {
        alerts: cloneAlertsData(loaded.alerts),
        meta: cloneAlertsMeta(loaded.meta),
        fetchedAtIso: new Date(currentNowMs).toISOString(),
      };
      alertsRequestCacheExpiresAtMs =
        currentNowMs + STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS;
      return loaded;
    })()
      .finally(() => {
        alertsRequestCacheInFlight = null;
      });
  }

  const loaded = await alertsRequestCacheInFlight;
  return {
    alerts: cloneAlertsData(loaded?.alerts),
    meta: {
      ...cloneAlertsMeta(loaded?.meta),
      requestCacheStatus: "MISS",
      requestCacheFetchedAt: new Date(currentNowMs).toISOString(),
      requestCacheTtlMs: STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS,
    },
  };
}

function localizeServiceAlerts(alerts, langPrefs) {
  const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];
  return {
    entities: entities.map((alert) => ({
      id: alert?.id || "",
      severity: alert?.severity || "unknown",
      effect: alert?.effect || null,
      activePeriods: Array.isArray(alert?.activePeriods) ? alert.activePeriods : [],
      informedEntities: Array.isArray(alert?.informedEntities)
        ? alert.informedEntities
        : [],
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

function filterLocalizedAlertsByScope(alerts, { stopId, scopeStopIds, routeIds, tripIds } = {}) {
  const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];
  if (!entities.length) return { entities: [] };

  function stopTokens(value) {
    return Array.from(stopKeySet(value));
  }

  function stopNumericRoot(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parentMatch = raw.match(/^Parent(\d+)$/i);
    if (parentMatch?.[1]) return String(Number(parentMatch[1]));
    const scopedNumericMatch = raw.match(/^(\d+)(?::|$)/);
    if (scopedNumericMatch?.[1]) return String(Number(scopedNumericMatch[1]));
    const sloidMatch = raw.match(/sloid:(\d+)/i);
    if (sloidMatch?.[1]) return String(Number(sloidMatch[1]));
    return "";
  }

  const stopTokenSet = new Set();
  const stopRootSet = new Set();
  for (const stop of [
    stopId,
    ...(Array.isArray(scopeStopIds) ? scopeStopIds : []),
  ]) {
    for (const token of stopTokens(stop)) stopTokenSet.add(token);
    const root = stopNumericRoot(stop);
    if (root && root !== "0") stopRootSet.add(root);
  }
  const stopSet = new Set(
    [stopId, ...(Array.isArray(scopeStopIds) ? scopeStopIds : [])]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
  const routeSet = new Set(
    (Array.isArray(routeIds) ? routeIds : [])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );
  const tripSet = new Set(
    (Array.isArray(tripIds) ? tripIds : [])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );

  const filtered = entities.filter((alert) => {
    const informed = Array.isArray(alert?.informedEntities) ? alert.informedEntities : [];
    if (informed.length === 0) return false;
    for (const entity of informed) {
      const eStop = String(entity?.stop_id || "").trim();
      const eRoute = String(entity?.route_id || "").trim();
      const eTrip = String(entity?.trip_id || "").trim();
      if (eStop && stopSet.has(eStop)) return true;
      if (eStop) {
        const tokens = stopTokens(eStop);
        if (tokens.some((token) => stopTokenSet.has(token))) return true;
        const eRoot = stopNumericRoot(eStop);
        if (eRoot && stopRootSet.has(eRoot)) return true;
      }
      if (eRoute && routeSet.has(eRoute)) return true;
      if (eTrip && tripSet.has(eTrip)) return true;
    }
    return false;
  });

  return {
    entities: filtered,
  };
}

function canonicalizeDepartures(
  departures,
  { stopId, debugLog, debugState, includeDelayDebug = false } = {}
) {
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

  return kept.map((dep) =>
    normalizeDeparture(dep, {
      stopId,
      includeDelayDebug: includeDelayDebug === true,
    })
  );
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
  const allowed = guardStationboardRequestPathUpstream(url, {
    scope: "api/stationboard:otd_fetch",
  });
  if (!allowed) {
    const err = new Error("request_path_upstream_blocked");
    err.code = "request_path_upstream_blocked";
    throw err;
  }
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
  if (STATIONBOARD_DISABLE_REQUEST_PATH_UPSTREAM) return [];
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

function buildOtdSupplementCacheKey({ stopId, stationName, windowMinutes, limit }) {
  return [
    String(stopId || "").trim(),
    String(stationName || "").trim().toLowerCase(),
    String(Number(windowMinutes) || 0),
    String(Number(limit) || 0),
  ].join("|");
}

async function getOtdReplacementSupplementCached(params = {}) {
  const key = buildOtdSupplementCacheKey(params);
  if (!key.replace(/\|/g, "")) return [];
  const now = Date.now();
  const entry = otdSupplementCache.get(key) || null;
  const isFresh = entry && now - Number(entry.ts || 0) <= OTD_SUPPLEMENT_CACHE_MS;

  if (isFresh && Array.isArray(entry.value)) {
    return entry.value;
  }

  const refresh = async () => {
    const next = await fetchOtdReplacementSupplement(params);
    otdSupplementCache.set(key, {
      ts: Date.now(),
      value: Array.isArray(next) ? next : [],
      inflight: null,
    });
    return Array.isArray(next) ? next : [];
  };

  if (entry?.inflight) {
    if (Array.isArray(entry.value)) return entry.value;
    return OTD_SUPPLEMENT_BLOCK_ON_COLD ? entry.inflight : [];
  }

  const inflight = refresh().catch((err) => {
    const fallback = Array.isArray(entry?.value) ? entry.value : [];
    if (process.env.NODE_ENV !== "production") {
      console.warn("[OTD EV] supplement cache refresh failed", {
        stopId: params?.stopId,
        message: String(err?.message || err),
      });
    }
    otdSupplementCache.set(key, {
      ts: Date.now(),
      value: fallback,
      inflight: null,
    });
    return fallback;
  });

  otdSupplementCache.set(key, {
    ts: Number(entry?.ts || 0),
    value: Array.isArray(entry?.value) ? entry.value : null,
    inflight,
  });

  if (Array.isArray(entry?.value)) {
    return entry.value;
  }
  return OTD_SUPPLEMENT_BLOCK_ON_COLD ? inflight : [];
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

function isParentIdLike(value) {
  return /^parent/i.test(String(value || "").trim());
}

function isPlatformLike(value) {
  return String(value || "").trim().includes(":");
}

async function fetchStopRowsByIds(ids = []) {
  const keys = uniqueStopIds(ids);
  if (keys.length === 0) return [];
  const res = await dbQuery(
    `
    SELECT
      s.stop_id,
      s.stop_name,
      COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), '') AS parent_station,
      COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type
    FROM public.gtfs_stops s
    WHERE s.stop_id = ANY($1::text[])
    ORDER BY s.stop_id
    `,
    [keys]
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function findParentRowForChildLikeInput(stopId) {
  const id = String(stopId || "").trim();
  if (!id) return null;
  const res = await dbQuery(
    `
    SELECT
      p.stop_id,
      p.stop_name,
      COALESCE(NULLIF(to_jsonb(p) ->> 'parent_station', ''), '') AS parent_station,
      COALESCE(NULLIF(to_jsonb(p) ->> 'location_type', ''), '') AS location_type
    FROM public.gtfs_stops c
    JOIN public.gtfs_stops p ON p.stop_id = c.parent_station
    WHERE c.stop_id = $1 OR c.stop_id LIKE $1 || ':%'
    ORDER BY
      CASE WHEN c.stop_id = $1 THEN 0 ELSE 1 END,
      char_length(c.stop_id) ASC
    LIMIT 1
    `,
    [id]
  );
  return res.rows?.[0] || null;
}

function sumScheduledRows(board) {
  const rowSources = Array.isArray(board?.debugMeta?.rowSources) ? board.debugMeta.rowSources : [];
  return rowSources.reduce((acc, source) => acc + (Number(source?.rowCount) || 0), 0);
}

async function fetchVersionSkewDebugInfo() {
  let staticVersion = null;
  let rtVersion = null;

  try {
    const staticRes = await dbQuery(
      `
      SELECT value
      FROM public.meta_kv
      WHERE key = 'gtfs_current_feed_version'
      LIMIT 1
      `
    );
    staticVersion = String(staticRes?.rows?.[0]?.value || "").trim() || null;
  } catch {
    staticVersion = null;
  }

  try {
    const rtRes = await dbQuery(
      `
      SELECT feed_version
      FROM public.rt_feed_meta
      WHERE feed_name = 'trip_updates'
      ORDER BY updated_at DESC NULLS LAST, fetched_at DESC NULLS LAST
      LIMIT 1
      `
    );
    rtVersion = String(rtRes?.rows?.[0]?.feed_version || "").trim() || null;
  } catch {
    rtVersion = null;
  }

  return {
    staticVersion,
    rtVersion,
    hasSkew:
      !!staticVersion &&
      !!rtVersion &&
      String(staticVersion).toLowerCase() !== String(rtVersion).toLowerCase(),
  };
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

function roundMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(1));
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

function toRtTripUpdatesDebug(rtMeta, departureAuditRows) {
  const base = rtMeta && typeof rtMeta === "object" ? rtMeta : {};
  const appliedToDeparturesCount = (Array.isArray(departureAuditRows) ? departureAuditRows : []).reduce(
    (acc, row) =>
      acc +
      (Array.isArray(row?.sourceTags) && row.sourceTags.includes("tripupdate") ? 1 : 0),
    0
  );

  const normalizedReason = normalizeRtReason(base.reason, base.applied === true);
  return {
    rtEnabledForRequest: base.rtEnabledForRequest === true,
    rtMetaReason:
      typeof base.rtMetaReason === "string"
        ? base.rtMetaReason
        : typeof base.reason === "string"
          ? base.reason
          : null,
    cacheStatus: String(base.cacheStatus || "MISS"),
    fetchedAtUtc: base.fetchedAt || base.fetchedAtUtc || null,
    ageSec: Number.isFinite(base.ageSeconds)
      ? Number(base.ageSeconds)
      : Number.isFinite(base.ageSec)
        ? Number(base.ageSec)
        : null,
    ttlSec: Number.isFinite(base.freshnessMaxAgeSeconds)
      ? Number(base.freshnessMaxAgeSeconds)
      : Number.isFinite(base.ttlSec)
        ? Number(base.ttlSec)
        : null,
    fetchMs: Number.isFinite(base.processingMs)
      ? Number(base.processingMs)
      : Number.isFinite(base.fetchMs)
        ? Number(base.fetchMs)
        : null,
    entityCount: Number.isFinite(base.entityCount) ? Number(base.entityCount) : null,
    scopedEntities: Number.isFinite(base.scopedEntities) ? Number(base.scopedEntities) : null,
    scopedTripCount: Number.isFinite(base.scopedTripCount) ? Number(base.scopedTripCount) : null,
    scopedStopCount: Number.isFinite(base.scopedStopCount) ? Number(base.scopedStopCount) : null,
    rtMode: typeof base.debugRtMode === "string" ? base.debugRtMode : null,
    hadError: base.hadError === true || !["fresh", "stale", "missing", "disabled", "guarded"].includes(normalizedReason),
    error: base.error ? String(base.error) : base.lastError ? String(base.lastError) : null,
    applied: base.applied === true,
    reason: normalizedReason,
    appliedToDeparturesCount,
  };
}

function normalizeRtReason(rawReason, applied) {
  if (applied === true) return "fresh";
  const reason = String(rawReason || "").trim().toLowerCase();
  if (!reason) return "missing";
  if (reason === "applied" || reason === "fresh" || reason === "fresh_cache") return "fresh";
  if (reason.includes("stale")) return "stale";
  if (reason === "disabled") return "disabled";
  if (reason.includes("guard") || reason.includes("decode") || reason.includes("error")) return "guarded";
  if (reason.includes("missing")) return "missing";
  return "guarded";
}

function buildRtResponseMeta(rtMetaRaw) {
  const rtMeta = rtMetaRaw && typeof rtMetaRaw === "object" ? rtMetaRaw : {};
  const reason = normalizeRtReason(rtMeta.reason, rtMeta.applied === true);
  const cacheFetchedAt =
    String(rtMeta.cacheFetchedAt || rtMeta.fetchedAt || "").trim() || null;
  const cacheAgeMs = Number.isFinite(rtMeta.cacheAgeMs)
    ? Number(rtMeta.cacheAgeMs)
    : Number.isFinite(rtMeta.ageMs)
      ? Number(rtMeta.ageMs)
      : Number.isFinite(rtMeta.ageSeconds)
        ? Math.max(0, Number(rtMeta.ageSeconds) * 1000)
        : null;
  const freshnessThresholdMs = Number.isFinite(rtMeta.freshnessThresholdMs)
    ? Math.max(5_000, Number(rtMeta.freshnessThresholdMs))
    : Number.isFinite(rtMeta.freshnessMaxAgeSeconds)
      ? Math.max(5_000, Number(rtMeta.freshnessMaxAgeSeconds) * 1000)
      : 45_000;
  const instance =
    rtMeta.instance && typeof rtMeta.instance === "object"
      ? {
          id: String(rtMeta.instance.id || RT_INSTANCE_META.id),
          allocId:
            String(rtMeta.instance.allocId || rtMeta.instance.allocID || "").trim() || null,
          host: String(rtMeta.instance.host || RT_INSTANCE_META.host),
          pid: Number.isFinite(Number(rtMeta.instance.pid))
            ? Number(rtMeta.instance.pid)
            : RT_INSTANCE_META.pid,
          build:
            String(rtMeta.instance.build || rtMeta.instance.version || "").trim() ||
            RT_INSTANCE_META.build,
        }
      : RT_INSTANCE_META;
  return {
    available: rtMeta.available === true,
    applied: rtMeta.applied === true,
    reason,
    feedKey: String(rtMeta.feedKey || LA_TRIPUPDATES_FEED_KEY),
    fetchedAt: cacheFetchedAt,
    cacheFetchedAt,
    cacheAgeMs,
    ageMs: cacheAgeMs,
    ageSeconds: Number.isFinite(rtMeta.ageSeconds)
      ? Number(rtMeta.ageSeconds)
      : Number.isFinite(cacheAgeMs)
        ? Math.floor(cacheAgeMs / 1000)
        : null,
    freshnessThresholdMs,
    freshnessMaxAgeSeconds: Math.round(freshnessThresholdMs / 1000),
    cacheStatus: String(rtMeta.cacheStatus || "MISS"),
    status: Number.isFinite(rtMeta.status)
      ? Number(rtMeta.status)
      : Number.isFinite(rtMeta.lastStatus)
        ? Number(rtMeta.lastStatus)
        : null,
    lastStatus: Number.isFinite(rtMeta.lastStatus) ? Number(rtMeta.lastStatus) : null,
    lastError: rtMeta.lastError ? String(rtMeta.lastError) : null,
    payloadBytes: Number.isFinite(rtMeta.payloadBytes) ? Number(rtMeta.payloadBytes) : null,
    instance,
  };
}

function buildAlertsResponseMeta({
  includeAlertsRequested,
  includeAlertsApplied,
  reason,
  alertsMeta,
} = {}) {
  const source = alertsMeta && typeof alertsMeta === "object" ? alertsMeta : {};
  const fetchedAt =
    String(source.fetchedAt || source.cacheFetchedAt || "").trim() || null;
  const cacheAgeMs = Number.isFinite(Number(source.cacheAgeMs))
    ? Number(source.cacheAgeMs)
    : null;
  const ageSeconds = Number.isFinite(Number(source.ageSeconds))
    ? Number(source.ageSeconds)
    : Number.isFinite(cacheAgeMs)
      ? Math.floor(cacheAgeMs / 1000)
      : null;
  return {
    available: source.available === true,
    applied: source.applied === true,
    reason:
      String(source.reason || "").trim() ||
      String(reason || "disabled"),
    fetchedAt,
    ageSeconds,
    includeRequested: includeAlertsRequested === true,
    includeApplied: includeAlertsApplied === true,
    feedKey: String(source.feedKey || LA_SERVICEALERTS_FEED_KEY),
    cacheAgeMs,
    freshnessThresholdMs: Number.isFinite(Number(source.freshnessThresholdMs))
      ? Number(source.freshnessThresholdMs)
      : null,
    status: Number.isFinite(Number(source.status))
      ? Number(source.status)
      : Number.isFinite(Number(source.lastStatus))
        ? Number(source.lastStatus)
        : null,
    lastStatus: Number.isFinite(Number(source.lastStatus))
      ? Number(source.lastStatus)
      : null,
    lastError: String(source.lastError || "").trim() || null,
    payloadBytes: Number.isFinite(Number(source.payloadBytes))
      ? Number(source.payloadBytes)
      : null,
    cacheStatus: String(source.cacheStatus || "").trim() || null,
  };
}

export async function getStationboard({
  stopId,
  stationId,
  stationName,
  lang,
  acceptLanguage,
  requestId: requestIdRaw,
  fromTs,
  toTs,
  limit,
  windowMinutes,
  includeAlerts,
  debug,
  debugRt,
} = {}) {
  void fromTs;
  void toTs;
  const alertsFeatureEnabled =
    String(process.env.STATIONBOARD_ENABLE_ALERTS || "").trim() !== "0";
  const includeAlertsRequested = includeAlerts !== false;
  const includeAlertsApplied = alertsFeatureEnabled && includeAlertsRequested;
  const debugEnabled =
    debug === true || shouldEnableStationboardDebug(process.env.STATIONBOARD_DEBUG_JSON);
  const rtDebugMode = debugEnabled ? String(debugRt || "").trim().toLowerCase() : "";
  const requestId = String(requestIdRaw || "").trim() || randomRequestId();
  const requestStartedMs = performance.now();
  const timing = {
    requestId,
    resolveStopMs: 0,
    buildStationboardMs: 0,
    sparseRetryTriggered: false,
    sparseRetryMs: 0,
    scopeStopIdsMs: 0,
    alertsWaitMs: 0,
    alertsMergeMs: 0,
    supplementMs: 0,
    totalMs: 0,
  };
  const logTiming = (extra = {}) => {
    timing.totalMs = roundMs(performance.now() - requestStartedMs);
    console.log("[stationboard-timing]", {
      ...timing,
      ...extra,
    });
  };
  // Request budget: prevents optional phases (sparse retry, scope fallback, alerts)
  // from chaining into a 504. Budget = min(STATIONBOARD_ROUTE_TIMEOUT_MS, 5000).
  // Each optional phase checks remaining budget; if low, degrades to static-only (200).
  const totalBudgetMs = Math.min(
    Math.max(100, Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || "6500")),
    5000
  );
  const LOW_BUDGET_THRESHOLD_MS = 400;
  let degradedMode = false;
  const degradedReasons = [];
  const budgetLeft = () => totalBudgetMs - (performance.now() - requestStartedMs);
  const isBudgetLow = () => budgetLeft() < LOW_BUDGET_THRESHOLD_MS;
  const debugLog = createStationboardDebugLogger({
    enabled: debugEnabled,
    requestId,
    scope: "api/stationboard",
  });
  const debugState = {
    requestId,
    stopResolution: {},
    timeWindow: null,
    rowSources: [],
    stageCounts: [],
    langPrefs: [],
    flags: [],
    warnings: [],
    version: null,
    rtTripUpdates: null,
    alertsCache: null,
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
      debugRtMode: rtDebugMode,
      langPrefs,
    },
  });

  const requestedStopIdInput = String(stopId || stationId || "").trim();
  let stopIdForResolve = String(stopId || "").trim();
  const preValidation = {
    requestedStopId: requestedStopIdInput || null,
    existsInStaticDb: null,
    fallbackApplied: null,
  };

  if (requestedStopIdInput) {
    let requestedRows = [];
    try {
      requestedRows = await fetchStopRowsByIds([requestedStopIdInput]);
    } catch (err) {
      debugLog("stop_pre_validation_error", {
        stopId: requestedStopIdInput,
        message: String(err?.message || err),
      });
    }
    preValidation.existsInStaticDb = requestedRows.length > 0;

    if (requestedRows.length === 0) {
      if (isParentIdLike(requestedStopIdInput)) {
        const err = new Error("stop_not_found");
        err.code = "stop_not_found";
        err.status = 404;
        err.tried = [requestedStopIdInput];
        err.details = {
          reason: "parent_stop_id_not_found_in_static_db",
          requestedStopId: requestedStopIdInput,
        };
        throw err;
      }

      if (isPlatformLike(requestedStopIdInput)) {
        const parentRow = await findParentRowForChildLikeInput(requestedStopIdInput).catch(
          () => null
        );
        if (parentRow?.stop_id) {
          stopIdForResolve = String(parentRow.stop_id).trim();
          preValidation.fallbackApplied = "input_not_found_fallback_to_parent";
          debugState.flags.push("resolution:fallback_to_parent_before_resolve");
        }
      }
    }
  }

  const resolveStartedMs = performance.now();
  const resolved = await resolveStop(
    {
      stop_id: stopIdForResolve || stopId,
      stationId,
      stationName,
    },
    {
      db: { query: dbQuery },
    }
  );
  timing.resolveStopMs = roundMs(performance.now() - resolveStartedMs);

  const locationId = String(resolved?.canonical?.id || "").trim();
  if (!locationId) {
    const err = new Error("unknown_stop");
    err.code = "unknown_stop";
    err.status = 400;
    err.tried = Array.isArray(resolved?.tried) ? resolved.tried : [];
    logTiming({ outcome: "unknown_stop" });
    throw err;
  }

  const requestedInputIds = uniqueStopIds([stopId, stationId]);
  let resolutionMatchedRows = [];
  if (debugEnabled) {
    const resolutionProbeIds = uniqueStopIds([
      ...requestedInputIds,
      locationId,
      ...(resolved?.children || []).map((child) => child?.id),
    ]);
    try {
      resolutionMatchedRows = await fetchStopRowsByIds(resolutionProbeIds);
    } catch (err) {
      debugLog("stop_resolution_probe_error", {
        message: String(err?.message || err),
      });
    }
    debugLog("stop_resolution_chain", {
      requestedStopId: String(stopId || ""),
      requestedStationId: String(stationId || ""),
      canonicalStopId: locationId,
      tried: Array.isArray(resolved?.tried) ? resolved.tried : [],
      matchedRows: resolutionMatchedRows,
    });
  }

  const boundedLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
  const requestedWindow = Number(windowMinutes);
  const baseWindowMinutes =
    Number.isFinite(requestedWindow) && requestedWindow > 0
      ? Math.max(30, Math.min(Math.trunc(requestedWindow), 720))
      : DEFAULT_STATIONBOARD_WINDOW_MINUTES;
  const sparseRetryMin = Math.max(
    0,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_MIN_DEPS || "2")
  );
  const sparseRetryWindowMinutes = Math.max(
    baseWindowMinutes,
    Number(process.env.STATIONBOARD_SPARSE_RETRY_WINDOW_MINUTES || "360")
  );
  const resolvedScope = {
    stationGroupId: locationId,
    stationName:
      String(resolved?.displayName || resolved?.canonical?.name || stationName || locationId).trim() ||
      locationId,
    childStops: Array.isArray(resolved?.children) ? resolved.children : [],
  };
  const alertsPromise = includeAlertsApplied
    ? loadAlertsFromCacheThrottled({
        nowMs: Date.now(),
      })
    : null;
  const buildOptionsBase = {
    limit: boundedLimit,
    windowMinutes: baseWindowMinutes,
    debug: debugEnabled,
    rtDebugMode,
    requestId,
    resolvedScope,
    debugLog: (event, payload) => {
      debugLog(event, payload);
    },
  };
  const buildStartedMs = performance.now();
  let board = await buildStationboard(locationId, buildOptionsBase);
  timing.buildStationboardMs = roundMs(performance.now() - buildStartedMs);
  if (
    sparseRetryMin > 0 &&
    Array.isArray(board?.departures) &&
    board.departures.length < sparseRetryMin &&
    sparseRetryWindowMinutes > baseWindowMinutes
  ) {
    if (isBudgetLow()) {
      // Budget low: skip sparse retry to preserve response time
      degradedMode = true;
      degradedReasons.push("sparse_retry_skipped_budget");
    } else {
      timing.sparseRetryTriggered = true;
      const sparseRetryStartedMs = performance.now();
      const expanded = await buildStationboard(locationId, {
        ...buildOptionsBase,
        windowMinutes: sparseRetryWindowMinutes,
      });
      timing.sparseRetryMs = roundMs(performance.now() - sparseRetryStartedMs);
      if ((expanded?.departures?.length || 0) > (board?.departures?.length || 0)) {
        board = expanded;
      }
    }
  }

  const initialScheduledRowCount = sumScheduledRows(board);
  if ((board?.departures?.length || 0) === 0) {
    if (isBudgetLow()) {
      // TEMP/EMERGENCY: skip stop-scope fallback — budget exhausted
      degradedMode = true;
      degradedReasons.push("scope_fallback_skipped_budget");
    } else {
      const canonicalIsParent = String(resolved?.canonical?.kind || "").trim() === "parent";
      const childIds = uniqueStopIds((resolved?.children || []).map((child) => child?.id));
      if (canonicalIsParent && childIds.length > 0) {
        const childrenScoped = await buildStationboard(locationId, {
          ...buildOptionsBase,
          scopeQueryMode: "children_only",
        });
        const childRowCount = sumScheduledRows(childrenScoped);
        if ((childrenScoped?.departures?.length || 0) > 0 || childRowCount > 0) {
          board = childrenScoped;
          debugState.flags.push("resolution:fallback_to_children");
        } else {
          debugState.flags.push("resolution:children_fallback_empty");
        }
      } else if (!canonicalIsParent) {
        const parentScoped = await buildStationboard(locationId, {
          ...buildOptionsBase,
          scopeQueryMode: "parent_only",
        });
        const parentRowCount = sumScheduledRows(parentScoped);
        if ((parentScoped?.departures?.length || 0) > 0 || parentRowCount > 0) {
          board = parentScoped;
          debugState.flags.push("resolution:fallback_to_parent");
        } else {
          debugState.flags.push("resolution:parent_fallback_empty");
        }
      }
    }
  }

  const departures = Array.isArray(board?.departures) ? board.departures : [];
  const scopeStartedMs = performance.now();
  const scopeStopIds = uniqueStopIds([
    ...(resolved?.children || []).map((child) => child?.id),
    ...(Array.isArray(board?.debugMeta?.stops?.queryStopIds)
      ? board.debugMeta.stops.queryStopIds
      : []),
  ]);
  timing.scopeStopIdsMs = roundMs(performance.now() - scopeStartedMs);
  const canonicalName =
    String(resolved?.displayName || resolved?.canonical?.name || stationName || "").trim() ||
    String(board?.station?.name || locationId).trim();
  const rowSources = Array.isArray(board?.debugMeta?.rowSources) ? board.debugMeta.rowSources : [];
  debugState.rowSources = rowSources;
  debugState.rtTripUpdates = board?.debugMeta?.rtTripUpdates || null;
  const rtResponseMeta = buildRtResponseMeta(debugState.rtTripUpdates);
  let alertsResponseMeta = buildAlertsResponseMeta({
    includeAlertsRequested,
    includeAlertsApplied,
    reason: includeAlertsApplied
      ? "missing_cache"
      : alertsFeatureEnabled
        ? "not_requested"
        : "disabled",
  });
  const scheduledRowCount = rowSources.reduce(
    (acc, source) => acc + (Number(source?.rowCount) || 0),
    0
  );
  const finalDeparturesForReason = Array.isArray(board?.departures) ? board.departures.length : 0;
  if (finalDeparturesForReason === 0) {
    if (initialScheduledRowCount === 0 && debugState.flags.includes("resolution:fallback_to_children")) {
      debugState.flags.push("resolution:resolved_by_children_scope");
    } else if (initialScheduledRowCount === 0 && debugState.flags.includes("resolution:fallback_to_parent")) {
      debugState.flags.push("resolution:resolved_by_parent_scope");
    } else {
      debugState.flags.push("resolution:no_service_in_time_window");
    }
  }

  debugState.stopResolution = {
    requestedStopId: String(stopId || stationId || ""),
    requestedInputIds,
    canonicalId: locationId,
    preValidation,
    tried: Array.isArray(resolved?.tried) ? resolved.tried : [],
    matchedRows: resolutionMatchedRows,
    resolvedChildren: (resolved?.children || []).map((child) => child?.id).filter(Boolean),
    scopeStopIds,
    queryStopIds: Array.isArray(board?.debugMeta?.stops?.queryStopIds)
      ? board.debugMeta.stops.queryStopIds
      : [],
  };
  if (debugEnabled) {
    debugLog("stationboard_sql_scope", {
      queryStopIds: debugState.stopResolution.queryStopIds,
      rowSources,
      scheduledRowCount,
    });
  }
  debugState.timeWindow = board?.debugMeta?.timeWindow || null;
  debugLog("resolved_scope", {
    stopResolution: debugState.stopResolution,
    timeWindow: debugState.timeWindow,
  });
  if (debugEnabled) {
    const versionInfo = await fetchVersionSkewDebugInfo().catch(() => null);
    debugState.version = versionInfo;
    if (versionInfo?.hasSkew) {
      debugState.warnings.push({
        code: "static_rt_version_skew",
        staticVersion: versionInfo.staticVersion,
        rtVersion: versionInfo.rtVersion,
      });
    }
  }

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
    rt: rtResponseMeta,
    alerts: alertsResponseMeta,
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
  if (baseResponse.departures.length === 0) {
    const noServiceReason = debugState.flags.includes("resolution:resolved_by_children_scope")
      ? "parent_child_scope_mismatch"
      : debugState.flags.includes("resolution:resolved_by_parent_scope")
        ? "child_parent_scope_mismatch"
        : "no_service_in_time_window";
    baseResponse.noService = {
      reason: noServiceReason,
      window: debugState.timeWindow,
    };
  }
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
      includeDelayDebug: debugEnabled,
    });
    if (debugEnabled) {
      const departureAudit = buildDepartureAudit(baseResponse.departures);
      baseResponse.debug = {
        requestId,
        instanceId: INSTANCE_ID,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        rowSources: debugState.rowSources,
        stageCounts: debugState.stageCounts,
        langPrefs,
        flags: debugState.flags,
        warnings: debugState.warnings,
        version: debugState.version,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
        rt: {
          tripUpdates: toRtTripUpdatesDebug(debugState.rtTripUpdates, departureAudit),
        },
        departureAudit,
        latencySafe: {
          degradedMode,
          degradedReasons,
          totalBudgetMs,
          sparseRetryRan: timing.sparseRetryTriggered,
          config: {
            routeTimeoutMs: Math.max(100, Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || "6500")),
            sparseRetryMinDeps: sparseRetryMin,
            defaultWindowMinutes: DEFAULT_STATIONBOARD_WINDOW_MINUTES,
            mainQueryTimeoutMs: Math.max(400, Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "3500")),
            fallbackQueryTimeoutMs: Math.max(250, Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "1200")),
            stopScopeQueryTimeoutMs: Math.max(150, Number(process.env.STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS || "800")),
            alertsEnabled: alertsFeatureEnabled,
          },
        },
      };
    }
    logTiming({
      outcome: "ok_no_alerts",
      departures: baseResponse.departures.length,
      buildTimings: board?.debugMeta?.timings || null,
    });
    return baseResponse;
  }

  // TEMP/EMERGENCY: if budget is exhausted before awaiting alerts, return static-only (200).
  if (isBudgetLow()) {
    degradedMode = true;
    degradedReasons.push("alerts_skipped_budget");
    baseResponse.departures = canonicalizeDepartures(baseResponse.departures, {
      stopId: locationId,
      debugLog,
      debugState,
      includeDelayDebug: debugEnabled,
    });
    if (debugEnabled) {
      const departureAudit = buildDepartureAudit(baseResponse.departures);
      baseResponse.debug = {
        requestId,
        instanceId: INSTANCE_ID,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        rowSources: debugState.rowSources,
        stageCounts: debugState.stageCounts,
        langPrefs,
        flags: debugState.flags,
        warnings: debugState.warnings,
        version: debugState.version,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
        rt: {
          tripUpdates: toRtTripUpdatesDebug(debugState.rtTripUpdates, departureAudit),
        },
        departureAudit,
        latencySafe: {
          degradedMode,
          degradedReasons,
          totalBudgetMs,
          sparseRetryRan: timing.sparseRetryTriggered,
          config: {
            routeTimeoutMs: Math.max(100, Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || "6500")),
            sparseRetryMinDeps: sparseRetryMin,
            defaultWindowMinutes: DEFAULT_STATIONBOARD_WINDOW_MINUTES,
            mainQueryTimeoutMs: Math.max(400, Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "3500")),
            fallbackQueryTimeoutMs: Math.max(250, Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "1200")),
            stopScopeQueryTimeoutMs: Math.max(150, Number(process.env.STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS || "800")),
            alertsEnabled: alertsFeatureEnabled,
          },
        },
      };
    }
    logTiming({
      outcome: "ok_budget_exhausted_no_alerts",
      departures: baseResponse.departures.length,
      buildTimings: board?.debugMeta?.timings || null,
    });
    return baseResponse;
  }

  try {
    const alertsWaitStartedMs = performance.now();
    const alertsLoadResult = (await alertsPromise) || {
      alerts: { entities: [] },
      meta: { reason: "missing_cache" },
    };
    const alertsRaw = alertsLoadResult?.alerts || { entities: [] };
    debugState.alertsCache = {
      servedFromCache:
        String(alertsLoadResult?.meta?.requestCacheStatus || "").trim().toUpperCase() === "HIT",
      cacheStatus:
        String(alertsLoadResult?.meta?.requestCacheStatus || "").trim().toUpperCase() ||
        "MISS",
      fetchedAt:
        String(
          alertsLoadResult?.meta?.requestCacheFetchedAt || alertsLoadResult?.meta?.fetchedAt || ""
        ).trim() || null,
      ttlSeconds: Math.round(
        Math.max(
          1_000,
          Number(alertsLoadResult?.meta?.requestCacheTtlMs || STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS)
        ) / 1000
      ),
    };
    alertsResponseMeta = buildAlertsResponseMeta({
      includeAlertsRequested,
      includeAlertsApplied,
      reason: "missing_cache",
      alertsMeta: alertsLoadResult?.meta,
    });
    baseResponse.alerts = alertsResponseMeta;
    timing.alertsWaitMs = roundMs(performance.now() - alertsWaitStartedMs);
    const alertsMergeStartedMs = performance.now();
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
    const alerts = filterLocalizedAlertsByScope(localizeServiceAlerts(alertsRaw, langPrefs), {
      stopId: locationId,
      scopeStopIds,
      routeIds,
      tripIds,
    });

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
      const supplementStartedMs = performance.now();
      const supplement = await getOtdReplacementSupplementCached({
        stopId: locationId,
        stationName: canonicalName,
        now: new Date(),
        windowMinutes: baseWindowMinutes,
        limit: boundedLimit,
      });
      timing.supplementMs = roundMs(performance.now() - supplementStartedMs);
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
    timing.alertsMergeMs = roundMs(performance.now() - alertsMergeStartedMs);
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
        includeDelayDebug: debugEnabled,
      }),
    };
    if (debugEnabled) {
      const departureAudit = buildDepartureAudit(response.departures);
      response.debug = {
        requestId,
        instanceId: INSTANCE_ID,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        rowSources: debugState.rowSources,
        stageCounts: debugState.stageCounts,
        langPrefs,
        flags: debugState.flags,
        warnings: debugState.warnings,
        version: debugState.version,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
        rt: {
          tripUpdates: toRtTripUpdatesDebug(debugState.rtTripUpdates, departureAudit),
        },
        alertsCache: debugState.alertsCache,
        departureAudit,
        latencySafe: {
          degradedMode,
          degradedReasons,
          totalBudgetMs,
          sparseRetryRan: timing.sparseRetryTriggered,
          config: {
            routeTimeoutMs: Math.max(100, Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || "6500")),
            sparseRetryMinDeps: sparseRetryMin,
            defaultWindowMinutes: DEFAULT_STATIONBOARD_WINDOW_MINUTES,
            mainQueryTimeoutMs: Math.max(400, Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "3500")),
            fallbackQueryTimeoutMs: Math.max(250, Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "1200")),
            stopScopeQueryTimeoutMs: Math.max(150, Number(process.env.STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS || "800")),
            alertsEnabled: alertsFeatureEnabled,
          },
        },
      };
    }
    logTiming({
      outcome: "ok_with_alerts",
      departures: response.departures.length,
      banners: Array.isArray(response?.banners) ? response.banners.length : 0,
      buildTimings: board?.debugMeta?.timings || null,
    });
    return response;
  } catch (err) {
    const response = {
      ...baseResponse,
      banners: [],
      departures: canonicalizeDepartures(baseResponse.departures, {
        stopId: locationId,
        debugLog,
        debugState,
        includeDelayDebug: debugEnabled,
      }),
    };
    if (process.env.NODE_ENV !== "production") {
      response.debug = {
        ...(response.debug || {}),
        alerts_error: String(err?.message || err),
      };
    }
    if (debugEnabled) {
      const departureAudit = buildDepartureAudit(response.departures);
      response.debug = {
        ...(response.debug || {}),
        requestId,
        instanceId: INSTANCE_ID,
        stopResolution: debugState.stopResolution,
        timeWindow: debugState.timeWindow,
        rowSources: debugState.rowSources,
        stageCounts: debugState.stageCounts,
        langPrefs,
        flags: debugState.flags,
        warnings: debugState.warnings,
        version: debugState.version,
        includeAlertsRequested,
        includeAlertsApplied,
        includeAlerts: includeAlertsApplied,
        requestedIncludeAlerts: includeAlertsRequested,
        alertsFeatureEnabled,
        rt: {
          tripUpdates: toRtTripUpdatesDebug(debugState.rtTripUpdates, departureAudit),
        },
        alertsCache: debugState.alertsCache,
        departureAudit,
        latencySafe: {
          degradedMode,
          degradedReasons,
          totalBudgetMs,
          sparseRetryRan: timing.sparseRetryTriggered,
          config: {
            routeTimeoutMs: Math.max(100, Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || "6500")),
            sparseRetryMinDeps: sparseRetryMin,
            defaultWindowMinutes: DEFAULT_STATIONBOARD_WINDOW_MINUTES,
            mainQueryTimeoutMs: Math.max(400, Number(process.env.STATIONBOARD_MAIN_QUERY_TIMEOUT_MS || "3500")),
            fallbackQueryTimeoutMs: Math.max(250, Number(process.env.STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS || "1200")),
            stopScopeQueryTimeoutMs: Math.max(150, Number(process.env.STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS || "800")),
            alertsEnabled: alertsFeatureEnabled,
          },
        },
      };
    }
    logTiming({
      outcome: "alerts_fallback",
      departures: response.departures.length,
      error: String(err?.message || err),
      buildTimings: board?.debugMeta?.timings || null,
    });
    return response;
  }
}
