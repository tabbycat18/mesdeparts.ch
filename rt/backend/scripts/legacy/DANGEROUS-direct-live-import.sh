#!/usr/bin/env bash
set -euo pipefail

################################################################################
# ⚠️  DANGEROUS: Legacy direct-live GTFS importer
################################################################################
# This script directly truncates and imports into LIVE production tables.
# It has NO safeguards:
#   - No stage tables or validation before commit
#   - No rollback if data validation fails mid-import
#   - Will cause immediate API downtime if data is malformed
#
# DO NOT USE FOR PRODUCTION UPDATES.
# Use refreshGtfsIfNeeded.js (staged import) instead.
# This script is kept only for EMERGENCY manual recovery scenarios.
################################################################################

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Export it before running this script." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
NEW_DEFAULT_DIR="$(cd "${SCRIPT_DIR}/../../data" && pwd)/gtfs-static-local"
LEGACY_DIR="$(cd "${SCRIPT_DIR}/../../data" && pwd)/gtfs-static"

if [[ -n "${GTFS_DIR:-}" ]]; then
  RESOLVED_GTFS_DIR="$GTFS_DIR"
elif [[ -d "$NEW_DEFAULT_DIR" ]]; then
  RESOLVED_GTFS_DIR="$NEW_DEFAULT_DIR"
else
  RESOLVED_GTFS_DIR="$LEGACY_DIR"
fi

if [[ ! -d "$RESOLVED_GTFS_DIR" ]]; then
  echo "GTFS directory not found: $RESOLVED_GTFS_DIR" >&2
  exit 1
fi

psql "$DATABASE_URL" -v gtfsdir="$RESOLVED_GTFS_DIR" <<'PSQL'
\set ON_ERROR_STOP on
\timing on
\echo 'Importing GTFS static from :gtfsdir'

TRUNCATE public.stop_times,
         public.trips,
         public.calendar_dates,
         public.calendar,
         public.routes,
         public.stops,
         public.agencies
RESTART IDENTITY;

\copy public.agencies (agency_id, agency_name, agency_url, agency_timezone, agency_lang, agency_phone)
  FROM :'gtfsdir'/agency.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

\copy public.stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station, platform_code)
  FROM :'gtfsdir'/stops.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

UPDATE public.stops
SET original_stop_id = stop_id
WHERE original_stop_id IS NULL;

\copy public.routes (route_id, agency_id, route_short_name, route_long_name, route_desc, route_type)
  FROM :'gtfsdir'/routes.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

\copy public.calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
  FROM :'gtfsdir'/calendar.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

\copy public.calendar_dates (service_id, date, exception_type)
  FROM :'gtfsdir'/calendar_dates.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

\copy public.trips (route_id, service_id, trip_id, trip_headsign, trip_short_name, direction_id, block_id, original_trip_id, hints)
  FROM :'gtfsdir'/trips.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

\copy public.stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type)
  FROM :'gtfsdir'/stop_times.csv WITH (FORMAT csv, HEADER true, QUOTE '"', ESCAPE '"', NULL '');

UPDATE public.stop_times
SET
  arrival_time_seconds = CASE
    WHEN arrival_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
      split_part(arrival_time, ':', 1)::int * 3600 +
      split_part(arrival_time, ':', 2)::int * 60 +
      COALESCE(NULLIF(split_part(arrival_time, ':', 3), '')::int, 0)
    ELSE NULL
  END,
  departure_time_seconds = CASE
    WHEN departure_time ~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN
      split_part(departure_time, ':', 1)::int * 3600 +
      split_part(departure_time, ':', 2)::int * 60 +
      COALESCE(NULLIF(split_part(departure_time, ':', 3), '')::int, 0)
    ELSE NULL
  END;

CREATE INDEX IF NOT EXISTS stop_times_stop_departure_idx
  ON public.stop_times (stop_id, departure_time_seconds);

ANALYZE public.stop_times;
ANALYZE public.stops;
ANALYZE public.trips;

REFRESH MATERIALIZED VIEW public.search_stops;

\echo 'Import completed.'
PSQL
