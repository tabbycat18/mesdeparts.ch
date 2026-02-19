-- ===========================================================================================
-- CLEANUP: Drop old GTFS tables after successful cutover
-- ===========================================================================================
-- This is a separate transaction (called AFTER swap_stage_to_live_cutover.sql succeeds).
-- It cleans up the _old tables that were renamed during cutover.
--
-- Run this after verifying the cutover succeeded and the new live tables are working.
-- If this step fails or is skipped, old tables persist for one more refresh cycle.
--
-- Typical usage:
--   1. swap_stage_to_live_cutover.sql  (atomic swap, updates live tables)
--   2. optimize_stop_search.sql        (rebuild indexes)
--   3. cleanup_old_after_swap.sql      (this file - remove old data)
-- ===========================================================================================

BEGIN;

DROP TABLE IF EXISTS public.gtfs_agency_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_stops_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_routes_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_trips_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_calendar_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_calendar_dates_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_stop_times_old CASCADE;

\echo '[cleanup] Dropped old GTFS tables'

COMMIT;

\echo '[cleanup] ✓ Old table cleanup complete'
