const ORIGIN = "https://transport.opendata.ch/v1";

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
    const upstream = new URL(url.pathname + url.search, ORIGIN);
    const cacheKey = new Request(upstream.toString(), request);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) return addCors(cached);

    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      cf: { cacheEverything: true },
    });

    const ttl = ttlFor(url.pathname);
    const proxyRes = new Response(res.body, res);
    proxyRes.headers.set("Cache-Control", `public, s-maxage=${ttl}`);
    proxyRes.headers.set("Access-Control-Allow-Origin", "*");

    ctx.waitUntil(cache.put(cacheKey, proxyRes.clone()));
    return proxyRes;
  },
};
