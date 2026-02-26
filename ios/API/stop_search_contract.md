# iOS Stop Search API Contract

This document covers the active stop-search endpoint used by iOS.

## Active Endpoint

- `GET /api/stops/search`
- Production base URL: `https://api.mesdeparts.ch`
- Staging base URL: `https://mesdeparts-ch.fly.dev`

Runtime source of truth:
- `realtime_api/backend/src/api/stopSearchRoute.js`
- `realtime_api/backend/src/search/stopsSearch.js`

Note:
- `realtime_api/backend/routes/searchStops.js` exists but is deprecated/non-mounted by `server.js`.

## Request Parameters

### Supported query parameters

- `q` (string) or `query` (string alias)
  - Search text.
  - Minimum length: 2 characters.
  - If shorter, endpoint returns `400` with `error: "query_too_short"`.

- `limit` (number, optional)
  - Default: `20`
  - Clamped: `1..50`

- `debug` (boolean-ish, optional)
  - Accepted truthy values include `1|true|yes|on`.
  - Enables debug path/logging when backend debug function is configured.

### Not currently supported by route contract

- `locale` is not parsed by the active route handler.

## Response Shape

Top-level response:
- `stops` (array) — required

Typical stop object fields returned by active ranking/output path:
- `id` (string)
- `name` (string)
- `stop_id` (string)
- `stationId` (string)
- `stationName` (string)
- `group_id` (string)
- `raw_stop_id` (string)
- `stop_name` (string)
- `parent_station` (string|null)
- `location_type` (string)
- `nb_stop_times` (number)
- `city` (string|null)
- `canton` (string|null)
- `isParent` (boolean)
- `isPlatform` (boolean)
- `aliasesMatched` (string[], optional)

## Required vs Optional (for iOS client parsing)

Required for response-level parsing:
- `stops` array

Recommended required for each chosen result:
- `stationId` or `group_id` or `stop_id`
- `name` (or fallback `stop_name`)

Optional/diagnostic:
- `aliasesMatched`, `city`, `canton`, `nb_stop_times`, `location_type`, `isParent`, `isPlatform`

## Ranking / Sorting Semantics (documented + code)

The search engine applies tiered ranking with dedupe by station/group:
1. exact name / exact alias
2. prefix name / prefix alias
3. token containment and word-start matches
4. fuzzy matches (similarity threshold by query length)

Tie-break factors include:
- parent-vs-platform preference depending on query shape
- location type preference
- stop activity (`nb_stop_times`)
- deterministic lexical fallback (`stop_name`, then `stop_id`)

Reference implementation:
- `rankStopCandidatesDetailed(...)`
- `rankStopCandidates(...)`
  in `realtime_api/backend/src/search/stopsSearch.js`

## Mapping Stop Search -> Stationboard `stop_id`

For stationboard requests (`GET /api/stationboard`), iOS should pass:
1. `stationId` (preferred)
2. else `group_id`
3. else `stop_id`

Why:
- `stationId/group_id` represents the parent/group stop scope, which is the safest default for stationboard results.
- Passing a child platform `stop_id` can narrow scope too much versus parent boards.

## Example mapping rule

Selected stop object:
- `{ stationId: "Parent8501120", stop_id: "Parent8501120", ... }`

Stationboard call:
- `/api/stationboard?stop_id=Parent8501120&limit=8&include_alerts=1`

## Real Sample Payloads

See:
- `ios/API/sample_payloads_stop_search/`

These are captured from live calls to `/api/stops/search` with no schema invention.
