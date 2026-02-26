# iOS Client Behavior: Errors And Modes

This file defines non-Swift behavior rules for stationboard response modes and realtime states.

## Scope

Endpoint:
- `GET /api/stationboard`

Primary signals:
- HTTP status
- `meta.responseMode`
- `meta.rtStatus`
- `meta.rtFetchedAt`, `meta.rtCacheAgeMs`

## HTTP-Level Behavior

- `200`: render payload. Then branch on `responseMode` and `rtStatus`.
- `204` (only with `since_rt` + board-presence hints): treat as “no data change”; keep current board.
- `4xx` (validation issues, e.g. conflicting ids): do not blind-retry; surface actionable message.
- `5xx` / network error: keep last successful board snapshot in memory and apply backoff retry.

## 200 + `meta.responseMode` Behavior

### `full`
- Show standard board UI.
- Normal refresh cadence.

### `degraded_static`
- Show board with subtle degraded/freshness badge.
- Continue normal cadence; do not increase request rate.
- Prefer manual refresh affordance instead of aggressive auto retries.

### `stale_cache_fallback`
- Show board and explicit stale indicator.
- Keep cadence conservative (no burst retries).
- If user manually refreshes, execute one immediate fetch.

### `static_timeout_fallback`
- Show board with timeout fallback indicator.
- Keep existing data visible; avoid spinner loops.
- Next retry follows bounded backoff window.

## `meta.rtStatus` Behavior

### `applied`
- Use realtime visuals normally (delay/platform/cancel status as available).

### `skipped_budget`
- Treat as temporary latency-budget degradation.
- Keep static schedule visible; annotate RT as limited.
- No extra retry burst.

### `disabled`
- Treat as feature-disabled state (configuration-driven).
- Keep static-only presentation; suppress repeated retry attempts for RT restoration.

### `missing_cache`
- Treat as poller/cache-unavailable state.
- Keep static schedule visible and show RT unavailable note.
- Continue baseline polling cadence only.

### `guarded_error`
- Treat as protected backend RT error path (safe fallback already applied).
- Render schedule; show non-blocking warning state.
- Use backoff retries, never tight loops.

### `stale_cache`
- Render data with stale indicator and age context.
- No cadence increase.

## Retry And Backoff Strategy (No Extra Traffic)

This strategy is aligned with current backend poll cadence and edge caching behavior:
- TripUpdates poller default: ~15s.
- Alerts poller default: ~60s.
- Edge stationboard cache is short-lived.

Recommended iOS behavior:
- Foreground auto refresh interval: `>= 15s` (suggest 20s with jitter ±2s).
- Manual pull-to-refresh: allowed immediately.
- On transient error (`5xx`, network timeout): exponential backoff `2s -> 5s -> 10s -> 20s` (cap 20s), then return to normal interval after success.
- Maximum one active stationboard request per view.
- If app is backgrounded, pause periodic refresh.

## Freshness Display Rules

Based on `meta`:
- If `rtStatus=applied`: show normal realtime marker.
- If `rtStatus != applied` OR `responseMode != full`: show reduced-freshness marker.
- Use `rtFetchedAt` and/or `rtCacheAgeMs` for “updated Xs ago” labeling when present.

## Versioning

Current state:
- No documented explicit API contract version header for stationboard responses.

Future-work recommendation:
- Add contract version via response header (e.g. `X-MD-Api-Version`) or `/version.json` endpoint.
- Client should parse responses additively and ignore unknown fields until explicit versioning exists.
