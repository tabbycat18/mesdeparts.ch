# RT Stack Overview

This `realtime_api/` folder contains the real-time (GTFS static + GTFS-RT) implementation.

## Swiss GTFS Context (Operational Model)

This project follows the opentransportdata.swiss model:

- `GTFS Static` is the timetable baseline ("ground truth") for stops/trips/stop_times/routes/calendar.
- `GTFS-RT TripUpdates` enrich static trips with realtime changes (delay, cancellation, skipped stops, added trips).
- `GTFS-RT Service Alerts` is a separate feed for disruption/event messaging (stop/route/network impact), including multilingual texts.

### 1) GTFS Static is versioned and can change IDs

- Static feeds are regenerated on a recurring cadence (typically twice weekly in Swiss operations).
- `trip_id` and `service_id` can change between static versions.
- Import/cutover must therefore be staged and atomic (stage -> live), not best-effort ad hoc updates.

### 2) TripUpdates are incremental, not a full "state dump"

- TripUpdates can be emitted on change, so missing entities are **not** a reliable "on-time" signal.
- `delay = 0` is meaningful: it indicates realtime-confirmed on-time, not "no realtime".
- Realtime merge logic must tolerate partial/incremental updates and keep state stable across polls.

### 3) Feed version alignment is critical

- GTFS-RT is tied to a specific static version.
- The Swiss `feed_version` value is the key alignment signal and must be tracked.
- If RT feed version and currently active static version diverge, treat it as version skew and avoid assuming identifiers still match cleanly.

### 4) Operating day vs calendar day caveat

- Static GTFS can use times beyond 24:00 (`24:xx`, `25:xx`) to represent the same operating day.
- RT `start_date` semantics are calendar-day based; merges must avoid cross-day collisions.
- This repo treats service-day handling and cross-midnight windows explicitly in stationboard build logic.

### 5) API/runtime constraints to respect

- Use protobuf feed format for production integrations; JSON is mainly for diagnostics/testing.
- Respect upstream rate limits (Swiss guidance: hard cap 2 req/min per key).
- Cache/refresh policy should smooth polling and prevent UI-driven overfetch.

## What Is Source Of Truth

- **Backend (`realtime_api/backend`) is the source of truth** for RT departures.
- **Frontend (`realtime_api/frontend`) is only presentation** of backend/API data.
- Root `legacy_api/web-ui/` is a separate legacy/simple flow and should be treated independently.

## Folder Map

- `realtime_api/backend/`
  - Node/Express API, GTFS import/refresh scripts, SQL, stationboard generation.
- `realtime_api/frontend/`
  - Static UI for the RT board (no build step required).
- `realtime_api/data/` (optional local-only folder)
  - Local GTFS snapshots for manual tooling; keep out of git.

## Why `src/` Was Added

You asked for M1 modular boundaries without rewriting.

The current backend now has:

- `realtime_api/backend/src/api/stationboard.js`
  - Thin API entry wrapper (`getStationboard`) for stationboard generation.
- `realtime_api/backend/src/rt/fetchTripUpdates.js`
  - Thin GTFS-RT trip updates fetch/normalize wrapper.
- `realtime_api/backend/src/merge/applyTripUpdates.js`
  - Merge module applying RT updates to scheduled rows.

These are wrappers/boundaries.

They **do not replace** existing logic overnight.
They sit in front of existing implementation so future refactors can happen safely.

## Current Runtime Flow (Stationboard)

1. `GET /api/stationboard` hits `realtime_api/backend/server.js`.
2. Server calls `getStationboard(...)` from `realtime_api/backend/src/api/stationboard.js`.
3. Wrapper delegates to existing pipeline in `realtime_api/backend/logic/buildStationboard.js`.
4. `buildStationboard`:
   - loads scheduled base rows using `realtime_api/backend/src/sql/stationboard.sql`
   - loads realtime index via `realtime_api/backend/loaders/loadRealtime.js`
   - merges with `applyTripUpdates(...)` from `realtime_api/backend/src/merge/applyTripUpdates.js`
5. Response is returned to frontend.

## `cancelled` Field (M1)

Each departure row now includes:

- `cancelled: boolean`

Rule:

- `true` only when matching GTFS-RT TripDescriptor `schedule_relationship == "CANCELED"`
- otherwise `false`

No cancellation inference from delay values.

## Scheduled Query

Single scheduled base-board query remains:

- `realtime_api/backend/src/sql/stationboard.sql`

No duplicate parallel SQL query was introduced for M1.

## GTFS Static Refresh Pipeline

Main script:

- `realtime_api/backend/scripts/refreshGtfsIfNeeded.js`

It:

1. checks current feed version from GTFS-RT
2. if changed, downloads static GTFS zip from official permalink
3. cleans required files
4. imports into stage tables
5. validates stage data
6. swaps stage -> live tables
7. updates metadata tables (`meta_kv`, `rt_feed_meta`)

Alignment expectation:

- `meta_kv.gtfs_current_feed_version` represents the active static alignment marker.
- GTFS-RT poll metadata (`feed_version`, header timestamp) should be recorded and compared against static alignment.
- Realtime identifiers (`trip_id`, `service_id`) must always be interpreted in the context of the aligned static version.

Related scripts/sql:

- `realtime_api/backend/scripts/importGtfsToStage.sh`
- `realtime_api/backend/sql/create_stage_tables.sql`
- `realtime_api/backend/sql/validate_stage.sql`
- `realtime_api/backend/sql/swap_stage_to_live_cutover.sql`
- `realtime_api/backend/sql/cleanup_old_after_swap.sql`

## Run Backend Locally

From `realtime_api/backend`:

```bash
npm install
npm run dev
```

Required env keys (in `.env`):

- `DATABASE_URL`
- `OPENTDATA_GTFS_RT_KEY`
- `OPENTDATA_GTFS_SA_KEY`

Compatibility keys still used by legacy RT loader path:

- `GTFS_RT_TOKEN` or `OPENDATA_SWISS_TOKEN`

## Tests

From `realtime_api/backend`:

```bash
npm test
```

Core tests:

- `realtime_api/backend/test/stationboard.cancelled.test.js`
- plus the rest of the suite under `realtime_api/backend/test/*.test.js`

This verifies merge behavior and `cancelled` flag assignment.

## Frontend Note

`realtime_api/frontend` is separate from backend logic.

- It renders data and applies UI styles/filters.
- It should not be treated as stationboard business logic source.

## Data Hygiene

Do not commit GTFS datasets.

Ignored local snapshots include (when present locally):

- `realtime_api/data/gtfs-static/`
- `realtime_api/data/gtfs-static-OLD/`

## If You Feel Lost: What To Read First

1. `realtime_api/README_realtime_api.md` (this file)
2. `realtime_api/backend/server.js`
3. `realtime_api/backend/src/api/stationboard.js`
4. `realtime_api/backend/logic/buildStationboard.js`
5. `realtime_api/backend/src/merge/applyTripUpdates.js`
6. `realtime_api/backend/loaders/loadRealtime.js`
7. `realtime_api/backend/src/sql/stationboard.sql`

That gives the complete backend execution path in order.
