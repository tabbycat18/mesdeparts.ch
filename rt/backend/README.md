# RT Backend Notes

GTFS static datasets must not be committed to git.

Static GTFS is downloaded by CI from the opentransportdata permalink during refresh jobs.
For local legacy tooling, the default folder name has been renamed to `rt/data/gtfs-static-local`.

TODO: remove any remaining legacy static dataset directories after the first successful automated import to Neon.

## Deployment Target

- Runtime target for this backend: **Fly.io**.
- Container file: `rt/backend/Dockerfile`.
- Container listen port: `8080` (`ENV PORT=8080`).

API Fly config is committed at `rt/backend/fly.toml`.

## GTFS-RT Option A1 (Global Limit Guarantee)

To guarantee the LA GTFS-RT upstream limit globally (5/min), run one dedicated poller app and let API instances read shared DB cache only.

- API app stays: `mesdeparts-ch` (`https://mesdeparts-ch.fly.dev`)
- Poller app: separate Fly app, single machine only
- API `/api/stationboard` must not fetch upstream GTFS-RT directly

### 1) Apply shared cache migration once (Neon)

```bash
cd rt/backend
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
  -c rt/backend/fly.poller.toml \
  --dockerfile rt/backend/Dockerfile
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

### Debug

- When `debug=1` is passed, `debug` is included for tracing only.
- Consumers must not rely on `debug` fields for business logic.

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

### Schema

- Canonical JSON schema: `rt/backend/docs/stationboard.schema.json`
