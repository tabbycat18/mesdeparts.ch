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
  - 204 unchanged (`since_rt`) responses: `public, max-age=2, stale-while-revalidate=4`
- `Vary: Origin, Accept-Encoding`

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
