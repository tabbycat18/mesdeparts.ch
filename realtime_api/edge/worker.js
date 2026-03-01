/**
 * Routing map (repo-verified)
 * - This Worker handles api.mesdeparts.ch/* only.
 * - mesdeparts.ch (frontend static files) is served by Cloudflare Pages — not this Worker.
 * - All requests are proxied to RT_BACKEND_ORIGIN (Fly.io backend).
 * - Special handling for /api/stationboard: edge-cached with a 15 s TTL.
 * - /api/* routes: proxied to RT_BACKEND_ORIGIN, no edge cache.
 */

const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_GLOBAL_LIMIT_PER_DAY = 0;
const RATE_LIMIT_WINDOW_SEC = 60;
const GLOBAL_LIMIT_WINDOW_SEC = 86400;
const STATIONBOARD_CACHE_TTL_SEC = 15;
const STATIONBOARD_EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${STATIONBOARD_CACHE_TTL_SEC}`;
const STATIONBOARD_CLIENT_CACHE_CONTROL = "private, no-store, max-age=0, must-revalidate";

const addCors = (res, extraHeaders = null) => {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", "*");
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      out.headers.set(key, value);
    }
  }
  return out;
};

const getClientIp = (request) => {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  const xff = request.headers.get("X-Forwarded-For");
  if (!xff) return null;
  return xff.split(",")[0].trim() || null;
};

const parseLimit = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const isRtStationboardPath = (pathname) => {
  const path = String(pathname || "");
  return path.startsWith("/api/stationboard");
};

const isApiPath = (pathname) => {
  const path = String(pathname || "");
  return path.startsWith("/api/");
};

const shouldBypassStationboardCache = (url) => {
  return (url.searchParams.get("debug") || "") === "1";
};

const resolveRtOrigin = (env) => {
  const raw = String(env?.RT_BACKEND_ORIGIN || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const normalizeStationboardCacheKey = (requestUrl) => {
  const normalizedUrl = new URL(requestUrl.toString());
  normalizedUrl.search = "";
  const normalizedParams = new URLSearchParams();

  const stopId =
    requestUrl.searchParams.get("stop_id") ||
    requestUrl.searchParams.get("stationId") ||
    requestUrl.searchParams.get("station_id") ||
    "";
  if (stopId) normalizedParams.set("stop_id", stopId);

  const limit = requestUrl.searchParams.get("limit");
  if (limit !== null) normalizedParams.set("limit", limit);

  const windowMinutes = requestUrl.searchParams.get("window_minutes");
  if (windowMinutes !== null) normalizedParams.set("window_minutes", windowMinutes);

  const lang = requestUrl.searchParams.get("lang");
  if (lang !== null) normalizedParams.set("lang", lang);

  const includeAlertsRaw =
    requestUrl.searchParams.get("include_alerts") ?? requestUrl.searchParams.get("includeAlerts");
  if (includeAlertsRaw == null) {
    normalizedParams.set("include_alerts", "1");
  } else {
    const normalizedAlerts = String(includeAlertsRaw).trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalizedAlerts)) {
      normalizedParams.set("include_alerts", "0");
    } else if (["1", "true", "yes", "on"].includes(normalizedAlerts)) {
      normalizedParams.set("include_alerts", "1");
    } else {
      normalizedParams.set("include_alerts", String(includeAlertsRaw));
    }
  }

  normalizedUrl.search = normalizedParams.toString();
  return new Request(normalizedUrl.toString(), { method: "GET" });
};

const cacheDebugLog = (env, message, details = null) => {
  if (String(env?.WORKER_CACHE_DEBUG || "") !== "1") return;
  if (details) {
    console.log(`[worker-cache] ${message}`, details);
    return;
  }
  console.log(`[worker-cache] ${message}`);
};

const stripOriginAntiCacheHeaders = (headers) => {
  const cacheControl = String(headers.get("cache-control") || "").toLowerCase();
  if (cacheControl.includes("private") || cacheControl.includes("no-store")) {
    headers.delete("cache-control");
  }
  const pragma = String(headers.get("pragma") || "").toLowerCase();
  if (pragma.includes("no-cache")) {
    headers.delete("pragma");
  }
};

const roundMs = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(1));
};

const resolveRequestId = (request) => {
  const existing =
    request.headers.get("x-md-request-id") || request.headers.get("x-request-id") || "";
  if (existing) return existing.trim();
  if (typeof crypto?.randomUUID === "function") return `sb-${crypto.randomUUID()}`;
  return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const upstreamHeaders = (request, requestId) => {
  const out = {
    accept: "application/json",
    "x-md-request-id": requestId,
  };
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) out["accept-language"] = acceptLanguage;
  return out;
};

const logStationboardTiming = (env, details) => {
  const enabled =
    String(env?.WORKER_TIMING_LOG || "") === "1" || String(env?.WORKER_CACHE_DEBUG || "") === "1";
  if (!enabled) return;
  console.log("[worker-stationboard-timing]", details);
};

const limitBucketKey = (prefix, id, windowSec) => {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  return new Request(`https://md-rate/${prefix}/${id}/${bucket}`);
};

const checkLimit = async (cache, ctx, keyReq, windowSec, limit) => {
  if (!limit || limit <= 0) return { limited: false, remaining: null };
  const cached = await cache.match(keyReq);
  let count = 0;
  if (cached) {
    const text = await cached.text();
    count = Number.parseInt(text, 10) || 0;
  }
  if (count >= limit) return { limited: true, remaining: 0 };
  const next = count + 1;
  const res = new Response(String(next), {
    headers: { "Cache-Control": `max-age=${windowSec}` },
  });
  ctx.waitUntil(cache.put(keyReq, res));
  return { limited: false, remaining: Math.max(limit - next, 0) };
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const workerStartedMs = performance.now();
    const requestId = resolveRequestId(request);
    const url = new URL(request.url);
    const cache = caches.default;

    const rtOrigin = resolveRtOrigin(env);
    if (!rtOrigin) {
      return new Response(
        JSON.stringify({
          error: "rt_origin_not_configured",
          detail: "Set RT_BACKEND_ORIGIN (e.g. https://mesdeparts-ch.fly.dev).",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    const rateLimitPerMin = parseLimit(env?.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN);
    const globalDailyLimit = parseLimit(env?.GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_LIMIT_PER_DAY);

    const ip = getClientIp(request) || "unknown";
    const perIp = await checkLimit(
      cache,
      ctx,
      limitBucketKey("ip", ip, RATE_LIMIT_WINDOW_SEC),
      RATE_LIMIT_WINDOW_SEC,
      rateLimitPerMin
    );
    if (perIp.limited) {
      const body = JSON.stringify({ error: "rate_limited", message: "Too many requests." });
      return addCors(
        new Response(body, { status: 429, headers: { "Content-Type": "application/json" } }),
        { "Retry-After": String(RATE_LIMIT_WINDOW_SEC) }
      );
    }

    const global = await checkLimit(
      cache,
      ctx,
      limitBucketKey("global", "all", GLOBAL_LIMIT_WINDOW_SEC),
      GLOBAL_LIMIT_WINDOW_SEC,
      globalDailyLimit
    );
    if (global.limited) {
      const body = JSON.stringify({ error: "busy", message: "Service busy. Try again later." });
      return addCors(
        new Response(body, { status: 503, headers: { "Content-Type": "application/json" } }),
        { "Retry-After": String(GLOBAL_LIMIT_WINDOW_SEC) }
      );
    }

    // /api/stationboard: edge-cached with a short TTL.
    if (isRtStationboardPath(url.pathname)) {
      const upstream = new URL(`/api/stationboard${url.search}`, rtOrigin);
      const bypass = shouldBypassStationboardCache(url);
      const stationboardHeaders = (cacheStatus, cacheKey, originMs) => ({
        "x-md-cache": cacheStatus,
        "x-md-rate-remaining": perIp.remaining ?? "",
        "x-md-request-id": requestId,
        "x-md-cache-key": cacheKey || "",
        "x-md-origin-ms": String(roundMs(originMs)),
        "x-md-worker-total-ms": String(roundMs(performance.now() - workerStartedMs)),
      });

      if (bypass) {
        const cacheKey = normalizeStationboardCacheKey(url);
        cacheDebugLog(env, "stationboard bypass", {
          reason: "debug=1",
          path: url.pathname,
          requestId,
          key: cacheKey.url,
        });
        const originStartedMs = performance.now();
        const direct = await fetch(upstream.toString(), {
          method: "GET",
          headers: upstreamHeaders(request, requestId),
        });
        const originMs = performance.now() - originStartedMs;
        logStationboardTiming(env, {
          requestId,
          path: url.pathname,
          cache: "BYPASS",
          cacheKey: cacheKey.url,
          originMs: roundMs(originMs),
          totalMs: roundMs(performance.now() - workerStartedMs),
        });
        return addCors(direct, stationboardHeaders("BYPASS", cacheKey.url, originMs));
      }

      const cacheKey = normalizeStationboardCacheKey(url);
      const cached = await cache.match(cacheKey);
      if (cached) {
        cacheDebugLog(env, "stationboard hit", { key: cacheKey.url, requestId });
        logStationboardTiming(env, {
          requestId,
          path: url.pathname,
          cache: "HIT",
          cacheKey: cacheKey.url,
          originMs: 0,
          totalMs: roundMs(performance.now() - workerStartedMs),
        });
        return addCors(cached, {
          ...stationboardHeaders("HIT", cacheKey.url, 0),
          "Cache-Control": STATIONBOARD_CLIENT_CACHE_CONTROL,
          Pragma: "no-cache",
        });
      }

      cacheDebugLog(env, "stationboard miss", { key: cacheKey.url, requestId });
      const originStartedMs = performance.now();
      const res = await fetch(upstream.toString(), {
        method: "GET",
        headers: upstreamHeaders(request, requestId),
      });
      const originMs = performance.now() - originStartedMs;

      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const cacheable = res.ok && contentType.includes("application/json");
      if (!cacheable) {
        cacheDebugLog(env, "stationboard bypass", {
          reason: !res.ok ? `status_${res.status}` : "non_json_response",
          requestId,
          key: cacheKey.url,
        });
        logStationboardTiming(env, {
          requestId,
          path: url.pathname,
          cache: "BYPASS",
          cacheKey: cacheKey.url,
          status: res.status,
          originMs: roundMs(originMs),
          totalMs: roundMs(performance.now() - workerStartedMs),
        });
        return addCors(res, stationboardHeaders("BYPASS", cacheKey.url, originMs));
      }

      const proxyRes = new Response(res.body, res);
      stripOriginAntiCacheHeaders(proxyRes.headers);
      proxyRes.headers.set("Cache-Control", STATIONBOARD_EDGE_CACHE_CONTROL);
      proxyRes.headers.set(
        "CDN-Cache-Control",
        `public, max-age=${STATIONBOARD_CACHE_TTL_SEC}`
      );
      proxyRes.headers.set(
        "Cloudflare-CDN-Cache-Control",
        `public, max-age=${STATIONBOARD_CACHE_TTL_SEC}`
      );
      proxyRes.headers.set("Access-Control-Allow-Origin", "*");
      const responseHeaders = stationboardHeaders("MISS", cacheKey.url, originMs);
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (value !== "") proxyRes.headers.set(key, String(value));
      }

      logStationboardTiming(env, {
        requestId,
        path: url.pathname,
        cache: "MISS",
        cacheKey: cacheKey.url,
        originMs: roundMs(originMs),
        totalMs: roundMs(performance.now() - workerStartedMs),
      });
      ctx.waitUntil(cache.put(cacheKey, proxyRes.clone()));
      return addCors(proxyRes, {
        ...responseHeaders,
        "Cache-Control": STATIONBOARD_CLIENT_CACHE_CONTROL,
        Pragma: "no-cache",
      });
    }

    // All other requests (API routes + static assets + HTML) → RT_BACKEND_ORIGIN.
    const upstream = new URL(`${url.pathname}${url.search}`, rtOrigin);
    const fetchHeaders = { "x-md-request-id": requestId };
    if (isApiPath(url.pathname)) fetchHeaders["accept"] = "application/json";
    const acceptLanguage = request.headers.get("accept-language");
    if (acceptLanguage) fetchHeaders["accept-language"] = acceptLanguage;

    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: fetchHeaders,
    });

    const proxyRes = new Response(res.body, res);
    proxyRes.headers.set("Access-Control-Allow-Origin", "*");
    proxyRes.headers.set("x-md-cache", "BYPASS");
    if (perIp.remaining !== null) {
      proxyRes.headers.set("x-md-rate-remaining", String(perIp.remaining));
    }
    proxyRes.headers.set("x-md-request-id", requestId);
    proxyRes.headers.set(
      "x-md-worker-total-ms",
      String(roundMs(performance.now() - workerStartedMs))
    );

    return proxyRes;
  },
};
