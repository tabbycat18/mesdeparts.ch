/**
 * Routing map (repo-verified)
 * - This Worker serves as a GET-only proxy.
 * - It does not serve static site assets/pages.
 * - Default behavior: incoming paths are forwarded to ORIGIN_BASE with a hard "/v1" prefix:
 *   request "/foo?x=1" -> upstream "https://transport.opendata.ch/v1/foo?x=1"
 * - Special stationboard routes:
 *   - "/stationboard" always proxies legacy upstream stationboard.
 *   - "/api/stationboard" can proxy either:
 *     - legacy upstream stationboard (default), or
 *     - RT backend stationboard when STATIONBOARD_UPSTREAM=rt and RT_BACKEND_ORIGIN is set.
 * - Path-specific behavior exists only for cache TTL hints:
 *   "/stationboard", "/connections", "/locations", default.
 */
const ORIGIN_BASE = "https://transport.opendata.ch";

const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_GLOBAL_LIMIT_PER_DAY = 0;
const RATE_LIMIT_WINDOW_SEC = 60;
const GLOBAL_LIMIT_WINDOW_SEC = 86400;
const STATIONBOARD_CACHE_TTL_SEC = 15;

const STATIONBOARD_CACHE_PARAMS = [
  "stop_id",
  "stationId",
  "limit",
  "window_minutes",
  "lang",
  "include_alerts",
  "includeAlerts",
];

const ttlFor = (url) => {
  const path = url.pathname || "";
  const search = url.searchParams || new URLSearchParams(url.search || "");
  const hasCoords = search.has("x") && search.has("y");
  if (path.startsWith("/stationboard")) return 10;       // tighter refresh for delays
  if (path.startsWith("/connections")) return 25;        // journey details overlay (trips)
  if (path.startsWith("/locations")) return hasCoords ? 120 : 86400; // near-me lookups change fast
  return 30;
};

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

const isLegacyStationboardPath = (pathname) => {
  const path = String(pathname || "");
  return path.startsWith("/stationboard");
};

const isRtStationboardPath = (pathname) => {
  const path = String(pathname || "");
  return path.startsWith("/api/stationboard");
};

const isStationboardPath = (pathname) =>
  isLegacyStationboardPath(pathname) || isRtStationboardPath(pathname);

const stationboardUpstreamMode = (env) => {
  const raw = String(env?.STATIONBOARD_UPSTREAM || "").trim().toLowerCase();
  return raw === "rt" ? "rt" : "legacy";
};

const shouldBypassStationboardCache = (url) => {
  return (url.searchParams.get("debug") || "") === "1";
};

const resolveStationboardUpstream = (url, env) => {
  if (isLegacyStationboardPath(url.pathname)) {
    return {
      upstream: new URL(`/v1/stationboard${url.search}`, ORIGIN_BASE),
      mode: "legacy",
    };
  }

  const mode = stationboardUpstreamMode(env);
  if (mode === "rt") {
    const rtOriginRaw = String(env?.RT_BACKEND_ORIGIN || "").trim();
    if (rtOriginRaw) {
      try {
        const rtOrigin = new URL(rtOriginRaw);
        return {
          upstream: new URL(`/api/stationboard${url.search}`, rtOrigin),
          mode: "rt",
        };
      } catch {
        // Fall through to safe legacy fallback below when RT origin is malformed.
      }
    }
  }

  // Safe default: keep legacy stationboard behavior until RT origin is explicitly enabled.
  return {
    upstream: new URL(`/v1/stationboard${url.search}`, ORIGIN_BASE),
    mode: mode === "rt" ? "legacy_fallback" : "legacy",
  };
};

const normalizeStationboardCacheKey = (requestUrl) => {
  const normalizedUrl = new URL(requestUrl.toString());
  const stationId = normalizedUrl.searchParams.get("stationId");
  const stationIdSnake = normalizedUrl.searchParams.get("station_id");
  const effectiveStationId = stationId || stationIdSnake || "";

  normalizedUrl.search = "";
  const normalizedParams = new URLSearchParams();

  for (const key of STATIONBOARD_CACHE_PARAMS) {
    if (key === "stationId") {
      if (effectiveStationId) {
        normalizedParams.set("stationId", effectiveStationId);
      }
      continue;
    }
    const val = requestUrl.searchParams.get(key);
    if (val !== null) {
      normalizedParams.set(key, val);
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

    const url = new URL(request.url);
    const ttl = ttlFor(url);
    // Preserve the /v1 prefix for default proxy paths.
    const upstream = new URL(`/v1${url.pathname}${url.search}`, ORIGIN_BASE);
    const cache = caches.default;

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

    if (isStationboardPath(url.pathname)) {
      const stationboardTarget = resolveStationboardUpstream(url, env);
      const bypass = shouldBypassStationboardCache(url);
      if (bypass) {
        cacheDebugLog(env, "stationboard bypass", {
          reason: "debug=1",
          path: url.pathname,
          mode: stationboardTarget.mode,
        });
        const direct = await fetch(stationboardTarget.upstream.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
        });
        return addCors(direct, {
          "x-md-cache": "BYPASS",
          "x-md-rate-remaining": perIp.remaining ?? "",
        });
      }

      const cacheKey = normalizeStationboardCacheKey(url);
      const cached = await cache.match(cacheKey);
      if (cached) {
        cacheDebugLog(env, "stationboard hit", {
          key: cacheKey.url,
          mode: stationboardTarget.mode,
        });
        return addCors(cached, {
          "x-md-cache": "HIT",
          "x-md-rate-remaining": perIp.remaining ?? "",
        });
      }

      cacheDebugLog(env, "stationboard miss", {
        key: cacheKey.url,
        mode: stationboardTarget.mode,
      });
      const res = await fetch(stationboardTarget.upstream.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
      });

      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const cacheable = res.ok && contentType.includes("application/json");
      if (!cacheable) {
        cacheDebugLog(env, "stationboard bypass", {
          reason: !res.ok ? `status_${res.status}` : "non_json_response",
        });
        return addCors(res, {
          "x-md-cache": "BYPASS",
          "x-md-rate-remaining": perIp.remaining ?? "",
        });
      }

      const proxyRes = new Response(res.body, res);
      proxyRes.headers.set("Cache-Control", "public, max-age=0");
      proxyRes.headers.set(
        "CDN-Cache-Control",
        `public, max-age=${STATIONBOARD_CACHE_TTL_SEC}`
      );
      proxyRes.headers.set("Access-Control-Allow-Origin", "*");
      proxyRes.headers.set("x-md-cache", "MISS");
      if (perIp.remaining !== null) {
        proxyRes.headers.set("x-md-rate-remaining", String(perIp.remaining));
      }

      ctx.waitUntil(cache.put(cacheKey, proxyRes.clone()));
      return proxyRes;
    }

    const cacheKey = new Request(upstream.toString());
    const cached = await cache.match(cacheKey);
    if (cached) {
      return addCors(cached, {
        "x-md-cache": "HIT",
        "x-md-rate-remaining": perIp.remaining ?? "",
      });
    }

    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      cf: { cacheEverything: true, cacheTtl: ttl },
    });

    // Do not cache error responses; just pass them through
    if (!res.ok) {
      return addCors(res, { "x-md-cache": "BYPASS" });
    }

    const proxyRes = new Response(res.body, res);
    // Force short edge cache and minimal browser cache to avoid sticky errors
    proxyRes.headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0`);
    proxyRes.headers.set("Access-Control-Allow-Origin", "*");
    proxyRes.headers.set("x-md-cache", "MISS");
    if (perIp.remaining !== null) {
      proxyRes.headers.set("x-md-rate-remaining", String(perIp.remaining));
    }

    ctx.waitUntil(cache.put(cacheKey, proxyRes.clone()));
    return proxyRes;
  },
};
