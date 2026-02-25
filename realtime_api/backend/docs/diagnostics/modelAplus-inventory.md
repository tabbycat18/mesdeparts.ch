# Model A+ Inventory (RT/SA Parsed Storage)

Generated: 2026-02-25 (UTC)
Source runner: `node scripts/modelAplusInventory.mjs`

## 1) Current table inventory (live DB snapshot)

| Table | Exists | Row count | Timestamp signals |
| --- | --- | ---:| --- |
| `rt_trip_updates` | yes | 0 | `updated_at` (null), `start_date` (null) |
| `rt_stop_time_updates` | yes | 0 | `updated_at` (null) |
| `rt_service_alerts` | yes | 0 | `updated_at` (null), `active_start` (null), `active_end` (null) |
| `rt_updates` | yes | 31275 | `seen_at` min=`2026-02-20 04:56:48+00`, max=`2026-02-20 16:56:19+00` |
| `rt_cache` | yes | 2 | `fetched_at` min=`2026-02-25 17:51:34+00`, max=`2026-02-25 17:51:45+00` |
| `rt_feed_meta` | yes | 2 | `updated_at`/`fetched_at` around `2026-02-23 14:29:56+00` |
| `meta_kv` | yes | 8 | `updated_at` up to `2026-02-25 17:51:34+00` |

`rt_cache` still contains large payload blobs (`~6.5 MB` trip updates, `~8.5 MB` service alerts in this snapshot).

## 2) Code-path mapping (authoritative usage)

### rt_cache payload readers

- `loaders/loadRealtime.js`
  - `readTripUpdatesFeedFromCache()`
  - uses `getRtCache()` -> `SELECT payload, fetched_at, etag, last_status, last_error FROM public.rt_cache ...`
- `src/rt/loadScopedRtFromCache.js`
  - blob-path TripUpdates scoping loader
- `src/rt/loadAlertsFromCache.js`
  - blob-path alerts loader
- `src/api/stationboard.js`
  - still wires blob fallback (`loadBlobLike`) for TripUpdates + alerts

### rt_cache payload writers

- `src/db/rtCache.js`
  - `upsertRtCache()` still has payload upsert SQL
- `scripts/pollLaTripUpdates.js` / `scripts/pollLaServiceAlerts.js`
  - intended parsed-write path, but live pg_stat evidence still shows payload-upsert query active in production

### parsed writers

- `src/rt/persistParsedArtifacts.js`
  - `persistParsedTripUpdatesSnapshot()` -> `rt_trip_updates`, `rt_stop_time_updates`
  - `persistParsedServiceAlertsSnapshot()` -> `rt_service_alerts`
- called from pollers:
  - `scripts/pollLaTripUpdates.js`
  - `scripts/pollLaServiceAlerts.js`

### parsed readers already available

- `src/rt/loadScopedRtFromParsedTables.js`
- `src/rt/loadAlertsFromParsedTables.js`
- stationboard currently prefers parsed, but fallback to blob is still wired.

## 3) Can parsed tables build Model-A `byKey` index for `applyTripUpdates`?

Short answer: **yes, schema fields are sufficient** in principle, and the code already does it.

Required merge keys/fields for Model A:

- `trip_id`
- `start_date`
- `stop_id`
- `stop_sequence`
- `departure_delay` and/or `departure_time_rt`
- `schedule_relationship` (trip + stop level for cancel/skip semantics)

These are present in the parsed read query used by `loadScopedRtFromParsedTables`:

- `stu.trip_id`, `stu.stop_id`, `stu.stop_sequence`
- `stu.departure_delay`, `stu.departure_time_rt`
- `stu.schedule_relationship AS stop_schedule_relationship`
- `tu.start_date`, `tu.route_id`
- `tu.schedule_relationship AS trip_schedule_relationship`

So the parsed loader can build the same runtime structures consumed by `applyTripUpdates` (`byKey`, trip fallback, cancellations, stop-status, flags).

Caveat from live inventory:

- `rt_trip_updates`, `rt_stop_time_updates`, `rt_service_alerts` are currently empty in production snapshot (`row_count=0`), so fallback paths currently trigger blob reads.

## 4) Query shapes to use (blob-free stationboard)

Trip-scoped query (preferred):

```sql
SELECT
  stu.trip_id,
  stu.stop_id,
  stu.stop_sequence,
  stu.departure_delay,
  stu.departure_time_rt,
  stu.schedule_relationship AS stop_schedule_relationship,
  stu.updated_at AS stop_updated_at,
  tu.start_date,
  tu.route_id,
  tu.schedule_relationship AS trip_schedule_relationship,
  tu.updated_at AS trip_updated_at
FROM public.rt_stop_time_updates stu
LEFT JOIN public.rt_trip_updates tu ON tu.trip_id = stu.trip_id
WHERE stu.trip_id = ANY($1::text[])
ORDER BY stu.updated_at DESC NULLS LAST
LIMIT $2;
```

Stop-scoped fallback query:

```sql
SELECT
  stu.trip_id,
  stu.stop_id,
  stu.stop_sequence,
  stu.departure_delay,
  stu.departure_time_rt,
  stu.schedule_relationship AS stop_schedule_relationship,
  stu.updated_at AS stop_updated_at,
  tu.start_date,
  tu.route_id,
  tu.schedule_relationship AS trip_schedule_relationship,
  tu.updated_at AS trip_updated_at
FROM public.rt_stop_time_updates stu
LEFT JOIN public.rt_trip_updates tu ON tu.trip_id = stu.trip_id
WHERE stu.stop_id = ANY($1::text[])
ORDER BY stu.updated_at DESC NULLS LAST
LIMIT $2;
```

Trip metadata supplement query:

```sql
SELECT
  trip_id,
  route_id,
  start_date,
  schedule_relationship AS trip_schedule_relationship,
  updated_at AS trip_updated_at
FROM public.rt_trip_updates
WHERE trip_id = ANY($1::text[])
ORDER BY updated_at DESC NULLS LAST
LIMIT $2;
```

Alerts parsed query:

```sql
SELECT
  alert_id,
  effect,
  cause,
  severity,
  header_text,
  description_text,
  active_start,
  active_end,
  informed_entities,
  updated_at
FROM public.rt_service_alerts
ORDER BY updated_at DESC NULLS LAST
LIMIT $1;
```

## 5) Required indexes for these query shapes

Observed live DB currently shows only PK indexes on parsed RT tables.

Use these (already defined in `sql/optimize_stationboard_latency.sql`):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_stop_time_updates_trip_id_updated_at
ON public.rt_stop_time_updates (trip_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_stop_time_updates_trip_stop_seq_updated_at
ON public.rt_stop_time_updates (trip_id, stop_id, stop_sequence, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_trip_updates_trip_id_updated_at
ON public.rt_trip_updates (trip_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_stop_time_updates_stop_id_updated_at
ON public.rt_stop_time_updates (stop_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_service_alerts_updated_at
ON public.rt_service_alerts (updated_at DESC);
```

## 6) Stationboard blob-free feasibility (no behavior change yet)

Decision: **Yes, stationboard can run blob-free off parsed tables, provided parsed tables are actually populated.**

Current blocker from inventory evidence:

- parsed RT/SA tables are empty in live snapshot
- stationboard still has blob fallback wired
- pg_stat statements still show blob payload reads/writes in active traffic

Minimal no-refactor rollout plan:

1. Ensure poller fleet writing parsed tables is the only active poller version.
2. Apply parsed-table indexes above in production.
3. Re-run 10-minute baseline with statement reset.
4. Confirm payload reads/upserts are near-zero before removing blob fallback wiring.
