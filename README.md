# mesdeparts.ch Repository Guide

Live site reference in repo docs: `https://mesdeparts.ch` (`README.md` history, `web-ui/README.md`).

MesDeparts is a browser-based Swiss departures board project with two parallel frontend tracks and one GTFS/GTFS-RT backend track. The repo contains:
- a legacy/simple static UI in `web-ui/` that can call `transport.opendata.ch` directly or through an optional Cloudflare proxy,
- a newer RT stack in `rt/` built around an Express backend (`rt/backend/`) and a static RT frontend (`rt/frontend/web-ui-rt/`),
- operational scripts and SQL for GTFS static import, GTFS-RT merge, and stationboard generation.

This document is intentionally explicit and uses only repository files as source. If a detail is not verifiable from files in this repo, it is marked as `Unknown (not found in repo)`.

## High-Level Architecture

```text
                      +---------------------------------------------+
                      | transport.opendata.ch / opentransportdata  |
                      |  - /v1 locations/stationboard/connections   |
                      |  - GTFS-RT TripUpdates + Service Alerts     |
                      +--------------------+------------------------+
                                           ^
                                           |
                        (legacy simple path)|
                                           |
+-------------------+        +-----------------------------+
| web-ui/           | -----> | cloudflare-worker/worker.js | ----+
| static frontend   |        | optional proxy/cache/rate    |    |
| (legacy/simple)   |        | limit, forwards to /v1/*     |    |
+-------------------+        +-----------------------------+    |
         |                                                       |
         +--------------------(direct mode)----------------------+


+----------------------------+        +--------------------------+
| rt/frontend/web-ui-rt/     | -----> | rt/backend/server.js     |
| static RT frontend          |  HTTP  | Express API (/api/*)     |
| consumes /api/stationboard  |        | stop resolve + board      |
+----------------------------+        | build + alert merge        |
                                      +------------+--------------+
                                                   |
                                                   v
                                      +--------------------------+
                                      | Neon Postgres            |
                                      | GTFS static tables       |
                                      | rt_updates cache table   |
                                      +--------------------------+
```

Sources:
- `web-ui/logic.v2025-02-07.js`
- `cloudflare-worker/worker.js`
- `rt/frontend/web-ui-rt/logic.v2025-02-07.js`
- `rt/backend/server.js`
- `rt/backend/src/api/stationboard.js`
- `rt/backend/src/logic/buildStationboard.js`

## Repository Layout (Top Level)

### `web-ui/` (legacy/simple UI)
- Purpose: static frontend using simple stationboard/location endpoints and optional proxy mode.
- Main entrypoints:
  - `web-ui/index.html`
  - `web-ui/dual-board.html`
  - `web-ui/main.v2025-02-07.js`
  - `web-ui/logic.v2025-02-07.js`
  - `web-ui/service-worker.js`
  - `web-ui/README.md`

### `rt/` (GTFS static + GTFS-RT stack)
- Purpose: primary real-time architecture with backend API + RT frontend.
- Main entrypoints:
  - `rt/backend/server.js`
  - `rt/frontend/web-ui-rt/index.html`
  - `rt/frontend/web-ui-rt/main.v2025-02-07.js`
  - `rt/README.md`
  - `rt/README-rt.md`

### `cloudflare-worker/` (optional edge proxy/cache)
- Purpose: GET-only proxy to `https://transport.opendata.ch/v1/*` with short TTL cache + simple rate limits.
- Main entrypoint:
  - `cloudflare-worker/worker.js`
- Config:
  - `wrangler.toml` (root)

### `assets/` (root static assets)
- Purpose: contains `location-pin.svg` and `without-icon.svg`.
- Runtime usage: `Unknown (not found in repo)` by source reference search.
- Files:
  - `assets/location-pin.svg`
  - `assets/without-icon.svg`

### `dev-artifacts/` (local artifacts)
- Purpose: contains sample GTFS-RT files.
- Runtime usage: `Unknown (not found in repo)` by source reference search.
- Files:
  - `dev-artifacts/gtfs-rt.json`
  - `dev-artifacts/gtfs-rt.pb`

### `.github/` (CI workflows)
- Purpose: GitHub Actions for GTFS refresh and schema JSON validity check.
- Main files:
  - `.github/workflows/gtfs_static_refresh.yml`
  - `.github/workflows/backend_schema_check.yml`

### `.wrangler/` (local Wrangler state)
- Purpose: local tooling directory for Wrangler.
- Runtime role in app: `Unknown (not found in repo)` beyond local CLI state.

## `rt/` Detailed Inventory and Subprojects

## `rt/backend/` (Express + Postgres + GTFS pipeline)
- Runtime entrypoint: `rt/backend/server.js`
- Package config: `rt/backend/package.json`
- Core API module:
  - `rt/backend/src/api/stationboard.js`
- Core stationboard builder:
  - `rt/backend/src/logic/buildStationboard.js`
  - compatibility wrapper: `rt/backend/logic/buildStationboard.js`
- Canonical stationboard model:
  - `rt/backend/src/models/stationboard.js`
- Merge pipeline:
  - `rt/backend/src/merge/applyTripUpdates.js`
  - `rt/backend/src/merge/applyAddedTrips.js`
  - `rt/backend/src/merge/pickPreferredDeparture.js`
  - `rt/backend/src/merge/attachAlerts.js`
  - `rt/backend/src/merge/synthesizeFromAlerts.js`
  - `rt/backend/src/merge/supplementFromOtdStationboard.js`
- GTFS-RT loaders:
  - `rt/backend/src/loaders/fetchTripUpdates.js`
  - `rt/backend/src/loaders/fetchServiceAlerts.js`
  - `rt/backend/src/loaders/tripUpdatesSummary.js`
- Legacy loader layer still used by runtime:
  - `rt/backend/loaders/loadRealtime.js`
  - `rt/backend/loaders/loadGtfs.js`
- SQL:
  - runtime stationboard query: `rt/backend/src/sql/stationboard.sql`
  - stage/import ops: `rt/backend/sql/*.sql`
  - schema snapshot: `rt/backend/schema_gtfs.sql`
- Scripts:
  - `rt/backend/scripts/refreshGtfsIfNeeded.js`
  - `rt/backend/scripts/importGtfsToStage.sh`
  - `rt/backend/scripts/import-gtfs.sh`
  - `rt/backend/scripts/debugStationboard.js`
  - `rt/backend/scripts/filter-stationboard.js`
  - `rt/backend/scripts/debugTripUpdatesCancelCount.js`
  - `rt/backend/scripts/seedStopAliases.js`
  - `rt/backend/scripts/getRtFeedVersion.js`
  - `rt/backend/scripts/fetchAlertsFeedMeta.js`
- Tests:
  - `rt/backend/test/*.test.js`
- Contract docs:
  - `rt/backend/docs/stationboard.schema.json`
  - `rt/backend/README.md`

## `rt/frontend/web-ui-rt/` (RT static frontend)
- Entry HTML:
  - `rt/frontend/web-ui-rt/index.html`
  - `rt/frontend/web-ui-rt/dual-board.html`
- App boot/logic/UI:
  - `rt/frontend/web-ui-rt/main.v2025-02-07.js`
  - `rt/frontend/web-ui-rt/logic.v2025-02-07.js`
  - `rt/frontend/web-ui-rt/ui.v2025-02-07.js`
  - `rt/frontend/web-ui-rt/state.v2025-02-07.js`
- PWA shell:
  - `rt/frontend/web-ui-rt/service-worker.js`
  - `rt/frontend/web-ui-rt/manifest.webmanifest`
- Docs/tests:
  - `rt/frontend/web-ui-rt/README.md`
  - `rt/frontend/web-ui-rt/test/logic.test.js`

## `rt/test/`
- Contains `rt/test/logic.test.js`.
- Wiring to runtime/package scripts: `Unknown (not found in repo)` for execution by CI or npm scripts.

## `rt/assets/`
- Present but currently empty (no files under `rt/assets` in inventory).

## Runtime Components

## 1) Legacy `web-ui/` frontend

How it fetches departures:
- API base logic in `web-ui/logic.v2025-02-07.js`:
  - `DIRECT_API_BASE = "https://transport.opendata.ch/v1"`
  - `BOARD_API_BASE = window.__MD_API_BASE || DIRECT_API_BASE`
  - `getApiBase()` selects direct vs board by `appState.apiMode`.
- Stationboard calls:
  - `fetchStationboardRaw()` requests `/stationboard?station=...&limit=...`.
- Stop search calls:
  - `/locations?query=...`
  - `/locations?type=station&x=...&y=...`

Entrypoints/config:
- `web-ui/index.html` sets `window.__MD_API_BASE__ = "https://api.mesdeparts.ch"`.
- `web-ui/dual-board.html` also sets `window.__MD_API_BASE__`.
- `web-ui/main.v2025-02-07.js` bootstraps refresh loop and UI wiring.

Service worker behavior:
- `web-ui/service-worker.js` caches shell assets and clock assets.
- API requests are network-only (explicit comment and logic in file).

## 2) RT stack (`rt/backend` + `rt/frontend/web-ui-rt`)

RT frontend behavior:
- `rt/frontend/web-ui-rt/logic.v2025-02-07.js` targets backend endpoints:
  - `/api/stops/search`
  - `/api/stops/nearby`
  - `/api/stationboard`
  - `/api/journey`
  - `/api/connections`
- Default API base:
  - from `window.__MD_API_BASE__`, or
  - `http://localhost:3001` on localhost, or
  - same-origin empty prefix.

RT backend runtime:
- `rt/backend/server.js` starts Express and exposes:
  - `GET /health`
  - `GET /api/stops/search`
  - `GET /api/stops/nearby`
  - `GET /api/journey`
  - `GET /api/connections`
  - `GET /api/stationboard`
  - `GET /api/debug/alerts`
  - `GET /api/_debug/tripupdates_summary` (only when debug flag is enabled by query or env)
- `GET /api/stationboard` delegates to `getStationboard()` in `rt/backend/src/api/stationboard.js`.

## 3) Cloudflare Worker (optional)

Source:
- `cloudflare-worker/worker.js`
- `wrangler.toml`

Behavior verified from code:
- Accepts `GET` only; other methods return `405`.
- Forwards request to upstream:
  - `https://transport.opendata.ch/v1${pathname}${query}`.
- Cache TTL by path:
  - `/stationboard` -> 10s
  - `/connections` -> 25s
  - `/locations` with coords (`x`,`y`) -> 120s
  - `/locations` without coords -> 86400s
  - default -> 30s
- CORS enabled (`Access-Control-Allow-Origin: *`).
- Rate limiting:
  - per-IP per minute (`RATE_LIMIT_PER_MIN`, default 120)
  - optional global daily (`GLOBAL_DAILY_LIMIT`, default 0 = disabled)

## 4) Database role and schema sources

DB connection:
- `rt/backend/db.js` creates a `pg.Pool` using `DATABASE_URL` with SSL required.
- Backend exits on missing `DATABASE_URL`.

Runtime table usage (as referenced by queries/code):
- `gtfs_stop_times`, `gtfs_trips`, `gtfs_routes`, `gtfs_calendar`, `gtfs_calendar_dates`, `gtfs_stops`:
  - used by `rt/backend/src/sql/stationboard.sql`
  - used by `rt/backend/src/logic/buildStationboard.js`
  - used by `rt/backend/src/resolve/resolveStop.js`

Other runtime tables:
- `rt_updates` created/maintained by `rt/backend/loaders/loadRealtime.js`.
- `app_stop_aliases` read by `rt/backend/src/resolve/resolveStop.js`, seeded by `rt/backend/scripts/seedStopAliases.js`.

Schema source files in repo:
- `rt/backend/schema_gtfs.sql` defines `agencies/stops/routes/trips/stop_times/...` (non-`gtfs_` names).
- `rt/backend/sql/create_stage_tables.sql` expects existing base `gtfs_*` tables and creates `*_stage` copies.

Schema status note:
- Table creation for base `gtfs_*` and for `app_stop_aliases` is `Unknown (not found in repo)` as standalone `CREATE TABLE` statements.
- This likely means schema exists already in deployment DB or is managed outside this repo.

## Data Pipeline

## GTFS static import flow

Primary automated refresh script:
- `rt/backend/scripts/refreshGtfsIfNeeded.js`

What it does (verified in script):
1. Reads feed metadata:
   - trip updates via `scripts/getRtFeedVersion.js`
   - service alerts via `scripts/fetchAlertsFeedMeta.js`
2. Compares `rtVersion` against DB key `meta_kv.gtfs_current_feed_version`.
3. If unchanged:
   - writes feed metadata to `public.rt_feed_meta` and exits.
4. If changed:
   - downloads static zip permalink:
     - `https://data.opentransportdata.swiss/fr/dataset/timetable-2026-gtfs2020/permalink`
   - unzips and cleans required GTFS files:
     - `agency.txt`, `stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `calendar_dates.txt`
   - creates stage tables: `sql/create_stage_tables.sql`
   - imports cleaned files: `scripts/importGtfsToStage.sh`
   - validates stage refs: `sql/validate_stage.sql`
   - swaps stage to live: `sql/swap_stage_to_live.sql`
   - updates `meta_kv` and `rt_feed_meta`.

Supporting SQL/scripts:
- `rt/backend/sql/create_stage_tables.sql`
- `rt/backend/sql/validate_stage.sql`
- `rt/backend/sql/swap_stage_to_live.sql`
- `rt/backend/scripts/importGtfsToStage.sh`

Legacy/manual importer also present:
- `rt/backend/scripts/import-gtfs.sh`
- imports from local CSV folder (`rt/data/gtfs-static-local` or fallback `rt/data/gtfs-static`) into `public.stops/public.routes/...` table family.
- This flow uses non-`gtfs_` table names and appears legacy compared to stage `gtfs_*` flow.

## GTFS-RT ingestion and merge flow

Trip updates loading:
- fetch from opentransportdata JSON endpoint:
  - `rt/backend/src/loaders/fetchTripUpdates.js`
  - URL default: `https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON`
- delay index/cache:
  - `rt/backend/loaders/loadRealtime.js`
  - builds `byKey`, `cancelledTripIds`, `stopStatusByKey`, `tripFlagsByTripId`, `addedTripStopUpdates`
  - caches by TTL (`GTFS_RT_CACHE_MS`, minimum derived from max calls/min)
  - persists rows into `public.rt_updates`

Service alerts loading:
- protobuf GTFS-RT alerts endpoint:
  - `rt/backend/src/loaders/fetchServiceAlerts.js`
  - URL default: `https://api.opentransportdata.swiss/la/gtfs-sa`
- normalization includes:
  - `informedEntities`
  - `activePeriods`
  - translation arrays (`headerTranslations`, `descriptionTranslations`)

Stationboard build and merge stages:
1. Scheduled base rows from Postgres:
   - `rt/backend/src/logic/buildStationboard.js` + `rt/backend/src/sql/stationboard.sql`
2. Apply trip updates to scheduled rows:
   - `rt/backend/src/merge/applyTripUpdates.js`
3. Add ADDED trips:
   - `rt/backend/src/merge/applyAddedTrips.js`
4. Dedupe preference:
   - `rt/backend/src/merge/pickPreferredDeparture.js`
5. Alert synthesis (timed synthetic rows only when explicit times exist):
   - `rt/backend/src/merge/synthesizeFromAlerts.js`
6. Attach alerts and banner extraction:
   - `rt/backend/src/merge/attachAlerts.js`
7. Optional OTD supplement for replacement-like rows:
   - `rt/backend/src/merge/supplementFromOtdStationboard.js`
8. Canonical model normalization:
   - `rt/backend/src/models/stationboard.js`

## Stationboard Contract (`/api/stationboard`)

## Request parameters (as implemented)

Source: `rt/backend/server.js` route `GET /api/stationboard`.

Accepted query params:
- `stop_id` (preferred)
- `stationId` or `station_id` (accepted aliases)
- `stationName` (optional, used in stop resolution and supplementary flows)
- `lang` (optional alert localization preference)
- `limit` (optional, numeric)
- `window_minutes` (optional, numeric)
- `debug` (optional; truthy values accepted: `1`, `true`, `yes`)

Headers:
- `Accept-Language` is forwarded to stationboard logic for alert text localization.

Validation:
- If both `stop_id` and `stationId` are missing, returns HTTP 400 with `missing_stop_id`.

## Response top-level shape

Built in `rt/backend/src/api/stationboard.js`:
- `station: { id, name }`
- `resolved: { canonicalId, source, childrenCount }`
- `banners: []`
- `departures: []` (canonicalized)
- optional `debug` when debug enabled

Schema reference:
- `rt/backend/docs/stationboard.schema.json`

## Canonical departure fields

Canonicalization source:
- `rt/backend/src/models/stationboard.js` (`normalizeDeparture`, `computeDisplayFields`)

Current emitted fields include:
- identity/route:
  - `key`, `trip_id`, `route_id`, `stop_id`, `stop_sequence`
- presentation:
  - `line`, `category`, `number`, `destination`
- times:
  - `scheduledDeparture`, `realtimeDeparture`, `delayMin`
- platform:
  - `platform`, `platformChanged`
- cancellation/replacement:
  - `cancelled`, `cancelReasonCode`, `replacementType`
- alerts:
  - `alerts[]` with `{ id, severity, header, description }`
- detail fields:
  - `status`, `flags`, `stopEvent`
- debug:
  - `debug: { source, flags }`

## Invariants and semantics

Authoritative cancellation:
- `cancelled` is authoritative.
- `cancelled` is forced true when either:
  - trip-level cancellation is present (`TRIP_CANCELLED`), or
  - stop is skipped/suppressed (`STOP_SKIPPED`).
- Relevant code:
  - `rt/backend/src/merge/applyTripUpdates.js`
  - `rt/backend/src/models/stationboard.js`

Cancellation detail fields:
- `cancelReasonCode` precedence:
  - trip cancel -> `CANCELED_TRIP`
  - skipped stop -> `SKIPPED_STOP`
- `stopEvent`:
  - `SKIPPED` when skipped-stop signal exists.
- `flags` may include:
  - `TRIP_CANCELLED`, `STOP_SKIPPED`, `REPLACEMENT_SERVICE`, `EXTRA_SERVICE`, `SHORT_TURN`, `SHORT_TURN_TERMINUS`, `RT_CONFIRMED`.

Delay semantics (`computeDisplayFields`):
- If `realtimeDeparture` missing/unparseable -> `delayMin = null`.
- If schedule missing/unparseable -> `delayMin = null`.
- If realtime differs from scheduled -> rounded minute delta.
- If realtime equals scheduled:
  - `delayMin = 0` only when RT-confirmed (`flags` has `RT_CONFIRMED` or debug flag `rt:confirmed`),
  - otherwise `delayMin = null` (scheduled fallback).
- Debug flags annotate decision path:
  - `delay:unknown_no_rt`
  - `delay:unknown_no_schedule`
  - `delay:from_rt_diff`
  - `delay:rt_equal_confirmed_zero`
  - `delay:unknown_scheduled_fallback`

Status values:
- Emitted values in current model:
  - `CANCELLED`, `SKIPPED_STOP`, `UNKNOWN`, `DELAYED`, `EARLY`, `ON_TIME`.
- Source: `rt/backend/src/models/stationboard.js`.

## Debug payload (`debug=1` or env-enabled)

Top-level `debug` (from `rt/backend/src/api/stationboard.js`) can include:
- `requestId`
- `stopResolution`
- `timeWindow`
- `stageCounts`
- `langPrefs`
- `alerts_error` (non-production error fallback path)

Per-departure debug always exists in canonicalized output:
- `debug.source`
- `debug.flags`

Global debug gate:
- query `debug=1|true|yes`
- or env `STATIONBOARD_DEBUG_JSON` truthy via `shouldEnableStationboardDebug(...)`.

## Alert language selection behavior

Files:
- `rt/backend/src/util/i18n.js`
- `rt/backend/src/loaders/fetchServiceAlerts.js`
- `rt/backend/src/api/stationboard.js`

Behavior:
- `?lang=` has highest priority (`resolveLangPrefs`).
- else use `Accept-Language` with q-weight ordering.
- translation pick order:
  1. exact/prefix language match,
  2. fallback German (`de`),
  3. first available translation.

## How To Run Locally

## Prerequisites

- Node.js:
  - workflows use Node 20 (`.github/workflows/*.yml`),
  - explicit `engines` field in package files: `Unknown (not found in repo)`.
- PostgreSQL/Neon access:
  - `DATABASE_URL` required by backend (`rt/backend/db.js`).
- GTFS tokens used by scripts/backend:
  - `OPENTDATA_GTFS_RT_KEY`
  - `OPENTDATA_GTFS_SA_KEY`
  - legacy aliases also accepted in code (`GTFS_RT_TOKEN`, `OPENDATA_SWISS_TOKEN`, `OPENTDATA_API_KEY`).

Quick env key list from `rt/backend/.env` currently present:
- `DATABASE_URL`
- `DEBUG_RT`
- `ENABLE_RT`
- `GTFS_RT_CACHE_MS`
- `GTFS_RT_MAX_CALLS_PER_MIN`
- `GTFS_RT_TOKEN`
- `NODE_ENV`
- `OPENTDATA_GTFS_RT_KEY`
- `OPENTDATA_GTFS_SA_KEY`

## Start backend (RT API)

```bash
cd rt/backend
npm ci
npm run dev
```

Production start script (same folder):

```bash
npm start
```

## Serve RT frontend (static)

```bash
cd rt/frontend/web-ui-rt
python3 -m http.server 8001
```

Then open `http://localhost:8001`.

## Serve legacy web-ui (static)

```bash
cd web-ui
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Import/refresh GTFS static data

Automated refresh pipeline:

```bash
cd rt/backend
export DATABASE_URL='...'
export OPENTDATA_GTFS_RT_KEY='...'
export OPENTDATA_GTFS_SA_KEY='...'
node scripts/refreshGtfsIfNeeded.js
```

Manual stage import from cleaned GTFS directory:

```bash
cd rt/backend
export DATABASE_URL='...'
bash scripts/importGtfsToStage.sh /path/to/clean_gtfs_dir
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/validate_stage.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/swap_stage_to_live.sql
```

Legacy importer (CSV-based flow):

```bash
cd rt/backend
export DATABASE_URL='...'
bash scripts/import-gtfs.sh
```

## Run tests

Backend:

```bash
cd rt/backend
npm test
```

Legacy web-ui:

```bash
cd web-ui
npm test
```

RT frontend:

```bash
cd rt/frontend/web-ui-rt
npm test
```

## Debug scripts

Stationboard debug snapshot:

```bash
cd rt/backend
node scripts/debugStationboard.js Parent8501120
```

Filter debug JSON from stdin:

```bash
cd rt/backend
node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js vallorbe
```

TripUpdate cancellation signal summary:

```bash
cd rt/backend
node scripts/debugTripUpdatesCancelCount.js
```

Feed metadata helpers:

```bash
cd rt/backend
node scripts/getRtFeedVersion.js
node scripts/fetchAlertsFeedMeta.js
```

Seed stop aliases:

```bash
cd rt/backend
node scripts/seedStopAliases.js
```

## Deployment and Operations

## Static frontends

Documented in:
- `web-ui/README.md`
- `rt/frontend/web-ui-rt/README.md`

Both are static folders (no bundler/build step required).

## Cloudflare Worker config

`wrangler.toml` values:
- `name = "mesdeparts-ch"`
- `main = "cloudflare-worker/worker.js"`
- `compatibility_date = "2025-12-17"`
- optional `routes` block is commented out.

Exact deploy command in repo docs/scripts: `Unknown (not found in repo)`.

## GitHub Actions

`GTFS Static Refresh`:
- file: `.github/workflows/gtfs_static_refresh.yml`
- trigger: hourly cron + manual dispatch
- runs:
  - `npm ci` in `rt/backend`
  - `node scripts/refreshGtfsIfNeeded.js`
- requires secrets:
  - `NEON_DATABASE_URL`
  - `OPENTDATA_GTFS_RT_KEY`
  - `OPENTDATA_GTFS_SA_KEY`

`Backend Schema Check`:
- file: `.github/workflows/backend_schema_check.yml`
- trigger: PRs touching `rt/backend/**`, pushes to `main` touching same paths, manual dispatch
- runs JSON parse validation for:
  - `rt/backend/docs/stationboard.schema.json`

## Troubleshooting

## 1) Missing or random delays

Check:
- delay logic: `rt/backend/src/models/stationboard.js` (`computeDisplayFields`)
- RT match and source flags: `rt/backend/src/merge/applyTripUpdates.js`
- RT feed/index loading: `rt/backend/loaders/loadRealtime.js`

Common reason:
- row fell back to scheduled source without confirmed RT match, so `delayMin` can be `null` by design.

## 2) Cancellation not shown for skipped stops

Check:
- skipped stop mapping in merge:
  - `rt/backend/src/merge/applyTripUpdates.js` (`SKIPPED` -> `suppressedStop`, tag `skipped_stop`, `cancelled=true`)
- canonical cancellation mapping:
  - `rt/backend/src/models/stationboard.js`

Debug aids:
- `rt/backend/scripts/debugStationboard.js`
- `rt/backend/scripts/filter-stationboard.js`

## 3) Alert language appears wrong or stuck

Check:
- language preference parsing:
  - `rt/backend/src/util/i18n.js`
- translation selection at request time:
  - `rt/backend/src/api/stationboard.js` (`localizeServiceAlerts`)
- translation payload normalization:
  - `rt/backend/src/loaders/fetchServiceAlerts.js`

## 4) Stop resolution fails (`unknown_stop`)

Check:
- resolver logic:
  - `rt/backend/src/resolve/resolveStop.js`
- alias table seed script:
  - `rt/backend/scripts/seedStopAliases.js`

Important:
- resolver reads `public.app_stop_aliases`.
- creation migration for `app_stop_aliases` table is `Unknown (not found in repo)`.

## 5) SQL editor shows errors in `stationboard.sql`

If runtime works but editor flags syntax:
- likely false positives from PostgreSQL placeholders (`$1`, `$2`, ...).
- runtime execution path:
  - file read in `rt/backend/src/logic/buildStationboard.js`
  - executed via `pg` prepared query.

## 6) Stationboard query timeouts

Check:
- optimization script:
  - `rt/backend/sql/optimize_stationboard.sql`
- query timeout envs used in builder:
  - `STATIONBOARD_MAIN_QUERY_TIMEOUT_MS`
  - `STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS`
  - `STATIONBOARD_TERMINUS_QUERY_TIMEOUT_MS`

## Source of Truth and Ownership

- `rt/backend/` is source of truth for RT stationboard semantics and `/api/stationboard` contract.
  - Canonical model: `rt/backend/src/models/stationboard.js`
  - API assembly: `rt/backend/src/api/stationboard.js`
- `rt/frontend/web-ui-rt/` is presentation/client behavior over backend data.
- `web-ui/` is legacy/simple API path (separate data contract and API endpoints).
- `cloudflare-worker/` is optional legacy proxy/cache layer for simple API paths.
- Stationboard contract documentation artifacts:
  - human docs: `rt/backend/README.md`
  - JSON schema: `rt/backend/docs/stationboard.schema.json`

Compatibility wrappers currently present:
- `rt/backend/src/rt/*.js` re-export from `rt/backend/src/loaders/*.js`
- `rt/backend/logic/buildStationboard.js` re-exports from `rt/backend/src/logic/buildStationboard.js`

## Glossary

- GTFS:
  - General Transit Feed Specification static schedule files (`stops.txt`, `trips.txt`, `stop_times.txt`, etc.).
- GTFS-RT:
  - realtime feed layer (TripUpdates, Service Alerts).
- TripUpdate:
  - GTFS-RT entity describing realtime trip/stop updates and schedule relationships.
- Service Alert:
  - GTFS-RT alert entity with informed entities, active periods, and translated text.
- Stationboard:
  - departure list for a requested stop/station scope (`/api/stationboard`).
- `stop_id` variants:
  - parent-like ID: `Parent8501120`
  - platform-scoped ID: `8501120:0:7`
  - SLOID-like ID observed in matching logic: `ch:1:sloid:1120`
- `cancelled`:
  - authoritative boolean for cancellation in canonical departure output.
- `status`:
  - detail enum-like field (`CANCELLED`, `SKIPPED_STOP`, `DELAYED`, etc.), not authoritative on its own.
- `delayMin`:
  - computed minute delta; may be `null` when realtime confidence is absent.
- Replacement service:
  - rows/tagging inferred from `EV` and replacement-related signals (alerts/text/tags).

## Ambiguities and TODOs (Verified Gaps)

- Base DDL for `public.gtfs_*` live tables is not present as a direct creation migration in this repo.
  - Stage SQL assumes these tables already exist.
  - `Unknown (not found in repo)` where that DDL is managed.
- `public.app_stop_aliases` is queried/seeded/swapped but no explicit create migration is present.
  - `Unknown (not found in repo)` where table is created.
- `rt/backend/schema_gtfs.sql` uses non-`gtfs_` table names (`stops`, `trips`, etc.), while runtime SQL references `gtfs_*`.
  - Indicates historical or parallel schema versions in repo.
- Root `assets/` usage and `dev-artifacts/` runtime usage are not referenced by application code.
  - `Unknown (not found in repo)` for active runtime integration.
- `rt/test/logic.test.js` exists but no npm script/workflow in repo references it.
  - `Unknown (not found in repo)` whether it is actively used.
