const CACHE_NAME = "md-static-v2026-01-02-2";
const ASSETS = [
  "./index.html",
  "./manifest.webmanifest",
  "./style.v2026-01-02-2.css",
  "./main.v2026-01-02-2.js",
  "./logic.v2026-01-02-2.js",
  "./ui.v2026-01-02-2.js",
  "./state.v2026-01-02-2.js",
  "./i18n.v2026-01-02-2.js",
  "./favourites.v2026-01-02-2.js",
  "./infoBTN.v2026-01-02-2.js",
  "./bus-icon-1.png",
  "./bus-icon-1.svg",
  "./clock/index.html",
];

const ASSET_PATHS = new Set(
  ASSETS.map((asset) => new URL(asset, self.registration.scope).pathname),
);
const FALLBACK_HTML = new URL("./index.html", self.registration.scope).toString();

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Keep API requests network-only; cache only our shell assets and navigations.
  const pathname = url.pathname;
  const isAssetRequest = ASSET_PATHS.has(pathname);

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(FALLBACK_HTML, networkResponse.clone());
          return networkResponse;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(FALLBACK_HTML);
          if (cached) return cached;
          throw err;
        }
      })(),
    );
    return;
  }

  if (!isAssetRequest) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(pathname);
      if (cached) {
        return cached;
      }

      const response = await fetch(request);
      if (response && response.ok) {
        cache.put(pathname, response.clone());
      }
      return response;
    })(),
  );
});
