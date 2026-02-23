-- ===========================================================================================
-- ZERO-DOWNTIME GTFS CUTOVER: Atomic Table Swap (CUTOVER ONLY)
-- ===========================================================================================
-- Strategy: Use table renames (atomic, fast) instead of TRUNCATE+INSERT
--
-- This transaction performs the atomic cutover ONLY:
-- 1. Validate stage tables have data
-- 2. Backup app_stop_aliases (curated data preservation)
-- 3. Atomic rename swap:
--    a. Rename live tables → old (temporary names)
--    b. Rename stage tables → live (promoted to production)
--    c. Restore app_stop_aliases with FK-aware logic
--
-- NOTE: Stale *_old tables from prior runs are dropped at cutover start for idempotency.
-- Newly created *_old tables from this swap are not dropped here.
-- Cleanup happens in a separate transaction (cleanup_old_after_swap.sql) after cutover.
--
-- Lock duration: ~10-50ms (just metadata updates, no data movement)
-- Downtime: <100ms (vs 5-15 seconds with old TRUNCATE+INSERT)
-- ===========================================================================================

BEGIN;

-- Idempotency guard: clear stale _old tables from a previous partial/failed run.
-- This only targets *_old names and never drops active live tables.
DROP TABLE IF EXISTS public.gtfs_agency_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_stops_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_routes_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_trips_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_calendar_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_calendar_dates_old CASCADE;
DROP TABLE IF EXISTS public.gtfs_stop_times_old CASCADE;

\echo '[swap-cutover] Cleared stale *_old tables (if any)'

-- Sanity check: ensure stage tables are populated
DO $$
DECLARE
  stage_agency_count BIGINT;
  stage_stops_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO stage_agency_count FROM public.gtfs_agency_stage;
  SELECT COUNT(*) INTO stage_stops_count FROM public.gtfs_stops_stage;

  IF stage_agency_count = 0 OR stage_stops_count = 0 THEN
    RAISE EXCEPTION 'Stage tables are empty. Refusing to swap empty data to live.';
  END IF;

  RAISE NOTICE '[swap-cutover] Stage validation passed: agency=%, stops=%',
    stage_agency_count, stage_stops_count;
END
$$;

-- Backup curated app_stop_aliases before swap (used for FK-aware restoration)
CREATE TEMP TABLE _app_stop_aliases_backup AS
SELECT * FROM public.app_stop_aliases;

\echo '[swap-cutover] Backed up app_stop_aliases for restoration'

-- ───────────────────────────────────────────────────────────────────────────────────
-- ATOMIC SWAP: Rename tables to promote stage → live
-- ───────────────────────────────────────────────────────────────────────────────────
-- Order matters: gtfs_stop_times last (has FKs to other tables)

-- Swap gtfs_agency
ALTER TABLE IF EXISTS public.gtfs_agency RENAME TO gtfs_agency_old;
ALTER TABLE public.gtfs_agency_stage RENAME TO gtfs_agency;
\echo '[swap-cutover] Swapped gtfs_agency'

-- Swap gtfs_stops (no FK deps from other GTFS tables, but is referenced by stop_times)
ALTER TABLE IF EXISTS public.gtfs_stops RENAME TO gtfs_stops_old;
ALTER TABLE public.gtfs_stops_stage RENAME TO gtfs_stops;
\echo '[swap-cutover] Swapped gtfs_stops'

-- Swap gtfs_routes
ALTER TABLE IF EXISTS public.gtfs_routes RENAME TO gtfs_routes_old;
ALTER TABLE public.gtfs_routes_stage RENAME TO gtfs_routes;
\echo '[swap-cutover] Swapped gtfs_routes'

-- Swap gtfs_trips (references routes & calendar)
ALTER TABLE IF EXISTS public.gtfs_trips RENAME TO gtfs_trips_old;
ALTER TABLE public.gtfs_trips_stage RENAME TO gtfs_trips;
\echo '[swap-cutover] Swapped gtfs_trips'

-- Swap gtfs_calendar (referenced by trips)
ALTER TABLE IF EXISTS public.gtfs_calendar RENAME TO gtfs_calendar_old;
ALTER TABLE public.gtfs_calendar_stage RENAME TO gtfs_calendar;
\echo '[swap-cutover] Swapped gtfs_calendar'

-- Swap gtfs_calendar_dates
ALTER TABLE IF EXISTS public.gtfs_calendar_dates RENAME TO gtfs_calendar_dates_old;
ALTER TABLE public.gtfs_calendar_dates_stage RENAME TO gtfs_calendar_dates;
\echo '[swap-cutover] Swapped gtfs_calendar_dates'

-- Swap gtfs_stop_times (references trips, stops - swap last)
ALTER TABLE IF EXISTS public.gtfs_stop_times RENAME TO gtfs_stop_times_old;
ALTER TABLE public.gtfs_stop_times_stage RENAME TO gtfs_stop_times;
\echo '[swap-cutover] Swapped gtfs_stop_times'

-- ───────────────────────────────────────────────────────────────────────────────────
-- Restore app_stop_aliases with FK-aware logic
-- ───────────────────────────────────────────────────────────────────────────────────
-- After swap, new gtfs_stops is fully populated. Restore curated aliases,
-- filtering by FK constraint if one exists (only restore aliases pointing to existing stops).

DO $$
DECLARE
  fk_col TEXT;
BEGIN
  -- Detect if app_stop_aliases has FK to gtfs_stops (and which column)
  SELECT a.attname
  INTO fk_col
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid
  JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  JOIN unnest(c.conkey) WITH ORDINALITY ck(attnum, ord) ON true
  JOIN unnest(c.confkey) WITH ORDINALITY rk(attnum, ord) ON ck.ord = rk.ord
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ck.attnum
  JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = rk.attnum
  WHERE n.nspname = 'public'
    AND t.relname = 'app_stop_aliases'
    AND rn.nspname = 'public'
    AND rt.relname = 'gtfs_stops'
    AND ra.attname = 'stop_id'
  LIMIT 1;

  IF fk_col IS NULL THEN
    -- No FK constraint: restore all aliases as-is
    INSERT INTO public.app_stop_aliases SELECT * FROM _app_stop_aliases_backup ON CONFLICT DO NOTHING;
    RAISE NOTICE '[swap-cutover] Restored app_stop_aliases (no FK, all rows)';
  ELSE
    -- FK exists: restore only aliases pointing to stops that exist in new live data
    EXECUTE format(
      'INSERT INTO public.app_stop_aliases
       SELECT b.* FROM _app_stop_aliases_backup b
       JOIN public.gtfs_stops s ON s.stop_id = b.%I
       ON CONFLICT DO NOTHING',
      fk_col
    );
    RAISE NOTICE '[swap-cutover] Restored app_stop_aliases (with FK join to gtfs_stops)';
  END IF;
END
$$;

COMMIT;

\echo '[swap-cutover] Atomic cutover complete (old tables preserved for optional cleanup)'
