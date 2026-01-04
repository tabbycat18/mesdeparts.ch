-- If a previous command left the session aborted:
ROLLBACK;

-- Views first
DROP MATERIALIZED VIEW IF EXISTS public.search_stops;
DROP VIEW IF EXISTS public.calendar_v;

-- Tables (order matters)
DROP TABLE IF EXISTS public.stop_times      CASCADE;
DROP TABLE IF EXISTS public.trips           CASCADE;
DROP TABLE IF EXISTS public.calendar_dates  CASCADE;
DROP TABLE IF EXISTS public.calendar        CASCADE;
DROP TABLE IF EXISTS public.routes          CASCADE;
DROP TABLE IF EXISTS public.stops           CASCADE;
DROP TABLE IF EXISTS public.agencies        CASCADE;

-- Optional (for fuzzy search later):
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) agencies
CREATE TABLE public.agencies (
  agency_id        TEXT PRIMARY KEY,
  agency_name      TEXT NOT NULL,
  agency_url       TEXT,
  agency_timezone  TEXT,
  agency_lang      TEXT,
  agency_phone     TEXT,
  agency_fare_url  TEXT,
  agency_email     TEXT
);

-- 2) stops (keep “problem” fields as TEXT so imports don’t fail on "")
CREATE TABLE public.stops (
  stop_id          TEXT PRIMARY KEY,
  stop_name        TEXT NOT NULL,
  stop_lat         DOUBLE PRECISION,
  stop_lon         DOUBLE PRECISION,
  location_type    TEXT,        -- tolerant (some feeds have blanks)
  parent_station   TEXT,
  platform_code    TEXT,
  original_stop_id TEXT,

  -- optional GTFS columns (nullable)
  stop_code        TEXT,
  stop_desc        TEXT,
  zone_id          TEXT,
  stop_url         TEXT,
  stop_timezone    TEXT,
  wheelchair_boarding TEXT
);

CREATE INDEX IF NOT EXISTS idx_search_stops_after_comma
ON public.search_stops (lower(trim(split_part(stop_name, ',', 2))));

CREATE INDEX IF NOT EXISTS stops_name_idx
  ON public.stops (LOWER(stop_name));

CREATE INDEX IF NOT EXISTS stops_parent_idx
  ON public.stops (parent_station);

-- 3) routes
CREATE TABLE public.routes (
  route_id         TEXT PRIMARY KEY,
  agency_id        TEXT,
  route_short_name TEXT,
  route_long_name  TEXT,
  route_desc       TEXT,
  route_type       TEXT,        -- keep as TEXT (Number(...) still works in JS)
  route_url        TEXT,
  route_color      TEXT,
  route_text_color TEXT,
  route_sort_order TEXT
);

CREATE INDEX IF NOT EXISTS routes_agency_idx
  ON public.routes (agency_id);

-- 4) calendar (no generated columns → avoids “immutable” issues)
CREATE TABLE public.calendar (
  service_id TEXT PRIMARY KEY,
  monday     SMALLINT NOT NULL,
  tuesday    SMALLINT NOT NULL,
  wednesday  SMALLINT NOT NULL,
  thursday   SMALLINT NOT NULL,
  friday     SMALLINT NOT NULL,
  saturday   SMALLINT NOT NULL,
  sunday     SMALLINT NOT NULL,
  start_date CHAR(8) NOT NULL,   -- YYYYMMDD
  end_date   CHAR(8) NOT NULL    -- YYYYMMDD
);

CREATE INDEX IF NOT EXISTS calendar_start_idx ON public.calendar (start_date);
CREATE INDEX IF NOT EXISTS calendar_end_idx   ON public.calendar (end_date);

CREATE OR REPLACE VIEW public.calendar_v AS
SELECT
  service_id,
  monday, tuesday, wednesday, thursday, friday, saturday, sunday,
  start_date,
  end_date,
  to_date(start_date, 'YYYYMMDD') AS start_date_date,
  to_date(end_date,   'YYYYMMDD') AS end_date_date
FROM public.calendar;

-- 5) calendar_dates
CREATE TABLE public.calendar_dates (
  id             BIGSERIAL PRIMARY KEY,
  service_id     TEXT NOT NULL,
  date           CHAR(8) NOT NULL,     -- YYYYMMDD
  exception_type SMALLINT NOT NULL
);

CREATE INDEX IF NOT EXISTS calendar_dates_service_date_idx
  ON public.calendar_dates (service_id, date);

-- 6) trips (keep direction_id as TEXT to tolerate blanks)
CREATE TABLE public.trips (
  trip_id          TEXT PRIMARY KEY,
  route_id         TEXT,
  service_id       TEXT,
  trip_headsign    TEXT,
  trip_short_name  TEXT,
  direction_id     TEXT,
  block_id         TEXT,
  shape_id         TEXT,
  wheelchair_accessible TEXT,
  bikes_allowed    TEXT,

  -- Swiss feed extras (if present)
  original_trip_id TEXT,
  hints            TEXT
);

CREATE INDEX IF NOT EXISTS trips_route_idx
  ON public.trips (route_id);

CREATE INDEX IF NOT EXISTS trips_service_idx
  ON public.trips (service_id);

-- 7) stop_times (seconds are normal columns, filled after import)
CREATE TABLE public.stop_times (
  id              BIGSERIAL PRIMARY KEY,
  trip_id         TEXT NOT NULL,
  arrival_time    TEXT,
  departure_time  TEXT,
  stop_id         TEXT NOT NULL,
  stop_sequence   INTEGER NOT NULL,
  pickup_type     TEXT,
  drop_off_type   TEXT,

  -- optional GTFS columns
  stop_headsign   TEXT,
  shape_dist_traveled DOUBLE PRECISION,
  timepoint       TEXT,

  arrival_time_seconds   INTEGER,
  departure_time_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS stop_times_stop_dep_idx
  ON public.stop_times (stop_id, departure_time_seconds);

CREATE INDEX IF NOT EXISTS stop_times_trip_seq_idx
  ON public.stop_times (trip_id, stop_sequence);