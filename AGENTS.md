# AGENTS.md

## 1) Purpose
- Give contributors and AI agents a verified quick map of the active realtime backend surface.
- Document only what is confirmed from a small, explicit file set in this phase.
- Avoid assumptions: unknown areas are marked as `TBD (not verified yet)`.

## 2) Repo layout (only folders you verified)
- `realtime_api/backend/`: active realtime backend service (verified via `realtime_api/backend/package.json` and `realtime_api/backend/server.js`).
- `realtime_api/backend/src/api/`: HTTP route + stationboard handler (verified via `realtime_api/backend/src/api/stationboardRoute.js` and `realtime_api/backend/src/api/stationboard.js`).
- `realtime_api/backend/src/logic/`: stationboard build pipeline (verified via `realtime_api/backend/src/logic/buildStationboard.js`).
- `realtime_api/backend/scripts/`: pollers and operational scripts (verified via `realtime_api/backend/scripts/pollLaTripUpdates.js` and scripts listed in `realtime_api/backend/package.json`).
- `legacy_api/`: legacy stack exists (verified from root `README_main.md`).
- `realtime_api/`: current active stack root exists (verified from root `README_main.md`).

## 3) RT backend entrypoints
- Service entrypoint: `realtime_api/backend/server.js`
- NPM entrypoint scripts:
  - `start`: `TZ=Europe/Zurich node server.js`
  - `dev`: `TZ=Europe/Zurich NODE_ENV=development node server.js`
  - `test`: `node --test test/*.test.js`
  - `poller`: `TZ=Europe/Zurich node scripts/pollFeeds.js`
  - `poller:trip`: `TZ=Europe/Zurich node scripts/pollLaTripUpdates.js`
  - `poller:alerts`: `TZ=Europe/Zurich node scripts/pollLaServiceAlerts.js`
- Stationboard route registration: `app.get("/api/stationboard", stationboardRouteHandler)` in `realtime_api/backend/server.js`.

## 4) Stationboard request flow (high-level, bullets)
- `/api/stationboard` is handled by `createStationboardRouteHandler(...)` in `realtime_api/backend/src/api/stationboardRoute.js`.
- Route parses query params (`stop_id`, `stationId`, `lang`, `limit`, `window_minutes`, `include_alerts`, `since_rt`) and validates `since_rt`.
- Route reads RT cache metadata early and may return `204` when `since_rt` indicates no RT change.
- Otherwise route calls stationboard handler (`getStationboard`) from `realtime_api/backend/src/api/stationboard.js`.
- Handler resolves stop scope and calls `buildStationboard(...)` from `realtime_api/backend/src/logic/buildStationboard.js`.
- Handler builds response with `station`, `resolved`, `rt`, `alerts`, `banners`, `departures`; then route applies response/cache headers.

## 5) Realtime data flow (poller -> rt_cache -> merge)
- TripUpdates poller script: `realtime_api/backend/scripts/pollLaTripUpdates.js`.
- Poller fetches upstream GTFS-RT TripUpdates and upserts feed payload/state using `getRtCache`/`upsertRtCache` (`realtime_api/backend/src/db/rtCache.js`, imported by poller).
- Stationboard build path reads scoped RT from cache via `loadScopedRtFromCache` and merges via `applyTripUpdates` (imports visible in `realtime_api/backend/src/logic/buildStationboard.js`).
- Poller cadence/backoff (TripUpdates, verified):
  - Base interval from `GTFS_RT_POLL_INTERVAL_MS` default `15000`.
  - 429 backoff: starts `60000`, exponential, capped `600000`.
  - Error backoff: starts `15000`, exponential, capped `120000`.

## 6) Where to change X (short lookup table)
| Behavior | Primary location |
| --- | --- |
| Stationboard response shape | `realtime_api/backend/src/api/stationboard.js` |
| Realtime merge | `realtime_api/backend/src/logic/buildStationboard.js` (uses `loadScopedRtFromCache` + `applyTripUpdates`) |
| Stop search | `realtime_api/backend/src/search/stopsSearch.js` (import verified in `realtime_api/backend/server.js`) |
| Poller cadence/backoff | `realtime_api/backend/scripts/pollLaTripUpdates.js` |
| Caching headers / Cloudflare behavior | `realtime_api/backend/src/api/stationboardRoute.js` (`Cache-Control`, `CDN-Cache-Control`, `Vary`) |

## 7) Common commands (only what you verify exists)
- `cd realtime_api/backend && npm run dev`
- `cd realtime_api/backend && npm start`
- `cd realtime_api/backend && npm test`
- `cd realtime_api/backend && npm run poller`
- `cd realtime_api/backend && npm run poller:trip`
- `cd realtime_api/backend && npm run poller:alerts`
- `cd realtime_api/backend && npm run probe:rt`
