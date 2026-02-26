-- Migration: add unique constraints required for incremental upsert strategy on RT tables.
-- Run once before deploying the incremental poller write path.
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/add_rt_upsert_unique_constraints.sql
--
-- These are plain (non-concurrent) CREATE UNIQUE INDEX IF NOT EXISTS statements so they
-- are safe to run inside a transaction with ON_ERROR_STOP.  For large live tables prefer
-- running each statement as CONCURRENTLY outside a transaction.

-- rt_trip_updates: one row per trip_id (natural key used by the poller de-dup map).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rt_trip_updates_trip_id
  ON public.rt_trip_updates (trip_id);

-- rt_stop_time_updates: one row per (trip_id, stop_id, stop_sequence).
-- stop_sequence is nullable when absent in the feed; NULLS are NOT DISTINCT so two rows
-- with the same trip_id/stop_id and NULL stop_sequence are treated as the same key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rt_stop_time_updates_trip_stop_seq
  ON public.rt_stop_time_updates (trip_id, stop_id, stop_sequence)
  NULLS NOT DISTINCT;
