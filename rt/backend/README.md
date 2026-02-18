# RT Backend Notes

GTFS static datasets must not be committed to git.

Static GTFS is downloaded by CI from the opentransportdata permalink during refresh jobs.
For local legacy tooling, the default folder name has been renamed to `rt/data/gtfs-static-local`.

TODO: remove any remaining legacy static dataset directories after the first successful automated import to Neon.

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

### Schema

- Canonical JSON schema: `rt/backend/docs/stationboard.schema.json`
