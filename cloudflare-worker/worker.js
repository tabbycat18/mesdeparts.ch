const ORIGIN_BASE = "https://transport.opendata.ch";

const ttlFor = (path) => {
  if (path.startsWith("/stationboard")) return 20;  // board refresh
  if (path.startsWith("/connections")) return 45;   // journey overlay
  if (path.startsWith("/locations")) return 86400;  // stop search cache
  return 30;
};

const addCors = (res) => {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", "*");
  return out;
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    // Preserve the /v1 prefix when forwarding to the upstream API
    const upstream = new URL(`/v1${url.pathname}${url.search}`, ORIGIN_BASE);
    const cacheKey = new Request(upstream.toString(), request);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) return addCors(cached);

    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      cf: { cacheEverything: true },
    });

    // Do not cache error responses; just pass them through
    if (!res.ok) {
      return addCors(res);
    }

    const ttl = ttlFor(url.pathname);
    const proxyRes = new Response(res.body, res);
    // Force short edge cache and minimal browser cache to avoid sticky errors
    proxyRes.headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0`);
    proxyRes.headers.set("Access-Control-Allow-Origin", "*");

    ctx.waitUntil(cache.put(cacheKey, proxyRes.clone()));
    return proxyRes;
  },
};
