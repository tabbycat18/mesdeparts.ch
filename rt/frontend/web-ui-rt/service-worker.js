// Core assets: required for the shell to work offline.
const CORE_ASSETS = [
  "./index.html",
  "./dual-board.html",
  "./manifest.webmanifest",
  "./style.v2026-02-20-1.css",
  "./main.v2026-02-20-1.js",
  "./logic.v2026-02-20-1.js",
  "./ui.v2026-02-20-1.js",
  "./state.v2026-02-20-1.js",
  "./i18n.v2026-02-20-1.js",
  "./favourites.v2026-02-20-1.js",
  "./homeStop.v2026-02-20-1.js",
  "./threeDotsTip.v2026-02-20-1.js",
  "./infoBTN.v2026-02-20-1.js",
  "./ui/homeStopOnboarding.v2026-02-20-1.js",
  "./disruption-lightning.svg",
  "./bus-icon-1.png",
  "./bus-icon-1.svg",
];

// Optional assets that can be warmed in the background.
const LAZY_ASSETS = [
  "./clock/index.html",
  "./clock/js/sbbUhr-1.3.js",
];

const ASSETS = [...CORE_ASSETS, ...LAZY_ASSETS];
const CACHE_REV = "2026-02-21-5-v1.8.3";

function hashStrings(list) {
  const str = list.join("|");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

// Cache version derives from asset list + explicit revision to invalidate when file
// contents change without filename changes.
const CACHE_NAME = `md-static-${hashStrings([...ASSETS, CACHE_REV])}`;

const ASSET_PATHS = new Set(
  ASSETS.map((asset) => new URL(asset, self.registration.scope).pathname),
);
const FALLBACK_HTML = new URL("./index.html", self.registration.scope).toString();

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(CORE_ASSETS);
      } catch (err) {
        // If an asset is temporarily missing during deploy, keep installing instead of blocking the SW.
        console.warn("[SW] core assets prefetch incomplete", err);
      }
      cache.addAll(LAZY_ASSETS).catch(() => {});
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

  // Clock iframe and its assets: serve cache-first to keep it instant/offline without changing behavior.
  if (url.pathname.startsWith("/clock")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(url.pathname);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        if (response && response.ok) {
          cache.put(url.pathname, response.clone());
        }
        return response;
      })(),
    );
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

        const cached = await cache.match(cachedUrl);
        const fetchAndUpdate = async () => {
          const response = await fetch(request);
          if (response && response.ok) {
            cache.put(cachedUrl, response.clone());
          }
          return response;
        };

        if (cached) {
          // Serve instantly, refresh in background.
          fetchAndUpdate().catch(() => {});
          return cached;
        }

        try {
          return await fetchAndUpdate();
        } catch (err) {
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
      const revalidate = (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            cache.put(pathname, response.clone());
          }
        } catch {
          // ignore background refresh errors
        }
      })();

      if (cached) {
        // Return instantly from cache, refresh in the background.
        void revalidate;
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response && response.ok) {
          cache.put(pathname, response.clone());
        }
        return response;
      } catch (err) {
        // If the network is unavailable and we have no cached version, surface the original error.
        throw err;
      }
    })(),
  );
});
