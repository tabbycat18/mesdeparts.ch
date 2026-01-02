// Bump the cache name to force-refresh cached assets (e.g. main.js) after fixes
const CACHE_NAME = "md-static-v2026-01-03";
const ASSETS = [
  "./index.html",
  "./dual-board.html",
  "./manifest.webmanifest",
  "./style.v2026-01-03.css",
  "./main.v2026-01-03.js",
  "./logic.v2026-01-03.js",
  "./ui.v2026-01-03.js",
  "./state.v2026-01-03.js",
  "./i18n.v2026-01-03.js",
  "./favourites.v2026-01-03.js",
  "./infoBTN.v2026-01-03.js",
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
        const cache = await caches.open(CACHE_NAME);
        const isDualBoard = pathname.endsWith("/dual-board.html");
        const cachedPath = isDualBoard ? "./dual-board.html" : "./index.html";
        const cachedUrl = new URL(cachedPath, self.registration.scope).pathname;

        // Serve the cached shell if available; otherwise fetch once and cache.
        const cached = await cache.match(cachedUrl);
        if (cached) {
          return cached;
        }

        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
          cache.put(cachedUrl, networkResponse.clone());
        }
        return networkResponse;
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
