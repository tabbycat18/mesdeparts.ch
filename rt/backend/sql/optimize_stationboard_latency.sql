-- Stationboard latency indexes (safe to run multiple times).
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stationboard_latency.sql
--
-- These indexes target stop-resolution predicates used by:
-- - src/resolve/resolveStop.js
-- - src/logic/buildStationboard.js

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gtfs_stops_parent_station
ON public.gtfs_stops (parent_station)
WHERE parent_station IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gtfs_stops_parent_or_self
ON public.gtfs_stops ((COALESCE(parent_station, stop_id)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_stop_aliases_alias_lower
ON public.app_stop_aliases ((LOWER(alias)));

-- Hot stationboard predicate: stop_id + departure_time_seconds range.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gtfs_stop_times_stop_depsec_trip_seq
ON public.gtfs_stop_times (stop_id, departure_time_seconds, trip_id, stop_sequence)
WHERE departure_time_seconds IS NOT NULL;

ANALYZE public.gtfs_stops;
ANALYZE public.app_stop_aliases;
ANALYZE public.gtfs_stop_times;
