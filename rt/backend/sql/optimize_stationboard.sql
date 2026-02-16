-- One-time optimization for large GTFS datasets.
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stationboard.sql

-- 0) Ensure seconds columns exist (older schemas may not have them).
ALTER TABLE public.gtfs_stop_times
  ADD COLUMN IF NOT EXISTS arrival_time_seconds INTEGER;

ALTER TABLE public.gtfs_stop_times
  ADD COLUMN IF NOT EXISTS departure_time_seconds INTEGER;

-- 1) Backfill seconds columns when missing (live table).
UPDATE public.gtfs_stop_times
SET departure_time_seconds = (
  CASE
    WHEN departure_time IS NULL OR departure_time = '' THEN NULL
    WHEN departure_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
      split_part(departure_time, ':', 1)::INT * 3600 +
      split_part(departure_time, ':', 2)::INT * 60 +
      COALESCE(NULLIF(split_part(departure_time, ':', 3), '')::INT, 0)
    ELSE NULL
  END
)
WHERE departure_time_seconds IS NULL;

UPDATE public.gtfs_stop_times
SET arrival_time_seconds = (
  CASE
    WHEN arrival_time IS NULL OR arrival_time = '' THEN NULL
    WHEN arrival_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
      split_part(arrival_time, ':', 1)::INT * 3600 +
      split_part(arrival_time, ':', 2)::INT * 60 +
      COALESCE(NULLIF(split_part(arrival_time, ':', 3), '')::INT, 0)
    ELSE NULL
  END
)
WHERE arrival_time_seconds IS NULL;

-- 2) High-impact stationboard index (boardable departures by stop+time).
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop_depsec_pickup
ON public.gtfs_stop_times (stop_id, departure_time_seconds)
WHERE departure_time_seconds IS NOT NULL
  AND COALESCE(pickup_type, 0) = 0;

-- 3) Calendar_dates lookup index for service/date + exception filtering.
CREATE INDEX IF NOT EXISTS idx_gtfs_calendar_dates_service_date_exc
ON public.gtfs_calendar_dates (service_id, date, exception_type);

ANALYZE public.gtfs_stop_times;
ANALYZE public.gtfs_trips;
ANALYZE public.gtfs_calendar;
ANALYZE public.gtfs_calendar_dates;
