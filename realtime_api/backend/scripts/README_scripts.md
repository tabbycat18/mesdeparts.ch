# Backend Scripts Guide

Docs index: [`../../README_INDEX.md`](../../README_INDEX.md)
SQL guide: [`../README_SQL.md`](../README_SQL.md)

This folder contains operational scripts, pollers, diagnostics, and QA utilities for the realtime backend.

## How to run

From `realtime_api/backend`:

```bash
node scripts/<script>.js
```

or use npm shortcuts from `package.json`:

```bash
npm run poller
npm run poller:trip
npm run poller:alerts
npm run search:verify
```

Many scripts auto-load `realtime_api/backend/.env` when needed.

## Quick commands (most used)

From `realtime_api/backend`:

```bash
# Stop search benchmark (DB required)
npm run search:bench

# One stationboard debug snapshot (default stop: Parent8501120)
node scripts/debugStationboard.js

# End-to-end stop debug (search -> stationboard)
node scripts/debugStop.js "Lausanne, Bel-Air"
```

If your backend is not local, set base URL for debug scripts:

```bash
STATIONBOARD_BASE_URL=https://api.mesdeparts.ch node scripts/debugStationboard.js
STATIONBOARD_BASE_URL=https://api.mesdeparts.ch node scripts/debugStop.js "Lausanne, Bel-Air"
```

## Required environment (common)

- `DATABASE_URL` for DB-dependent scripts
- `GTFS_RT_TOKEN` / `OPENDATA_SWISS_TOKEN` / `OPENTDATA_GTFS_RT_KEY` for TripUpdates polling
- `OPENTDATA_GTFS_SA_KEY` / `OPENTDATA_API_KEY` for Service Alerts polling

## Script groups

### Pollers (production-facing)

- `pollFeeds.js`
  - Starts both pollers together when tokens are available.
  - Used by `npm run poller`.

- `pollLaTripUpdates.js`
  - Polls LA GTFS-RT TripUpdates feed and writes snapshots/metadata to `rt_cache`.
  - Default interval: `GTFS_RT_POLL_INTERVAL_MS` (default `15000` ms).
  - Has 429/error backoff logic.

- `pollLaServiceAlerts.js`
  - Polls LA GTFS Service Alerts feed and writes snapshots/metadata to `rt_cache`.
  - Default interval: `GTFS_SA_POLL_INTERVAL_MS` (default `60000` ms, min `15000`).
  - Has 429/error backoff logic.

### Static GTFS refresh / import

- `refreshGtfsIfNeeded.js`
  - End-to-end static refresh orchestrator (download, clean, import stage/live, SQL setup, metadata updates).
  - Uses advisory locking to avoid concurrent imports.

- `importGtfsToStage.sh`
  - Low-level import helper used by refresh flow.
  - Requires `DATABASE_URL` and a cleaned GTFS directory path.

- `getRtFeedVersion.js`
  - Fetches TripUpdates feed metadata (`feed_version`).

- `fetchAlertsFeedMeta.js`
  - Fetches Service Alerts feed metadata.

### Stationboard / RT diagnostics

- `probeStationboardRt.js`
  - Calls a stationboard URL repeatedly and prints RT headers/body status (`applied`, `reason`, age).
  - Usage:
    - `node scripts/probeStationboardRt.js "<url>" [calls] [totalMs]`

- `debugStationboard.js`
  - Fetches one stationboard with `debug=1`, prints cancellation/delay/source summaries.
  - Includes `rtDiagnostics` (`rtEnabledForRequest`, `rtMetaReason`, `reason`, scoped counters).
  - Typical deploy validation:
    - `STATIONBOARD_BASE_URL=https://api.mesdeparts.ch node scripts/debugStationboard.js Parent8587387`

- `filter-stationboard.js`
  - Filters stationboard JSON from stdin for quick CLI inspection.
  - Example:
    - `node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js annemasse`

- `debugTripUpdatesCancelCount.js`
  - Fetches live TripUpdates and prints cancellation/skipped summary counts.

- `verifyRtDeterminism.js`
  - Repeated stationboard calls to detect inconsistent RT merge behavior between responses/instances.

- `sanitySweepM1.js`
  - Multi-station health sanity checks over `/api/stops/search` + `/api/stationboard`.

### Stop search tooling

- `benchmarkStopSearch.js`
  - Benchmarks search query performance against DB search path.
  - Used by `npm run search:bench`.
  - Requires reachable `DATABASE_URL`.

- `verifyStopSearchCases.js`
  - Validates expected search behavior/cases against DB-driven search implementation.
  - Used by `npm run search:verify`.

- `reproStopSearchRegression.js`
  - Repro harness for known stop-search regression queries.
  - Used by `npm run search:repro-regression`.

- `syncStopSearchAliases.js`
  - Rebuilds/syncs alias/search seed data for stop search.
  - Used by `npm run search:sync-aliases`.

- `seedStopAliases.js`
  - Seeds alias records from CSV/manual specs.
  - Used by `npm run seed:aliases`.

#### Recommended safe loop for stop-search changes

When changing search behavior, run scripts in this order:

1. `npm run search:sync-aliases`
   - Ensure alias/spec data is aligned before tuning scoring.
2. `npm run search:repro-regression`
   - Verify known regressions (`foret`, `grande borde`, `bel air`, `st/sr francois`) stay fixed.
3. `npm run search:verify`
   - Validate expected ranking/target behavior against DB.
4. `npm run search:bench`
   - Check latency regressions before deploy.

If step 2 or 3 fails, do not proceed to deploy.

Extra guardrail before changing ranking/SQL:

- Confirm whether the issue is data (alias/spec) or logic:
  - If one/few stations are wrong, start with aliases/specs (Tier 1).
  - If broad ordering is wrong across many queries, inspect ranking logic (Tier 2).
  - Only then consider SQL retrieval changes (Tier 3+).

### Stop resolution / endpoint checks

- `debugStop.js`
  - End-to-end debug for a query: search + stationboard follow-up.
  - Args: `node scripts/debugStop.js "<query>"`
  - Base URL: `STATIONBOARD_BASE_URL` (default `http://localhost:3001`).
  - Used by `npm run stops:debug`.

- `verifyStops.js`
  - Batch verification of stop search + stationboard behavior.
  - Used by `npm run stops:verify`.

### GTFS alignment audits

- `gtfsAlignmentAuditNow.js`
  - "Now" alignment audit: compares live GTFS-RT snapshot to current static DB consistency.

- `gtfsAlignmentHistoryReport.js`
  - Historical alignment report over recent ingest/poll windows.

### Schema / drift utility

- `schemaDriftTask.js`
  - Scans SQL/code references to report table naming/schema drift hotspots.
  - Used by `npm run schema:drift`.

## Complete inventory (all script files in this folder)

| File | Purpose | Typical trigger |
| --- | --- | --- |
| `scripts/benchmarkStopSearch.js` | Benchmarks stop-search query performance against DB. | `npm run search:bench` |
| `scripts/debugStationboard.js` | Fetches one stationboard and prints cancellation/delay/source summary. | manual debug |
| `scripts/debugStop.js` | One-query pipeline check (`/api/stops/search` then `/api/stationboard`). | `npm run stops:debug -- "<query>"` |
| `scripts/debugTripUpdatesCancelCount.js` | Pulls TripUpdates and summarizes cancel/skip signals. | manual RT debug |
| `scripts/fetchAlertsFeedMeta.js` | Reads Service Alerts feed metadata (`feed_version`, timestamps). | metadata check |
| `scripts/filter-stationboard.js` | Filters stationboard JSON from stdin by query terms. | piped CLI debug |
| `scripts/getRtFeedVersion.js` | Reads TripUpdates `feed_version`. | metadata check |
| `scripts/gtfsAlignmentAuditNow.js` | Current-point GTFS static vs GTFS-RT alignment audit. | ops audit |
| `scripts/gtfsAlignmentHistoryReport.js` | Historical alignment report over recent poll/ingest windows. | ops audit |
| `scripts/importGtfsToStage.sh` | Imports cleaned GTFS CSVs into stage tables. | called by refresh/import ops |
| `scripts/lib/fetchGtfsFeedMeta.js` | Shared helper for GTFS feed metadata fetch (auth `GET` + protobuf decode, then returns `feedVersion`/`headerTimestamp`). | imported by metadata scripts |
| `scripts/pollFeeds.js` | Starts both TripUpdates + Service Alerts pollers in one process. | `npm run poller` |
| `scripts/pollLaServiceAlerts.js` | Service Alerts poller (upstream -> `rt_cache`). | `npm run poller:alerts` |
| `scripts/pollLaTripUpdates.js` | TripUpdates poller (upstream -> `rt_cache`). | `npm run poller:trip` |
| `scripts/probeStationboardRt.js` | Calls stationboard repeatedly and prints RT/apply headers. | incident diagnostics |
| `scripts/refreshGtfsIfNeeded.js` | Full static refresh orchestrator (download, clean, import, swap, setup). | CI/manual refresh |
| `scripts/reproStopSearchRegression.js` | Repro suite for known stop-search regressions. | `npm run search:repro-regression` |
| `scripts/sanitySweepM1.js` | Multi-station sanity sweep of search + stationboard behavior. | `npm run sanity:m1` |
| `scripts/schemaDriftTask.js` | Reports schema/table reference drift across SQL+code. | `npm run schema:drift` |
| `scripts/seedStopAliases.js` | Seeds alias records (CSV/spec-driven). | `npm run seed:aliases` |
| `scripts/syncStopSearchAliases.js` | Rebuilds/syncs search aliases and reports status. | `npm run search:sync-aliases` |
| `scripts/verifyRtDeterminism.js` | Repeats stationboard requests to detect RT instability. | manual determinism check |
| `scripts/verifyStopSearchCases.js` | Validates expected stop-search cases against DB. | `npm run search:verify` |
| `scripts/verifyStops.js` | Batch checks search + stationboard correctness over query list. | `npm run stops:verify` |

## Safe usage notes

- Prefer running pollers as dedicated long-running processes (`pollFeeds.js` or split pollers), not inside request paths.
- Refresh/import scripts should be run intentionally (CI/manual ops), not from local dev loops.
- Most debug scripts call local backend by default (`http://localhost:3001`) unless overridden by env vars.
- `fetch failed` usually means backend URL is unreachable from your current environment.

## Script-specific requirements and common errors

- `importGtfsToStage.sh`
  - Command: `bash scripts/importGtfsToStage.sh <clean_gtfs_dir>`
  - Needs: exported `DATABASE_URL` and a valid cleaned GTFS directory argument.
  - Common failures:
    - `DATABASE_URL is not set. Export it before running this script.`
    - `Usage: scripts/importGtfsToStage.sh <clean_gtfs_dir>`

- `pollFeeds.js`
  - Command: `node scripts/pollFeeds.js` (or `npm run poller`)
  - Needs: `DATABASE_URL` plus at least one valid poller token (trip and/or alerts).
  - Common failure: `[DB] ERROR: DATABASE_URL is missing. Set it before running the server.`

- `pollLaServiceAlerts.js`
  - Command: `node scripts/pollLaServiceAlerts.js` (or `npm run poller:alerts`)
  - Needs: `DATABASE_URL` and service-alert token (`OPENTDATA_GTFS_SA_KEY` or fallback keys).
  - Common failure: `[DB] ERROR: DATABASE_URL is missing. Set it before running the server.`

- `pollLaTripUpdates.js`
  - Command: `node scripts/pollLaTripUpdates.js` (or `npm run poller:trip`)
  - Needs: `DATABASE_URL` and trip-update token (`GTFS_RT_TOKEN` / `OPENDATA_SWISS_TOKEN` / `OPENTDATA_GTFS_RT_KEY`).
  - Common failure: `[DB] ERROR: DATABASE_URL is missing. Set it before running the server.`

- `benchmarkStopSearch.js`
  - Command: `npm run search:bench`
  - Needs: reachable `DATABASE_URL`.
  - Common failure: `getaddrinfo ENOTFOUND ...neon...` (DB host/DNS not reachable).

- `debugStationboard.js`
  - Command: `node scripts/debugStationboard.js [stopId]`
  - Needs: reachable backend at `STATIONBOARD_BASE_URL` (default `http://localhost:3001`).
  - Common failure: `debugStationboard failed: fetch failed`.

- `debugStop.js`
  - Command: `node scripts/debugStop.js "<query>"`
  - Needs: reachable backend at `STATIONBOARD_BASE_URL`.
  - Common failure: `{ "ok": false, "error": "fetch failed" }`.

- `debugTripUpdatesCancelCount.js`
  - Command: `node scripts/debugTripUpdatesCancelCount.js`
  - Needs: GTFS-RT token (`GTFS_RT_TOKEN` / `OPENDATA_SWISS_TOKEN` / `OPENTDATA_GTFS_RT_KEY`) and outbound network access.
  - Common failure: `fetch failed` during GTFS-RT refresh/fetch.

- `fetchAlertsFeedMeta.js`
  - Command: `node scripts/fetchAlertsFeedMeta.js`
  - Needs: `OPENTDATA_API_KEY` (or pass key programmatically in code path).
  - Common failure: `OPENTDATA_API_KEY is required`.

- `filter-stationboard.js`
  - Command: `node scripts/filter-stationboard.js <query>`
  - Needs: stationboard JSON on stdin.
  - Common failure: `No JSON on stdin`.
  - Example:
    - `node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js annemasse`

- `getRtFeedVersion.js`
  - Command: `node scripts/getRtFeedVersion.js`
  - Needs: `OPENTDATA_API_KEY`.
  - Common failure: `OPENTDATA_API_KEY is required`.

- `gtfsAlignmentAuditNow.js`
  - Command: `node scripts/gtfsAlignmentAuditNow.js`
  - Needs: reachable `DATABASE_URL` (+ RT feed access for full audit).
  - Common failure: `getaddrinfo ENOTFOUND ...neon...`.

- `gtfsAlignmentHistoryReport.js`
  - Command: `node scripts/gtfsAlignmentHistoryReport.js`
  - Needs: reachable `DATABASE_URL` and alignment audit tables.
  - Common failure: `getaddrinfo ENOTFOUND ...neon...`.
