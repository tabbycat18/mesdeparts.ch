-- Add indexes on updated_at to make retention pruning efficient.
--
-- The chunked DELETE in pruneRtTripUpdates filters:
--   WHERE updated_at < $cutoff
-- Without an index on updated_at Postgres does a sequential scan over the
-- full table (82k+ rows) to find the handful of stale rows.  With the index
-- the DELETE touches only the pages that contain qualifying rows.
--
-- Use CONCURRENTLY so the build does not hold a lock that blocks the poller.
-- Do NOT wrap these statements in a transaction (CONCURRENTLY is not allowed
-- inside an explicit transaction block).
--
-- Safe to re-run: IF NOT EXISTS is a no-op when the index already exists.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_trip_updates_updated_at
  ON public.rt_trip_updates (updated_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_stop_time_updates_updated_at
  ON public.rt_stop_time_updates (updated_at);
