# RT Backend Notes

Docs index: [`../README_INDEX.md`](../README_INDEX.md)
SQL guide: [`README_SQL.md`](./README_SQL.md)

GTFS static datasets must not be committed to git.

Static GTFS is downloaded by CI from the opentransportdata permalink during refresh jobs.
For local manual tooling, use `realtime_api/data/gtfs-static-local` (optional, local-only).

TODO: remove any remaining legacy static dataset directories after the first successful automated import to Neon.

## Deployment Target

- Runtime target for this backend: **Fly.io**.
- Container file: `realtime_api/backend/Dockerfile`.
- Container listen port: `8080` (`ENV PORT=8080`).

API Fly config is committed at `realtime_api/backend/fly.toml`.

## Secrets And Rotation Runbook

Credential sources used by this stack:

- Local development: `realtime_api/backend/.env` (`DATABASE_URL`, poller tokens). This file must stay git-ignored.
- Fly runtime: app secrets on both `mesdeparts-ch` and `mesdeparts-rt-poller` (`fly secrets set ...`).
- GitHub Actions refresh workflow: repository secrets `NEON_DATABASE_URL`, `OPENTDATA_GTFS_RT_KEY`, `OPENTDATA_GTFS_SA_KEY`.

Rotation checklist (no secrets in repo):

1. Rotate credentials at the provider first (Neon and API token issuer).
2. Update Fly secrets for both apps.
3. Update GitHub repository secrets used by `.github/workflows/gtfs_static_refresh.yml`.
4. Update local `.env` files used for manual scripts.
5. Restart poller/API processes and run one refresh dry run.
6. Validate that logs contain no raw DSN/password values (workflow now masks these values by default).

## Runtime Truth Map (verified)

Use this map first to avoid chasing outdated paths:

- Process entrypoint: `realtime_api/backend/server.js`
- Active stop-search route: `/api/stops/search` mounted via `src/api/stopSearchRoute.js`
- Active stationboard route: `/api/stationboard` mounted via `src/api/stationboardRoute.js`
- Stationboard API orchestration: `realtime_api/backend/src/api/stationboard.js`
- Canonical builder implementation: `realtime_api/backend/src/logic/buildStationboard.js`
- Compatibility shim (re-export only): `realtime_api/backend/logic/buildStationboard.js`
- Scoped RT cache merge input: `realtime_api/backend/src/rt/loadScopedRtFromCache.js`
- Alerts cache input: `realtime_api/backend/src/rt/loadAlertsFromCache.js`
- Shared feed cache/decode module: `realtime_api/backend/loaders/loadRealtime.js`
- SQL runbook and ownership map: `realtime_api/backend/README_SQL.md`
- Deep file-by-file explanations for logic/loaders/rt: `realtime_api/backend/README_src.md`

Deprecated/non-mounted route file:
- `realtime_api/backend/routes/searchStops.js` exists for legacy compatibility and is not mounted by `server.js`.

## GTFS-RT Option A1 (Global Limit Guarantee)

To guarantee the LA GTFS-RT upstream limit globally (5/min), run one dedicated poller app and let API instances read shared DB cache only.

- API app stays: `mesdeparts-ch` (`https://mesdeparts-ch.fly.dev`)
- Poller app: separate Fly app, single machine only
- API `/api/stationboard` must not fetch upstream GTFS-RT directly

### 1) Apply shared cache migration once (Neon)

```bash
cd realtime_api/backend
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/create_rt_cache.sql
```

### 2) Create poller app (one-time)

```bash
fly apps create mesdeparts-rt-poller
```

### 3) Set poller secrets (must share same Neon DB as API app)

```bash
fly secrets set -a mesdeparts-rt-poller \
  DATABASE_URL="postgresql://...your-neon-url..." \
  GTFS_RT_TOKEN="...your-la-gtfs-rt-token..."
```

If your API app uses a different token env name, set it too (`OPENDATA_SWISS_TOKEN` or `OPENTDATA_GTFS_RT_KEY`).

### 4) Deploy poller app

```bash
fly deploy \
  -a mesdeparts-rt-poller \
  -c realtime_api/backend/fly.poller.toml \
  --dockerfile realtime_api/backend/Dockerfile
```

Poller runtime command is `npm run poller`.

### 5) Force exactly one poller machine

```bash
fly scale count 1 -a mesdeparts-rt-poller
```

Do not scale the poller above `1`. Do not enable autoscaling for the poller app.

### 6) API app secrets (same DB)

Ensure API app points to the same `DATABASE_URL`:

```bash
fly secrets set -a mesdeparts-ch DATABASE_URL="postgresql://...same-neon-url..."
```

This Option A1 layout guarantees all LA GTFS-RT upstream calls come from a single process (the poller), while API machines remain DB-cache readers.

## How to distinguish backend/poller DB traffic

Postgres connections now set `application_name` at the pg client config layer:

- backend/API process (`server.js`) -> `md_backend`
- poller processes (`scripts/poll*.js`) -> `md_poller`

`PGAPPNAME` (or `PG_APPLICATION_NAME`) still overrides these defaults when explicitly set.

Operational checks:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY application_name, state
ORDER BY application_name, state;
```

```sql
SELECT application_name, calls, total_exec_time
FROM pg_stat_statements
WHERE application_name IN ('md_backend', 'md_poller')
ORDER BY total_exec_time DESC
LIMIT 20;
```

## GTFS Refresh Lock + Idempotency

`scripts/refreshGtfsIfNeeded.js` now enforces a single DB-heavy refresh at a time via PostgreSQL session advisory lock.

- Lock key: dedicated global key in refresh script.
- Concurrent runner behavior: immediate clean exit with `refresh already running`.
- Fast no-op path:
  - if static SHA256 is unchanged, import is skipped
  - stop-search rebuild is skipped unless explicitly requested
- stop-search rebuild metadata keys:
  - `gtfs_stop_search_rebuild_requested`
  - `gtfs_stop_search_last_rebuild_sha256`
  - `gtfs_stop_search_last_rebuild_at`
- Rebuild rate limit: `GTFS_STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS` (default `6`).

This prevents repeated `optimize_stop_search.sql` rebuild churn on unchanged hourly runs.

## RT Cache Pressure Controls

To reduce per-request DB pressure and poller write churn:

- Stationboard TripUpdates source is now parsed RT tables (`rt_trip_updates` + `rt_stop_time_updates`) by default.
- Blob cache (`rt_cache.payload`) is disabled by default for TripUpdates request path; debug-only mode (`debug_rt=blob`) can force blob diagnostics, and debug/meta expose `rtSource` (`parsed` or `blob`).
- Stationboard Service Alerts source is now parsed table `rt_service_alerts` by default.
- Service Alerts blob cache (`rt_cache` / `la_servicealerts`) is disabled by default on request path; debug-only mode (`debug_rt=blob`) can force blob diagnostics, and debug/meta expose `alertsSource` (`parsed` or `blob_fallback`).
- Blob fallback reads still use short in-process decoded-feed cache (`RT_DECODED_FEED_CACHE_MS`, default `10s`, clamped `10s..15s`) with in-flight read coalescing.
- Stationboard Service Alerts request-path cache/decode is throttled separately (`STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS`, default `60s`, clamped to minimum `60s`).
- Parsed alerts reads are scoped and bounded (`scopeStopIds`/`route_id`/`trip_id` match in `informed_entities`) with lookback guard `STATIONBOARD_ALERTS_PARSED_LOOKBACK_MS` (default `6h`) and row cap `STATIONBOARD_ALERTS_PARSED_MAX_ROWS` (default `500`).
- Decoded-feed cache invalidation uses RT content identity per feed (`etag` -> payload SHA -> `fetched_at` fallback) to avoid unnecessary payload re-reads when content is unchanged.
- When `include_alerts=0`, stationboard skips request-path alerts loading entirely.
- `debug=1` diagnostics now include:
  - `debug.rt.tripUpdates.rtSource` (`parsed` or `blob`)
  - `debug.rt.alerts.alertsSource` (`parsed` or `blob_fallback`)
  - `debug.rt.tripUpdates.rtReadSource` (`memory` or `db`)
  - `debug.rt.tripUpdates.rtCacheHit`
  - `debug.rt.tripUpdates.rtPayloadFetchCountThisRequest` (`1` only when this request executed a payload `SELECT`, else `0`)
  - `debug.rt.tripUpdates.rtPayloadBytes`
  - `debug.rt.tripUpdates.rtDecodeMs`
  - `debug.rt.alerts.alertsPayloadFetchCountThisRequest` (`1` only when this request executed alerts payload `SELECT`, else `0`)
  - `debug.rt.tripUpdates.instanceId` / `debug.rt.alerts.instanceId` (instance attribution in multi-machine deployments)
- Pollers avoid redundant writes:
  - pollers persist decoded protobuf snapshots into parsed RT tables (`rt_trip_updates`, `rt_stop_time_updates`, `rt_service_alerts`)
  - parsed-table compaction strategy is snapshot replacement (bounded cardinality); retention window knob `RT_PARSED_RETENTION_HOURS` (default `6`) controls stale-row pruning metrics per tick
  - `rt_cache` now stores lightweight metadata only (`fetched_at`, `last_status`, `etag`, `last_error`); payload SHA-256 is tracked in `meta_kv`
  - poller tick path does not execute `INSERT/UPSERT ... payload = EXCLUDED.payload` against `rt_cache`
  - unchanged `200` payloads skip parsed snapshot rewrites when SHA-256 matches (`RT_CACHE_MIN_WRITE_INTERVAL_MS`, default `30000`)
  - frequent `304` status writes are throttled by the same interval
  - parsed snapshot + metadata writes use advisory xact lock per feed to avoid concurrent writer churn across poller replicas.

### Measurement checklist (network-bleed acceptance)

Use this repeatable 10-minute workflow to validate DB churn reductions.

1. Reset statement counters immediately before sampling:

```bash
psql "$DATABASE_URL" -X -A -t -c "SELECT pg_stat_statements_reset();"
```

2. Run a 10-minute normal traffic window.

3. Collect stats (manual SQL or helper script):

```bash
node scripts/measureRtCacheChurn.mjs
# optional one-shot reset + sample header
node scripts/measureRtCacheChurn.mjs --reset
```

4. Acceptance signals (calls should be materially lower than baseline):
   - payload reads should drop:
     - `SELECT payload, fetched_at, etag, last_status, last_error FROM public.rt_cache WHERE feed_key = $1`
   - heavy payload upserts should drop:
     - `INSERT INTO public.rt_cache (...) ON CONFLICT (feed_key) DO UPDATE SET payload = EXCLUDED.payload, ...`
   - expected shift:
     - relatively more lightweight metadata updates (`UPDATE public.rt_cache SET fetched_at=..., last_status=..., ...`)
     - stable backend/poller split in `pg_stat_activity` (`md_backend` vs `md_poller`)

### Baseline report script

Capture a timestamped controlled-window snapshot (DB churn + stationboard RT freshness/latency):

```bash
cd realtime_api/backend
node scripts/rtBaselineReport.mjs \
  --url https://api.mesdeparts.ch \
  --stops Parent8587387,Parent8501000,Parent8501120 \
  --n 30 \
  --duration-minutes 10 \
  --reset-statements
```

Outputs:
- `docs/diagnostics/rt-baseline-<YYYYMMDD-HHMM>.json` (raw samples + DB query snapshots)
- `docs/diagnostics/rt-baseline-<YYYYMMDD-HHMM>.md` (short human summary)

New script options:
- `--reset-statements`: calls `pg_stat_statements_reset()` before the start snapshot.
- `--duration-minutes <N>`: runs a controlled measurement window (samples are spread across this window when `--n > 0`).
- `--accept-max-payload-select-calls <N>`: threshold for `SELECT payload ... FROM rt_cache` delta (default `2`).
- `--accept-max-payload-upsert-calls <N>`: threshold for payload-upsert delta in `rt_cache` (default `2`).

Report now includes:
- `pg_stat_statements` snapshots at start and end
- statement deltas for the window
- acceptance summary for payload reads/writes being near-zero in 10 minutes.

## Stationboard Latency Guard

`getStationboard()` includes a built-in latency guard to avoid chaining optional phases
(`sparse retry`, `scope fallback`, `alerts`, `supplement`) into a timeout.

- Budget: `totalBudgetMs = min(STATIONBOARD_ROUTE_TIMEOUT_MS, 5000)`
- Guard threshold: dynamic (`8%` of budget, clamped `250..800 ms`)
- Behavior when low budget: skip optional phases and return static/partial payload with `200`

Debug (`debug=1`) includes `debug.latencySafe` with:

- `degradedMode` and `degradedReasons`
- `remainingBudgetMs` and `lowBudgetThresholdMs`
- effective config and phase timings

This guard is always active; it does not require emergency deploy overrides.

### Model A API metadata (always-on)

`/api/stationboard` responses include additive top-level `meta` so phone/tablet differences are
explainable without enabling debug:

- `serverTime`, `requestId`, `totalBackendMs`
- `responseMode` (`full`, `degraded_static`, `stale_cache_fallback`, `static_timeout_fallback`)
- `skippedSteps` (budget/fallback reasons)
- `rtStatus`, `rtAppliedCount`, `rtFetchedAt`, `rtCacheAgeMs`
- `alertsStatus`, `alertsFetchedAt`, `alertsCacheAgeMs`

Status semantics:
- `rtStatus`: `applied`, `stale_cache`, `skipped_budget`, `disabled`, `missing_cache`, `guarded_error`
- `alertsStatus`: `applied`, `skipped_budget`, `disabled`, `missing_cache`, `error_fallback`

### Optional tuning knobs (defaults)

| Variable | Default (if unset) | Where applied |
| --- | --- | --- |
| `STATIONBOARD_SPARSE_RETRY_MIN_DEPS` | `2` | `src/api/stationboard.js` |
| `STATIONBOARD_DEFAULT_WINDOW_MINUTES` | `210` | `src/api/stationboard.js` |
| `STATIONBOARD_MAIN_QUERY_TIMEOUT_MS` | `3500` | `src/logic/buildStationboard.js` |
| `STATIONBOARD_FALLBACK_QUERY_TIMEOUT_MS` | `1200` | `src/logic/buildStationboard.js` |
| `STATIONBOARD_STOP_SCOPE_QUERY_TIMEOUT_MS` | `800` | `src/logic/buildStationboard.js` |
| `STATIONBOARD_ROUTE_TIMEOUT_MS` | `5000` (hard-capped at 5000) | `src/api/stationboardRoute.js` |
| `STATIONBOARD_ENABLE_ALERTS` | `1` | `src/api/stationboard.js` |
| `STATIONBOARD_MIN_REMAINING_SPARSE_RETRY_MS` | dynamic threshold | `src/api/stationboard.js` |
| `STATIONBOARD_MIN_REMAINING_SCOPE_FALLBACK_MS` | dynamic threshold | `src/api/stationboard.js` |
| `STATIONBOARD_MIN_REMAINING_RT_APPLY_MS` | dynamic threshold | `src/api/stationboard.js` + `src/logic/buildStationboard.js` |
| `STATIONBOARD_MIN_REMAINING_ALERTS_MS` | dynamic threshold | `src/api/stationboard.js` |
| `STATIONBOARD_MIN_REMAINING_SUPPLEMENT_MS` | dynamic threshold | `src/api/stationboard.js` |

For normal production deploys, keep `fly.toml` free of stationboard emergency overrides
and only tune these values if a measured incident requires it.

### Tuning playbook when RT is skipped by budget

Use `meta` first to classify the issue before changing thresholds:

- `rtStatus=disabled` -> feature/env toggle issue
- `rtStatus=missing_cache` -> poller/cache health issue
- `rtStatus=stale_cache` -> stale feed path
- `rtStatus=skipped_budget` -> budget tuning candidate

Recommended first tuning set (keep route timeout cap at 5000 ms):

- `STATIONBOARD_MIN_REMAINING_SPARSE_RETRY_MS=900`
- `STATIONBOARD_MIN_REMAINING_SCOPE_FALLBACK_MS=800`
- `STATIONBOARD_MIN_REMAINING_RT_APPLY_MS=500`
- `STATIONBOARD_MIN_REMAINING_ALERTS_MS=700`
- `STATIONBOARD_MIN_REMAINING_SUPPLEMENT_MS=950`

Adjustment rule:
- If `skipped_budget` remains frequent and DB/pool is healthy -> lower `RT_APPLY` by 100 ms.
- If p95/p99 worsens -> raise `SPARSE_RETRY`/`SUPPLEMENT` thresholds first.

## Stationboard Performance

If stationboard requests are slow/time out on large datasets, run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stationboard.sql
```

This will:
- backfill `arrival_time_seconds` / `departure_time_seconds` in `gtfs_stop_times`
- add a partial index for boardable departures by stop and departure seconds
- analyze core GTFS tables

## Service Alerts (M2)

Stationboard can attach GTFS-RT Service Alerts from opentransportdata.swiss.

Env vars:
- `OPENTDATA_GTFS_SA_KEY` (preferred for Service Alerts)
- fallback: `OPENTDATA_API_KEY`

Quick check:

```bash
curl "http://localhost:3001/api/stationboard?stop_id=Parent8501120&limit=20"
```

Sample response shape (shortened):

```json
{
  "station": { "id": "Parent8501120", "name": "Lausanne" },
  "banners": [
    {
      "severity": "warning",
      "header": "Stop disruption",
      "description": "Maintenance work",
      "affected": { "stop_id": "8501120:0:1" }
    }
  ],
  "departures": [
    {
      "trip_id": "162.TA.91-9-K-j26-1.2.H",
      "stop_id": "8501120:0:1",
      "alerts": [
        { "id": "alert-123", "severity": "warning", "header": "Stop disruption" }
      ]
    }
  ]
}
```

## API Contract: /api/stationboard (RT backend)

Each entry in `departures[]` is normalized by the backend into a canonical shape.

### Cancellation invariants (authoritative)

- `cancelled: boolean` is the authoritative cancellation signal.
- Consumers must treat `cancelled === true` as cancelled, regardless of `status`.
- Consumers must not key cancellation only on `status`.
- Consumers should key behavior on `cancelled` and `delayMin`; `status` is informational and may expand.

### Subtype/detail fields (non-authoritative)

These fields provide detail and must not be used as the sole cancellation source:

- `status: string` (for example: `"SKIPPED_STOP"`, `"CANCELLED"`)
- `cancelReasonCode: string | null` (for example: `"SKIPPED_STOP"`, `"CANCELED_TRIP"`)
- `stopEvent: string | null` (for example: `"SKIPPED"`)
- `flags: string[]` (for example: `"STOP_SKIPPED"`, `"TRIP_CANCELLED"`, `"RT_CONFIRMED"`)

### Delay semantics

- `delayMin` is computed from scheduled vs realtime timestamps.
- `delayMin === 0` is emitted only when realtime is confirmed.
- When realtime is not confirmed, `delayMin` may be `null` even if times appear equal.

### Transport/cache headers (stationboard route)

`src/api/stationboardRoute.js` sets cache headers so browser caches do not keep stale
stationboard JSON while edge caches can still absorb load:

- `Cache-Control: private, no-store, max-age=0, must-revalidate`
- `Pragma: no-cache`
- `CDN-Cache-Control`:
  - 200 responses: `public, max-age=12, stale-while-revalidate=24`
  - 204 unchanged (`since_rt`) responses: `public, max-age=2, stale-while-revalidate=4` (only when client explicitly sends `if_board=1`, i.e. it already has a board for that context)
- Timeout degrade behavior:
  - if stationboard build times out, route serves stale cached board when present
  - if no cached board exists, route returns static-only fallback (`200`) with debug degraded metadata when `debug=1`
- `Vary: Origin, Accept-Encoding`
- Identical in-flight stationboard requests are coalesced per key in-process (`stop/lang/limit/window/include_alerts`) so only one backend build runs at a time per key; coalesced responses include `x-md-inflight: HIT`.

### Debug

- When `debug=1` is passed, `debug` is included for tracing only.
- Consumers must not rely on `debug` fields for business logic.
- RT diagnostics under `debug.rt.tripUpdates` include:
  - `rtEnabledForRequest`
  - `rtMetaReason` (raw scoped-loader reason, for example `applied`, `stale_cache`)
  - `reason` (normalized reason, for example `fresh`, `stale`)
  - `scopedEntities`, `scopedTripCount`, `scopedStopCount`

### RT stop-id matching invariant (Swiss platform IDs)

When matching scheduled rows with RT stop_time_updates:
1. exact stop id
2. one-level parent (`:0`)
3. numeric root

Parent/root variants are only derived for Swiss platform-shaped IDs:
`^[0-9]{7}:0:[A-Za-z0-9]{1,2}$`

## Stop Resolution Debug/Verification

Use these backend-only tools when a stop resolves incorrectly (for example `Lausanne, Bel-Air`):

```bash
# One-query repro: search -> chosen stop_id -> stationboard(debug=1) summary
npm run stops:debug -- "Lausanne, Bel-Air"

# Multi-query verification sweep (built-in golden list)
npm run stops:verify

# Optional custom JSON list (array of strings)
npm run stops:verify -- ./scripts/stopQueries.json
```

Manual API checks:

```bash
curl "http://localhost:3001/api/stops/search?q=Lausanne,%20Bel-Air&limit=10&debug=1"
curl "http://localhost:3001/api/stationboard?stop_id=<returned_id>&limit=20&debug=1"
```

Script reference:
- `realtime_api/backend/scripts/README_scripts.md`

### Schema

- Canonical JSON schema: `realtime_api/backend/docs/stationboard.schema.json`

## Stop Search Normalization and Ranking (Developer Note)

The stop search pipeline uses one shared normalization contract for user queries and indexed stop text.

Normalization steps:
- lowercase
- accent fold (DB: `public.md_unaccent(...)` with deterministic `translate(...)` fallback; JS: NFKD + combining-mark strip)
- punctuation/separators to spaces (comma, hyphen, apostrophes, dots, slashes, underscores, and other symbols)
- normalize common abbreviations (`st|saint -> saint`, `hauptbahnhof|hbf|hb -> hb`)
- collapse repeated whitespace, then trim

Primary indexed source:
- materialized view `public.stop_search_index` (built by `sql/optimize_stop_search.sql`)
- key normalized columns:
  - `name_norm` (normalized full stop name)
  - `name_core` (normalized stop name with generic station terms stripped)
  - `search_text` (combined normalized text for contains/fuzzy)

Indexes used for speed:
- prefix/typeahead:
  - `idx_stop_search_index_name_norm_prefix` on `name_norm text_pattern_ops`
  - `idx_stop_aliases_alias_norm_prefix` on `stop_aliases.alias_norm text_pattern_ops`
- fuzzy fallback:
  - `idx_stop_search_index_search_text_trgm`, `idx_stop_search_index_name_norm_trgm`, `idx_stop_search_index_name_core_trgm`
  - `idx_stop_aliases_alias_norm_trgm`

Ranking order in `src/search/stopsSearch.js`:
1. exact/prefix normalized matches (highest)
2. token-contained and city/head-token aware matches
3. trigram/fuzzy similarity fallback

Why typos like `bel aie` still match `Bel-Air`:
- query normalization turns `bel aie` into stable tokens
- candidates that do not pass exact/prefix still get fuzzy scores from trigram similarity on normalized `name_norm`/aliases
- fuzzy tier is retained in top results, so close strings (`aie` vs `air`) remain discoverable.

### End-to-end request flow (`/api/stops/search`)

1. Route validation in `src/api/stopSearchRoute.js`:
   - `q` required, min length `2`
   - `limit` clamped to `1..50`
2. Primary search call in `src/search/stopsSearch.js`:
   - shared normalization (`src/util/searchNormalize.js`)
   - capability probe (`stop_search_index`, aliases, SQL functions, `pg_trgm`, `unaccent`)
3. Query strategy:
   - full primary SQL path when capabilities are complete
   - degraded fallback SQL path when capabilities are missing or primary fails
4. Ranking and shaping:
   - stable tiered scoring (exact/prefix > contains > fuzzy)
   - dedupe by station group + stop name, return canonical stop objects
5. Route fallback behavior:
   - on route-level timeout/error, a fast fallback runs
   - response includes `x-md-search-fallback` headers when fallback was applied

### Current conclusions (verified behavior)

- Search is resilient-by-design: it returns useful results even when advanced DB capabilities are unavailable.
- Primary quality depends on the indexed stack (`stop_search_index` + aliases + `pg_trgm` + `unaccent`).
- Fallback behavior is intentional and covered by tests; it must remain functional.
- Normalization parity between JS and SQL is critical (`st/saint`, `hb/hbf`, accent/punctuation folding).
- Regression-sensitive queries already exist and should be treated as contract tests (for example `foret`, `grande borde`, `bel air`, `st/sr francois`).

### Safe continuous improvement (without breaking current search)

1. Add tests first:
   - add/extend cases in `test/stopSearch.test.js`, `test/stopSearch.degraded.test.js`, `test/stopSearch.route.test.js`
2. Prefer data tuning before algorithm changes:
   - update alias seeds/specs, then run `npm run search:sync-aliases`
3. If normalization changes:
   - update both JS (`src/util/searchNormalize.js`) and SQL (`normalize_stop_search_text` in `sql/optimize_stop_search.sql`)
4. Keep fallback paths intact:
   - never remove degraded SQL or route-level fallback headers
5. Verify before merge:
   - `node --test test/stopSearch.test.js test/stopSearch.degraded.test.js test/stopSearch.route.test.js`
   - `npm run search:repro-regression`
   - `npm run search:verify`
   - `npm run search:bench`

### Search improvement map (risk-tiered)

Start with lower-risk changes first:

1. Tier 1 (lowest risk): alias/spec tuning
   - Files: `sql/optimize_stop_search.sql` seed specs and alias tables, plus `scripts/syncStopSearchAliases.js`
   - Use when specific stations are missing/misranked but overall behavior is good.
2. Tier 2 (medium risk): ranking weights/tie-breakers
   - File: `src/search/stopsSearch.js` (`scoreCandidate`, ranking comparator, tier scoring)
   - Use when candidate set is good but ordering is wrong.
3. Tier 3 (higher risk): SQL retrieval strategy
   - File: `src/search/stopsSearch.js` SQL blocks (`PRIMARY_SQL`, fallback SQL), capability gates, budgets/timeouts
   - Use only when Tier 1/2 cannot recover required results.
4. Tier 4 (highest risk): normalization semantics
   - Files: `src/util/searchNormalize.js` and SQL `normalize_stop_search_text` in `sql/optimize_stop_search.sql`
   - Always update JS+SQL together to avoid drift.

Do-not-break invariants:
- Keep degraded fallback path functional.
- Keep `x-md-search-fallback` headers on fallback responses.
- Keep query min-length and limit clamping behavior.
- Keep typo/diacritic behavior for known regressions (`foret`, `grande borde`, `bel air`, `st/sr francois`).
