DO $$
DECLARE
  missing_stops BIGINT;
  missing_trips BIGINT;
BEGIN
  SELECT COUNT(*) INTO missing_stops
  FROM public.gtfs_stop_times_stage st
  LEFT JOIN public.gtfs_stops_stage s ON s.stop_id = st.stop_id
  WHERE s.stop_id IS NULL;

  SELECT COUNT(*) INTO missing_trips
  FROM public.gtfs_stop_times_stage st
  LEFT JOIN public.gtfs_trips_stage t ON t.trip_id = st.trip_id
  WHERE t.trip_id IS NULL;

  IF missing_stops > 0 OR missing_trips > 0 THEN
    RAISE EXCEPTION
      'Stage validation failed. Missing stop refs: %, missing trip refs: %',
      missing_stops,
      missing_trips;
  END IF;
END
$$;
