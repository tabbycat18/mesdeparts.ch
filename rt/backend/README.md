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
