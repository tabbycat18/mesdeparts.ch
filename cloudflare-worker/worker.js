const ORIGIN_BASE = "https://transport.opendata.ch";

const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_GLOBAL_LIMIT_PER_DAY = 0;
const RATE_LIMIT_WINDOW_SEC = 60;
const GLOBAL_LIMIT_WINDOW_SEC = 86400;

const ttlFor = (path) => {
  if (path.startsWith("/stationboard")) return 25;      // board refresh
  if (path.startsWith("/connections")) return 45;       // journey details overlay (trips)
  if (path.startsWith("/locations")) return 86400;      // stop search cache
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
    // Preserve the /v1 prefix when forwarding to the upstream API
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
      cf: { cacheEverything: true },
    });

    // Do not cache error responses; just pass them through
    if (!res.ok) {
      return addCors(res, { "x-md-cache": "BYPASS" });
    }

    const ttl = ttlFor(url.pathname);
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
