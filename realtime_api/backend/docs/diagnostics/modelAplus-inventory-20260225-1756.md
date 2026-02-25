# Model A+ Inventory (RT/SA storage + usage)

Date: 2026-02-25 17:56 (local)
Scope: current runtime inventory only (no behavior changes)

## Model A+ target (definition used for this inventory)
- TripUpdates and ServiceAlerts are persisted in parsed relational tables (`rt_trip_updates`, `rt_stop_time_updates`, `rt_service_alerts`) and read directly on stationboard request path.
- `rt_cache.payload` (blob `BYTEA`) is no longer on the stationboard hot path.
- Stationboard output shape remains unchanged (`departures`, `banners`, `rt/meta`, `alerts/meta`, etc.).

## 1) RT/SA tables that exist (with live row counts)
Query source: Postgres `public` schema (`SELECT count(*)` per table).

| Table | Exists | Row count |
| --- | --- | ---: |
| `rt_trip_updates` | yes | 0 |
| `rt_stop_time_updates` | yes | 0 |
| `rt_service_alerts` | yes | 0 |
| `rt_updates` | yes | 31,275 |
| `rt_cache` | yes | 2 |
| `rt_feed_meta` | yes | 2 |
| `meta_kv` | yes | 8 |

Observed `rt_cache` payload sizes:
- `la_servicealerts`: 8,687,320 bytes (8484 kB)
- `la_tripupdates`: 7,555,703 bytes (7379 kB)

## 2) Which tables are written by pollers today (TripUpdates + ServiceAlerts)
Current pollers:
- `realtime_api/backend/scripts/pollLaTripUpdates.js`
- `realtime_api/backend/scripts/pollLaServiceAlerts.js`

Write path today:
- Both pollers write `public.rt_cache` via `upsertRtCache(...)` and metadata updates via `updateRtCacheStatus(...)`.
- Both pollers also write payload SHA to `meta_kv` via `setRtCachePayloadSha(...)`.
- Pollers do **not** write parsed tables (`rt_trip_updates`, `rt_stop_time_updates`, `rt_service_alerts`) in current code.

Code pointers:
- TripUpdates poller blob write: `pollLaTripUpdates.js` (200 path `upsertRtCacheLike(...)`)
- ServiceAlerts poller blob write: `pollLaServiceAlerts.js` (200 path `upsertRtCacheLike(...)`)
- Shared DB upsert/update SQL: `src/db/rtCache.js` (`upsertRtCache`, `updateRtCacheStatus`, `setRtCachePayloadSha`)

Related but not poller-owned:
- `rt_feed_meta` is written in static refresh flow (`scripts/refreshGtfsIfNeeded.js`, `upsertFeedMeta`).

## 3) Which tables are read on stationboard request path today
Stationboard path reads RT/SA from `rt_cache` blobs (directly or through scoped loader/cache wrapper):

TripUpdates request path:
- `src/logic/buildStationboard.js` calls `loadScopedRtFromCache(...)`
- `src/rt/loadScopedRtFromCache.js` calls `readTripUpdatesFeedFromCache(...)`
- `loaders/loadRealtime.js` uses:
  - `getRtCacheMeta(...)` (`octet_length(payload)` metadata read)
  - `getRtCache(...)` (`SELECT payload, fetched_at, etag, last_status, last_error FROM public.rt_cache ...`)
- Underlying SQL in `src/db/rtCache.js`

ServiceAlerts request path:
- `src/api/stationboard.js` calls `loadAlertsFromCacheThrottled(...)`
- `src/rt/loadAlertsFromCache.js` calls `getRtCache(...)` and decodes `payload` blob
- Underlying SQL in `src/db/rtCache.js`

`rt_feed_meta` is read for version-skew debug info in `src/api/stationboard.js` (`fetchVersionSkewDebugInfo`).

No stationboard-path reads found for:
- `rt_trip_updates`
- `rt_stop_time_updates`
- `rt_service_alerts`
- `rt_updates`

## 4) Hot-path DB statements moving payload blobs (`pg_stat_statements`)
Top `rt_cache` payload-related statements observed:

1. `SELECT payload, fetched_at, etag, last_status, last_error FROM public.rt_cache WHERE feed_key = $1 LIMIT $2`
- calls: 231
- total_exec_ms: 10510.439
- mean_exec_ms: 45.500

2. `INSERT INTO public.rt_cache ... payload ... ON CONFLICT ... UPDATE payload = EXCLUDED.payload ...`
- calls: 71
- total_exec_ms: 11113.131
- mean_exec_ms: 156.523

3. `SELECT fetched_at, last_status, octet_length(payload) AS payload_bytes, etag, last_error FROM public.rt_cache ...`
- calls: 249
- total_exec_ms: 4.897
- mean_exec_ms: 0.020

## Code pointers summary (writes/reads)
Writes:
- Poller writes blob cache: `scripts/pollLaTripUpdates.js`, `scripts/pollLaServiceAlerts.js`
- SQL implementation for writes: `src/db/rtCache.js`
- Refresh writes feed meta: `scripts/refreshGtfsIfNeeded.js` (`rt_feed_meta`)

Reads:
- Stationboard RT scope read: `src/logic/buildStationboard.js` -> `src/rt/loadScopedRtFromCache.js` -> `loaders/loadRealtime.js` -> `src/db/rtCache.js`
- Stationboard alerts read: `src/api/stationboard.js` -> `src/rt/loadAlertsFromCache.js` -> `src/db/rtCache.js`

## Can we go blob-free in stationboard now?
Short answer: **No, not now**.

Why:
- Parsed target tables exist but are empty (`rt_trip_updates=0`, `rt_stop_time_updates=0`, `rt_service_alerts=0`).
- Pollers currently populate `rt_cache` blobs, not parsed tables.
- Stationboard request path currently reads/decode blobs from `rt_cache`.

Implication:
- Switching stationboard to parsed tables today would require adding/validating parsed-table writers and read-path adapters first.
- Output shape can likely remain unchanged during migration, but data source cannot be switched safely yet without that ingestion/read-path work.
