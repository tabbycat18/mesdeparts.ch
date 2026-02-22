# mesdeparts.ch Mega Repo Guide

MesDeparts is a Swiss public-transport departure-board project that currently ships two parallel tracks in one monorepo: a legacy static frontend (`legacy_api/web-ui/`) and an RT stack (`realtime_api/`) that uses GTFS static + GTFS-RT through an Express backend (`realtime_api/backend`).

This guide is intentionally repo-grounded. Any claim not directly verifiable from files in this repository is labeled as `Unknown (not found in repo): ...`.

## For contributors / AI agents
See `AGENTS.md`.

## Important Update (Repo Reorganization)

The repository was reorganized to make stack boundaries explicit.

Old path -> new path:
- `web-ui/` -> `legacy_api/web-ui/`
- `cloudflare-worker/` -> `realtime_api/edge/` (active) and `legacy_api/cloudflare-worker/` (archive copy)
- `wrangler.toml` -> `realtime_api/edge/wrangler.toml` (active) and `legacy_api/wrangler.toml` (archive copy)
- `rt/` -> `realtime_api/`
- top-level zero-downtime docs -> `realtime_api/docs/`

If your local scripts/IDE still reference old paths, update them now.
Common example:
- old: `rt/backend/.env`
- new: `realtime_api/backend/.env`

Quick start (current paths):
- backend tests: `cd realtime_api/backend && npm test`
- RT frontend tests: `cd realtime_api/frontend && npm test`
- edge worker deploy: `npx wrangler deploy --config realtime_api/edge/wrangler.toml`
- legacy frontend tests: `cd legacy_api/web-ui && npm test`

## Repo Layout

- `realtime_api/`: active stack (backend + RT frontend + edge worker).
- `legacy_api/`: archived legacy stack (`legacy_api/web-ui/`, archive copies of old worker files).
- `assets/` and `dev-artifacts/` remain at root because they are not clearly legacy-only.
- Historical incident/debug markdown files from root are archived under `realtime_api/docs/archive/`.

Legacy policy:
- `legacy_api/` is archive/read-only and should not be used for active Cloudflare deployment.

## Repo Map

```text
.
├── README.md                              # full guide
├── LICENSE / NOTICE
├── .github/workflows/
│   ├── gtfs_static_refresh.yml            # hourly static GTFS refresh job
│   └── backend_schema_check.yml           # stationboard schema JSON parse check
├── .wrangler/                             # local Wrangler state directory
├── legacy_api/                            # single legacy root (archive/read-only)
│   ├── wrangler.toml                      # archive copy (do not deploy)
│   ├── cloudflare-worker/
│   │   └── worker.js                      # archive copy (legacy)
│   └── web-ui/                            # legacy static frontend path
├── realtime_api/                                    # active RT stack
│   ├── README_realtime_api.md
│   ├── backend/                           # Express + Neon + GTFS pipelines
│   ├── docs/                              # RT ops/zero-downtime docs + archive/problem-a notes
│   ├── edge/                              # active Cloudflare Worker + wrangler config
│   ├── frontend/               # RT static frontend
│   └── test/
├── assets/                                # shared static assets at repo root
└── dev-artifacts/                         # local GTFS-RT artifacts
```

## Top-Level Folder Roles

- `legacy_api/web-ui/`: legacy/public static UI; entrypoints are `legacy_api/web-ui/index.html`, `legacy_api/web-ui/dual-board.html`, and `legacy_api/web-ui/main.v2025-02-07.js`.
- `realtime_api/`: active RT stack; backend API entrypoint is `realtime_api/backend/server.js`, RT UI entrypoint is `realtime_api/frontend/index.html`.
- `realtime_api/edge/`: active edge proxy/cache/rate-limit layer; entrypoints are `realtime_api/edge/worker.js` and `realtime_api/edge/wrangler.toml`.
- `legacy_api/cloudflare-worker/`: archive copy of the previous worker implementation.
- `.github/workflows/`: CI/automation workflows; files are `.github/workflows/gtfs_static_refresh.yml` and `.github/workflows/backend_schema_check.yml`.
- `.wrangler/`: local Wrangler tooling state directory.
- `assets/`: root SVG assets (`assets/location-pin.svg`, `assets/without-icon.svg`).
- `dev-artifacts/`: sample GTFS-RT artifact files (`dev-artifacts/gtfs-rt.json`, `dev-artifacts/gtfs-rt.pb`).
- `legacy_api/wrangler.toml`: archive copy only; active deploy config is `realtime_api/edge/wrangler.toml`.

Unknown (not found in repo): active runtime imports of `assets/` and `dev-artifacts/` by production code paths.
Unknown (not found in repo): production/runtime relevance of `.wrangler/` content beyond local CLI state.

## Architecture

### Legacy Path (`legacy_api/web-ui/`)

```text
Browser
  -> legacy_api/web-ui/index.html + legacy_api/web-ui/logic.v2025-02-07.js
  -> API base selected in UI (board/direct mode)
     -> direct: https://transport.opendata.ch/v1/*
     -> optional proxy: realtime_api/edge/worker.js -> https://transport.opendata.ch/v1/*
```

Relevant files:
- `legacy_api/web-ui/logic.v2025-02-07.js`
- `legacy_api/web-ui/main.v2025-02-07.js`
- `realtime_api/edge/worker.js`

### RT Path (`realtime_api/`)

```text
Browser
  -> realtime_api/frontend/*.js
  -> GET /api/stops/*, /api/stationboard, /api/journey, /api/connections
  -> realtime_api/backend/server.js
      -> resolve stop: realtime_api/backend/src/resolve/resolveStop.js
      -> build board: realtime_api/backend/src/logic/buildStationboard.js
      -> merge RT: realtime_api/backend/src/merge/* + realtime_api/backend/loaders/loadRealtime.js
      -> attach alerts: realtime_api/backend/src/loaders/fetchServiceAlerts.js + realtime_api/backend/src/merge/*
      -> canonicalize output: realtime_api/backend/src/models/stationboard.js
  -> Neon/Postgres tables (gtfs_* + app_stop_aliases + rt_updates)
```

Relevant files:
- `realtime_api/backend/server.js`
- `realtime_api/backend/src/api/stationboardRoute.js`
- `realtime_api/backend/src/api/stationboard.js`
- `realtime_api/backend/src/logic/buildStationboard.js`
- `realtime_api/backend/src/models/stationboard.js`

## Legacy vs RT (What Differs)

- Legacy `legacy_api/web-ui/` is a static client with direct/open API style calls and optional Worker proxy mode.
- RT path uses `realtime_api/backend` as a server-side merge layer with SQL + GTFS-RT parsing + canonical stationboard normalization.
- Migration target in repo docs/code direction: `realtime_api/backend` becomes canonical stationboard source; `legacy_api/web-ui/` stays stable until cutover.

## `/api/stationboard` Contract Freeze

Endpoint:
- `GET /api/stationboard` (registered in `realtime_api/backend/server.js` via `createStationboardRouteHandler(...)`).

Route parser and conflict logic source:
- `realtime_api/backend/src/api/stationboardRoute.js`

### Request Params

- `stop_id` (highest precedence)
- `stationId` (fallback alias)
- `station_id` (fallback alias after `stationId`)
- `stationName` (optional resolver hint)
- `lang` (optional language preference)
- `limit` (optional numeric)
- `window_minutes` (optional numeric)
- `debug` (`1|true|yes|on` => debug true)
- `include_alerts` / `includeAlerts` (`1|true|yes|on` or `0|false|no|off`)

Header used:
- `Accept-Language` (passed into language preference resolver in `realtime_api/backend/src/api/stationboard.js`).

### Param Precedence and Conflict Rule

- Effective target ID precedence is `stop_id` -> `stationId` -> `station_id`.
- If both `stop_id` and station alias are provided, the route resolves both independently and compares canonical roots.
- Conflict is raised only when both sides resolve and roots differ.
- If one side fails to resolve, route does not raise conflict preemptively; it proceeds with normal handling.

Conflict response (HTTP 400) fields from `stationboardRoute.js`:
- `error: "conflicting_stop_id"`
- `detail`
- `precedence: "stop_id"`
- `received.stop_id`
- `received.stationId`
- `resolved.stop_id.stop`
- `resolved.stop_id.root`
- `resolved.stationId.stop`
- `resolved.stationId.root`

Route tests for this contract:
- `realtime_api/backend/test/stationboard.route.test.js`

### include_alerts Gate (M2 Feature Gate)

From `realtime_api/backend/src/api/stationboard.js`:
- `includeAlertsRequested = includeAlerts !== false`
- `includeAlertsApplied = (process.env.STATIONBOARD_ENABLE_M2 !== "0") && includeAlertsRequested`

Debug keys (when debug is enabled):
- `debug.includeAlertsRequested`
- `debug.includeAlertsApplied`
- compatibility keys also present: `debug.includeAlerts`, `debug.requestedIncludeAlerts`

### Response Shape

Top-level (from `realtime_api/backend/src/api/stationboard.js`):
- `station`
- `resolved`
- `banners`
- `departures`
- optional `debug`

Canonical schema file:
- `realtime_api/backend/docs/stationboard.schema.json`

Canonical departure normalizer:
- `realtime_api/backend/src/models/stationboard.js` (`normalizeDeparture`, `computeDisplayFields`)

### Invariants

Cancellation:
- `cancelled` is authoritative for cancellation state.
- `status`, `cancelReasonCode`, `stopEvent`, and `flags` are detail/subtype fields.

Delay semantics:
- `realtimeDeparture` missing/unparseable => `delayMin = null`
- realtime differs from scheduled => minute delta
- realtime equals scheduled => `delayMin = 0` only when RT-confirmed, else `null`

Status/detail semantics in canonical model:
- Status values set by code: `CANCELLED`, `SKIPPED_STOP`, `UNKNOWN`, `DELAYED`, `EARLY`, `ON_TIME`
- Cancellation detail examples: `cancelReasonCode` (`CANCELED_TRIP`, `SKIPPED_STOP`), `stopEvent` (`SKIPPED`), `flags` (`TRIP_CANCELLED`, `STOP_SKIPPED`, `RT_CONFIRMED`, ...)

## GTFS Static + GTFS-RT + SIRI Design in This Repo

### GTFS Static Ingest/Refresh

Primary refresh script:
- `realtime_api/backend/scripts/refreshGtfsIfNeeded.js`

Verified flow:
1. Fetch feed metadata (`realtime_api/backend/scripts/getRtFeedVersion.js`, `realtime_api/backend/scripts/fetchAlertsFeedMeta.js`).
2. Compare `meta_kv.gtfs_current_feed_version` with RT version.
3. If changed: download static GTFS permalink, clean required files, import into stage, validate, swap stage to live.
4. Update `meta_kv` + `rt_feed_meta`.

SQL and shell pieces:
- `realtime_api/backend/sql/create_stage_tables.sql`
- `realtime_api/backend/scripts/importGtfsToStage.sh`
- `realtime_api/backend/sql/validate_stage.sql`
- `realtime_api/backend/sql/swap_stage_to_live_cutover.sql`
- `realtime_api/backend/sql/cleanup_old_after_swap.sql`

Runtime query source:
- `realtime_api/backend/src/sql/stationboard.sql`

Cutover/cleanup SQL currently used by refresh flow:
- `realtime_api/backend/sql/swap_stage_to_live_cutover.sql`
- `realtime_api/backend/sql/cleanup_old_after_swap.sql`

### GTFS-RT TripUpdates

- Fetcher: `realtime_api/backend/src/loaders/fetchTripUpdates.js`
- Merge/cache/persist layer: `realtime_api/backend/loaders/loadRealtime.js`
- Merge application to scheduled rows: `realtime_api/backend/src/merge/applyTripUpdates.js`
- Added trips merge: `realtime_api/backend/src/merge/applyAddedTrips.js`

Persistence behavior:
- `realtime_api/backend/loaders/loadRealtime.js` creates and upserts `public.rt_updates`.

### GTFS-RT Service Alerts

- Fetch/decode: `realtime_api/backend/src/loaders/fetchServiceAlerts.js`
- Request-time language resolution: `realtime_api/backend/src/util/i18n.js`
- Attachment/synthesis: `realtime_api/backend/src/merge/attachAlerts.js`, `realtime_api/backend/src/merge/synthesizeFromAlerts.js`
- Optional supplement fetch path: `realtime_api/backend/src/merge/supplementFromOtdStationboard.js` (triggered via `getStationboard` flow)

### SIRI

Unknown (not found in repo): active SIRI ingestion, SIRI endpoint clients, or SIRI merge modules in current runtime.

## How To Run (Local)

### Backend (`realtime_api/backend`)

Install and start:

```bash
cd realtime_api/backend
npm ci
npm run dev
```

Production-like start command:

```bash
cd realtime_api/backend
npm start
```

Required env var to boot backend:
- `DATABASE_URL` (checked in `realtime_api/backend/db.js`)

Common API token envs used by loaders/scripts:
- `OPENTDATA_GTFS_RT_KEY`
- `OPENTDATA_GTFS_SA_KEY`
- `GTFS_RT_TOKEN`
- `OPENDATA_SWISS_TOKEN`
- `OPENTDATA_API_KEY`

Run tests:

```bash
cd realtime_api/backend
npm test
```

Schema drift helper:

```bash
cd realtime_api/backend
npm run schema:drift
```

Package scripts available (from `realtime_api/backend/package.json`):
- `npm run seed:aliases`
- `npm run sb:filter`
- `npm run poller` / `npm run poller:trip` / `npm run poller:alerts`

Debug scripts:

```bash
cd realtime_api/backend
node scripts/debugStationboard.js Parent8501120
node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js vallorbe
node scripts/debugTripUpdatesCancelCount.js
```

### Legacy frontend (`legacy_api/web-ui`) and RT frontend (`realtime_api/frontend`)

Both frontend folders are static and have their own readmes:
- `legacy_api/web-ui/README_legacy_web_ui.md`
- `realtime_api/frontend/README_frontend.md`

## Migration Roadmap (M0 -> M5)

This roadmap is the migration plan, not a claim that every milestone is fully complete.

### M0

Goal:
- Stable scheduled stationboard from GTFS static.

Modules involved:
- `realtime_api/backend/src/sql/stationboard.sql`
- `realtime_api/backend/src/logic/buildStationboard.js`
- `realtime_api/backend/src/resolve/resolveStop.js`

Acceptance criteria:
- `/api/stationboard` returns deterministic scheduled departures for a known stop.
- Stop resolution works for parent/platform IDs.

Risks + rollback:
- Risk: schema mismatch (`gtfs_*` not present in DB).
- Rollback: keep legacy `legacy_api/web-ui/` path as production path while fixing DB/runtime schema.

### M1

Goal:
- Deterministic TripUpdates merge with canonical cancellation/delay semantics.

Modules involved:
- `realtime_api/backend/loaders/loadRealtime.js`
- `realtime_api/backend/src/merge/applyTripUpdates.js`
- `realtime_api/backend/src/models/stationboard.js`
- `realtime_api/backend/test/stationboard.model.test.js`

Acceptance criteria:
- Skipped/suppressed stop is represented as cancelled at stationboard row level.
- Delay semantics follow `null vs 0` rules from canonical model.

Risks + rollback:
- Risk: false 0-minute delays from scheduled fallback.
- Rollback: disable RT merge by setting `ENABLE_RT=0` while preserving static board.

### M2

Goal:
- Service Alerts attachment, localization, and gated activation.

Modules involved:
- `realtime_api/backend/src/loaders/fetchServiceAlerts.js`
- `realtime_api/backend/src/merge/attachAlerts.js`
- `realtime_api/backend/src/merge/synthesizeFromAlerts.js`
- `realtime_api/backend/src/util/i18n.js`
- `realtime_api/backend/src/api/stationboard.js`

Acceptance criteria:
- `include_alerts/includeAlerts` intent is parsed.
- `STATIONBOARD_ENABLE_M2` gate controls actual alerts application.
- Debug keys expose requested vs applied state.

Risks + rollback:
- Risk: noisy or missing alerts from upstream feed changes.
- Rollback: set `STATIONBOARD_ENABLE_M2=0` and keep base stationboard output stable.

### M3

Goal:
- Route/API contract hardening and deterministic route-level behavior.

Modules involved:
- `realtime_api/backend/src/api/stationboardRoute.js`
- `realtime_api/backend/test/stationboard.route.test.js`

Acceptance criteria:
- Conflict handling is canonical-root based.
- Conflict payload is stable (`conflicting_stop_id` contract).
- Deterministic tests pass without DB/network coupling.

Risks + rollback:
- Risk: client sends conflicting stop params and gets new 400 behavior.
- Rollback: keep client sending only one canonical param (`stop_id`) during rollout.

### M4

Goal:
- Operationalize GTFS refresh and schema contract checks.

Modules involved:
- `.github/workflows/gtfs_static_refresh.yml`
- `.github/workflows/backend_schema_check.yml`
- `realtime_api/backend/scripts/refreshGtfsIfNeeded.js`
- `realtime_api/backend/docs/stationboard.schema.json`

Acceptance criteria:
- Hourly refresh workflow runs with required secrets.
- Schema JSON check passes on backend changes.

Risks + rollback:
- Risk: missing GitHub secrets or DB connectivity failures.
- Rollback: run refresh manually in backend until CI secrets/workflow are fixed.

### M5

Goal:
- Production cutover where RT path is canonical and legacy path becomes fallback/legacy.

Modules involved:
- `realtime_api/backend/*`
- `realtime_api/frontend/*`
- operational deploy config (`realtime_api/edge/wrangler.toml`, hosting configuration)

Acceptance criteria:
- RT board parity or better for cancellations/replacements/extra trains on target stations.
- Clear rollback path to legacy remains documented.

Risks + rollback:
- Risk: runtime regressions under production load.
- Rollback: direct traffic back to legacy `legacy_api/web-ui/` path while investigating RT regressions.

Unknown (not found in repo): final production traffic-switch mechanism and release orchestration tooling.

## Manual Ops Checklist

### Neon / Postgres Setup

- Provide `DATABASE_URL` for backend runtime and scripts.
- Ensure DB has runtime tables referenced by code/SQL: `gtfs_*`, `app_stop_aliases`, `meta_kv`, `rt_feed_meta`, and `rt_updates`.
- Run refresh/import scripts from `realtime_api/backend/scripts/*` as needed.

Unknown (not found in repo): single canonical migration file that creates all base runtime tables (`gtfs_*`, `app_stop_aliases`, `meta_kv`, `rt_feed_meta`) from scratch.

### Required Tables / Schema Sources in Repo

- Stage-table DDL: `realtime_api/backend/sql/create_stage_tables.sql`
- Stage validation: `realtime_api/backend/sql/validate_stage.sql`
- Stage->live swap: `realtime_api/backend/sql/swap_stage_to_live_cutover.sql`
- Post-cutover cleanup: `realtime_api/backend/sql/cleanup_old_after_swap.sql`
- Runtime stationboard query: `realtime_api/backend/src/sql/stationboard.sql`
- Legacy schema artifact: `realtime_api/backend/schema_gtfs.sql` (non-`gtfs_` table naming)
- Drift helper: `realtime_api/backend/scripts/schemaDriftTask.js`

### Secrets / Env Vars

GitHub workflow secrets required by refresh job:
- `NEON_DATABASE_URL`
- `OPENTDATA_GTFS_RT_KEY`
- `OPENTDATA_GTFS_SA_KEY`

Common runtime/script env vars used in backend code:
- Required: `DATABASE_URL`
- Feature flags and behavior gates: `ENABLE_RT`, `STATIONBOARD_ENABLE_M2`, `DEBUG`, `DEBUG_RT`
- GTFS-RT/service-alert keys: `GTFS_RT_TOKEN`, `OPENDATA_SWISS_TOKEN`, `OPENTDATA_GTFS_RT_KEY`, `OPENTDATA_GTFS_SA_KEY`, `OPENTDATA_API_KEY`

### GitHub Actions Behavior

- `gtfs_static_refresh.yml`: hourly + manual, runs `node scripts/refreshGtfsIfNeeded.js` in `realtime_api/backend`.
- `backend_schema_check.yml`: PR/push/manual, validates JSON parse for `realtime_api/backend/docs/stationboard.schema.json`.
- In-repo scheduler currently visible: GitHub Actions cron in `.github/workflows/gtfs_static_refresh.yml`.

Unknown (not found in repo): additional external schedulers (server cron, managed jobs) for GTFS refresh.

### Cloudflare Worker Role

From `realtime_api/edge/worker.js`:
- GET-only proxy to `https://transport.opendata.ch/v1/*`
- path-based edge TTLs
- CORS headers
- per-IP minute and optional global daily rate limiting
- stationboard routes:
  - `/stationboard` -> legacy upstream stationboard (`https://transport.opendata.ch/v1/stationboard`)
  - `/api/stationboard` -> upstream selected by `STATIONBOARD_UPSTREAM`:
    - `legacy` (default): legacy upstream stationboard
    - `rt`: `RT_BACKEND_ORIGIN/api/stationboard` (falls back to legacy if `RT_BACKEND_ORIGIN` is not set)
- stationboard edge-cache branch for stationboard paths (`/stationboard`, `/api/stationboard`):
  - cache key normalization keeps only: `stop_id`, `stationId`, `limit`, `window_minutes`, `lang`, `include_alerts`, `includeAlerts`
  - `station_id` is canonicalized to `stationId` in the cache key
  - `debug=1` bypasses cache
  - caches only `200` JSON responses (`content-type` contains `application/json`)
  - stationboard cache TTL is 15 seconds via `CDN-Cache-Control: public, max-age=15`
  - debug logging can be enabled with `WORKER_CACHE_DEBUG=1` (logs hit/miss/bypass and normalized cache key URL)

Unknown (not found in repo): whether production stationboard traffic is currently routed through this Worker.

### RT Backend Deployment

- Deployment target for `realtime_api/backend`: **Fly.io**.
- Docker runtime path used in this repo: `realtime_api/backend/Dockerfile`.
- Backend container port: `8080` (set in `realtime_api/backend/Dockerfile`).
- Fly config: `fly.toml` at repository root.
  - App name: `mesdeparts-ch`
  - Primary region: `ams` (Amsterdam)
  - Min machines: 1, auto-scaling enabled
  - Deploy with: `fly deploy`

## Troubleshooting Playbooks

### 1) Symptom: cancellations are missing for trains that should be skipped/cancelled

What to inspect:
- `realtime_api/backend/src/merge/applyTripUpdates.js`
- `realtime_api/backend/src/models/stationboard.js`
- `realtime_api/backend/scripts/debugStationboard.js`

Likely causes:
- stop-level `SKIPPED` signal not propagated to canonical cancellation fields
- UI/consumer reading only detail fields and ignoring authoritative `cancelled`

Validate fix:
- run `node scripts/debugStationboard.js Parent8501120`
- confirm affected departures include `cancelled: true` and expected `cancelReasonCode`

### 2) Symptom: delay values look random (too many 0 or null)

What to inspect:
- `realtime_api/backend/src/models/stationboard.js` (`computeDisplayFields`)
- `realtime_api/backend/src/merge/applyTripUpdates.js`
- `realtime_api/backend/loaders/loadRealtime.js`

Likely causes:
- scheduled fallback being interpreted as RT-confirmed
- missing/expired RT feed data

Validate fix:
- inspect per-row `delayMin`, `flags`, and `debug.flags` in debug output
- ensure `delayMin=0` appears only with RT-confirmed signals

### 3) Symptom: alerts/replacements/extra trains not visible

What to inspect:
- `realtime_api/backend/src/api/stationboard.js` (M2 gate and include alerts flow)
- `realtime_api/backend/src/loaders/fetchServiceAlerts.js`
- `realtime_api/backend/src/merge/attachAlerts.js`
- `realtime_api/backend/src/merge/synthesizeFromAlerts.js`

Likely causes:
- `STATIONBOARD_ENABLE_M2=0`
- missing alerts API key
- no active/matching informed entities for requested scope

Validate fix:
- request `/api/stationboard?...&include_alerts=1&debug=1`
- verify `debug.includeAlertsRequested` and `debug.includeAlertsApplied`

### 4) Symptom: stop resolution fails (`unknown_stop`) or wrong station scope

What to inspect:
- `realtime_api/backend/src/resolve/resolveStop.js`
- `realtime_api/backend/src/api/stationboardRoute.js`
- `realtime_api/backend/scripts/seedStopAliases.js`

Likely causes:
- alias table missing or stale
- conflicting params (`stop_id` and `stationId`) with different roots

Validate fix:
- test both parent and platform IDs
- verify conflict payload details for mismatched canonical roots

### 5) Symptom: SQL/runtime drift confusion (`schema_gtfs.sql` vs `gtfs_*`)

What to inspect:
- `realtime_api/backend/schema_gtfs.sql`
- `realtime_api/backend/src/sql/stationboard.sql`
- `realtime_api/backend/sql/*.sql`
- `realtime_api/backend/scripts/schemaDriftTask.js`

Likely causes:
- mixed legacy naming vs current runtime naming

Validate fix:
- run `cd realtime_api/backend && npm run schema:drift`
- reconcile on canonical runtime naming used by active stationboard path

## Where To Change X

- Stationboard query/window issues: `realtime_api/backend/src/sql/stationboard.sql`, `realtime_api/backend/src/logic/buildStationboard.js`
- Param parsing/conflict behavior: `realtime_api/backend/src/api/stationboardRoute.js`
- API response composition and M2 gate: `realtime_api/backend/src/api/stationboard.js`
- Cancellation/delay/status semantics: `realtime_api/backend/src/models/stationboard.js`
- TripUpdates merge behavior: `realtime_api/backend/src/merge/applyTripUpdates.js`
- Alert matching/localization behavior: `realtime_api/backend/src/merge/attachAlerts.js`, `realtime_api/backend/src/util/i18n.js`
- Stop alias resolution: `realtime_api/backend/src/resolve/resolveStop.js`, `realtime_api/backend/scripts/seedStopAliases.js`
- CI refresh/check workflows: `.github/workflows/gtfs_static_refresh.yml`, `.github/workflows/backend_schema_check.yml`
- Legacy UI tweaks: `legacy_api/web-ui/` (separate track; do not mix with RT backend logic)

## How To Contribute Safely

- Keep `legacy_api/web-ui/` and `realtime_api/` changes intentionally separated.
- For RT backend changes, run:

```bash
cd realtime_api/backend
npm test
npm run schema:drift
```

- Keep `/api/stationboard` contract aligned across these files:
- `realtime_api/backend/src/api/stationboardRoute.js` (request parsing + conflict behavior)
- `realtime_api/backend/src/api/stationboard.js` (response assembly + feature gates)
- `realtime_api/backend/src/models/stationboard.js` (canonical departure semantics)
- `realtime_api/backend/docs/stationboard.schema.json` (schema artifact checked by CI)
- Prefer adding regression tests under `realtime_api/backend/test/` for route/model/merge behavior.

## Deep Docs

- `./realtime_api/backend/README_backend.md`
- `./realtime_api/backend/docs/stationboard.schema.json`
- `./realtime_api/README_realtime_api.md`
- `./realtime_api/docs/INDEX.md`
- `./legacy_api/web-ui/README_legacy_web_ui.md`
- `./realtime_api/frontend/README_frontend.md`
