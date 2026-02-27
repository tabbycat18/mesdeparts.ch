# README — GTFS-RT Poller

The **poller** is a continuously-running background process that keeps the real-time departure data for mesdeparts.ch fresh. It runs as a dedicated Fly.io application (`mesdeparts-rt-poller`), separate from the public backend (`mesdeparts-ch`). Every 15 seconds it fetches the Swiss national GTFS-RT TripUpdates feed from the opendata.swiss API, decodes the protobuf payload, and upserts the parsed trip-delay and stop-time data into the shared Neon PostgreSQL database. In parallel, every 60 seconds, it fetches the ServiceAlerts feed and does the same. The backend API (`mesdeparts-ch`) then reads from these tables on every stationboard request to merge real-time delays onto the static GTFS schedule before serving the response to the Cloudflare edge and ultimately to browser clients.

---

## Architecture at a glance

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  opendata.swiss (LA GTFS-RT)                                             │
 │  GET /la/gtfs-rt?format=JSON   ← TripUpdates (protobuf)                 │
 │  GET /la/gtfs-sa               ← ServiceAlerts (protobuf)               │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  HTTP (auth token)  poll every 15 s / 60 s
                 │
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │  Fly.io — mesdeparts-rt-poller  (fly.poller.toml)                        │
 │  Process: npm run poller  →  scripts/pollFeeds.js                        │
 │    ├─ scripts/pollLaTripUpdates.js   (15 s loop, advisory lock 7483921)  │
 │    └─ scripts/pollLaServiceAlerts.js (60 s loop, advisory lock 7483922)  │
 │  Region: ams  |  1 shared CPU  |  1 GB RAM  |  always-on (no HTTP port) │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  pg upsert (Neon pooled URL)
                 │
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │  Neon PostgreSQL (shared DB)                                             │
 │  rt_cache              — raw protobuf blob + etag + last_status          │
 │  rt_tripupdates        — parsed trip-level delays                        │
 │  rt_tripupdates_stop   — parsed stop-level delays                        │
 │  rt_servicealerts      — parsed alert entities                           │
 │  rt_servicealerts_informed_entity  — alert→route/trip/stop mappings      │
 │  rt_poller_heartbeat   — poller liveness timestamps                      │
 │  meta_kv               — payload SHA-256 change detection                │
 └──────────────────────────────────────────────┬───────────────────────────┘
                                                │  pg read (on each request)
 ┌──────────────────────────────────────────────▼───────────────────────────┐
 │  Fly.io — mesdeparts-ch  (fly.toml)                                      │
 │  Process: npm start  →  server.js  (Express, port 8080)                  │
 │    loaders/loadRealtime.js      — in-memory decoded feed cache (10–15 s) │
 │    src/api/stationboard.js      — orchestrates RT merge per request      │
 │    src/logic/buildStationboard.js — SQL + RT merge pipeline              │
 │  Region: ams  |  1 shared CPU  |  1 GB RAM  |  HTTP  |  auto-scaling    │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │  proxy (all /api/* traffic)
                 │
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │  Cloudflare Worker — mesdeparts-ch  (edge/worker.js)                     │
 │  Route: api.mesdeparts.ch/*                                              │
 │    /api/stationboard → edge-cached 15 s  (CDN-Cache-Control: 15)         │
 │    /api/*            → proxied, no cache                                 │
 │    Rate limit: 120 req/min per IP  (Cloudflare cache API as store)       │
 │    Headers added: x-md-cache, x-md-request-id, x-md-worker-total-ms     │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │
                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  Browser client  /  mesdeparts.ch frontend                               │
 │  Served by Cloudflare Pages (static files from realtime_api/frontend/)  │
 │  v20260223-1.main.js — refresh loop calling api.mesdeparts.ch/api/       │
 └──────────────────────────────────────────────────────────────────────────┘
```

---

## Where the code lives

| Path | Role |
|---|---|
| [`realtime_api/backend/scripts/pollFeeds.js`](realtime_api/backend/scripts/pollFeeds.js) | **Supervisor entrypoint.** Starts both pollers in parallel via `Promise.all`. Implements `runPollerWithRestart()` — infinite outer loop with exponential-backoff restart (5 s base, 60 s max ±20 % jitter) on any crash or unexpected exit. |
| [`realtime_api/backend/scripts/pollLaTripUpdates.js`](realtime_api/backend/scripts/pollLaTripUpdates.js) | **TripUpdates poller.** Exports `createLaTripUpdatesPoller()`. Tick-based loop: fetch → ETag check → decode → upsert. Default interval 15 s (floor 5 s). |
| [`realtime_api/backend/scripts/pollLaServiceAlerts.js`](realtime_api/backend/scripts/pollLaServiceAlerts.js) | **ServiceAlerts poller.** Same architecture as TripUpdates. Default interval 60 s (floor 15 s). Uses snapshot (replace-all) strategy rather than incremental upsert. |
| [`realtime_api/backend/scripts/checkPollerHeartbeat.js`](realtime_api/backend/scripts/checkPollerHeartbeat.js) | **Health check.** Reads `rt_poller_heartbeat` and exits 0 (OK) or 2 (stale/missing). Thresholds: trip ≤ 90 s, alerts ≤ 300 s. |
| [`realtime_api/backend/src/loaders/fetchTripUpdates.js`](realtime_api/backend/src/loaders/fetchTripUpdates.js) | Resolves API token; provides upstream URL constant `LA_GTFS_RT_TRIP_UPDATES_URL`. Used by both the poller and on-demand request path. |
| [`realtime_api/backend/src/loaders/fetchServiceAlerts.js`](realtime_api/backend/src/loaders/fetchServiceAlerts.js) | Same as above for ServiceAlerts; also contains `normalizeAlertEntity()` with enum mappings, translation picker, and deduplication. |
| [`realtime_api/backend/src/rt/persistParsedArtifacts.js`](realtime_api/backend/src/rt/persistParsedArtifacts.js) | Parses decoded feeds and upserts rows into `rt_tripupdates`/`rt_tripupdates_stop` (incremental) and `rt_servicealerts`/`rt_servicealerts_informed_entity` (snapshot). Batch sizes: 500 trip rows, 200 stop rows. |
| [`realtime_api/backend/src/db/rtCache.js`](realtime_api/backend/src/db/rtCache.js) | DB layer for `rt_cache` and `meta_kv`. Handles advisory lock acquisition/release, upsert of raw blobs, and SHA-256 comparison. Feed keys: `"la_tripupdates"`, `"la_servicealerts"`. |
| [`realtime_api/backend/src/db/rtPollerHeartbeat.js`](realtime_api/backend/src/db/rtPollerHeartbeat.js) | Read/write helpers for `rt_poller_heartbeat`. Touched on every successful tick and every error. |
| [`realtime_api/backend/loaders/loadRealtime.js`](realtime_api/backend/loaders/loadRealtime.js) | **Backend-side cache.** In-memory cache of the decoded feed (TTL 10–15 s). Used by the stationboard request path, not the poller. |
| [`realtime_api/backend/src/api/stationboard.js`](realtime_api/backend/src/api/stationboard.js) | Stationboard orchestrator: loads static schedule, calls `loadRealtimeDelayIndexOnce()`, merges delays, attaches alerts. |
| [`realtime_api/edge/worker.js`](realtime_api/edge/worker.js) | Cloudflare Worker. Proxies all `api.mesdeparts.ch/*` to the Fly backend. Edge-caches `/api/stationboard` 15 s. Rate-limits per IP. |
| [`realtime_api/edge/wrangler.toml`](realtime_api/edge/wrangler.toml) | Worker deployment config. Route: `api.mesdeparts.ch/*`. `RT_BACKEND_ORIGIN = "https://mesdeparts-ch.fly.dev"`. |
| [`fly.poller.toml`](fly.poller.toml) | Fly.io config for the poller app (`mesdeparts-rt-poller`). Process: `npm run poller`. Region: `ams`. No HTTP service. |
| [`fly.toml`](fly.toml) | Fly.io config for the main backend app (`mesdeparts-ch`). HTTP service on 8080. |
| [`Dockerfile`](Dockerfile) | **Shared Docker image** (node:20-alpine). Used by both Fly apps. Default `CMD ["npm", "start"]`; poller app overrides to `npm run poller` via `fly.poller.toml [processes]`. |

---

## How it runs

### Trigger mechanism

The poller is an **always-on process loop** — there is no cron, no external scheduler, no GitHub Actions schedule, and no Fly.io cron trigger. The Fly machine for `mesdeparts-rt-poller` runs continuously with `min_machines_running` implied by the background process semantics.

The loop structure:

```
pollFeeds.js  (supervisor)
  └─ runPollerWithRestart("trip_updates", createLaTripUpdatesPoller)   ─┐
  └─ runPollerWithRestart("service_alerts", createLaServiceAlertsPoller) ─┤ Promise.all
                                                                          ┘

Each poller: createFooPoller() → { tick(), runForever() }
  runForever() = infinite for(;;) loop calling tick() then sleeping
```

### Intervals (verified in code)

| Poller | Default interval | Env var override | Floor |
|---|---|---|---|
| TripUpdates | **15 000 ms** | `GTFS_RT_POLL_INTERVAL_MS` | 5 000 ms |
| ServiceAlerts | **60 000 ms** | `GTFS_SA_POLL_INTERVAL_MS` | 15 000 ms |

The sleep between ticks is calculated dynamically: the interval minus the tick duration, floored at 0. On upstream errors, the poller enters a backoff sleep instead of the normal interval sleep.

### Supervisor restart backoff

If `runForever()` throws or unexpectedly returns, `runPollerWithRestart()` restarts it with exponential backoff:

- Base: 5 000 ms
- Max: 60 000 ms
- Jitter: ±20 % of computed delay

DB disconnect errors (PostgreSQL codes `57P01`–`57P03`, `08xxx`, `53300`, and network codes `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`) are detected and logged with event `poller_db_error_reconnect`.

---

## Adjacent scheduled jobs (not the RT poller)

### GitHub Actions — GTFS static refresh

File: [`.github/workflows/gtfs_static_refresh.yml`](.github/workflows/gtfs_static_refresh.yml)

This is a **separate, unrelated scheduler** triggered by a GitHub Actions cron. It refreshes the static GTFS schedule data (stops, routes, trips, stop_times), not the real-time feeds.

| Property | Value |
|---|---|
| Trigger | `cron: "0 * * * *"` (every hour, at minute :00) + `workflow_dispatch` |
| Concurrency | group `gtfs-refresh`, `cancel-in-progress: false` |
| Script | `node scripts/refreshGtfsIfNeeded.js` |
| Upstream URL | `https://data.opentransportdata.swiss/fr/dataset/timetable-2026-gtfs2020/permalink` |
| Advisory lock | `GTFS_REFRESH_LOCK_ID = 7_483_920` (distinct from RT locks 7483921/7483922) |
| GitHub secrets used | `NEON_DATABASE_URL`, `OPENTDATA_GTFS_RT_KEY`, `OPENTDATA_GTFS_SA_KEY` |
| Post-step | SQL verification that `stop_search_index` materialized view is canonical and all 4 required indexes are valid |

The script compares SHA-256 and ETag of the GTFS ZIP against the values stored in `meta_kv`. A full table cutover only runs when the ZIP has actually changed; otherwise it exits cleanly as a no-op. The `GTFS_STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS` env var (default 6 h) throttles search index rebuilds even when the data changes.

### Frontend refresh loop

The browser client (`realtime_api/frontend/v20260205-1.main.js`) runs its own **`setTimeout`-based refresh loop** (not `setInterval`). Each tick schedules the next via `scheduleNextRefresh()` → `setTimeout(fn, delayMs)`.

| Constant | Value | Source |
|---|---|---|
| `REFRESH_DEPARTURES` | **15 000 ms** (base interval) | `v20260205-1.state.js:23` |
| `FOLLOWUP_REFRESH_BASE_MS` | 3 000 ms (post-load follow-up) | `v20260205-1.main.js:73` |
| `REFRESH_BACKOFF_STEPS_MS` | [2 000, 5 000, 10 000, 15 000] ms | `v20260205-1.main.js:76` |
| `FULL_REFRESH_INTERVAL_MS` | 10 × 60 000 ms (force full reload) | `v20260205-1.main.js:228` |

The loop skips scheduling when the tab is hidden (`document.hidden`). It is completely independent of the backend poller — it just polls the Cloudflare edge at `api.mesdeparts.ch/api/stationboard`.

### Pattern scan results (confirmed absent)

The following patterns were searched across the entire repo and **not found** in any active runtime code:

| Pattern | Result |
|---|---|
| `setInterval` (backend/poller) | Not present. Pollers use Promise-based `sleep()` with `setTimeout`. |
| `node-cron` / `cron(...)` | Not present. |
| `RRULE` | Not present. |
| `onSchedule` / `on('scheduled')` | Not present. |
| `bull` / job queue | Not present. No message queues of any kind. |
| `refreshStationboard` | Not present. Equivalent is `refreshDepartures()` in frontend. |
| `loadTripUpdates` | Not present. Equivalent is `fetchTripUpdates()` / `loadRealtimeDelayIndexOnce()`. |

---

## What it does step-by-step

### TripUpdates poller (every ~15 s)

1. **Check cache metadata** — reads `rt_cache` row for `"la_tripupdates"`: last `fetched_at`, stored `etag`, payload size.
2. **Decide whether to write** — skips write if the last successful write was within `RT_CACHE_MIN_WRITE_INTERVAL_MS` (default 30 s), even if a new payload arrives.
3. **Fetch upstream** — `GET https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON` with `Authorization: <token>` and `If-None-Match: <etag>` (if available). Timeout: `GTFS_RT_FETCH_TIMEOUT_MS` (default 8 000 ms).
4. **Handle HTTP status:**
   - **200** → payload is new or changed; proceed to decode.
   - **304** → payload unchanged; update `fetched_at` timestamp in `rt_cache` only (no blob write).
   - **429** → rate-limited; enter backoff (base 60 s, max 10 min, exponential).
   - **Other error** → enter backoff (base 15 s, max 2 min; non-transient errors use 120 s base, 10 min max).
5. **SHA-256 check** — compare hash of new payload to stored hash in `meta_kv`. Skip upsert if unchanged (dedup guard).
6. **Acquire advisory lock** — `pg_try_advisory_xact_lock(7483921)`. If lock not acquired (another instance is writing), skip this write cycle; log a warning if lock-skip streak exceeds `RT_POLLER_LOCK_SKIP_WARN_STREAK` (default 6) or the cached payload is stale beyond `RT_POLLER_LOCK_SKIP_STALE_AGE_MS` (default 90 s).
7. **Persist raw blob** — upsert into `rt_cache(feed_key, payload, fetched_at, etag, last_status)`.
8. **Decode protobuf** — `GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(payloadBytes)`.
9. **Persist parsed data** — call `persistParsedTripUpdatesIncremental()`:
   - Batch-upsert trip rows into `rt_tripupdates` (500 rows/batch).
   - Batch-upsert stop rows into `rt_tripupdates_stop` (200 rows/batch).
   - Prune rows older than `RT_PARSED_RETENTION_HOURS` (default 6 h).
10. **Update payload SHA** — write new SHA-256 to `meta_kv`.
11. **Touch heartbeat** — `touchTripUpdatesHeartbeat({ at, instanceId })` → writes `tripupdates_updated_at` in `rt_poller_heartbeat`.
12. **Sleep** — wait until next interval tick.

### ServiceAlerts poller (every ~60 s)

Steps 1–11 follow the same pattern with these differences:

- URL: `https://api.opentransportdata.swiss/la/gtfs-sa`
- Feed key: `"la_servicealerts"`, advisory lock ID: `7483922`
- Persistence strategy: **snapshot** (`persistParsedServiceAlertsSnapshot`) — deletes all existing alert rows then inserts fresh snapshot in a transaction. This avoids stale alert accumulation.
- Tables written: `rt_servicealerts`, `rt_servicealerts_informed_entity`.
- Heartbeat: `touchAlertsHeartbeat()`.

### Backend read path (not the poller, but relevant context)

On each `/api/stationboard` request, the backend calls `loadRealtimeDelayIndexOnce()` in [`loaders/loadRealtime.js`](realtime_api/backend/loaders/loadRealtime.js). This reads from the **parsed tables** (`rt_tripupdates`, `rt_tripupdates_stop`) by default — **not** from `rt_cache` blobs. The in-memory decoded-feed cache has a TTL of 10 000–15 000 ms (`RT_DECODED_FEED_CACHE_MS`) to avoid hammering the DB on every request.

---

## Configuration

### Poller env vars

| Name | Required | Default | Purpose | Where set |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Neon PostgreSQL connection string (pooled) | Fly secret (`mesdeparts-rt-poller`) |
| `GTFS_RT_TOKEN` | **Yes*** | — | Bearer token for opendata.swiss GTFS-RT API | Fly secret (`mesdeparts-rt-poller`) |
| `OPENDATA_SWISS_TOKEN` | No | — | Fallback token (checked if `GTFS_RT_TOKEN` absent) | Fly secret or `.env` |
| `OPENTDATA_GTFS_RT_KEY` | No | — | Second fallback for TripUpdates API key | Fly secret or `.env` |
| `OPENTDATA_GTFS_SA_KEY` | No | — | Primary token for ServiceAlerts feed | Fly secret or `.env` |
| `OPENTDATA_API_KEY` | No | — | Fallback for ServiceAlerts feed | Fly secret or `.env` |
| `GTFS_RT_POLL_INTERVAL_MS` | No | `15000` | TripUpdates poll interval (floor 5 000 ms) | Fly secret / env |
| `GTFS_SA_POLL_INTERVAL_MS` | No | `60000` | ServiceAlerts poll interval (floor 15 000 ms) | Fly secret / env |
| `GTFS_RT_FETCH_TIMEOUT_MS` | No | `8000` | HTTP fetch timeout for both feeds | Fly secret / env |
| `GTFS_SA_FETCH_TIMEOUT_MS` | No | `GTFS_RT_FETCH_TIMEOUT_MS` | ServiceAlerts-specific fetch timeout | Fly secret / env |
| `RT_CACHE_MIN_WRITE_INTERVAL_MS` | No | `30000` | Minimum time between blob writes to `rt_cache` | Fly secret / env |
| `RT_PARSED_RETENTION_HOURS` | No | `6` | How long to keep parsed rows in `rt_tripupdates*` | Fly secret / env |
| `RT_POLLER_LOCK_SKIP_WARN_STREAK` | No | `6` | Warn after N consecutive lock-skip cycles | Fly secret / env |
| `RT_POLLER_LOCK_SKIP_STALE_AGE_MS` | No | `90000` | Warn if skipped and cached payload is older than this | Fly secret / env |
| `RT_POLLER_HEARTBEAT_ENABLED` | No | `"0"` (enabled) | Set to `"0"` to enable; any other value disables heartbeat writes | Fly secret / env |
| `LA_GTFS_RT_URL` | No | Upstream default | Override TripUpdates upstream URL | Fly secret / env |
| `LA_GTFS_SA_URL` | No | Upstream default | Override ServiceAlerts upstream URL | Fly secret / env |
| `RT_UPSERT_BATCH_DEBUG` | No | — | Set `"1"` to log batch sizes during upsert | Fly secret / env |
| `FLY_MACHINE_ID` | No | — | Auto-set by Fly.io; used as `instance_id` in heartbeat | Auto (Fly) |

*At least one of `GTFS_RT_TOKEN`, `OPENDATA_SWISS_TOKEN`, or `OPENTDATA_GTFS_RT_KEY` must be present or the supervisor exits immediately with `poller_missing_token`.

### Backend env vars (relevant to RT path)

| Name | Required | Default | Purpose | Where set |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Neon PostgreSQL connection string | Fly secret (`mesdeparts-ch`) |
| `ENABLE_RT` | No | — | Set `"1"` to enable real-time data in stationboard | Fly secret (`mesdeparts-ch`) / `fly.toml` |
| `GTFS_RT_CACHE_MS` | No | `30000` | In-memory TTL for raw RT payload | Fly env |
| `RT_DECODED_FEED_CACHE_MS` | No | `10000` | In-memory TTL for decoded feed object (min 10 000 ms, max 15 000 ms) | Fly env |
| `DEBUG_RT` | No | — | Set `"1"` for verbose GTFS-RT logging | Fly env |
| `STATIONBOARD_MIN_REMAINING_RT_APPLY_MS` | No | `500` | Latency guard: skip RT merge if remaining budget < this | `fly.toml [env]` |
| `POLLER_HEARTBEAT_TRIP_MAX_AGE_S` | No | `90` | `checkPollerHeartbeat.js` staleness threshold for trip updates | CLI arg or env |
| `POLLER_HEARTBEAT_ALERTS_MAX_AGE_S` | No | `300` | `checkPollerHeartbeat.js` staleness threshold for alerts | CLI arg or env |

### Cloudflare Worker env vars

| Name | Required | Default | Purpose | Where set |
|---|---|---|---|---|
| `RT_BACKEND_ORIGIN` | **Yes** | `"https://mesdeparts-ch.fly.dev"` | Fly backend URL to proxy to | `wrangler.toml [vars]` |
| `RATE_LIMIT_PER_MIN` | No | `120` | Per-IP rate limit (requests/minute) | Cloudflare dashboard / `wrangler.toml` |
| `GLOBAL_DAILY_LIMIT` | No | `0` (disabled) | Global daily request cap | Cloudflare dashboard / `wrangler.toml` |
| `WORKER_CACHE_DEBUG` | No | — | Set `"1"` for cache hit/miss logging | Cloudflare dashboard |
| `WORKER_TIMING_LOG` | No | — | Set `"1"` for worker timing logs | Cloudflare dashboard |

---

## Deploy & operate

### Run locally

```bash
# 1. Install dependencies
cd realtime_api/backend
npm install

# 2. Create .env in realtime_api/backend/ with at minimum:
#    DATABASE_URL=postgres://...
#    GTFS_RT_TOKEN=...

# 3. Run the full poller (TripUpdates + ServiceAlerts supervisor)
npm run poller
# TZ=Europe/Zurich node scripts/pollFeeds.js

# 4. Run individual pollers for debugging
npm run poller:trip      # TripUpdates only
npm run poller:alerts    # ServiceAlerts only

# 5. Check poller health (reads rt_poller_heartbeat from DB)
npm run poller:heartbeat
# or with custom thresholds:
node scripts/checkPollerHeartbeat.js --trip-threshold-s 90 --alerts-threshold-s 300
```

### Deploy the poller to Fly.io

```bash
# Deploy (or update) the dedicated poller app
flyctl deploy --config fly.poller.toml

# The poller app is: mesdeparts-rt-poller
# It reuses the same root Dockerfile as the backend.
# fly.poller.toml overrides CMD to: npm run poller
# There is NO HTTP service — it is a purely background process.

# Set required secrets (one-time per app):
fly secrets set GTFS_RT_TOKEN="<token>" --app mesdeparts-rt-poller
fly secrets set DATABASE_URL="<neon-pooled-url>" --app mesdeparts-rt-poller

# Check logs:
fly logs --app mesdeparts-rt-poller

# SSH into the machine:
fly ssh console --app mesdeparts-rt-poller
```

### Deploy the main backend to Fly.io

```bash
# Deploy (uses fly.toml + root Dockerfile)
flyctl deploy
# or: fly deploy

# App name: mesdeparts-ch
# Health check: GET /health  (returns JSON with ok, db, ENABLE_RT, hasToken)
```

### Deploy the Cloudflare Worker

```bash
npx wrangler deploy --config realtime_api/edge/wrangler.toml
# Worker name: mesdeparts-ch
# Route: api.mesdeparts.ch/*
# Proxies all /api/* to RT_BACKEND_ORIGIN (https://mesdeparts-ch.fly.dev)
```

### How Cloudflare affects the poller

The **poller does not interact with Cloudflare at all**. It calls the opendata.swiss upstream APIs directly and writes directly to Neon via PostgreSQL. Cloudflare only sits in the path between browser clients and the backend.

What Cloudflare does that matters for freshness:

- `/api/stationboard` responses are edge-cached for **15 seconds** (`CDN-Cache-Control: max-age=15`).
- Browser clients receive `Cache-Control: private, no-store, max-age=0, must-revalidate` to prevent local caching.
- Cache key for stationboard is normalised by the worker: only `stop_id`, `limit`, and `window_minutes` params are included; other query params are stripped.
- Cache bypass: append `?debug=1` to any stationboard request to skip the edge cache (`shouldBypassStationboardCache`).
- The `x-md-cache` response header indicates `HIT`, `MISS`, or `BYPASS`.

---

## Troubleshooting

### Poller appears to have stopped / departures are stale

```bash
# 1. Check heartbeat (exits 0 = OK, 2 = stale/missing)
cd realtime_api/backend
npm run poller:heartbeat

# 2. Live logs on Fly
fly logs --app mesdeparts-rt-poller

# 3. Key log events to look for:
#    poller_supervisor_start      — normal startup
#    poller_tick_success          — successful fetch+upsert cycle
#    poller_db_error_reconnect    — DB disconnect; supervisor will retry
#    poller_runner_error_reconnect — other crash; supervisor will retry
#    poller_runner_unexpected_exit — runForever() returned (shouldn't happen)
#    rt_poller_lock_skip_warn     — advisory lock contention (two instances?)
```

### 429 rate-limit errors from opendata.swiss

The pollers handle 429 automatically with exponential backoff (60 s base, 10 min max). If you see repeated `backoff_reason: "rate_limited"` in logs, the API token may have hit its quota. Check your opendata.swiss API key quota. You can widen the interval with `GTFS_RT_POLL_INTERVAL_MS`.

### DB connection errors

PostgreSQL error codes `57P01`–`57P03`, `08xxx`, `53300`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE` trigger the `isLikelyDbDisconnectError` path and a supervisor restart. These are typically transient Neon pool timeouts. The supervisor will retry with exponential backoff (5 s base, 60 s max). If they persist, check the Neon console for connection limits or check `DATABASE_URL` is set correctly in Fly secrets.

### Stale data despite poller running

Check the full chain:

1. **Is `ENABLE_RT` set to `"1"` in `mesdeparts-ch` Fly app?** → `GET https://mesdeparts-ch.fly.dev/health`
2. **Is the in-memory backend cache too stale?** → `RT_DECODED_FEED_CACHE_MS` default is 10 s; check `rtMetaReason` in stationboard response meta.
3. **Is the Cloudflare edge cache serving a stale response?** → Check `x-md-cache: HIT` header. If HIT, wait 15 s or use `?debug=1` to bypass.
4. **Is the data in the DB fresh?** → `npm run poller:heartbeat` shows `ageS` for both feeds.

### Advisory lock contention warning (`rt_poller_lock_skip_warn`)

This means two poller instances tried to write concurrently — for example, after a re-deploy with overlap. The warning fires after `RT_POLLER_LOCK_SKIP_WARN_STREAK` (default 6) consecutive skipped cycles or when the cached payload is older than `RT_POLLER_LOCK_SKIP_STALE_AGE_MS` (default 90 s). Normally, only one machine should be running `mesdeparts-rt-poller`. Check:

```bash
fly status --app mesdeparts-rt-poller
# should show exactly 1 machine running
```

### Backend `/health` endpoint

```bash
curl https://mesdeparts-ch.fly.dev/health
# {"ok":true,"port":8080,"db":1,"ENABLE_RT":"1","hasToken":true}
```

### Debug endpoints (development only)

```
GET /api/debug/alerts?stop_id=<id>         — alert analysis for a stop
GET /api/_debug/tripupdates_summary?force_upstream=1  — TripUpdates feed analysis
GET /api/_dbinfo                           — DB schema info
```

---

## Assumptions / Unknowns

- **Dockerfile for poller**: There is no dedicated Dockerfile for the poller. Based on `fly.poller.toml` (no `[build]` section) and the AGENTS.md documentation, the poller reuses the root `Dockerfile`. The `[processes]` block in `fly.poller.toml` overrides the startup command to `npm run poller`. This is consistent with AGENTS.md § 10 but is not directly confirmed by a Fly.io build log — **I cannot verify this from a live build log.**
- **Neon connection string name**: The heartbeat script checks for `DATABASE_URL` or `DATABASE_URL_POLLER`. Whether the poller Fly app uses `DATABASE_URL_POLLER` (a separate pooled URL) or the same `DATABASE_URL` as the backend is not confirmed from env/secrets config — **I cannot verify which is set in production Fly secrets.**
- **GitHub Actions GTFS static refresh is separate**: `.github/workflows/gtfs_static_refresh.yml` runs hourly (`cron: "0 * * * *"`) and refreshes static GTFS tables, not the RT poller. It was initially missed in the first scan and is now documented in "Adjacent scheduled jobs" above.
- **Cloudflare Pages deployment**: AGENTS.md states the frontend is served by Cloudflare Pages, "managed via Cloudflare dashboard (not in repo)". The exact Pages project name, build config, and deploy triggers are not in the repo — **I cannot verify these from the codebase.**
- **`RT_POLLER_HEARTBEAT_ENABLED` semantics**: The env var comment in the code says `"0"` means *enabled* (counter-intuitive naming). This is what the source code shows (`process.env.RT_POLLER_HEARTBEAT_ENABLED !== "0"` pattern would disable it). Double-check the source before changing this in production.
- **opendata.swiss API key quota**: The exact quota tier for the GTFS-RT token is not documented in the repo — **I cannot verify daily/hourly rate limits from the code.**
- **Fly machine auto-scaling for poller**: `fly.poller.toml` does not specify `min_machines_running` or `auto_stop_machines`. Whether Fly keeps exactly one machine alive at all times or can scale to zero is not confirmed — **I cannot verify this without inspecting live Fly machine settings.**
