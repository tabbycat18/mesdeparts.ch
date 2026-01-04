# RT Web UI

Static, dependency-free front-end for the GTFS/RT variant. Everything in this folder is served as-is (no build step), with ES modules and versioned filenames to keep long-lived caches safe to bust.

## Entry points
- `rt-index.html`: single-board experience with language switcher, favorites, filters, and the SBB clock iframe (`clock/`).
- `rt-dual-board.html`: two boards side by side for kiosks/embeds, with separate station pickers and view/filter controls.
- `manifest.webmanifest` + `rt-service-worker.js`: PWA shell; caches static assets, leaves API requests online-only.

## Architecture (versioned files)
- `rt-main.v*.js`: boot; reads URL/localStorage defaults (`stationName`/`stationId`, language), wires event handlers, starts refresh + countdown loops, and toggles board/direct API mode (auto-switches back to board mode after ~2 min unless overridden).
- `rt-state.v*.js`: shared config/constants (refresh cadence, horizons, view modes, thresholds) and mutable `appState`.
- `rt-logic.v*.js`: transport.opendata.ch client (or proxy when board mode is on), station resolve/nearby search, journey details fallback, delay/remark computation, grouping/sorting, and network detection for line colors.
- `rt-ui.v*.js`: DOM rendering of the board, clocks, station search with suggestions/nearby, filters (line/platform/train service), favorites popovers, view toggle, auto-fit watcher, and embed state publication.
- `rt-i18n.v*.js`: minimal translations (FR/DE/IT/EN) + language persistence.
- `rt-favourites.v*.js`: localStorage (`md_favorites_v1`) helpers; no backend.
- `rt-infoBTN.v*.js`: info/help/realtime/credits overlay shown from the “i” button.
- `rt-style.v*.css`: board + dual layout styles, network color tokens, popovers.
- `clock/`: self-hosted SBB clock assets (Apache 2.0); cached by the service worker for offline/instant loads.

## Data & refresh flow
- Default station is `Lausanne, motte` (id `8592082`); query params or stored values override it. Deep links use `?stationName=...&stationId=...`.
- API base defaults to `https://transport.opendata.ch/v1`; override in HTML with `window.__MD_API_BASE__ = "https://api.mesdeparts.ch";` (proxy). Board mode uses that proxy; direct mode hits the public API and auto-reverts to board mode after ~2 minutes unless explicitly kept.
- `refreshDepartures` calls `/stationboard` (limit tuned to UI), rebuilds grouped rows (3 h horizon, train/bus split, line/platform filters, favorites-only mode, train service filters) and renders. Countdown column updates every 5 s from cached data.
- Stale board guard: if the stationboard looks “empty because everything is already in the past”, the UI triggers a cache-bypassing refetch at most once per minute per station to recover from sticky caches and will fall back to a direct (non-proxy) fetch if the board stays empty for ~1 minute.
- Station search uses `/locations` (with debounced caching) and an optional geolocation helper via `/locations?x/y`. Journey details overlay falls back to `/journey` or `/connections` when `passList` is missing.
- Embeds: pages add a `dual-embed` class when framed; `publishEmbedState` exposes current board state to the parent.

## Running locally
- Static server only; no bundler needed:
  ```sh
  cd rt/frontend/web-ui-rt
  python3 -m http.server 8001
  ```
  Then open http://localhost:8001/rt-index.html.
- Tests (Node built-in): `npm test` from `rt/frontend/web-ui-rt/` (checks key helpers in `rt-logic.*.js`). `package.json` has no deps.

## Versioning & deploy notes
- JS/CSS filenames carry a version tag (`*.vYYYY-MM-DD-N.*`). When you bump assets, update references in `rt-index.html`, `rt-dual-board.html`, and the `CORE_ASSETS`/`LAZY_ASSETS` lists inside `rt-service-worker.js`, plus the visible version tags in the HTML headers.
- `rt-service-worker.js` derives its cache name from the asset list; keep the list in sync with the actual files so cache busting remains automatic.
- The UI is fully static: host this folder on any static host (Netlify/Vercel/S3/nginx/Apache). A `.htaccess` file is provided for Apache caching.

## Behavior/UX notes
- Board mode toggle (“Tableau”) reduces API load by using the proxy; direct mode is faster for one-off checks. Filters/view changes are client-side only.
- Language, favorites, board mode preference, and last station are stored in `localStorage`; nothing leaves the browser.
- The service worker pre-caches the shell and serves navigations cache-first with background revalidation; API calls always hit the network.
