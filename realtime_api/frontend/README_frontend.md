# Web UI

Docs index: [`../README_INDEX.md`](../README_INDEX.md)

Static, dependency-free front-end for mesdeparts.ch. Everything in this folder is served as-is (no build step), with ES modules and versioned filenames to keep long-lived caches safe to bust.

## Features
- Stop search with suggestions and favorites (stored locally; no account).
- Two bus views: by line (balanced by destination) or chronological; trains are always chronological.
- Filters for platform/line/train service plus “My favorites” mode.
- Self-hosted SBB clock + digital clock; auto-refresh every 10–20 s (~3 h horizon).
- Multilingual (FR/DE/IT/EN), deep links via `?stationName=...&stationId=...`, installable PWA shell (API stays online).

## Entry points
- `index.html`: single-board experience with language switcher, favorites, filters, and the SBB clock iframe (`clock/`).
- `dual-board.html`: two boards side by side for kiosks/embeds, with separate station pickers and view/filter controls.
- `manifest.webmanifest` + `service-worker.js`: PWA shell; caches static assets, leaves API requests online-only. On activation after an update, the SW notifies all open clients (`SW_UPDATED` postMessage) so they auto-reload and pick up the new shell immediately.

## Architecture (versioned files)
- `main.v*.js`: boot; reads URL/localStorage defaults (`stationName`/`stationId`, language), wires event handlers, and starts refresh + countdown loops.
- `state.v*.js`: shared config/constants (refresh cadence, horizons, view modes, thresholds) and mutable `appState`.
- `logic.v*.js`: `realtime_api/backend` client (`/api/stops/search`, `/api/stops/nearby`, `/api/stationboard`), station resolve/nearby search, delay/remark computation, grouping/sorting, and network detection for line colors.
- `ui.v*.js`: DOM rendering of the board, clocks, station search with suggestions/nearby, filters (line/platform/train service), favorites popovers, view toggle, auto-fit watcher, and embed state publication.
- `i18n.v*.js`: minimal translations (FR/DE/IT/EN) + language persistence.
- `favourites.v*.js`: localStorage (`md_favorites_v1`) helpers; no backend.
- `infoBTN.v*.js`: info/help/realtime/credits overlay shown from the “i” button.
- `style.v*.css`: board + dual layout styles, network color tokens, popovers.
- `clock/`: self-hosted SBB clock assets (Apache 2.0); cached by the service worker for offline/instant loads.

## Data & refresh flow
- Default station is `Lausanne, motte`; query params or stored values override it. Deep links use `?stationName=...&stationId=...`.
- API base defaults to same-origin in deployment; on `localhost` it auto-targets `http://localhost:3001`. Override with `window.__MD_API_BASE__ = "https://your-backend-host"` when needed.
- `refreshDepartures` calls `/api/stationboard` (limit tuned to UI), rebuilds grouped rows (3 h horizon, train/bus split, line/platform filters, favorites-only mode, train service filters) and renders. Countdown column updates every 5 s from cached data.
- Backend stationboard responses now carry additive top-level `meta` (Model A): `serverTime`, `responseMode`, `requestId`, `totalBackendMs`, `skippedSteps`, `rtStatus`, `rtAppliedCount`, `rtFetchedAt`, `rtCacheAgeMs`, `alertsStatus`, `alertsFetchedAt`, `alertsCacheAgeMs`. `logic.v*.js` normalizes/persists it as `data.meta` and `appState.lastStationboardMeta` for diagnostics only (no polling or rendering cadence changes).
- RT availability notice is driven by backend status, not HTTP code: show `rtTemporarilyUnavailable` whenever `meta.rtStatus !== "applied"` (fallback for legacy payloads: show unless `rt.applied=true` or `rt.reason="fresh"`).
- Bus line alert-column rendering is deterministic: show the extra line-column space only when at least one bus row has a positive delay signal (`status==="delay"` or `displayedDelayMin>0` or `delayMin>0`) and at least one bus row has renderable inline alert text; otherwise the line column stays collapsed.
- Line-alert popovers are anchored near the clicked row on all viewport sizes (no bottom sheet mode on mobile) and use a single-surface content layout with simple row separators.
- For single-alert departures, the popover header combines line + alert headline (`Line <id> – <headline>`), while the body shows the alert description text only.
- Refresh scheduling is timer-based (`REFRESH_DEPARTURES`) with Page Visibility/focus hooks: when the page returns to foreground, the app triggers an immediate refresh and performs drift catch-up if the scheduled timer slipped while backgrounded/throttled.
- Refresh requests are coalesced client-side: if a refresh is already in flight, new foreground/focus/manual refresh intents are queued and collapsed into a single follow-up fetch instead of launching parallel requests. See **Loading-hint state machine** below for the ownership rules.
- Incremental `since_rt` polling is context-guarded: the client sends `since_rt` only when a board is already applied for the same stop/language context, and includes `if_board=1` to allow backend `204` short-circuit only in that safe state.
- Kiosk/unattended safeguard: when the page is visible but no stationboard response has been received for an overdue window, the countdown loop triggers a cooldown-limited forced refresh to recover without manual reload.
- Stationboard fetches use `cache: "no-store"` on the browser side to avoid Safari/iPad HTTP cache staleness while preserving edge-cache behavior on `api.mesdeparts.ch`.
- Stale board guard: if the board looks stale/empty, the UI triggers a cache-bypassing refetch at most once per minute per station.
- Trip-details modal (`Détail du trajet`) uses abortable/time-bounded fetches and always exits loading state; non-OK/timeout failures show an error plus a retry button instead of indefinite loading.
- Station search uses `/api/stops/search` and geolocation helper via `/api/stops/nearby`.
- Embeds: pages add a `dual-embed` class when framed; `publishEmbedState` exposes current board state to the parent.
- Dual board consumes embedded `boardLoading`/`boardNotice` state so each pane can surface live status in the top banner (localized “Refreshing…” and “Realtime data currently unavailable” when RT is degraded).

## Running locally
- Static server only; no bundler needed:
  ```sh
  cd realtime_api/frontend
  python3 -m http.server 8000
  ```
  Then open http://localhost:8000.
- Tests (Node built-in): `npm test` from `realtime_api/frontend/` (checks key helpers in `logic.*.js`). `package.json` has no deps.

## Versioning & deploy notes
- JS/CSS filenames carry a version tag (`*.vYYYY-MM-DD-N.*`). When you bump assets, update references in `index.html`, `dual-board.html`, and the `CORE_ASSETS`/`LAZY_ASSETS` lists inside `service-worker.js`, plus the visible version tags in the HTML headers.
- `service-worker.js` derives its cache name from the asset list; keep the list in sync with the actual files so cache busting remains automatic. A changed asset list (or bumped `CACHE_REV`) produces a new `CACHE_NAME`, triggering install → activate → `SW_UPDATED` → client auto-reload on next visit.
- The UI is fully static: host this folder on any static host (Netlify/Vercel/S3/nginx/Apache). A `.htaccess` file is not used here; rely on versioned filenames for cache control.

## API target
- This UI is now wired for `realtime_api/backend` API routes only.
- It is not using the old `/locations` + `/stationboard` contract anymore.
- RT merge/source-of-truth stays backend-side; frontend does not implement platform-vs-parent stop-id matching logic.
- For diagnostics only, backend `debug=1` exposes `debug.rt.tripUpdates` (including `rtEnabledForRequest`, `rtMetaReason`, scoped counters).

## Loading-hint state machine

`refreshDepartures` (`main.v*.js`) shows a loading hint ("Actualisation… / Refreshing…") only for
**foreground** calls (page-load, user-triggered, or focus-restore).  Background/scheduler calls
always set `showLoadingHint = false` and never toggle the hint.

Ownership rules enforced by the `finally` block:

| Situation | `showLoadingHint` | `pendingRefreshRequest` | `isStaleRequest()` | Result |
| --- | --- | --- | --- | --- |
| Normal foreground completion | `true` | `null` | `false` | Hint OFF, board published |
| Queued follow-up (new request arrived while this one was in-flight) | `true` | set | `false` | Hint OFF, follow-up dispatched |
| Stale / superseded (station changed mid-fetch) | `true` | `null` | `true` | Hint OFF, scheduler rescheduled |
| Background scheduler call | `false` | any | any | Hint unchanged (never set), board published if applicable |

The critical invariant: `setBoardLoadingHint(false)` is always called **before** any early `return`
path inside `finally` when `showLoadingHint` is `true`.  This prevents the hint from getting stuck
when the foreground request exits via the queued or stale branch.

Regression tests: `test/refreshHint.test.js` (8 tests including a `simulateRefreshFinallyBroken`
fixture that documents the pre-fix bug).

## Behavior/UX notes
- Filters/view changes are client-side only.
- Language, favorites, and last station are stored in `localStorage`; nothing leaves the browser.
- The service worker pre-caches the shell and serves navigations cache-first with background revalidation; API calls always hit the network. When a new SW version activates, it sends `SW_UPDATED` to all open tabs; `main.v*.js` listens and calls `location.reload()` so the new shell is served immediately without manual reloading. A `pageshow` + `persisted` listener in `main.v*.js` also handles iOS bfcache restoration (page thawed from freeze bypasses the SW entirely) by triggering an immediate reload.
