# iOS Stationboard API Contract

This contract is limited to the endpoint currently required by the iOS app.

## Endpoint

- `GET /api/stationboard`
- Base URL (prod): `https://api.mesdeparts.ch`
- Base URL (staging): `https://mesdeparts-ch.fly.dev`

## Request Parameters Used By iOS

### Required

- `stop_id` (string)
  - Canonical stop/station identifier (example: `Parent8501120`).

### Optional (used by iOS)

- `limit` (integer)
  - Number of departures to return.
  - Recommended app range: `1..20`.

- `include_alerts` (boolean-ish)
  - `1` to request alerts merge.
  - `0` to skip alerts merge for this request.

### Request Examples

- `/api/stationboard?stop_id=Parent8501120&limit=8&include_alerts=1`
- `/api/stationboard?stop_id=Parent8501000&limit=8&include_alerts=0`

## Response Shape (Model A)

The response is JSON and the iOS app reads:

### Required for iOS rendering

- `departures` (array)
- `meta` (object, Model A always-on metadata)

### Optional top-level objects

- `station` (object|null)
- `resolved` (object|null)
- `rt` (object)
- `alerts` (object)
- `banners` (array)
- `debug` (object|null, only when debug mode is requested)

## `departures[]` fields

### Required (per schema/runtime contract)

- `line` (string|null)
- `destination` (string|null)
- `scheduledDeparture` (ISO datetime)
- `cancelled` (boolean)

### Optional but used by iOS when present

- `realtimeDeparture` (ISO datetime|null)
- `delayMin` (integer|null)
- `platform` (string|null)
- `platformChanged` (boolean|null)
- `previousPlatform` (string|null)
- `status` (string|null)
- `flags` (string[])

## `meta` fields used by iOS

### Required for app diagnostics/freshness

- `serverTime` (ISO datetime)
- `responseMode` (string)
- `rtStatus` (string)

### Optional but consumed when present

- `rtFetchedAt` (ISO datetime|null)
- `rtCacheAgeMs` (number|null)
- `rtAppliedCount` (number)
- `totalBackendMs` (number)
- `requestId` (string)
- `alertsStatus` (string)

## `meta.responseMode` interpretation

- `full`: Normal response path.
- `degraded_static`: Static-safe/degraded response (optional phases skipped/fallback path).
- `stale_cache_fallback`: Fallback using stale cached response.
- `static_timeout_fallback`: Timeout-protected static fallback path.

Client rule:
- Always render departures for all modes.
- Show a subtle degraded/freshness indicator when mode is not `full`.

## `meta.rtStatus` interpretation

- `applied`: Realtime merge applied.
- `stale_cache`: Realtime exists but is stale.
- `skipped_budget`: Realtime step skipped due to budget/latency guard.
- `disabled`: Realtime disabled by configuration.
- `missing_cache`: Realtime snapshot unavailable.
- `guarded_error`: Guarded RT error; safe response still returned.

Client rule:
- Always render departures (static-safe behavior).
- If `rtStatus != applied`, mark realtime as reduced/unavailable in UI diagnostics.

## Real Sample Responses

Captured via curl and stored at:
- `ios/API/sample_payloads/stationboard_parent8501120_limit5_include_alerts1.json`
- `ios/API/sample_payloads/stationboard_parent8501000_limit5_include_alerts0.json`
- `ios/API/sample_payloads/stationboard_parent8576391_limit5_include_alerts1.json`

Source command pattern:
- `curl -sS 'https://api.mesdeparts.ch/api/stationboard?...'`
