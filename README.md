# mesdeparts.ch Mega Repo Guide

MesDeparts is a Swiss public-transport departure-board project that currently ships two parallel tracks in one monorepo: a legacy static frontend (`legacy_api/web-ui/`) and an RT stack (`rt/`) that uses GTFS static + GTFS-RT through an Express backend (`rt/backend`). The migration target in this repo is to make `rt/` the canonical stationboard path while keeping `legacy_api/web-ui/` stable until cutover.

This guide is intentionally repo-grounded. Any claim not directly verifiable from files in this repository is labeled as `Unknown (not found in repo): ...`.

## Repo Layout

- `rt/`: active stack (backend + RT frontend).
- `legacy_api/`: legacy stack (`legacy_api/web-ui/`, `legacy_api/cloudflare-worker/`, `legacy_api/wrangler.toml`).
- `assets/` and `dev-artifacts/` remain at root because they are not clearly legacy-only.

## Repo Map

```text
.
├── README.md                              # this guide
├── LICENSE / NOTICE
├── legacy_api/wrangler.toml              # Cloudflare Worker config (legacy stack)
├── .github/workflows/
│   ├── gtfs_static_refresh.yml            # hourly static GTFS refresh job
│   └── backend_schema_check.yml           # stationboard schema JSON parse check
├── .wrangler/                             # local Wrangler state directory
├── legacy_api/cloudflare-worker/
│   └── worker.js                          # GET proxy to transport.opendata.ch/v1/*
├── legacy_api/web-ui/                                # legacy static frontend path
├── rt/                                    # RT migration path
│   ├── README.md / README-rt.md
│   ├── backend/                           # Express + Neon + GTFS pipelines
│   ├── frontend/web-ui-rt/               # RT static frontend
│   └── test/
├── assets/                                # shared static assets at repo root
└── dev-artifacts/                         # local GTFS-RT artifacts
```

## Top-Level Folder Roles

- `legacy_api/web-ui/`: legacy/public static UI; entrypoints are `legacy_api/web-ui/index.html`, `legacy_api/web-ui/dual-board.html`, and `legacy_api/web-ui/main.v2025-02-07.js`.
- `rt/`: migration track; backend API entrypoint is `rt/backend/server.js`, RT UI entrypoint is `rt/frontend/web-ui-rt/index.html`.
- `legacy_api/cloudflare-worker/`: optional edge proxy/cache/rate-limit layer for `transport.opendata.ch`; entrypoint is `legacy_api/cloudflare-worker/worker.js`.
- `.github/workflows/`: CI/automation workflows; files are `.github/workflows/gtfs_static_refresh.yml` and `.github/workflows/backend_schema_check.yml`.
- `.wrangler/`: local Wrangler tooling state directory.
- `assets/`: root SVG assets (`assets/location-pin.svg`, `assets/without-icon.svg`).
- `dev-artifacts/`: sample GTFS-RT artifact files (`dev-artifacts/gtfs-rt.json`, `dev-artifacts/gtfs-rt.pb`).
- `legacy_api/wrangler.toml`: Worker deployment metadata (`main = "cloudflare-worker/worker.js"`).

Unknown (not found in repo): active runtime imports of `assets/` and `dev-artifacts/` by production code paths.
Unknown (not found in repo): production/runtime relevance of `.wrangler/` content beyond local CLI state.

## Architecture

### Legacy Path (`legacy_api/web-ui/`)

```text
Browser
  -> legacy_api/web-ui/index.html + legacy_api/web-ui/logic.v2025-02-07.js
  -> API base selected in UI (board/direct mode)
     -> direct: https://transport.opendata.ch/v1/*
     -> optional proxy: legacy_api/cloudflare-worker/worker.js -> https://transport.opendata.ch/v1/*
```

Relevant files:
- `legacy_api/web-ui/logic.v2025-02-07.js`
- `legacy_api/web-ui/main.v2025-02-07.js`
- `legacy_api/cloudflare-worker/worker.js`

### RT Path (`rt/`)

```text
Browser
  -> rt/frontend/web-ui-rt/*.js
  -> GET /api/stops/*, /api/stationboard, /api/journey, /api/connections
  -> rt/backend/server.js
      -> resolve stop: rt/backend/src/resolve/resolveStop.js
      -> build board: rt/backend/src/logic/buildStationboard.js
      -> merge RT: rt/backend/src/merge/* + rt/backend/loaders/loadRealtime.js
      -> attach alerts: rt/backend/src/loaders/fetchServiceAlerts.js + rt/backend/src/merge/*
      -> canonicalize output: rt/backend/src/models/stationboard.js
  -> Neon/Postgres tables (gtfs_* + app_stop_aliases + rt_updates)
```

Relevant files:
- `rt/backend/server.js`
- `rt/backend/src/api/stationboardRoute.js`
- `rt/backend/src/api/stationboard.js`
- `rt/backend/src/logic/buildStationboard.js`
- `rt/backend/src/models/stationboard.js`

## Legacy vs RT (What Differs)

- Legacy `legacy_api/web-ui/` is a static client with direct/open API style calls and optional Worker proxy mode.
- RT path uses `rt/backend` as a server-side merge layer with SQL + GTFS-RT parsing + canonical stationboard normalization.
- Migration target in repo docs/code direction: `rt/backend` becomes canonical stationboard source; `legacy_api/web-ui/` stays stable until cutover.

## `/api/stationboard` Contract Freeze

Endpoint:
- `GET /api/stationboard` (registered in `rt/backend/server.js` via `createStationboardRouteHandler(...)`).

Route parser and conflict logic source:
- `rt/backend/src/api/stationboardRoute.js`

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
- `Accept-Language` (passed into language preference resolver in `rt/backend/src/api/stationboard.js`).

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
- `rt/backend/test/stationboard.route.test.js`

### include_alerts Gate (M2 Feature Gate)

From `rt/backend/src/api/stationboard.js`:
- `includeAlertsRequested = includeAlerts !== false`
- `includeAlertsApplied = (process.env.STATIONBOARD_ENABLE_M2 !== "0") && includeAlertsRequested`

Debug keys (when debug is enabled):
- `debug.includeAlertsRequested`
- `debug.includeAlertsApplied`
- compatibility keys also present: `debug.includeAlerts`, `debug.requestedIncludeAlerts`

### Response Shape

Top-level (from `rt/backend/src/api/stationboard.js`):
- `station`
- `resolved`
- `banners`
- `departures`
- optional `debug`

Canonical schema file:
- `rt/backend/docs/stationboard.schema.json`

Canonical departure normalizer:
- `rt/backend/src/models/stationboard.js` (`normalizeDeparture`, `computeDisplayFields`)

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
- `rt/backend/scripts/refreshGtfsIfNeeded.js`

Verified flow:
1. Fetch feed metadata (`scripts/getRtFeedVersion.js`, `scripts/fetchAlertsFeedMeta.js`).
2. Compare `meta_kv.gtfs_current_feed_version` with RT version.
3. If changed: download static GTFS permalink, clean required files, import into stage, validate, swap stage to live.
4. Update `meta_kv` + `rt_feed_meta`.

SQL and shell pieces:
- `rt/backend/sql/create_stage_tables.sql`
- `rt/backend/scripts/importGtfsToStage.sh`
- `rt/backend/sql/validate_stage.sql`
- `rt/backend/sql/swap_stage_to_live.sql`

Runtime query source:
- `rt/backend/src/sql/stationboard.sql`

⚠️ **Legacy/dangerous importer** (do not use for production):
- `rt/backend/scripts/legacy/DANGEROUS-direct-live-import.sh`
  - Direct truncation and import into live tables (no validation, no rollback).
  - Kept only for emergency manual recovery. Use `refreshGtfsIfNeeded.js` (staged import) for normal updates.

### GTFS-RT TripUpdates

- Fetcher: `rt/backend/src/loaders/fetchTripUpdates.js`
- Merge/cache/persist layer: `rt/backend/loaders/loadRealtime.js`
- Merge application to scheduled rows: `rt/backend/src/merge/applyTripUpdates.js`
- Added trips merge: `rt/backend/src/merge/applyAddedTrips.js`

Persistence behavior:
- `rt/backend/loaders/loadRealtime.js` creates and upserts `public.rt_updates`.

### GTFS-RT Service Alerts

- Fetch/decode: `rt/backend/src/loaders/fetchServiceAlerts.js`
- Request-time language resolution: `rt/backend/src/util/i18n.js`
- Attachment/synthesis: `rt/backend/src/merge/attachAlerts.js`, `rt/backend/src/merge/synthesizeFromAlerts.js`
- Optional supplement fetch path: `rt/backend/src/merge/supplementFromOtdStationboard.js` (triggered via `getStationboard` flow)

### SIRI

Unknown (not found in repo): active SIRI ingestion, SIRI endpoint clients, or SIRI merge modules in current runtime.

## How To Run (Local)

### Backend (`rt/backend`)

Install and start:

```bash
cd rt/backend
npm ci
npm run dev
```

Production-like start command:

```bash
cd rt/backend
npm start
```

Required env var to boot backend:
- `DATABASE_URL` (checked in `rt/backend/db.js`)

Common API token envs used by loaders/scripts:
- `OPENTDATA_GTFS_RT_KEY`
- `OPENTDATA_GTFS_SA_KEY`
- `GTFS_RT_TOKEN`
- `OPENDATA_SWISS_TOKEN`
- `OPENTDATA_API_KEY`

Run tests:

```bash
cd rt/backend
npm test
```

Schema drift helper:

```bash
cd rt/backend
npm run schema:drift
```

Package scripts available (from `rt/backend/package.json`):
- `npm run import:gtfs:legacy` ⚠️ (dangerous direct-live import, use only for emergency recovery)
- `npm run seed:aliases`
- `npm run sb:filter`

Debug scripts:

```bash
cd rt/backend
node scripts/debugStationboard.js Parent8501120
node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js vallorbe
node scripts/debugTripUpdatesCancelCount.js
```

### Legacy frontend (`legacy_api/web-ui`) and RT frontend (`rt/frontend/web-ui-rt`)

Both frontend folders are static and have their own readmes:
- `legacy_api/web-ui/README.md`
- `rt/frontend/web-ui-rt/README.md`

## Migration Roadmap (M0 -> M5)

This roadmap is the migration plan, not a claim that every milestone is fully complete.

### M0

Goal:
- Stable scheduled stationboard from GTFS static.

Modules involved:
- `rt/backend/src/sql/stationboard.sql`
- `rt/backend/src/logic/buildStationboard.js`
- `rt/backend/src/resolve/resolveStop.js`

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
- `rt/backend/loaders/loadRealtime.js`
- `rt/backend/src/merge/applyTripUpdates.js`
- `rt/backend/src/models/stationboard.js`
- `rt/backend/test/stationboard.model.test.js`

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
- `rt/backend/src/loaders/fetchServiceAlerts.js`
- `rt/backend/src/merge/attachAlerts.js`
- `rt/backend/src/merge/synthesizeFromAlerts.js`
- `rt/backend/src/util/i18n.js`
- `rt/backend/src/api/stationboard.js`

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
- `rt/backend/src/api/stationboardRoute.js`
- `rt/backend/test/stationboard.route.test.js`

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
- `rt/backend/scripts/refreshGtfsIfNeeded.js`
- `rt/backend/docs/stationboard.schema.json`

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
- `rt/backend/*`
- `rt/frontend/web-ui-rt/*`
- operational deploy config (`legacy_api/wrangler.toml`, hosting configuration)

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
- Run refresh/import scripts from `rt/backend/scripts/*` as needed.

Unknown (not found in repo): single canonical migration file that creates all base runtime tables (`gtfs_*`, `app_stop_aliases`, `meta_kv`, `rt_feed_meta`) from scratch.

### Required Tables / Schema Sources in Repo

- Stage-table DDL: `rt/backend/sql/create_stage_tables.sql`
- Stage validation: `rt/backend/sql/validate_stage.sql`
- Stage->live swap: `rt/backend/sql/swap_stage_to_live.sql`
- Runtime stationboard query: `rt/backend/src/sql/stationboard.sql`
- Legacy schema artifact: `rt/backend/schema_gtfs.sql` (non-`gtfs_` table naming)
- Drift helper: `rt/backend/scripts/schemaDriftTask.js`

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

- `gtfs_static_refresh.yml`: hourly + manual, runs `node scripts/refreshGtfsIfNeeded.js` in `rt/backend`.
- `backend_schema_check.yml`: PR/push/manual, validates JSON parse for `rt/backend/docs/stationboard.schema.json`.
- In-repo scheduler currently visible: GitHub Actions cron in `.github/workflows/gtfs_static_refresh.yml`.

Unknown (not found in repo): additional external schedulers (server cron, managed jobs) for GTFS refresh.

### Cloudflare Worker Role

From `legacy_api/cloudflare-worker/worker.js`:
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

- Deployment target for `rt/backend`: **Fly.io**.
- Docker runtime path used in this repo: `rt/backend/Dockerfile`.
- Backend container port: `8080` (set in `rt/backend/Dockerfile`).

Unknown (not found in repo): committed Fly config file path (for example `fly.toml`) and app/region/autoscaling values.

## Troubleshooting Playbooks

### 1) Symptom: cancellations are missing for trains that should be skipped/cancelled

What to inspect:
- `rt/backend/src/merge/applyTripUpdates.js`
- `rt/backend/src/models/stationboard.js`
- `rt/backend/scripts/debugStationboard.js`

Likely causes:
- stop-level `SKIPPED` signal not propagated to canonical cancellation fields
- UI/consumer reading only detail fields and ignoring authoritative `cancelled`

Validate fix:
- run `node scripts/debugStationboard.js Parent8501120`
- confirm affected departures include `cancelled: true` and expected `cancelReasonCode`

### 2) Symptom: delay values look random (too many 0 or null)

What to inspect:
- `rt/backend/src/models/stationboard.js` (`computeDisplayFields`)
- `rt/backend/src/merge/applyTripUpdates.js`
- `rt/backend/loaders/loadRealtime.js`

Likely causes:
- scheduled fallback being interpreted as RT-confirmed
- missing/expired RT feed data

Validate fix:
- inspect per-row `delayMin`, `flags`, and `debug.flags` in debug output
- ensure `delayMin=0` appears only with RT-confirmed signals

### 3) Symptom: alerts/replacements/extra trains not visible

What to inspect:
- `rt/backend/src/api/stationboard.js` (M2 gate and include alerts flow)
- `rt/backend/src/loaders/fetchServiceAlerts.js`
- `rt/backend/src/merge/attachAlerts.js`
- `rt/backend/src/merge/synthesizeFromAlerts.js`

Likely causes:
- `STATIONBOARD_ENABLE_M2=0`
- missing alerts API key
- no active/matching informed entities for requested scope

Validate fix:
- request `/api/stationboard?...&include_alerts=1&debug=1`
- verify `debug.includeAlertsRequested` and `debug.includeAlertsApplied`

### 4) Symptom: stop resolution fails (`unknown_stop`) or wrong station scope

What to inspect:
- `rt/backend/src/resolve/resolveStop.js`
- `rt/backend/src/api/stationboardRoute.js`
- `rt/backend/scripts/seedStopAliases.js`

Likely causes:
- alias table missing or stale
- conflicting params (`stop_id` and `stationId`) with different roots

Validate fix:
- test both parent and platform IDs
- verify conflict payload details for mismatched canonical roots

### 5) Symptom: SQL/runtime drift confusion (`schema_gtfs.sql` vs `gtfs_*`)

What to inspect:
- `rt/backend/schema_gtfs.sql`
- `rt/backend/src/sql/stationboard.sql`
- `rt/backend/sql/*.sql`
- `rt/backend/scripts/schemaDriftTask.js`

Likely causes:
- mixed legacy naming vs current runtime naming

Validate fix:
- run `cd rt/backend && npm run schema:drift`
- reconcile on canonical runtime naming used by active stationboard path

## Where To Change X

- Stationboard query/window issues: `rt/backend/src/sql/stationboard.sql`, `rt/backend/src/logic/buildStationboard.js`
- Param parsing/conflict behavior: `rt/backend/src/api/stationboardRoute.js`
- API response composition and M2 gate: `rt/backend/src/api/stationboard.js`
- Cancellation/delay/status semantics: `rt/backend/src/models/stationboard.js`
- TripUpdates merge behavior: `rt/backend/src/merge/applyTripUpdates.js`
- Alert matching/localization behavior: `rt/backend/src/merge/attachAlerts.js`, `rt/backend/src/util/i18n.js`
- Stop alias resolution: `rt/backend/src/resolve/resolveStop.js`, `rt/backend/scripts/seedStopAliases.js`
- CI refresh/check workflows: `.github/workflows/gtfs_static_refresh.yml`, `.github/workflows/backend_schema_check.yml`
- Legacy UI tweaks: `legacy_api/web-ui/` (separate track; do not mix with RT backend logic)

## How To Contribute Safely

- Keep `legacy_api/web-ui/` and `rt/` changes intentionally separated.
- For RT backend changes, run:

```bash
cd rt/backend
npm test
npm run schema:drift
```

- Keep `/api/stationboard` contract aligned across these files:
- `rt/backend/src/api/stationboardRoute.js` (request parsing + conflict behavior)
- `rt/backend/src/api/stationboard.js` (response assembly + feature gates)
- `rt/backend/src/models/stationboard.js` (canonical departure semantics)
- `rt/backend/docs/stationboard.schema.json` (schema artifact checked by CI)
- Prefer adding regression tests under `rt/backend/test/` for route/model/merge behavior.

## Deep Docs

- `./rt/backend/README.md`
- `./rt/backend/docs/stationboard.schema.json`
- `./rt/README.md`
- `./rt/README-rt.md`
- `./legacy_api/web-ui/README.md`
- `./rt/frontend/web-ui-rt/README.md`
