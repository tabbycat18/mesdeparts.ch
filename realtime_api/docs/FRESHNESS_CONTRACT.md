# Freshness Contract (Web + iOS)

This document defines a shared interpretation of stationboard freshness using the existing Model A metadata contract.

Scope:
- Endpoint: `GET /api/stationboard`
- Clients: `realtime_api/frontend` (web), `ios/MesDepartsApp` (iOS app)
- Fields: `meta.serverTime`, `meta.rtFetchedAt`, `meta.rtCacheAgeMs`, `meta.responseMode`, `meta.rtStatus`

## 1) Definitions

### 1.1 Polling interval targets (current runtime)

- Web target: `15s` (`REFRESH_DEPARTURES = 15_000` in `frontend/v20260228.state.js`)
- iOS target: `~20s` with small jitter in `ios/MesDepartsApp` (view-driven polling loop).

Contract rule:
- Clients must not poll faster than their configured cadence.
- Clients may pause while backgrounded/inactive and resume immediately on foreground.

### 1.2 Freshness semantics from Model A

Interpretation order:
1. `meta.rtStatus`
2. `meta.responseMode`
3. `meta.rtCacheAgeMs`
4. `meta.rtFetchedAt` vs `meta.serverTime`

Fresh RT snapshot:
- `meta.rtStatus == "applied"`
- `meta.responseMode == "full"` (preferred)
- `meta.rtCacheAgeMs` finite and typically within backend fresh threshold (default target `<= 45_000 ms`)

Degraded but acceptable stationboard:
- `meta.responseMode` in:
  - `degraded_static`
  - `stale_cache_fallback`
  - `static_timeout_fallback`
- and `meta.rtStatus` in:
  - `stale_cache`
  - `skipped_budget`
  - `disabled`
  - `missing_cache`
  - `guarded_error`

In degraded mode, clients must still render static departures if present and expose degraded status to users/diagnostics.

## 2) What Must Remain Unchanged

- Poller cadence/behavior:
  - `backend/scripts/pollLaTripUpdates.js`
  - `backend/scripts/pollLaServiceAlerts.js`
- Backend Model A response contract:
  - top-level `meta` keys and status semantics
- Worker cache strategy:
  - `edge/worker.js` short stationboard edge TTL (`15s`)
  - browser no-store behavior for stationboard JSON

This contract is observational only; it does not change runtime cadence or upstream fetch behavior.

## 3) What Clients Are Allowed To Do

- Request scheduling:
  - add jitter
  - coalesce overlapping refresh requests
  - pause while app/tab is backgrounded
  - trigger immediate refresh on foreground/focus resume
- Diagnostics/instrumentation:
  - store recent freshness samples locally
  - export samples for debugging
- Conditional requests:
  - `ETag/If-None-Match` only if endpoint/edge explicitly supports it for stationboard responses.
  - Current stationboard freshness flow uses Model A + existing cache semantics; ETag is not required by this contract.

## 4) PASS / FAIL Checklist

Use these rules for manual checks or CI smoke scripts.

### PASS

- Client polling interval is not faster than configured cadence.
- For each stationboard response, client records:
  - `serverTime`
  - `rtFetchedAt`
  - `rtCacheAgeMs`
  - `responseMode`
  - `rtStatus`
  - client request start/end + duration
- If `rtStatus == applied`, samples usually show:
  - `responseMode == full`
  - `rtCacheAgeMs <= 45_000` (or near threshold under transient conditions)
- If degraded status is returned:
  - departures still render (static-first behavior)
  - client surfaces degraded diagnostics (does not silently claim RT freshness)

### FAIL

- Client increases request rate above configured cadence.
- Client treats degraded statuses as fresh RT.
- Client hides all departures during degraded/static fallback while backend still returns departures.
- Client omits freshness sample logging/export.

## 5) Instrumentation Reference

- Web:
  - rolling buffer in `appState.stationboardFreshnessSamples` (max 20)
  - export helper: `window.mesdepartsExportFreshnessSamples()`
- iOS:
  - rolling buffer in `FreshnessDiagnosticsBuffer` (max 50)
  - diagnostics screen available from Stationboard More menu.
