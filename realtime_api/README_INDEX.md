# Realtime Docs Index

Central navigation for the active `realtime_api/` stack.

## Start here (fast path)

Read in this order when onboarding or debugging:

1. [`README_realtime_api.md`](./README_realtime_api.md)
2. [`backend/README_backend.md`](./backend/README_backend.md)
3. [`backend/README_src.md`](./backend/README_src.md)
4. [`backend/scripts/README_scripts.md`](./backend/scripts/README_scripts.md)

This order is designed to avoid code-search for common context.

## Core overview

- [`README_realtime_api.md`](./README_realtime_api.md) - architecture, runtime flow, and high-level backend/frontend/edge context.

## Backend docs

- [`backend/README_backend.md`](./backend/README_backend.md) - backend operations, deployment notes, stationboard contract, stop-search behavior.
- [`backend/README_src.md`](./backend/README_src.md) - deep code map of `src/` (api, merge, rt, search, utilities).
- [`backend/scripts/README_scripts.md`](./backend/scripts/README_scripts.md) - script-by-script usage, requirements, and safe execution order.

## Frontend docs

- [`frontend/README_frontend.md`](./frontend/README_frontend.md) - static UI structure, runtime behavior, versioned assets.

## Edge docs

- [`edge/README_edge.md`](./edge/README_edge.md) - Cloudflare Worker deployment path and commands.

## Operations docs

- [`docs/ZERO_DOWNTIME_README.md`](./docs/ZERO_DOWNTIME_README.md) - zero-downtime GTFS refresh implementation details.

## Authoritative runtime map (verified)

- Backend process entrypoint: `realtime_api/backend/server.js`
- Mounted stationboard route: `/api/stationboard` via `src/api/stationboardRoute.js`
- Mounted stop-search route: `/api/stops/search` via `src/api/stopSearchRoute.js`
- Stationboard API orchestrator: `realtime_api/backend/src/api/stationboard.js`
- Stationboard builder (canonical): `realtime_api/backend/src/logic/buildStationboard.js`
- Stationboard builder compatibility shim: `realtime_api/backend/logic/buildStationboard.js` (re-export only)
- Scoped RT cache loader: `realtime_api/backend/src/rt/loadScopedRtFromCache.js`
- Alerts cache loader: `realtime_api/backend/src/rt/loadAlertsFromCache.js`
- Feed cache decode/state module: `realtime_api/backend/loaders/loadRealtime.js`
- Pollers:
  - combined: `realtime_api/backend/scripts/pollFeeds.js`
  - trip updates: `realtime_api/backend/scripts/pollLaTripUpdates.js`
  - service alerts: `realtime_api/backend/scripts/pollLaServiceAlerts.js`
- Frontend entrypoint: `realtime_api/frontend/index.html`
- Edge worker entrypoint: `realtime_api/edge/worker.js`

## Compatibility/legacy notes (verified)

- `legacy_api/` is archive-only; do not use it for active deploys.
- `realtime_api/backend/routes/searchStops.js` exists but is not mounted by `server.js` (deprecated path).

## Archive note

- Legacy stack docs remain in `legacy_api/` and are intentionally separate from this active index.
