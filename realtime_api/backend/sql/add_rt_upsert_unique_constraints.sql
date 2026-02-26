-- Migration: unique indexes required for incremental upsert (ON CONFLICT) on RT tables.
-- Run once on the live DB before deploying the incremental poller write path.
--
-- IMPORTANT: CONCURRENTLY cannot run inside a transaction block.
-- Run each statement individually, e.g.:
--   psql "$DATABASE_URL" -c "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_rt_trip_updates_trip_id ON public.rt_trip_updates (trip_id);"
--   psql "$DATABASE_URL" -c "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_rt_stop_time_updates_trip_stop_seq ON public.rt_stop_time_updates (trip_id, stop_id, stop_sequence);"

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_rt_trip_updates_trip_id
  ON public.rt_trip_updates (trip_id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_rt_stop_time_updates_trip_stop_seq
  ON public.rt_stop_time_updates (trip_id, stop_id, stop_sequence);
