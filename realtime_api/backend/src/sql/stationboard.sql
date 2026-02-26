WITH filtered_stop_times AS MATERIALIZED (
  SELECT
    st.trip_id,
    st.stop_id,
    st.stop_sequence,
    st.arrival_time,
    st.departure_time,
    st.departure_time_seconds AS dep_sec
  FROM public.gtfs_stop_times st
  WHERE st.stop_id = ANY($1::text[])
    -- Departures board only:
    -- 1) must have a real departure time at this stop (not arrival-only row)
    -- pickup_type is intentionally not enforced here; some feeds are too strict.
    AND st.departure_time_seconds IS NOT NULL
    AND (
      ($3::int < 86400 AND st.departure_time_seconds BETWEEN $2::int AND $3::int)
      OR
      ($3::int >= 86400 AND (
        st.departure_time_seconds BETWEEN $2::int AND $3::int
        OR ($2::int < 86400 AND st.departure_time_seconds BETWEEN 0 AND ($3::int - 86400))
      ))
    )
),
trips_for_stops AS MATERIALIZED (
  SELECT
    fst.trip_id,
    fst.stop_id,
    fst.stop_sequence,
    fst.arrival_time,
    fst.departure_time,
    fst.dep_sec,
    t.route_id,
    t.service_id,
    t.trip_headsign,
    to_jsonb(t) ->> 'trip_short_name' AS trip_short_name
  FROM filtered_stop_times fst
  JOIN public.gtfs_trips t ON t.trip_id = fst.trip_id
),
candidate_services AS MATERIALIZED (
  SELECT DISTINCT tfs.service_id
  FROM trips_for_stops tfs
),
active_services AS (
  SELECT cs.service_id
  FROM candidate_services cs
  JOIN public.gtfs_calendar c ON c.service_id = cs.service_id
  WHERE c.start_date::int <= $5::int
    AND c.end_date::int >= $5::int
    AND (
      CASE $6::int
        WHEN 0 THEN c.sunday
        WHEN 1 THEN c.monday
        WHEN 2 THEN c.tuesday
        WHEN 3 THEN c.wednesday
        WHEN 4 THEN c.thursday
        WHEN 5 THEN c.friday
        WHEN 6 THEN c.saturday
      END
    ) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM public.gtfs_calendar_dates cd
      WHERE cd.service_id = cs.service_id
        AND cd.date::int = $5::int
        AND cd.exception_type = 2
    )
  UNION
  SELECT cs.service_id
  FROM candidate_services cs
  JOIN public.gtfs_calendar_dates cd ON cd.service_id = cs.service_id
  WHERE cd.date::int = $5::int
    AND cd.exception_type = 1
),
candidates AS (
  SELECT
    tfs.trip_id,
    tfs.stop_id,
    tfs.stop_sequence,
    tfs.arrival_time,
    tfs.departure_time,
    COALESCE(tfs.departure_time, tfs.arrival_time) AS time_str,
    tfs.dep_sec,
    tfs.route_id,
    tfs.service_id,
    tfs.trip_headsign,
    tfs.trip_short_name,
    r.route_short_name,
    r.route_long_name,
    NULL::text AS route_desc,
    r.route_type::text AS route_type,
    r.agency_id,
    ag.agency_name
  FROM trips_for_stops tfs
  JOIN active_services a ON a.service_id = tfs.service_id
  LEFT JOIN public.gtfs_routes r ON r.route_id = tfs.route_id
  LEFT JOIN public.gtfs_agency ag ON ag.agency_id = r.agency_id
),
deduped AS (
  SELECT DISTINCT ON (trip_id, stop_id, stop_sequence)
    trip_id,
    stop_id,
    stop_sequence,
    arrival_time,
    departure_time,
    time_str,
    dep_sec,
    route_id,
    service_id,
    trip_headsign,
    trip_short_name,
    route_short_name,
    route_long_name,
    route_desc,
    route_type,
    agency_id
  FROM candidates
  ORDER BY
    trip_id,
    stop_id,
    stop_sequence,
    dep_sec ASC
)
SELECT *
FROM deduped
ORDER BY dep_sec ASC
LIMIT $4;
