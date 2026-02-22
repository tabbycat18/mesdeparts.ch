# AGENTS.md

## 1) Purpose
- Give contributors and AI agents a fast, verified map of the active stack.
- Minimize repeated code-search by using README-first onboarding.
- Keep runtime truth explicit when compatibility/shim files exist.

## 2) Read-this-first order (mandatory)
- `realtime_api/README_INDEX.md`
- `realtime_api/README_realtime_api.md`
- `realtime_api/backend/README_backend.md`
- `realtime_api/backend/README_SQL.md`
- `realtime_api/backend/README_src.md`
- `realtime_api/backend/scripts/README_scripts.md`
- `realtime_api/docs/INDEX.md`

Loader/logic canonical docs:
- Runtime map and quick links: `realtime_api/README_INDEX.md`
- Deep explanations (file-level): `realtime_api/backend/README_src.md` (`src/loaders`, `src/logic`, `src/rt`)

If context is still missing after this order, then inspect code.

## 3) Verified repo layout
- `realtime_api/`: active stack (backend + frontend + edge).
- `realtime_api/backend/`: active API, GTFS/RT logic, pollers/scripts.
- `realtime_api/frontend/`: active static web UI.
- `realtime_api/edge/`: active Cloudflare Worker.
- `realtime_api/docs/`: active operations documentation (zero-downtime GTFS refresh docs + runbooks).
- `legacy_api/`: archive-only legacy stack (do not use for active deploys).

## 4) Authoritative runtime entrypoints (verified in code)
- Backend process entrypoint: `realtime_api/backend/server.js`
- Mounted stationboard route: `/api/stationboard` via `realtime_api/backend/src/api/stationboardRoute.js`
- Mounted stop-search route: `/api/stops/search` via `realtime_api/backend/src/api/stopSearchRoute.js`
- Stationboard orchestrator: `realtime_api/backend/src/api/stationboard.js`
- Canonical stationboard builder: `realtime_api/backend/src/logic/buildStationboard.js`
- Builder compatibility shim: `realtime_api/backend/logic/buildStationboard.js` (re-export only)
- Scoped RT cache loader: `realtime_api/backend/src/rt/loadScopedRtFromCache.js`
- Alerts cache loader: `realtime_api/backend/src/rt/loadAlertsFromCache.js`
- Shared feed cache/decode module: `realtime_api/backend/loaders/loadRealtime.js`
- Pollers:
  - `realtime_api/backend/scripts/pollFeeds.js`
  - `realtime_api/backend/scripts/pollLaTripUpdates.js`
  - `realtime_api/backend/scripts/pollLaServiceAlerts.js`
- Frontend entrypoint: `realtime_api/frontend/index.html`
- Edge worker entrypoint: `realtime_api/edge/worker.js`

## 5) Compatibility/deprecated files (verified)
- `realtime_api/backend/routes/searchStops.js` exists but is not mounted by `server.js`.
- `realtime_api/backend/sql/legacy/schema_gtfs.sql` is legacy-only archival SQL (not active runtime/cutover SQL).
- `legacy_api/*` remains archived for reference; active runtime/deploy is under `realtime_api/*`.

## 6) Where to change X
| Goal | Primary file(s) |
| --- | --- |
| GTFS refresh/cutover SQL ownership and run order | `realtime_api/backend/README_SQL.md` |
| Stationboard route params/headers/204 | `realtime_api/backend/src/api/stationboardRoute.js` |
| Stationboard response/meta/alerts wiring | `realtime_api/backend/src/api/stationboard.js` |
| Core board SQL + RT merge pipeline | `realtime_api/backend/src/logic/buildStationboard.js` |
| Loader module explanation (feed cache/decode) | `realtime_api/backend/loaders/loadRealtime.js`, docs in `realtime_api/backend/README_src.md` |
| RT/alerts scoped loader explanation | `realtime_api/backend/src/rt/loadScopedRtFromCache.js`, `realtime_api/backend/src/rt/loadAlertsFromCache.js` |
| TripUpdates merge behavior | `realtime_api/backend/src/merge/applyTripUpdates.js` |
| Alerts attachment/synthesis | `realtime_api/backend/src/merge/attachAlerts.js`, `realtime_api/backend/src/merge/synthesizeFromAlerts.js` |
| Stop search route behavior | `realtime_api/backend/src/api/stopSearchRoute.js` |
| Stop search normalization/ranking/sql strategy | `realtime_api/backend/src/search/stopsSearch.js`, `realtime_api/backend/src/util/searchNormalize.js` |
| Search DB normalization/index setup | `realtime_api/backend/sql/optimize_stop_search.sql` |
| Stationboard DB optimization SQL | `realtime_api/backend/sql/optimize_stationboard.sql`, `realtime_api/backend/sql/optimize_stationboard_latency.sql` |
| Poll cadence/backoff | `realtime_api/backend/scripts/pollLaTripUpdates.js`, `realtime_api/backend/scripts/pollLaServiceAlerts.js` |
| Frontend polling/render behavior | `realtime_api/frontend/logic.v*.js`, `realtime_api/frontend/ui.v*.js`, `realtime_api/frontend/state.v*.js` |
| Edge routing/cache/proxy rules | `realtime_api/edge/worker.js`, `realtime_api/edge/wrangler.toml` |

## 7) Common commands (verified)
- `cd realtime_api/backend && npm run dev`
- `cd realtime_api/backend && npm test`
- `cd realtime_api/backend && npm run poller`
- `cd realtime_api/backend && npm run poller:trip`
- `cd realtime_api/backend && npm run poller:alerts`
- `cd realtime_api/backend && npm run search:repro-regression`
- `cd realtime_api/backend && npm run search:verify`
- `cd realtime_api/backend && npm run search:bench`
- `cd realtime_api/frontend && npm test`
- `npx wrangler deploy --config realtime_api/edge/wrangler.toml`

## 8) Documentation maintenance rule
- For behavior changes, update docs in the same PR/commit:
  1. Update the nearest technical README (`backend`, `frontend`, `edge`, `scripts`, `src`).
  2. Update `realtime_api/README_INDEX.md` if navigation or authoritative paths changed.
  3. Update this `AGENTS.md` if runtime entrypoints, ownership, or workflow changed.

## 9) Stop-search change protocol (do not skip)
- Apply changes by risk tier:
  1. aliases/spec data
  2. ranking weights/tie-breakers
  3. SQL retrieval strategy
  4. normalization semantics (JS + SQL together)
- Preserve invariants:
  - degraded fallback path
  - fallback response headers
  - known regression queries
- Mandatory gate before merge/deploy:
  - `node --test test/stopSearch.test.js test/stopSearch.degraded.test.js test/stopSearch.route.test.js`
  - `npm run search:repro-regression`
  - `npm run search:verify`
  - `npm run search:bench`
