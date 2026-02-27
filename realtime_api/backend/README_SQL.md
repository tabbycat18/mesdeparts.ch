# Backend SQL Guide

Docs index: [`../README_INDEX.md`](../README_INDEX.md)

This file documents SQL files used by the active realtime backend.

## Scope

- Folder covered: `realtime_api/backend/sql/`
- Related runtime SQL file: `realtime_api/backend/src/sql/stationboard.sql`
- Script orchestration source: `realtime_api/backend/scripts/refreshGtfsIfNeeded.js`

## Quick map (what each SQL file is for)

| File | Role | Triggered by | Operational criticality |
| --- | --- | --- | --- |
| `sql/create_stage_tables.sql` | Recreate all `*_stage` GTFS tables (drop + create LIKE live). | `refreshGtfsIfNeeded.js` | Critical in refresh pipeline |
| `sql/validate_stage.sql` | Referential sanity check on staged GTFS (`stop_times` -> `stops/trips`). | `refreshGtfsIfNeeded.js` | Critical in refresh pipeline |
| `sql/swap_stage_to_live_cutover.sql` | Atomic zero-downtime rename swap from stage to live + alias restore. | `refreshGtfsIfNeeded.js` | Critical in refresh pipeline |
| `sql/optimize_stop_search.sql` | Build/swap `stop_search_index`, maintain stop-search functions/aliases/indexes. | `refreshGtfsIfNeeded.js` and manual | Critical in refresh pipeline |
| `sql/cleanup_old_after_swap.sql` | Drop `*_old` GTFS tables after successful cutover. | `refreshGtfsIfNeeded.js` | Non-fatal post-step |
| `sql/create_rt_cache.sql` | Create `public.rt_cache` table for poller/API cache exchange. | Manual ops / provisioning | Critical for poller-only RT strategy |
| `sql/create_rt_poller_heartbeat.sql` | Create `public.rt_poller_heartbeat` table for poller freshness/health tracking. | Manual ops / provisioning | Critical for stale-RT diagnostics |
| `sql/add_alert_translations_jsonb.sql` | One-time migration: add `header_translations` + `description_translations` JSONB columns and two GIN indexes to `public.rt_service_alerts`. | Manual ops / migration | Applied once after initial table creation |
| `sql/add_rt_upsert_unique_constraints.sql` | No-op checklist artifact: confirms `rt_trip_updates` and `rt_stop_time_updates` PKs already satisfy `ON CONFLICT` targets; no DDL runs. | Informational only | None |
| `sql/optimize_stationboard.sql` | Backfill time-seconds columns + add stationboard indexes (non-concurrent). | Manual ops | Performance optimization |
| `sql/optimize_stationboard_latency.sql` | Add low-lock concurrent latency indexes for stops/aliases/stoptimes. | Manual ops | Performance optimization |
| `sql/legacy/schema_gtfs.sql` | Historical legacy schema/bootstrap SQL kept for archive/reference only. | Legacy audits only | Not in active runtime path |
| `src/sql/stationboard.sql` | Main scheduled stationboard SELECT used at request time. | Loaded by `src/logic/buildStationboard.js` | Runtime-critical query |

## Refresh pipeline order (verified from code)

`refreshGtfsIfNeeded.js` runs SQL in this order:

1. `create_stage_tables.sql`
2. import shell script (`scripts/importGtfsToStage.sh`)
3. `validate_stage.sql`
4. `swap_stage_to_live_cutover.sql`
5. `optimize_stop_search.sql` (fatal if it fails, only when rebuild is needed)
6. `cleanup_old_after_swap.sql` (non-fatal if it fails)

Behavior notes:
- A session advisory lock gates DB-heavy refresh/rebuild sections (`pg_try_advisory_lock`); concurrent runs exit with `refresh already running`.
- Fast no-op path: if static SHA256 equals `meta_kv.gtfs_static_sha256`, import and search rebuild are skipped.
- `stop_search_index` rebuild is idempotent and guarded by metadata:
  - request flag: `meta_kv.gtfs_stop_search_rebuild_requested`
  - last rebuild SHA: `meta_kv.gtfs_stop_search_last_rebuild_sha256`
  - last rebuild timestamp: `meta_kv.gtfs_stop_search_last_rebuild_at`
  - minimum interval: `GTFS_STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS` (default `6`)
- `optimize_stop_search.sql` failure is treated as hard failure.
- `cleanup_old_after_swap.sql` failure is logged as non-fatal and can be retried.
- After search optimization, alias sync script is attempted (`syncStopSearchAliases.js`) as non-fatal.

## File details

### `sql/create_stage_tables.sql`

- Drops and recreates:
  - `gtfs_agency_stage`, `gtfs_stops_stage`, `gtfs_routes_stage`, `gtfs_trips_stage`,
    `gtfs_calendar_stage`, `gtfs_calendar_dates_stage`, `gtfs_stop_times_stage`.
- Uses `CREATE TABLE ... (LIKE public.<live> INCLUDING ALL)` to mirror live schema/index defaults.

### `sql/validate_stage.sql`

- Validates stage data references before cutover:
  - no `gtfs_stop_times_stage.stop_id` missing in `gtfs_stops_stage`
  - no `gtfs_stop_times_stage.trip_id` missing in `gtfs_trips_stage`
- Raises exception to abort refresh when invalid.

### `sql/swap_stage_to_live_cutover.sql`

- Runs inside a transaction (`BEGIN/COMMIT`).
- Drops stale `*_old` tables at transaction start (`DROP TABLE IF EXISTS`) so reruns do not fail on name conflicts.
- Validates stage counts are non-zero before swap.
- Performs atomic metadata renames:
  - live tables -> `_old`
  - stage tables -> live names
- Restores `app_stop_aliases` via FK-aware logic after swap.
- Keeps lock window minimal by avoiding heavy data copy in cutover step.
- Does not drop the newly created `_old` backup tables from the current swap; cleanup is separate.

### `sql/cleanup_old_after_swap.sql`

- Separate transaction that drops:
  - `gtfs_agency_old`, `gtfs_stops_old`, `gtfs_routes_old`, `gtfs_trips_old`,
    `gtfs_calendar_old`, `gtfs_calendar_dates_old`, `gtfs_stop_times_old`.
- Intended after successful cutover and index rebuild.

### `sql/optimize_stop_search.sql`

Main responsibilities:

- Ensures optional extensions when possible (`pg_trgm`, `unaccent`) with graceful notices on privilege limits.
- Creates/updates normalization functions:
  - `public.md_unaccent(text)`
  - `public.normalize_stop_search_text(text)`
  - `public.strip_stop_search_terms(text)`
- Maintains alias tables and seed specs:
  - `public.stop_aliases`
  - `public.stop_alias_seed_specs`
  - optional sync from `public.app_stop_aliases`
- Builds `public.stop_search_index_new` materialized view, creates indexes, then atomically swaps to `public.stop_search_index`.
- Verifies canonical index presence/validity after swap.
- Analyzes search tables.

Operational notes:
- Designed to be idempotent and tolerant of mixed historical states.
- Includes explicit reconciliation for legacy/new index names during swap.

Safe edit guidance for search SQL:

- Prefer editing alias/spec data before changing SQL predicates.
- If normalization regex/transforms change in SQL, mirror equivalent behavior in:
  - `src/util/searchNormalize.js`
  - and re-run regression tests immediately.
- Keep zero-downtime swap mechanics intact:
  - build `_new` materialized view
  - create `_new` indexes
  - atomic rename to canonical names
  - verification block after swap
- Avoid removing fallback-friendly pieces (`LIKE`, trigram branches, token-AND checks) unless replaced with equivalent behavior.

### `sql/create_rt_cache.sql`

- Creates shared poller/API cache table:
  - `public.rt_cache(feed_key, fetched_at, payload, etag, last_status, last_error)`.
- Required for poller-only upstream strategy.

### `sql/create_rt_poller_heartbeat.sql`

- Creates shared poller heartbeat table:
  - `public.rt_poller_heartbeat(id, updated_at, tripupdates_updated_at, alerts_updated_at, last_error, instance_id)`.
- Used by pollers to expose:
  - latest successful parsed snapshot time per feed
  - latest poller error message (`last_error`)
  - instance attribution (`instance_id`)
- Used by `scripts/checkPollerHeartbeat.js` for fast stale-RT diagnostics.

### `sql/add_alert_translations_jsonb.sql`

- One-time migration applied to `public.rt_service_alerts`.
- Adds two JSONB columns:
  - `header_translations jsonb DEFAULT NULL` — full multi-language array `[{language, text}, ...]`
  - `description_translations jsonb DEFAULT NULL` — same structure for description
- Adds two GIN indexes:
  - `idx_rt_service_alerts_header_translations`
  - `idx_rt_service_alerts_description_translations`
- Fallback behavior: if columns are NULL, consuming code falls back to the existing single-language `header_text` / `description_text` columns.
- Safe to inspect before re-running: the `ALTER TABLE ... ADD COLUMN` will fail if columns already exist (uses plain `ADD COLUMN`, not `ADD COLUMN IF NOT EXISTS`); `CREATE INDEX IF NOT EXISTS` is safe to re-run.

### `sql/add_rt_upsert_unique_constraints.sql`

- Contains no executable DDL.
- Documents that `rt_trip_updates` and `rt_stop_time_updates` already have PKs that serve as `ON CONFLICT` targets for incremental upsert:
  - `rt_trip_updates PRIMARY KEY (trip_id)`
  - `rt_stop_time_updates PRIMARY KEY (trip_id, stop_sequence)`
- Kept as a deployment checklist artifact only. Safe to read; no-op to run.

### `sql/optimize_stationboard.sql`

- Adds and backfills:
  - `gtfs_stop_times.arrival_time_seconds`
  - `gtfs_stop_times.departure_time_seconds`
- Adds hot indexes for stationboard-style filtering.
- Runs `ANALYZE` on core GTFS tables.

Operational notes:
- Uses regular (non-concurrent) index creation.
- Best run during low-traffic maintenance windows.

### `sql/optimize_stationboard_latency.sql`

- Adds concurrent indexes to reduce lock impact:
  - `gtfs_stops(parent_station)`
  - expression index on `COALESCE(parent_station, stop_id)`
  - `LOWER(alias)` on `app_stop_aliases`
  - `gtfs_stop_times(stop_id, departure_time_seconds, trip_id, stop_sequence)` partial
- Runs `ANALYZE`.

Operational notes:
- Uses `CREATE INDEX CONCURRENTLY`; do not wrap in an outer transaction.

### `src/sql/stationboard.sql` (runtime query)

- Main scheduled departure query used by `src/logic/buildStationboard.js`.
- Filters by stop scope, departure time window, service calendar activity, and dedupes by trip/stop/sequence.
- Returns rows consumed by merge pipeline (`applyTripUpdates`, `applyAddedTrips`, alerts synthesis/attach downstream).
- Stop-id platform/parent/root RT matching behavior is implemented in JS merge/scope layers
  (`src/merge/applyTripUpdates.js`, `src/rt/loadScopedRtFromCache.js`), not in SQL.

## Runbook snippets

From `realtime_api/backend`:

```bash
# Create shared RT cache table
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/create_rt_cache.sql

# Create poller heartbeat table
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/create_rt_poller_heartbeat.sql

# Stationboard performance indexes/backfill
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stationboard.sql

# Lower-lock latency index pass
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stationboard_latency.sql

# Stop-search rebuild/swap
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stop_search.sql
```

## What to edit for common SQL changes

| Change goal | Primary SQL file |
| --- | --- |
| Stage import/cutover table choreography | `sql/create_stage_tables.sql`, `sql/swap_stage_to_live_cutover.sql`, `sql/cleanup_old_after_swap.sql` |
| Stage referential gate | `sql/validate_stage.sql` |
| Stop-search normalization/index behavior | `sql/optimize_stop_search.sql` |
| RT cache table shape | `sql/create_rt_cache.sql` |
| Poller heartbeat/staleness table shape | `sql/create_rt_poller_heartbeat.sql` |
| Service alert multi-language translation columns | `sql/add_alert_translations_jsonb.sql` |
| Stationboard DB performance tuning | `sql/optimize_stationboard.sql`, `sql/optimize_stationboard_latency.sql` |
| Runtime scheduled board selection logic | `src/sql/stationboard.sql` |

## Legacy SQL note

- `sql/legacy/schema_gtfs.sql` is intentionally archived in the realtime repo for reference.
- It is not part of the active refresh pipeline (`refreshGtfsIfNeeded.js`) and not required by request-path runtime.
- Do not modify this file for current runtime behavior; use canonical SQL files under `sql/` and `src/sql/`.

## Vestigial tables (confirmed dead code)

### `rt_updates`

- **Created dynamically** by `persistRtUpdates()` in `realtime_api/backend/loaders/loadRealtime.js` via a `CREATE TABLE IF NOT EXISTS` inside the function body.
- `persistRtUpdates()` is never called from `server.js` or any active request handler. Only test files reference these dead-code exports.
- If the `rt_updates` table exists in the DB, it is vestigial — not written to or read from in normal operation. It can be safely dropped:
  ```sql
  DROP TABLE IF EXISTS public.rt_updates;
  ```
- There is no provisioning SQL file for this table; it does not appear in any `sql/` file. Its existence in the DB would be the result of a historical test or experimental run of the dead code path.

## Search-change SQL verification gate

After any stop-search SQL change:

1. Rebuild/swap search SQL objects:
   - `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stop_search.sql`
   - Optional request-path trigger for next refresh run:
     - `INSERT INTO public.meta_kv(key, value, updated_at) VALUES ('gtfs_stop_search_rebuild_requested','1',NOW()) ON CONFLICT (key) DO UPDATE SET value='1', updated_at=NOW();`
2. Run app-level regression checks:
   - `node --test test/stopSearch.test.js test/stopSearch.degraded.test.js test/stopSearch.route.test.js`
   - `npm run search:repro-regression`
   - `npm run search:verify`
3. Check performance:
   - `npm run search:bench`

Do not deploy search SQL changes if regression or verify checks fail.
