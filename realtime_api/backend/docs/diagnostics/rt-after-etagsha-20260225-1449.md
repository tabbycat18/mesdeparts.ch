# RT After etag/sha Report

- Timestamp (UTC): 2026-02-25T14:49:04.539Z
- URL: `https://api.mesdeparts.ch`
- Stops: `Parent8587387`, `Parent8501000`, `Parent8501120`
- Samples: 30

| Metric | Value |
| --- | --- |
| p50 totalBackendMs | 253.6 |
| p95 totalBackendMs | 1161.8 |
| avg rtCacheAgeMs | 14072 |
| median rtCacheAgeMs | 14125 |
| max rtCacheAgeMs | 14309 |
| % responses rtStatus=applied | 100 |

## rtStatus distribution

- `applied`: 30

## Raw data

- JSON: `rt-after-etagsha-20260225-1449.json`

## Diff highlights

Compared against baseline `rt-baseline-20260225-1430.json`.

- `pg_stat_statements` payload-SELECT calls (`SELECT payload, fetched_at, etag, last_status, last_error ...`): `250 -> 397` (delta `+147` calls, cumulative counters; no reset performed).
- Same payload-SELECT `total_exec_time`: `9223.87ms -> 15147.68ms` (delta `+5923.81ms`, cumulative).
- `rtCacheAgeMs`: avg `15950.67 -> 14072` (delta `-1878.67`), median `16073 -> 14125` (delta `-1948`), max `16236 -> 14309` (delta `-1927`).
- `totalBackendMs`: p50 `217 -> 253.6` (delta `+36.6`), p95 `959.6 -> 1161.8` (delta `+202.2`).
- `rtStatus` distribution is unchanged: `applied=30/30` (100%) in both snapshots.
