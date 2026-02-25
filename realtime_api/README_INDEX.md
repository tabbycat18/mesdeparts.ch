# Realtime Docs Index

Central navigation for the active `realtime_api/` stack.

## Start here (fast path)

Read in this order when onboarding or debugging:

1. [`README_realtime_api.md`](./README_realtime_api.md)
2. [`backend/README_backend.md`](./backend/README_backend.md)
3. [`backend/README_SQL.md`](./backend/README_SQL.md)
4. [`backend/README_src.md`](./backend/README_src.md)
5. [`backend/scripts/README_scripts.md`](./backend/scripts/README_scripts.md)
6. [`docs/INDEX.md`](./docs/INDEX.md)

This order is designed to avoid code-search for common context.

## Core overview

- [`README_realtime_api.md`](./README_realtime_api.md) - architecture, runtime flow, and high-level backend/frontend/edge context.

## Backend docs

- [`backend/README_backend.md`](./backend/README_backend.md) - backend operations, deployment notes, stationboard contract, stop-search behavior.
- [`backend/README_src.md`](./backend/README_src.md) - deep code map of `src/` (api, merge, rt, search, utilities), including Model A top-level stationboard `meta` contract.
- [`backend/README_SQL.md`](./backend/README_SQL.md) - SQL runbook: file roles, refresh order, cutover/search/runtime query mapping.
- [`backend/scripts/README_scripts.md`](./backend/scripts/README_scripts.md) - script-by-script usage, requirements, and safe execution order.

Loader + logic quick links:
- Logic pipeline entry: `backend/src/logic/buildStationboard.js`
- Logic compatibility shim: `backend/logic/buildStationboard.js`
- Feed cache/decode loader: `backend/loaders/loadRealtime.js`
- Scoped RT loader (default): `backend/src/rt/loadScopedRtFromParsedTables.js`
- Alerts loader (default): `backend/src/rt/loadAlertsFromParsedTables.js`
- Blob/debug loaders: `backend/src/rt/loadScopedRtFromCache.js`, `backend/src/rt/loadAlertsFromCache.js`
- Deep explanation of these files: [`backend/README_src.md`](./backend/README_src.md) (sections: `src/loaders`, `src/logic`, `src/rt`)
- TripUpdates debug diagnostics exposure (`rtEnabledForRequest`, `rtMetaReason`, scoped counters):
  `backend/src/logic/buildStationboard.js` + `backend/src/api/stationboard.js`
- Swiss platform-vs-parent stop-id matching guard/order:
  `backend/src/merge/applyTripUpdates.js` + `backend/src/rt/loadScopedRtFromCache.js`

Search-improvement references:
- Risk-tiered strategy and invariants: `backend/README_backend.md` ("Search improvement map")
- Code touchpoints by risk: `backend/README_src.md` ("Search touchpoints by risk")
- SQL-safe editing and verification gate: `backend/README_SQL.md`
- Execution run-loop and scripts: `backend/scripts/README_scripts.md`

## Frontend docs

- [`frontend/README_frontend.md`](./frontend/README_frontend.md) - static UI structure, runtime behavior, versioned assets (including stationboard foreground refresh/catch-up and browser `no-store` fetch policy).

## Edge docs

- [`edge/README_edge.md`](./edge/README_edge.md) - Cloudflare Worker deployment path and commands (including stationboard edge TTL + client no-store header behavior).

## Operations docs

- [`docs/INDEX.md`](./docs/INDEX.md) - operations-doc hub for zero-downtime GTFS refresh and rollout runbooks.
- [`docs/ZERO_DOWNTIME_README.md`](./docs/ZERO_DOWNTIME_README.md) - zero-downtime GTFS refresh implementation details.
- [`docs/ZERO_DOWNTIME_PLAN.md`](./docs/ZERO_DOWNTIME_PLAN.md) - design rationale and migration strategy.
- [`docs/MIGRATION_GUIDE.md`](./docs/MIGRATION_GUIDE.md) - deployment and verification runbook.
- [`docs/IMPLEMENTATION_SUMMARY.md`](./docs/IMPLEMENTATION_SUMMARY.md) - technical before/after summary.
- [`docs/GTFS_ZERO_DOWNTIME_REFACTOR.md`](./docs/GTFS_ZERO_DOWNTIME_REFACTOR.md) - refactor notes and migration context.

## Authoritative runtime map (verified)

- Backend process entrypoint: `realtime_api/backend/server.js`
- Mounted stationboard route: `/api/stationboard` via `src/api/stationboardRoute.js`
- Mounted stop-search route: `/api/stops/search` via `src/api/stopSearchRoute.js`
- Stationboard API orchestrator: `realtime_api/backend/src/api/stationboard.js`
- Stationboard builder (canonical): `realtime_api/backend/src/logic/buildStationboard.js`
- Stationboard builder compatibility shim: `realtime_api/backend/logic/buildStationboard.js` (re-export only)
- Scoped RT parsed-table loader (default): `realtime_api/backend/src/rt/loadScopedRtFromParsedTables.js`
- Alerts parsed-table loader (default): `realtime_api/backend/src/rt/loadAlertsFromParsedTables.js`
- Blob/debug loaders: `realtime_api/backend/src/rt/loadScopedRtFromCache.js`, `realtime_api/backend/src/rt/loadAlertsFromCache.js`
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
- `realtime_api/docs/` is active operations documentation for the realtime stack (not legacy).

## Archive note

- Legacy stack docs remain in `legacy_api/` and are intentionally separate from this active index.
- Historical incident/debug notes for Problem A are archived at:
  - `realtime_api/docs/archive/problem-a/PROBLEM_A_ANALYSIS.md`
  - `realtime_api/docs/archive/problem-a/PROBLEM_A_FIX_SUMMARY.md`
  - `realtime_api/docs/archive/problem-a/PROBLEM_A_INVESTIGATION_COMPLETE.md`
  - `realtime_api/docs/archive/problem-a/PROBLEM_A_QUICK_REFERENCE.md`
