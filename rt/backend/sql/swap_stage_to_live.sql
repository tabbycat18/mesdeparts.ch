BEGIN;

CREATE TEMP TABLE _app_stop_aliases_backup AS
SELECT *
FROM public.app_stop_aliases;

TRUNCATE TABLE
  public.gtfs_stop_times,
  public.gtfs_calendar_dates,
  public.gtfs_calendar,
  public.gtfs_trips,
  public.gtfs_routes,
  public.gtfs_stops,
  public.gtfs_agency,
  public.app_stop_aliases;

INSERT INTO public.gtfs_agency SELECT * FROM public.gtfs_agency_stage;
INSERT INTO public.gtfs_stops SELECT * FROM public.gtfs_stops_stage;
INSERT INTO public.gtfs_routes SELECT * FROM public.gtfs_routes_stage;
INSERT INTO public.gtfs_trips SELECT * FROM public.gtfs_trips_stage;
INSERT INTO public.gtfs_calendar SELECT * FROM public.gtfs_calendar_stage;
INSERT INTO public.gtfs_calendar_dates SELECT * FROM public.gtfs_calendar_dates_stage;
INSERT INTO public.gtfs_stop_times SELECT * FROM public.gtfs_stop_times_stage;

DO $$
DECLARE
  fk_col TEXT;
BEGIN
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
    EXECUTE 'INSERT INTO public.app_stop_aliases SELECT * FROM _app_stop_aliases_backup ON CONFLICT DO NOTHING';
  ELSE
    EXECUTE format(
      'INSERT INTO public.app_stop_aliases
       SELECT b.*
       FROM _app_stop_aliases_backup b
       JOIN public.gtfs_stops s ON s.stop_id = b.%I
       ON CONFLICT DO NOTHING',
      fk_col
    );
  END IF;
END
$$;

COMMIT;
