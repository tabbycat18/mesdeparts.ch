import { performance } from "node:perf_hooks";
import os from "node:os";

const DEFAULT_STATIONBOARD_ROUTE_TIMEOUT_MS = 6500;
const DEFAULT_STATIONBOARD_STALE_CACHE_MS = 90000;
const DEFAULT_RT_FRESHNESS_THRESHOLD_MS = Math.max(
  5_000,
  Number(process.env.STATIONBOARD_RT_FRESH_MAX_AGE_MS || "45000")
);
const DEFAULT_RT_FEED_KEY = "la_tripupdates";
const DEFAULT_200_CDN_CACHE_CONTROL = "public, max-age=12, stale-while-revalidate=24";
const DEFAULT_204_CDN_CACHE_CONTROL = "public, max-age=2, stale-while-revalidate=4";
const ROUTE_INSTANCE_ID = String(process.env.FLY_ALLOC_ID || os.hostname() || "local").trim();
const ROUTE_BUILD = String(
  process.env.APP_VERSION ||
    process.env.RELEASE_VERSION ||
    process.env.FLY_IMAGE_REF ||
    process.env.GIT_SHA ||
    "dev"
)
  .trim()
  .slice(0, 32);
const stationboardResponseCache = new Map();

function stationboardRouteTimeoutMs() {
  return Math.max(
    100,
    Number(process.env.STATIONBOARD_ROUTE_TIMEOUT_MS || String(DEFAULT_STATIONBOARD_ROUTE_TIMEOUT_MS))
  );
}

function stationboardStaleCacheMs() {
  return Math.max(
    5_000,
    Number(process.env.STATIONBOARD_STALE_CACHE_MS || String(DEFAULT_STATIONBOARD_STALE_CACHE_MS))
  );
}

function text(value) {
  return String(value || "").trim();
}

function normalizeIdentity(value) {
  return text(value).toLowerCase();
}

function parseBooleanish(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function parseSinceRtMs(raw) {
  const value = text(raw);
  if (!value) return { ok: true, ms: null, raw: "" };

  if (/^\d{12,16}$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return { ok: true, ms: Math.trunc(num), raw: value };
    }
  }

  const parsedMs = Date.parse(value);
  if (Number.isFinite(parsedMs) && parsedMs > 0) {
    return { ok: true, ms: Math.trunc(parsedMs), raw: value };
  }

  return { ok: false, ms: null, raw: value };
}

function toIsoOrNull(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
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

function setResponseHeader(res, key, value) {
  if (!res || !key) return;
  const val = String(value);
  if (typeof res.setHeader === "function") {
    res.setHeader(key, val);
    return;
  }
  if (typeof res.set === "function") {
    res.set(key, val);
    return;
  }
  if (res.headers && typeof res.headers === "object") {
    res.headers[key] = val;
  }
}

function appendVaryHeader(res, ...tokens) {
  const values = (Array.isArray(tokens) ? tokens : [])
    .flatMap((token) => String(token || "").split(","))
    .map((token) => token.trim())
    .filter(Boolean);
  if (!values.length) return;
  const existingRaw = typeof res?.getHeader === "function" ? res.getHeader("Vary") : "";
  const existing = String(existingRaw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...values]));
  if (!merged.length) return;
  setResponseHeader(res, "Vary", merged.join(", "));
}

function toFiniteNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalRtReason(rawReason, applied) {
  if (applied === true) return "fresh";
  const reason = text(rawReason).toLowerCase();
  if (!reason) return "missing";
  if (reason === "applied" || reason === "fresh" || reason === "fresh_cache") return "fresh";
  if (reason.includes("stale")) return "stale";
  if (reason === "disabled") return "disabled";
  if (reason.includes("guard") || reason.includes("decode") || reason.includes("error")) return "guarded";
  if (reason.includes("missing")) return "missing";
  return "guarded";
}

function routeInstanceMeta(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = text(src.id) || ROUTE_INSTANCE_ID || `${os.hostname()}:${process.pid}`;
  return {
    id,
    allocId: text(src.allocId) || text(process.env.FLY_ALLOC_ID) || null,
    host: text(src.host) || text(os.hostname()) || "localhost",
    pid: Number.isFinite(Number(src.pid)) ? Number(src.pid) : process.pid,
    build: text(src.build) || ROUTE_BUILD || "dev",
  };
}

function ensureRtMeta(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const applied = src.applied === true;
  const reason = canonicalRtReason(text(src.reason), applied);
  const fetchedAt = text(src.cacheFetchedAt) || text(src.fetchedAt) || null;
  const ageMs =
    toFiniteNumberOrNull(src.cacheAgeMs) ??
    (toFiniteNumberOrNull(src.ageSeconds) != null
      ? Math.max(0, Math.round(Number(src.ageSeconds) * 1000))
      : null);
  const freshnessThresholdMs = Math.max(
    5_000,
    toFiniteNumberOrNull(src.freshnessThresholdMs) ??
      (toFiniteNumberOrNull(src.freshnessMaxAgeSeconds) != null
        ? Math.round(Number(src.freshnessMaxAgeSeconds) * 1000)
        : DEFAULT_RT_FRESHNESS_THRESHOLD_MS)
  );
  return {
    available: src.available === true || applied,
    applied,
    reason,
    feedKey: text(src.feedKey) || DEFAULT_RT_FEED_KEY,
    fetchedAt,
    cacheFetchedAt: fetchedAt,
    cacheAgeMs: ageMs,
    ageMs,
    ageSeconds:
      toFiniteNumberOrNull(src.ageSeconds) ??
      (ageMs != null ? Math.max(0, Math.floor(ageMs / 1000)) : null),
    freshnessThresholdMs,
    freshnessMaxAgeSeconds: Math.round(freshnessThresholdMs / 1000),
    cacheStatus: text(src.cacheStatus) || (applied ? "FRESH" : "MISS"),
    status: toFiniteNumberOrNull(src.status) ?? toFiniteNumberOrNull(src.lastStatus),
    lastStatus: toFiniteNumberOrNull(src.lastStatus),
    lastError: text(src.lastError) || null,
    payloadBytes: toFiniteNumberOrNull(src.payloadBytes),
    instance: routeInstanceMeta(src.instance),
  };
}

function ensureAlertsMeta(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    available: src.available === true,
    applied: src.applied === true,
    reason: text(src.reason) || "disabled",
    fetchedAt: text(src.fetchedAt) || null,
    ageSeconds: toFiniteNumberOrNull(src.ageSeconds),
    includeRequested: src.includeRequested === true,
    includeApplied: src.includeApplied === true,
  };
}

function ensureStationboardMetaPayload(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  return {
    ...src,
    departures: Array.isArray(src.departures) ? src.departures : [],
    rt: ensureRtMeta(src.rt),
    alerts: ensureAlertsMeta(src.alerts),
  };
}

function applyRtDiagnosticHeaders(res, payload, { cacheKey = "" } = {}) {
  const rt = payload?.rt && typeof payload.rt === "object" ? payload.rt : ensureRtMeta();
  const applied = rt.applied === true ? "1" : "0";
  const reason = canonicalRtReason(rt.reason, rt.applied === true);
  const ageMs = toFiniteNumberOrNull(rt.cacheAgeMs);
  const fetchedAt = text(rt.cacheFetchedAt) || text(rt.fetchedAt) || "";
  const status = toFiniteNumberOrNull(rt.status) ?? toFiniteNumberOrNull(rt.lastStatus);
  const instanceId = text(rt.instance?.id) || ROUTE_INSTANCE_ID || `${os.hostname()}:${process.pid}`;
  setResponseHeader(res, "x-md-rt-applied", applied);
  setResponseHeader(res, "x-md-rt-reason", reason);
  setResponseHeader(res, "x-md-rt-age-ms", ageMs == null ? "-1" : String(Math.max(0, Math.round(ageMs))));
  setResponseHeader(res, "x-md-rt-fetched-at", fetchedAt || "");
  setResponseHeader(res, "x-md-rt-status", status == null ? "" : String(status));
  setResponseHeader(res, "x-md-instance", instanceId);
  if (cacheKey) setResponseHeader(res, "x-md-cache-key", cacheKey);
}

function withTimeout(promise, timeoutMs, code = "timeout") {
  const effectiveTimeoutMs = Math.max(100, Math.trunc(Number(timeoutMs) || 0));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(code);
      err.code = code;
      reject(err);
    }, effectiveTimeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function emitStationboardDecisionLog(logger, payload = {}) {
  logger?.log?.("[API] /api/stationboard decision", payload);
}

async function defaultGetRtCacheMeta(feedKey) {
  const mod = await import("../db/rtCache.js");
  return mod.getRtCacheMeta(feedKey);
}

function cacheKeyForRequest({
  stopId,
  stationId,
  stationName,
  lang,
  limit,
  windowMinutes,
  includeAlerts,
}) {
  return [
    text(stopId),
    text(stationId),
    text(stationName),
    text(lang),
    String(Number(limit) || 0),
    String(Number(windowMinutes) || 0),
    includeAlerts == null ? "auto" : includeAlerts ? "alerts1" : "alerts0",
  ].join("|");
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function readCachedStationboard(key) {
  const item = stationboardResponseCache.get(key);
  if (!item || !item.payload) return null;
  const ageMs = Date.now() - Number(item.ts || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > stationboardStaleCacheMs()) {
    stationboardResponseCache.delete(key);
    return null;
  }
  return cloneJson(item.payload);
}

function storeCachedStationboard(key, payload) {
  if (!key || !payload || typeof payload !== "object") return;
  stationboardResponseCache.set(key, {
    ts: Date.now(),
    payload: cloneJson(payload),
  });
  if (stationboardResponseCache.size > 100) {
    const oldest = stationboardResponseCache.keys().next().value;
    if (oldest) stationboardResponseCache.delete(oldest);
  }
}

export function deriveResolvedIdentity(resolved) {
  const resolvedStopId =
    text(resolved?.resolvedStopId) || text(resolved?.canonical?.id) || text(resolved?.id) || null;
  const resolvedRootId =
    text(resolved?.resolvedRootId) || text(resolved?.rootId) || resolvedStopId || null;

  return {
    resolvedStopId,
    resolvedRootId,
  };
}

async function resolveIdentityForInput({ stop_id, stationId, stationName }, deps) {
  const stopId = text(stop_id);
  const sid = text(stationId);
  if (!stopId && !sid) return null;

  const { resolveStopLike, dbQueryLike } = deps || {};
  if (typeof resolveStopLike !== "function") return null;

  try {
    const resolved = await resolveStopLike(
      {
        stop_id: stopId || undefined,
        stationId: sid || undefined,
        stationName: text(stationName) || undefined,
      },
      {
        db: {
          query: typeof dbQueryLike === "function" ? dbQueryLike : async () => ({ rows: [] }),
        },
      }
    );
    return deriveResolvedIdentity(resolved);
  } catch (err) {
    if (
      err?.code === "unknown_stop" ||
      err?.code === "stop_not_found" ||
      Number(err?.status) === 400 ||
      Number(err?.status) === 404
    ) {
      return null;
    }
    throw err;
  }
}

async function detectStopParamConflict({ stopId, stationId, stationName }, deps) {
  const lhs = await resolveIdentityForInput(
    { stop_id: stopId, stationName },
    deps
  );
  const rhs = await resolveIdentityForInput(
    { stationId, stationName },
    deps
  );

  if (!lhs?.resolvedRootId || !rhs?.resolvedRootId) {
    return {
      hasConflict: false,
      stopIdIdentity: lhs,
      stationIdIdentity: rhs,
    };
  }

  const hasConflict =
    normalizeIdentity(lhs.resolvedRootId) !== normalizeIdentity(rhs.resolvedRootId);

  return {
    hasConflict,
    stopIdIdentity: lhs,
    stationIdIdentity: rhs,
  };
}

export function createStationboardRouteHandler({
  getStationboardLike,
  getRtCacheMetaLike = defaultGetRtCacheMeta,
  resolveStopLike,
  dbQueryLike,
  logger = console,
} = {}) {
  if (typeof getStationboardLike !== "function") {
    throw new Error("createStationboardRouteHandler requires getStationboardLike");
  }

  return async function stationboardRouteHandler(req, res) {
    const routeStartedMs = performance.now();
    const requestId =
      text(req.headers["x-md-request-id"]) ||
      text(req.headers["x-request-id"]) ||
      randomRequestId();
    let debug = false;
    setResponseHeader(res, "x-md-request-id", requestId);
    setResponseHeader(res, "Cache-Control", "public, max-age=0, must-revalidate");
    setResponseHeader(
      res,
      "CDN-Cache-Control",
      DEFAULT_200_CDN_CACHE_CONTROL
    );
    appendVaryHeader(res, "Origin", "Accept-Encoding");
    setResponseHeader(res, "x-md-instance", ROUTE_INSTANCE_ID);
    try {
      const stopIdRaw = text(req.query.stop_id);
      const stationIdCamelRaw = text(req.query.stationId);
      const stationIdSnakeRaw = text(req.query.station_id);
      const stationIdRaw = stationIdCamelRaw || stationIdSnakeRaw;
      const effectiveStopId = stopIdRaw || stationIdRaw;
      const stationName = text(req.query.stationName);
      const lang = text(req.query.lang);
      const limit = Number(req.query.limit || "300");
      const windowMinutes = Number(req.query.window_minutes || "0");
      debug = parseBooleanish(req.query.debug) === true;
      const debugRt = text(req.query.debug_rt).toLowerCase();
      const includeAlertsParsed = parseBooleanish(
        req.query.include_alerts ?? req.query.includeAlerts
      );
      const sinceRtParsed = parseSinceRtMs(req.query.since_rt);
      if (!sinceRtParsed.ok) {
        setResponseHeader(
          res,
          "x-md-backend-total-ms",
          String(roundMs(performance.now() - routeStartedMs))
        );
        return res.status(400).json({
          error: {
            code: "invalid_since_rt",
            message: "since_rt must be ISO timestamp or epoch ms",
          },
        });
      }
      const sinceRtMs = sinceRtParsed.ms;
      const responseCacheKey = cacheKeyForRequest({
        stopId: effectiveStopId,
        stationId: stationIdRaw,
        stationName,
        lang,
        limit,
        windowMinutes,
        includeAlerts: includeAlertsParsed,
      });
      setResponseHeader(res, "x-md-cache-key", responseCacheKey);

      logger?.log?.("[API] /api/stationboard params", {
        requestId,
        stopId: stopIdRaw,
        stationId: stationIdRaw,
        stationName,
        lang,
        limit,
        windowMinutes,
        debug,
        debugRt,
        includeAlerts: includeAlertsParsed,
        sinceRt: sinceRtParsed.raw || null,
        sinceRtMs,
      });

      if (!effectiveStopId) {
        setResponseHeader(
          res,
          "x-md-backend-total-ms",
          String(roundMs(performance.now() - routeStartedMs))
        );
        return res.status(400).json({
          error: "missing_stop_id",
          expected: ["stop_id", "stationId"],
        });
      }

      if (stopIdRaw && stationIdRaw) {
        const conflict = await detectStopParamConflict(
          {
            stopId: stopIdRaw,
            stationId: stationIdRaw,
            stationName,
          },
          { resolveStopLike, dbQueryLike }
        );

        if (conflict.hasConflict) {
          setResponseHeader(
            res,
            "x-md-backend-total-ms",
            String(roundMs(performance.now() - routeStartedMs))
          );
          return res.status(400).json({
            error: "conflicting_stop_id",
            detail: "stop_id and stationId/station_id resolve to different canonical roots",
            precedence: "stop_id",
            received: {
              stop_id: stopIdRaw,
              stationId: stationIdRaw,
            },
            resolved: {
              stop_id: {
                stop: conflict.stopIdIdentity?.resolvedStopId || null,
                root: conflict.stopIdIdentity?.resolvedRootId || null,
              },
              stationId: {
                stop: conflict.stationIdIdentity?.resolvedStopId || null,
                root: conflict.stationIdIdentity?.resolvedRootId || null,
              },
            },
          });
        }
      }

      const rtCacheMeta = await Promise.resolve(
        typeof getRtCacheMetaLike === "function"
          ? getRtCacheMetaLike(DEFAULT_RT_FEED_KEY)
          : null
      ).catch((err) => {
        logger?.warn?.("[API] /api/stationboard rt_cache meta read failed", {
          requestId,
          error: String(err?.message || err),
        });
        return null;
      });
      const nowMs = Date.now();
      const rtFetchedAtMs = rtCacheMeta?.fetched_at
        ? Number(new Date(rtCacheMeta.fetched_at).getTime())
        : null;
      const rtFetchedAtIso = toIsoOrNull(rtFetchedAtMs);
      const rtAgeMs =
        Number.isFinite(rtFetchedAtMs) && rtFetchedAtMs > 0
          ? Math.max(0, nowMs - rtFetchedAtMs)
          : null;
      const rtStatus =
        toFiniteNumberOrNull(rtCacheMeta?.last_status) ??
        (rtCacheMeta?.has_payload ? 200 : null);
      const hasRtSnapshot =
        Number.isFinite(rtFetchedAtMs) && rtFetchedAtMs > 0;

      if (
        Number.isFinite(sinceRtMs) &&
        hasRtSnapshot &&
        Number.isFinite(rtFetchedAtMs) &&
        rtFetchedAtMs <= sinceRtMs
      ) {
        setResponseHeader(res, "CDN-Cache-Control", DEFAULT_204_CDN_CACHE_CONTROL);
        setResponseHeader(res, "x-md-rt-applied", "0");
        setResponseHeader(res, "x-md-rt-reason", "unchanged_since_rt");
        setResponseHeader(res, "x-md-rt-fetched-at", rtFetchedAtIso || "");
        setResponseHeader(
          res,
          "x-md-rt-age-ms",
          rtAgeMs == null ? "-1" : String(Math.max(0, Math.round(rtAgeMs)))
        );
        setResponseHeader(res, "x-md-rt-status", rtStatus == null ? "" : String(rtStatus));
        setResponseHeader(
          res,
          "x-md-backend-total-ms",
          String(roundMs(performance.now() - routeStartedMs))
        );
        emitStationboardDecisionLog(logger, {
          requestId,
          stopId: effectiveStopId,
          stationId: stationIdRaw || null,
          sinceRtMs,
          rtFetchedAtMs: Number.isFinite(rtFetchedAtMs) ? rtFetchedAtMs : null,
          responded204: true,
          rtApplied: false,
          rtReason: "unchanged_since_rt",
          totalMs: roundMs(performance.now() - routeStartedMs),
        });
        if (typeof res.status === "function") {
          res.status(204);
        } else {
          res.statusCode = 204;
        }
        if (typeof res.end === "function") return res.end();
        return;
      }

      let result;
      try {
        result = await withTimeout(
          getStationboardLike({
            stopId: effectiveStopId,
            stationId: stationIdRaw,
            stationName,
            lang,
            acceptLanguage: req.headers["accept-language"],
            requestId,
            limit,
            windowMinutes,
            includeAlerts: includeAlertsParsed == null ? undefined : includeAlertsParsed,
            debug,
            debugRt: debug ? debugRt : "",
          }),
          stationboardRouteTimeoutMs(),
          "stationboard_timeout"
        );
      } catch (err) {
        if (err?.code !== "stationboard_timeout") throw err;
        const cached = readCachedStationboard(responseCacheKey);
        if (!cached) throw err;
        const normalizedCached = ensureStationboardMetaPayload(cached);
        setResponseHeader(res, "x-md-stale", "1");
        setResponseHeader(res, "x-md-stale-reason", "stationboard_timeout");
        applyRtDiagnosticHeaders(res, normalizedCached, {
          cacheKey: responseCacheKey,
        });
        setResponseHeader(
          res,
          "x-md-backend-total-ms",
          String(roundMs(performance.now() - routeStartedMs))
        );
        emitStationboardDecisionLog(logger, {
          requestId,
          stopId: effectiveStopId,
          stationId: stationIdRaw || null,
          sinceRtMs,
          rtFetchedAtMs: Number.isFinite(rtFetchedAtMs) ? rtFetchedAtMs : null,
          responded204: false,
          rtApplied: normalizedCached?.rt?.applied === true,
          rtReason: normalizedCached?.rt?.reason || null,
          totalMs: roundMs(performance.now() - routeStartedMs),
        });
        if (debug) {
          normalizedCached.debug = {
            ...(normalizedCached.debug && typeof normalizedCached.debug === "object"
              ? normalizedCached.debug
              : {}),
            cache: {
              key: responseCacheKey,
              vary: "Origin, Accept-Encoding",
              cacheControl: "public, max-age=0, must-revalidate",
              cdnCacheControl: "public, max-age=12, stale-while-revalidate=24",
            },
          };
        }
        return res.json(normalizedCached);
      }
      const normalizedResult = ensureStationboardMetaPayload(result);
      if (debug) {
        normalizedResult.debug = {
          ...(normalizedResult.debug && typeof normalizedResult.debug === "object"
            ? normalizedResult.debug
            : {}),
          cache: {
            key: responseCacheKey,
            vary: "Origin, Accept-Encoding",
            cacheControl: "public, max-age=0, must-revalidate",
            cdnCacheControl: "public, max-age=12, stale-while-revalidate=24",
          },
        };
      }
      storeCachedStationboard(responseCacheKey, normalizedResult);
      applyRtDiagnosticHeaders(res, normalizedResult, { cacheKey: responseCacheKey });
      setResponseHeader(
        res,
        "x-md-backend-total-ms",
        String(roundMs(performance.now() - routeStartedMs))
      );
      emitStationboardDecisionLog(logger, {
        requestId,
        stopId: effectiveStopId,
        stationId: stationIdRaw || null,
        sinceRtMs,
        rtFetchedAtMs: Number.isFinite(rtFetchedAtMs) ? rtFetchedAtMs : null,
        responded204: false,
        rtApplied: normalizedResult?.rt?.applied === true,
        rtReason: normalizedResult?.rt?.reason || null,
        totalMs: roundMs(performance.now() - routeStartedMs),
      });
      return res.json(normalizedResult);
    } catch (err) {
      const backendTotalMs = roundMs(performance.now() - routeStartedMs);
      setResponseHeader(res, "x-md-backend-total-ms", String(backendTotalMs));
      logger?.error?.("[API] /api/stationboard failed:", {
        requestId,
        backendTotalMs,
        error: String(err?.message || err),
      });
      emitStationboardDecisionLog(logger, {
        requestId,
        stopId: text(req?.query?.stop_id) || text(req?.query?.stationId) || null,
        stationId: text(req?.query?.stationId) || text(req?.query?.station_id) || null,
        sinceRtMs: parseSinceRtMs(req?.query?.since_rt).ms,
        rtFetchedAtMs: null,
        responded204: false,
        rtApplied: false,
        rtReason: "request_failed",
        totalMs: backendTotalMs,
      });
      if (err?.code === "stop_not_found" || Number(err?.status) === 404) {
        const payload = {
          error: "stop_not_found",
          detail: String(err?.details?.reason || "stop_id_not_found_in_static_db"),
          tried: Array.isArray(err?.tried) ? err.tried : [],
        };
        if (debug) {
          payload.debug = {
            requestId,
            details: err?.details || null,
          };
        }
        return res.status(404).json(payload);
      }
      if (err?.code === "unknown_stop" || Number(err?.status) === 400) {
        return res.status(400).json({
          error: "unknown_stop",
          tried: Array.isArray(err?.tried) ? err.tried : [],
        });
      }
      if (err?.code === "stationboard_timeout") {
        return res.status(504).json({
          error: "stationboard_timeout",
          detail: "backend_stationboard_timeout",
        });
      }
      if (process.env.NODE_ENV !== "production") {
        return res.status(500).json({
          error: "stationboard_failed",
          detail: String(err?.message || err),
        });
      }
      return res.status(500).json({ error: "stationboard_failed" });
    }
  };
}
