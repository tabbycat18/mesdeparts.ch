DROP TABLE IF EXISTS public.gtfs_stop_times_stage;
DROP TABLE IF EXISTS public.gtfs_calendar_dates_stage;
DROP TABLE IF EXISTS public.gtfs_calendar_stage;
DROP TABLE IF EXISTS public.gtfs_trips_stage;
DROP TABLE IF EXISTS public.gtfs_routes_stage;
DROP TABLE IF EXISTS public.gtfs_stops_stage;
DROP TABLE IF EXISTS public.gtfs_agency_stage;

CREATE TABLE public.gtfs_agency_stage (LIKE public.gtfs_agency INCLUDING ALL);
CREATE TABLE public.gtfs_stops_stage (LIKE public.gtfs_stops INCLUDING ALL);
CREATE TABLE public.gtfs_routes_stage (LIKE public.gtfs_routes INCLUDING ALL);
CREATE TABLE public.gtfs_trips_stage (LIKE public.gtfs_trips INCLUDING ALL);
CREATE TABLE public.gtfs_calendar_stage (LIKE public.gtfs_calendar INCLUDING ALL);
CREATE TABLE public.gtfs_calendar_dates_stage (LIKE public.gtfs_calendar_dates INCLUDING ALL);
CREATE TABLE public.gtfs_stop_times_stage (LIKE public.gtfs_stop_times INCLUDING ALL);
