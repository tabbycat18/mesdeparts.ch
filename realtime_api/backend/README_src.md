# Backend `src/` Map

Docs index: [`../README_INDEX.md`](../README_INDEX.md)
SQL guide: [`README_SQL.md`](./README_SQL.md)

This file documents the current `realtime_api/backend/src/` tree based on direct file inspection.

## Scope

- Scanned files: all files under `realtime_api/backend/src/`
- Total files scanned: 39 (`38` source files + `1` `.DS_Store`)
- Excludes non-`src` runtime files (for example `server.js`, `loaders/`, `scripts/`)

## High-level flow

1. HTTP routes
   - `src/api/stationboardRoute.js` parses request/query/caching behavior.
   - `src/api/stopSearchRoute.js` parses `/api/stops/search` requests.
2. Stationboard build/merge
   - `src/api/stationboard.js` orchestrates resolve/build/alerts/supplement/response.
   - `src/logic/buildStationboard.js` performs SQL base board + RT merge pipeline.
   - `src/merge/*` applies TripUpdates, added trips, alerts, dedupe rules.
3. Realtime data access
   - `src/rt/loadScopedRtFromParsedTables.js` scopes TripUpdates from parsed RT tables (default).
   - `src/rt/loadScopedRtFromCache.js` scopes TripUpdates from cached payload (fallback).
   - `src/rt/loadAlertsFromParsedTables.js` loads Service Alerts from parsed table (default).
   - `src/rt/loadAlertsFromCache.js` loads Service Alerts from cached payload (debug-only via `debug_rt=blob`).
   - `src/db/rtCache.js` provides RT cache read/write helpers.
4. Search and resolve
   - `src/search/stopsSearch.js` is the stop-search engine.
   - `src/resolve/resolveStop.js` resolves station/stop identity and scope.

## API deep dive (`src/api`)

### `src/api/stationboardRoute.js` (HTTP edge behavior)

Primary responsibilities:
- Parse and validate request inputs for `/api/stationboard`:
  - stop identity: `stop_id`, `stationId`, `station_id`, `stationName`
  - board controls: `limit`, `window_minutes`, `lang`
  - feature flags: `include_alerts` / `includeAlerts`, `debug`, `debug_rt`
  - incremental RT polling token: `since_rt` (ISO timestamp or epoch ms)
  - client board-presence hint: `if_board`/`has_board` (booleanish)
- Detect conflicting stop identity (`stop_id` vs `stationId`) using canonical resolution checks.
- Read RT cache metadata early (`la_tripupdates`) and short-circuit with `204` only when `since_rt` indicates no change and the client sends `if_board=1`/`has_board=1`.
- Apply cache and diagnostics headers (`Cache-Control`, `CDN-Cache-Control`, `Pragma`, `Vary`, `x-md-*`):
  browser-facing stationboard responses are explicit `no-store`; edge-cache intent stays in `CDN-Cache-Control`.
- Coalesce identical in-flight stationboard builds per request key to prevent duplicate concurrent DB work under bursty client refresh patterns.
- Call `getStationboard(...)` with timeout/error handling and stale-response fallback cache.
- Normalize meta blocks (`rt`, `alerts`) before returning.

Why this split matters:
- Route-layer logic handles transport concerns (timeouts, cache headers, request validation).
- Business assembly remains in `src/api/stationboard.js` + `src/logic/buildStationboard.js`.

### `src/api/stationboard.js` (response assembly)

Primary responsibilities:
- Resolve effective station/stop scope (`resolveStop`).
- Build base board via `buildStationboard(...)` (static SQL first, then RT merge pipeline).
- Prepare canonical response payload (`station`, `resolved`, `departures`, `banners`, `rt`, `alerts`).
- Normalize departures through `src/models/stationboard.js` (`normalizeDeparture`).
- Each departure includes `operator` = `gtfs_agency.agency_name` (human-readable, e.g. `"Städtische Verkehrsbetriebe Bern"`, `"TPG"`) resolved via `LEFT JOIN gtfs_agency ag ON ag.agency_id = r.agency_id` in the stationboard SQL. Falls back to `agency_id` (numeric FK, e.g. `"827"`) if `agency_name` is absent. The frontend matches `dep.operator` against `operatorPatterns` in `network-map.json` for line-badge network detection — always use `agency_name`, not `agency_id`, in those patterns.
- Attach alerts from parsed tables (`src/rt/loadAlertsFromParsedTables.js`) and merge alert effects (`attachAlerts`, `synthesizeFromAlerts`).
- Keep blob-backed alerts loader (`src/rt/loadAlertsFromCache.js`) for explicit debug mode (`debug_rt=blob`) only.
- Throttle request-path Service Alerts cache reads with an in-process TTL (`STATIONBOARD_ALERTS_REQUEST_CACHE_TTL_MS`, default 60s, clamped to minimum 60s) to avoid repeated alert-cache fetch/decode on frequent board refreshes.
- Apply optional OTD supplement logic (`supplementFromOtdStationboard`) behind request-path upstream guard.
- Emit debug payloads/timings when debug mode is enabled.
  - `debug.rt.tripUpdates` includes request RT toggle and reasons:
    `rtEnabledForRequest`, `rtMetaReason`, normalized `reason`, and scoped counters.

Request-budget guard:
- `totalBudgetMs = min(STATIONBOARD_ROUTE_TIMEOUT_MS, 5000)` (default 5 000 ms).
- Before each optional phase a remaining-budget check fires with stage-specific thresholds:
  `minRemainingForSparseRetryMs`, `minRemainingForScopeFallbackMs`,
  `minRemainingForRtApplyMs`, `minRemainingForAlertsMs`, `minRemainingForSupplementMs`.
- If budget is low the phase is **skipped**, `degradedMode = true`, and the reason is appended to
  `degradedReasons`.  The function still returns a usable 200 with whatever departures were built.
- Guard points in order: sparse retry → scope fallback → alerts (early return) → supplement.
- `response.debug.latencySafe` (when `debug=true`) exposes `degradedMode`, `degradedReasons`,
  `totalBudgetMs`, `remainingBudgetMs`, and `lowBudgetThresholdMs`.
- Regression tests: `test/stationboard.budget.test.js`.

Always-on top-level stationboard `meta` (Model A contract):
- Every successful stationboard JSON response includes a top-level `meta` object:
  - `serverTime`, `responseMode`, `requestId`, `totalBackendMs`
  - `skippedSteps`
  - `rtStatus`, `rtAppliedCount`, `rtFetchedAt`, `rtCacheAgeMs`
  - `alertsStatus`, `alertsFetchedAt`, `alertsCacheAgeMs`
- `responseMode` values:
  - `full`
  - `degraded_static`
  - `stale_cache_fallback`
  - `static_timeout_fallback`
- `rtStatus` values:
  - `applied`, `stale_cache`, `skipped_budget`, `disabled`, `missing_cache`, `guarded_error`
- `alertsStatus` values:
  - `applied`, `skipped_budget`, `disabled`, `missing_cache`, `error_fallback`
- Operational diagnosis should start from `meta.rtStatus`:
  `disabled` (feature/env), `missing_cache` (poller/cache), `stale_cache` (freshness), `skipped_budget` (threshold tuning).

Important design guard:
- Request-path upstream RT/alerts fetches are blocked by `guardStationboardRequestPathUpstream(...)`.
- Poller/cache path is the intended realtime source.

### `src/api/stopSearchRoute.js` (search HTTP contract)

Primary responsibilities:
- Validate query length (`MIN_QUERY_LEN = 2`).
- Clamp `limit` safely.
- Support debug mode path (`searchDebugFn`) and normal path (`searchFn`).
- Handle degraded fallback (`fallbackFn`) on error or empty primary result.
- Return minimal JSON contract: `{ stops: [...] }`.

## API change map (where to edit)

| Change you want | Primary file |
| --- | --- |
| Stationboard query parameter parsing and validation | `src/api/stationboardRoute.js` |
| 200/204 behavior for `since_rt` | `src/api/stationboardRoute.js` |
| Cache/diagnostic response headers | `src/api/stationboardRoute.js` |
| Stationboard payload shaping (`rt`, `alerts`, `banners`, `departures`) | `src/api/stationboard.js` |
| Stop search route contract and fallback behavior | `src/api/stopSearchRoute.js` |
| Canonical departure field computation | `src/models/stationboard.js` |
| Departure `operator` field (agency name for network/color detection) | `src/sql/stationboard.sql` (JOIN), `src/logic/buildStationboard.js` (set), `src/models/stationboard.js` (expose) |

## Search deep dive (`src/search` + stop-search route)

### `src/search/stopsSearch.js` (engine)

Primary responsibilities:
- Normalize query text with shared rules (`normalizeStopSearchText`).
- Detect DB capabilities (`stop_search_index`, alias tables, normalize/strip SQL functions, `pg_trgm`, `unaccent`).
- Execute primary SQL when capabilities are complete.
- Degrade gracefully to fallback SQL + alias fallback when primary path is unavailable.
- Rank and dedupe candidates with stable tiering:
  - exact/prefix
  - token-contained
  - fuzzy similarity
- Provide debug-mode top-candidate details (`searchStopsWithDebug`).

Key guarantees:
- Result stability is prioritized over aggressive ranking churn.
- Fallback path remains available even when advanced DB features are missing.

### `src/api/stopSearchRoute.js` (route contract)

Primary responsibilities:
- Input validation (`q` min length `2`, safe `limit` clamping).
- Use primary search fn, optional debug search fn, and fallback fn.
- Keep API contract simple: `{ stops: [...] }`.
- Trigger fallback both on hard errors and on empty primary results.

### Search change map (where to edit)

| Change you want | Primary file |
| --- | --- |
| Query normalization rules (`st`, `sr`, accents, punctuation) | `src/util/searchNormalize.js` |
| Ranking weights/tiers and candidate scoring | `src/search/stopsSearch.js` |
| Primary/fallback SQL strategy and budgets | `src/search/stopsSearch.js` |
| Route validation and fallback response behavior | `src/api/stopSearchRoute.js` |
| DB normalization/index objects | `sql/optimize_stop_search.sql` |

### Safe evolution checklist (search)

1. Add failing test first for the target query/behavior.
2. Prefer alias/spec data updates before scoring changes.
3. If normalization changes, keep JS + SQL normalization in sync.
4. Preserve degraded fallback behavior and fallback headers.
5. Run search tests + regression + benchmark before merge.

### Search touchpoints by risk (code-first)

| Risk | What to change | Where |
| --- | --- | --- |
| Low | Query/stop alias content and weights | `scripts/syncStopSearchAliases.js`, SQL seed/spec sections in `sql/optimize_stop_search.sql` |
| Medium | Ranking/tie-break scores | `src/search/stopsSearch.js` (`scoreCandidate`, `compareScored`) |
| Medium | Candidate-limit and budgets/timeouts | `src/search/stopsSearch.js` constants + `server.js` stop-search timeout env usage |
| High | Primary/fallback SQL match logic | `src/search/stopsSearch.js` (`PRIMARY_SQL`, fallback SQL constants) |
| Highest | Text normalization semantics | `src/util/searchNormalize.js` + SQL `normalize_stop_search_text` in `sql/optimize_stop_search.sql` |

Search invariants to preserve:
- `supportsPrimarySearch(...)` gate must keep degraded mode reachable.
- `runFallbackSearch(...)` and one-char backoff retry must remain active.
- `searchStopsWithDebug(...)` must keep debug visibility for ranking analysis.

## Merge deep dive (`src/merge`)

### `src/merge/applyTripUpdates.js` (scheduled rows + TripUpdates merge)

Primary responsibilities:
- Build lookup indexes from scoped TripUpdates:
  - delay candidates keyed by `trip_id + stop_id (+ stop_sequence) (+ start_date)`
  - cancellation sets (`CANCELED` trip relationship)
  - stop status index (`SKIPPED`, `NO_DATA`, etc.)
  - trip-level suppression flags for short-turn inference
- Apply RT to each base row:
  - choose best delay match (exact first, then controlled fallback)
  - for Swiss platform IDs, stop matching variants are tried in order: exact -> `:0` parent -> numeric root
  - parent/root expansion is regex-guarded to Swiss platform shape (`^[0-9]{7}:0:[A-Za-z0-9]{1,2}$`) to avoid broad matches
  - compute `realtimeDeparture` and `delayMin` from RT timestamps/fields
  - mark cancellation/suppression and service tags (`skipped_stop`, `short_turn`)
  - set `source = "tripupdate"` when RT matched
- Platform-change propagation:
  - if `options.platformByStopId` is provided, compare scheduled `row.stop_id` vs RT stop id
  - when platform differs, set `platformChanged = true` and update `platform`

### `src/merge/applyAddedTrips.js` (RT ADDED trips to departures)

Primary responsibilities:
- Extract ADDED trip entities from TripUpdates (`schedule_relationship = ADDED`).
- Filter to station scope (`stationStopIds`) and time window (`windowMinutes`, `departedGraceSeconds`).
- Build synthetic departures with `source = "rt_added"` and inferred tags (`replacement`, `extra`).
- Resolve platform from `platformByStopId` when available.

### `src/merge/attachAlerts.js` (alert attachment + banners)

Primary responsibilities:
- Attach active alert snippets to departures (`dep.alerts`) using trip/route/stop/stop_sequence matching.
- Add service tags (`replacement`, `extra`, `short_turn`, `skipped_stop`) to matching departures.
- Build station-level `banners` from stop-scoped alerts.
- Fallback behavior:
  - if no stop-scoped banners were produced, surface route/trip-level matches as banners.

### `src/merge/synthesizeFromAlerts.js` (synthetic departures from alert text/times)

Primary responsibilities:
- Convert eligible alerts into synthetic departures (`source = "synthetic_alert"`).
- Strict synthesis gate:
  - only alerts with service-impact tags (`replacement`/`extra`)
  - only when explicit departure time signals can be extracted
- Keep rows inside board window + grace, then sort and limit.

### `src/merge/supplementFromOtdStationboard.js` (OTD replacement supplement)

Primary responsibilities:
- Parse OTD stationboard rows and detect replacement-service signals in text.
- Emit synthetic replacement rows when they fall inside board window.
- Used as optional supplement path (not the primary RT cache merge).

### `src/merge/pickPreferredDeparture.js` (dedupe preference)

Primary responsibilities:
- Decide which departure wins when deduping competing rows.
- Current preference signals include:
  - cancellation/suppression state
  - realtime evidence (`realtimeDeparture` drift, `delayMin`, RT source)
  - replacement/synthetic tags and sources.

## RT deep dive (`src/rt`)

### `src/rt/loadScopedRtFromParsedTables.js` (TripUpdates parsed-table scope loader)

Primary responsibilities:
- Read scoped RT rows from parsed tables (`rt_stop_time_updates`, `rt_trip_updates`) using indexed predicates (`trip_id = ANY(...)` and stop-id fallback).
- Build the in-memory merge structures consumed by `applyTripUpdates` (`byKey`, cancellations, stop status, trip flags, trip fallback, `addedTripStopUpdates`).
- Enforce freshness threshold (`STATIONBOARD_RT_FRESH_MAX_AGE_MS`, default 45s) using parsed-table `updated_at`.
- Return `meta.rtSource = "parsed"` so stationboard can expose source selection in debug/top-level meta.

### `src/rt/loadScopedRtFromCache.js` (TripUpdates cache scope loader)

Primary responsibilities:
- Read `la_tripupdates` cache snapshot via `loaders/loadRealtime.js`.
- TripUpdates payload decode reads are memory-cached per feed key for a short TTL (`RT_DECODED_FEED_CACHE_MS`, default `10s`, clamped `10s..15s`) with in-flight coalescing.
- Enforce freshness threshold (`STATIONBOARD_RT_FRESH_MAX_AGE_MS`, default 45s).
- Scope entities to current board context:
  - requested trip ids (`scopeTripIds`)
  - requested stop scope (`scopeStopIds` with stop-id variants)
  - same Swiss platform variant guard/order as merge: exact -> `:0` parent -> numeric root
  - ADDED trips additionally constrained by board time window
- Guardrails against request-path blowups:
  - max processing ms
  - max scanned entities
  - max scoped entities
  - max scoped stop updates
- Return `tripUpdates` plus rich `meta` (`applied`, `reason`, `cacheAgeMs`, `instance`, counters, `rtReadSource`, `rtCacheHit`, `rtPayloadFetchCountThisRequest`, `rtPayloadBytes`, `rtDecodeMs`).
- `meta.reason` is the raw scoped-loader reason (for example `applied`, `stale_cache`, `guard_tripped`)
  and is surfaced as `debug.rt.tripUpdates.rtMetaReason` by stationboard debug output.

Common reasons in `meta.reason`:
- `applied`
- `stale_cache`
- `missing_cache`
- `guard_tripped`
- `decode_failed`
- `disabled`

### `src/rt/loadAlertsFromCache.js` (Service Alerts cache loader)

Primary responsibilities:
- Read `la_servicealerts` payload from `rt_cache`.
- Decode protobuf payload and normalize entities (`normalizeAlertEntity` from loaders).
- Apply freshness + stale-grace policy:
  - fresh threshold: `STATIONBOARD_ALERTS_FRESH_MAX_AGE_MS` (default 120s)
  - stale grace: `STATIONBOARD_ALERTS_STALE_GRACE_MS` (default 30m)
- Return `alerts: { entities }` plus `meta` (`available`, `applied`, `reason`, `cacheAgeMs`, `status`).

### `src/rt/loadAlertsFromParsedTables.js` (Service Alerts parsed-table loader)

Primary responsibilities:
- Read alerts from `public.rt_service_alerts` with scoped SQL predicates and bounded row limits.
- Scope by `informed_entities` (`stop_id`, `route_id`, `trip_id`) plus an `updated_at` lookback window (`STATIONBOARD_ALERTS_PARSED_LOOKBACK_MS`).
- Build alert entities compatible with merge/attach pipeline (`id`, `effect`, text fields, `activePeriods`, `informedEntities`).
- Apply active-period filtering and optional stop/route/trip scope filtering.
- Expose `meta.alertsSource = "parsed"` and freshness/staleness semantics aligned with request-path alerts behavior.

### Thin re-exports (`src/rt/fetch*.js`, `src/rt/tripUpdatesSummary.js`)

Primary responsibilities:
- Re-export loader utilities from `src/loaders/*`.
- Keep existing import paths stable while loader implementations live elsewhere.

## Merge/RT change map (where to edit)

| Change you want | Primary file |
| --- | --- |
| Delay/cancellation/suppressed-stop merge behavior | `src/merge/applyTripUpdates.js` |
| Platform-change detection from RT stop ids | `src/merge/applyTripUpdates.js` |
| ADDED-trip departures | `src/merge/applyAddedTrips.js` |
| Alert-to-banner and alert-to-departure matching | `src/merge/attachAlerts.js` |
| Synthetic departures from alert time text | `src/merge/synthesizeFromAlerts.js` |
| OTD replacement supplement behavior | `src/merge/supplementFromOtdStationboard.js` |
| Dedupe preference between competing departure rows | `src/merge/pickPreferredDeparture.js` |
| Scoped TripUpdates parsed-table loading (default request path) | `src/rt/loadScopedRtFromParsedTables.js` |
| Scoped TripUpdates cache loading + guard limits (fallback path) | `src/rt/loadScopedRtFromCache.js` |
| Parsed Service Alerts loading (default request path) | `src/rt/loadAlertsFromParsedTables.js` |
| Service-alert cache loading + freshness/grace | `src/rt/loadAlertsFromCache.js` |

## Folder summary

- `src/api/`: route handlers + stationboard API orchestration.
- `src/audit/`: GTFS static vs RT audit table helpers.
- `src/db/`: DB wrapper and `rt_cache` helpers.
- `src/debug/`: stationboard/cancellation diagnostic helpers.
- `src/loaders/`: direct upstream GTFS-RT/alerts loaders + summary helpers.
- `src/logic/`: core stationboard build from static+RT.
- `src/merge/`: merge/transformation steps for departures and alerts.
- `src/models/`: response normalization/canonical shaping.
- `src/resolve/`: stop/station resolution logic.
- `src/rt/`: parsed-first RT/alerts loaders, blob/debug fallbacks, and thin re-exports.
- `src/search/`: stop-search normalization/ranking/query behavior.
- `src/sql/`: stationboard SQL query.
- `src/time/`: Zurich timezone/service-day utilities.
- `src/util/`: shared helper utilities.

## File-by-file catalog

### `src/api`

- `src/api/stationboard.js` (1847 lines)
  - Exports: `getStationboard(...)`
- `src/api/stationboardRoute.js` (1168 lines)
  - Exports: `deriveResolvedIdentity(...)`, `createStationboardRouteHandler(...)`
- `src/api/stopSearchRoute.js` (121 lines)
  - Exports: `createStopSearchRouteHandler(...)`

### `src/audit`

- `src/audit/alignmentLogs.js` (373 lines)
  - Exports:
    - `getFeedHeaderTimestampSeconds(...)`
    - `epochSecondsToDate(...)`
    - `computeObjectSha256(...)`
    - `extractTripUpdatesSnapshot(...)`
    - `ensureAlignmentAuditTables(...)`
    - `fetchCurrentStaticSnapshot(...)`
    - `fetchCurrentFeedVersion(...)`
    - `insertStaticIngestLog(...)`
    - `insertRtPollLog(...)`

### `src/db`

- `src/db/query.js` (7 lines)
  - Exports: `query(...)`, `db`
- `src/db/rtCache.js` (135 lines)
  - Exports:
    - `LA_TRIPUPDATES_FEED_KEY`
    - `LA_SERVICEALERTS_FEED_KEY`
    - `upsertRtCache(...)`
    - `getRtCache(...)`
    - `getRtCacheMeta(...)`

### `src/debug`

- `src/debug/cancellationTrace.js` (64 lines)
  - Exports: `createCancellationTracer(...)`
- `src/debug/departureAudit.js` (56 lines)
  - Exports: `buildDepartureAudit(...)`
- `src/debug/stationboardDebug.js` (54 lines)
  - Exports:
    - `shouldEnableStationboardDebug(...)`
    - `summarizeCancellation(...)`
    - `createStationboardDebugLogger(...)`

### `src/loaders`

- `src/loaders/fetchServiceAlerts.js` (275 lines)
  - Exports:
    - `LA_GTFS_RT_SERVICE_ALERTS_URL`
    - `normalizeAlertEntity(...)`
    - `resolveServiceAlertsApiKey(...)`
    - `fetchServiceAlerts(...)`
- `src/loaders/fetchTripUpdates.js` (275 lines)
  - Exports:
    - `LA_GTFS_RT_TRIP_UPDATES_URL`
    - `resolveTripUpdatesApiKey(...)`
    - `fetchTripUpdates(...)`
    - `__resetTripUpdatesFetchStateForTests()`
    - `__getTripUpdatesFetchStateForTests()`
- `src/loaders/tripUpdatesSummary.js` (175 lines)
  - Exports: `summarizeTripUpdates(...)`

### `src/logic`

- `src/logic/buildStationboard.js` (1170 lines)
  - Exports: `buildStationboard(...)`

### `src/merge`

- `src/merge/applyAddedTrips.js` (321 lines)
  - Exports: `applyAddedTrips(...)`
- `src/merge/applyTripUpdates.js` (937 lines)
  - Exports: `applyTripUpdates(...)`
- `src/merge/attachAlerts.js` (411 lines)
  - Exports: `attachAlerts(...)`
- `src/merge/pickPreferredDeparture.js` (51 lines)
  - Exports: `pickPreferredMergedDeparture(...)`
- `src/merge/supplementFromOtdStationboard.js` (133 lines)
  - Exports: `supplementFromOtdStationboard(...)`
- `src/merge/synthesizeFromAlerts.js` (350 lines)
  - Exports: `synthesizeFromAlerts(...)`

### `src/models`

- `src/models/stationboard.js` (359 lines)
  - Exports: `computeDisplayFields(...)`, `normalizeDeparture(...)`

### `src/resolve`

- `src/resolve/resolveStop.js` (456 lines)
  - Exports: `normalizeAliasKey(...)`, `resolveStop(...)`

### `src/rt`

- `src/rt/fetchServiceAlerts.js` (1 line)
  - Exports: re-export of `fetchServiceAlerts` from `src/loaders/fetchServiceAlerts.js`
- `src/rt/fetchTripUpdates.js` (1 line)
  - Exports: re-export of `fetchTripUpdates` from `src/loaders/fetchTripUpdates.js`
- `src/rt/loadAlertsFromCache.js` (149 lines)
  - Exports: `loadAlertsFromCache(...)`
- `src/rt/loadScopedRtFromCache.js` (409 lines)
  - Exports: `loadScopedRtFromCache(...)`
- `src/rt/tripUpdatesSummary.js` (1 line)
  - Exports: re-export of `summarizeTripUpdates` from `src/loaders/tripUpdatesSummary.js`

### `src/search`

- `src/search/stopsSearch.js` (1527 lines)
  - Exports:
    - `normalizeSearchText(...)`
    - `stripStopWords(...)`
    - `rankStopCandidatesDetailed(...)`
    - `rankStopCandidates(...)`
    - `__resetSearchCapabilitiesCacheForTests()`
    - `detectSearchCapabilities(...)`
    - `searchStops(...)`
    - `searchStopsWithDebug(...)`

### `src/sql`

- `src/sql/stationboard.sql` (124 lines)
  - SQL query used by stationboard builder.

### `src/time`

- `src/time/zurichTime.js` (206 lines)
  - Exports:
    - `formatZurich(...)`
    - `secondsSinceZurichMidnight(...)`
    - `ymdIntInZurich(...)`
    - `weekdayIndexInZurich(...)`
    - `addDaysToYmdInt(...)`
    - `zurichDateTimeToUtcDate(...)`
    - `dateFromZurichServiceDateAndSeconds(...)`
    - `dateFromZurichServiceDateAndTime(...)`
    - `zonedWindowDebug(...)`
    - `ZURICH_TIME_ZONE`

### `src/util`

- `src/util/alertActive.js` (137 lines)
  - Exports: `isAlertActiveNow(...)`
- `src/util/alertDebugScope.js` (45 lines)
  - Exports: `stopRootForDebugMatch(...)`, `informedStopMatchesForDebug(...)`
- `src/util/departureDelay.js` (54 lines)
  - Exports:
    - `DELAY_JITTER_SEC`
    - `computeDelaySecondsFromTimestamps(...)`
    - `computeDepartureDelayDisplayFromSeconds(...)`
- `src/util/departureFilter.js` (53 lines)
  - Exports: `isRenderableDepartureRow(...)`, `filterRenderableDepartures(...)`
- `src/util/i18n.js` (114 lines)
  - Exports: `resolveLangPrefs(...)`, `pickTranslation(...)`
- `src/util/searchNormalize.js` (32 lines)
  - Exports: `normalizeStopSearchText(...)`
- `src/util/stopScope.js` (56 lines)
  - Exports: `normalizeStopId(...)`, `stopKeySet(...)`, `hasTokenIntersection(...)`
- `src/util/text.js` (64 lines)
  - Exports:
    - `normalizeText(...)`
    - `lower(...)`
    - `toArray(...)`
    - `uniqueStrings(...)`
    - `routeLabel(...)`
    - `departureReasons(...)`
    - `looksLikeDisruptionText(...)`
- `src/util/upstreamRequestGuard.js` (46 lines)
  - Exports: `isBlockedStationboardUpstreamUrl(...)`, `guardStationboardRequestPathUpstream(...)`

## Note

- `src/.DS_Store` is a macOS metadata file and is not part of backend runtime logic.

