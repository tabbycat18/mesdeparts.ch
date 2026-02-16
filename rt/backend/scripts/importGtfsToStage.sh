#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Export it before running this script." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <clean_gtfs_dir>" >&2
  exit 1
fi

CLEAN_DIR="$1"
if [[ ! -d "$CLEAN_DIR" ]]; then
  echo "Clean GTFS directory not found: $CLEAN_DIR" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<PSQL
TRUNCATE TABLE
  public.gtfs_stop_times_stage,
  public.gtfs_calendar_dates_stage,
  public.gtfs_calendar_stage,
  public.gtfs_trips_stage,
  public.gtfs_routes_stage,
  public.gtfs_stops_stage,
  public.gtfs_agency_stage;

DROP TABLE IF EXISTS _import_agency;
CREATE TEMP TABLE _import_agency (
  agency_id TEXT,
  agency_name TEXT,
  agency_url TEXT,
  agency_timezone TEXT,
  agency_lang TEXT,
  agency_phone TEXT
);
\\copy _import_agency FROM '${CLEAN_DIR}/agency.txt' WITH (FORMAT csv, HEADER true)
INSERT INTO public.gtfs_agency_stage (agency_id, agency_name, agency_url, agency_timezone)
SELECT
  NULLIF(agency_id, ''),
  NULLIF(agency_name, ''),
  NULLIF(agency_url, ''),
  NULLIF(agency_timezone, '')
FROM _import_agency
ON CONFLICT (agency_id) DO NOTHING;

DROP TABLE IF EXISTS _import_stops;
CREATE TEMP TABLE _import_stops (
  stop_id TEXT,
  stop_name TEXT,
  stop_lat TEXT,
  stop_lon TEXT,
  location_type TEXT,
  parent_station TEXT,
  platform_code TEXT,
  original_stop_id TEXT
);
\\copy _import_stops FROM '${CLEAN_DIR}/stops.txt' WITH (FORMAT csv, HEADER true)
DO \$\$
DECLARE
  cols TEXT;
  exprs TEXT;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_stops_stage'
    AND c.column_name IN (
      'stop_id',
      'stop_name',
      'stop_lat',
      'stop_lon',
      'location_type',
      'parent_station',
      'platform_code',
      'original_stop_id'
    );

  SELECT string_agg(
    CASE c.column_name
      WHEN 'stop_id' THEN 'NULLIF(stop_id, '''')'
      WHEN 'stop_name' THEN 'NULLIF(stop_name, '''')'
      WHEN 'stop_lat' THEN 'NULLIF(stop_lat, '''')::DOUBLE PRECISION'
      WHEN 'stop_lon' THEN 'NULLIF(stop_lon, '''')::DOUBLE PRECISION'
      WHEN 'location_type' THEN 'NULLIF(location_type, '''')'
      WHEN 'parent_station' THEN 'NULLIF(parent_station, '''')'
      WHEN 'platform_code' THEN 'NULLIF(platform_code, '''')'
      WHEN 'original_stop_id' THEN 'NULLIF(original_stop_id, '''')'
      ELSE 'NULL'
    END,
    ', ' ORDER BY c.ordinal_position
  )
  INTO exprs
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_stops_stage'
    AND c.column_name IN (
      'stop_id',
      'stop_name',
      'stop_lat',
      'stop_lon',
      'location_type',
      'parent_station',
      'platform_code',
      'original_stop_id'
    );

  EXECUTE format(
    'INSERT INTO public.gtfs_stops_stage (%s) SELECT %s FROM _import_stops ON CONFLICT (stop_id) DO NOTHING',
    cols,
    exprs
  );
END
\$\$;

DROP TABLE IF EXISTS _import_routes;
CREATE TEMP TABLE _import_routes (
  route_id TEXT,
  agency_id TEXT,
  route_short_name TEXT,
  route_long_name TEXT,
  route_desc TEXT,
  route_type TEXT
);
\\copy _import_routes FROM '${CLEAN_DIR}/routes.txt' WITH (FORMAT csv, HEADER true)
DO \$\$
DECLARE
  cols TEXT;
  exprs TEXT;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_routes_stage'
    AND c.column_name IN (
      'route_id',
      'agency_id',
      'route_short_name',
      'route_long_name',
      'route_desc',
      'route_type'
    );

  SELECT string_agg(
    CASE c.column_name
      WHEN 'route_id' THEN 'NULLIF(route_id, '''')'
      WHEN 'agency_id' THEN 'NULLIF(agency_id, '''')'
      WHEN 'route_short_name' THEN 'NULLIF(route_short_name, '''')'
      WHEN 'route_long_name' THEN 'NULLIF(route_long_name, '''')'
      WHEN 'route_desc' THEN 'NULLIF(route_desc, '''')'
      WHEN 'route_type' THEN 'NULLIF(route_type, '''')::INTEGER'
      ELSE 'NULL'
    END,
    ', ' ORDER BY c.ordinal_position
  )
  INTO exprs
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_routes_stage'
    AND c.column_name IN (
      'route_id',
      'agency_id',
      'route_short_name',
      'route_long_name',
      'route_desc',
      'route_type'
    );

  EXECUTE format(
    'INSERT INTO public.gtfs_routes_stage (%s) SELECT %s FROM _import_routes ON CONFLICT (route_id) DO NOTHING',
    cols,
    exprs
  );
END
\$\$;

DROP TABLE IF EXISTS _import_trips;
CREATE TEMP TABLE _import_trips (
  route_id TEXT,
  service_id TEXT,
  trip_id TEXT,
  trip_headsign TEXT,
  trip_short_name TEXT,
  direction_id TEXT,
  block_id TEXT,
  original_trip_id TEXT,
  hints TEXT
);
\\copy _import_trips FROM '${CLEAN_DIR}/trips.txt' WITH (FORMAT csv, HEADER true)
INSERT INTO public.gtfs_trips_stage (route_id, service_id, trip_id, trip_headsign, direction_id)
SELECT
  NULLIF(route_id, ''),
  NULLIF(service_id, ''),
  NULLIF(trip_id, ''),
  NULLIF(trip_headsign, ''),
  NULLIF(direction_id, '')::INTEGER
FROM _import_trips
ON CONFLICT (trip_id) DO NOTHING;

DROP TABLE IF EXISTS _import_calendar;
CREATE TEMP TABLE _import_calendar (
  service_id TEXT,
  monday TEXT,
  tuesday TEXT,
  wednesday TEXT,
  thursday TEXT,
  friday TEXT,
  saturday TEXT,
  sunday TEXT,
  start_date TEXT,
  end_date TEXT
);
\\copy _import_calendar FROM '${CLEAN_DIR}/calendar.txt' WITH (FORMAT csv, HEADER true)
INSERT INTO public.gtfs_calendar_stage (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
SELECT
  NULLIF(service_id, ''),
  NULLIF(monday, '')::SMALLINT,
  NULLIF(tuesday, '')::SMALLINT,
  NULLIF(wednesday, '')::SMALLINT,
  NULLIF(thursday, '')::SMALLINT,
  NULLIF(friday, '')::SMALLINT,
  NULLIF(saturday, '')::SMALLINT,
  NULLIF(sunday, '')::SMALLINT,
  NULLIF(start_date, ''),
  NULLIF(end_date, '')
FROM _import_calendar
ON CONFLICT (service_id) DO NOTHING;

DROP TABLE IF EXISTS _import_calendar_dates;
CREATE TEMP TABLE _import_calendar_dates (
  service_id TEXT,
  date TEXT,
  exception_type TEXT
);
\\copy _import_calendar_dates FROM '${CLEAN_DIR}/calendar_dates.txt' WITH (FORMAT csv, HEADER true)
INSERT INTO public.gtfs_calendar_dates_stage (service_id, date, exception_type)
SELECT
  NULLIF(service_id, ''),
  NULLIF(date, ''),
  NULLIF(exception_type, '')::SMALLINT
FROM _import_calendar_dates;

DROP TABLE IF EXISTS _import_stop_times;
CREATE TEMP TABLE _import_stop_times (
  trip_id TEXT,
  arrival_time TEXT,
  departure_time TEXT,
  stop_id TEXT,
  stop_sequence TEXT,
  pickup_type TEXT,
  drop_off_type TEXT
);
\\copy _import_stop_times FROM '${CLEAN_DIR}/stop_times.txt' WITH (FORMAT csv, HEADER true)
DO \$\$
DECLARE
  cols TEXT;
  exprs TEXT;
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
  INTO cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_stop_times_stage'
    AND c.column_name IN (
      'trip_id',
      'arrival_time',
      'departure_time',
      'stop_id',
      'stop_sequence',
      'pickup_type',
      'drop_off_type',
      'arrival_time_seconds',
      'departure_time_seconds'
    );

  SELECT string_agg(
    CASE c.column_name
      WHEN 'trip_id' THEN 'NULLIF(trip_id, '''')'
      WHEN 'arrival_time' THEN 'NULLIF(arrival_time, '''')'
      WHEN 'departure_time' THEN 'NULLIF(departure_time, '''')'
      WHEN 'stop_id' THEN 'NULLIF(stop_id, '''')'
      WHEN 'stop_sequence' THEN 'NULLIF(stop_sequence, '''')::INTEGER'
      WHEN 'pickup_type' THEN 'NULLIF(pickup_type, '''')::INTEGER'
      WHEN 'drop_off_type' THEN 'NULLIF(drop_off_type, '''')::INTEGER'
      WHEN 'arrival_time_seconds' THEN
        'CASE
           WHEN NULLIF(arrival_time, '''') IS NULL THEN NULL
           WHEN arrival_time ~ ''^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$'' THEN
             split_part(arrival_time, '':'', 1)::INT * 3600 +
             split_part(arrival_time, '':'', 2)::INT * 60 +
             COALESCE(NULLIF(split_part(arrival_time, '':'', 3), '''')::INT, 0)
           ELSE NULL
         END'
      WHEN 'departure_time_seconds' THEN
        'CASE
           WHEN NULLIF(departure_time, '''') IS NULL THEN NULL
           WHEN departure_time ~ ''^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$'' THEN
             split_part(departure_time, '':'', 1)::INT * 3600 +
             split_part(departure_time, '':'', 2)::INT * 60 +
             COALESCE(NULLIF(split_part(departure_time, '':'', 3), '''')::INT, 0)
           ELSE NULL
         END'
      ELSE 'NULL'
    END,
    ', ' ORDER BY c.ordinal_position
  )
  INTO exprs
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'gtfs_stop_times_stage'
    AND c.column_name IN (
      'trip_id',
      'arrival_time',
      'departure_time',
      'stop_id',
      'stop_sequence',
      'pickup_type',
      'drop_off_type',
      'arrival_time_seconds',
      'departure_time_seconds'
    );

  EXECUTE format(
    'INSERT INTO public.gtfs_stop_times_stage (%s) SELECT %s FROM _import_stop_times',
    cols,
    exprs
  );
END
\$\$;
PSQL
