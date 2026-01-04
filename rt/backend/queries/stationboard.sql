WITH active_services AS (
  SELECT c.service_id
  FROM public.calendar c
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
      FROM public.calendar_dates cd
      WHERE cd.service_id = c.service_id
        AND cd.date::int = $5::int
        AND cd.exception_type = 2
    )
  UNION
  SELECT cd.service_id
  FROM public.calendar_dates cd
  WHERE cd.date::int = $5::int
    AND cd.exception_type = 1
),
candidates AS (
  SELECT
    st.trip_id,
    st.stop_id,
    st.stop_sequence,
    st.arrival_time,
    st.departure_time,
    COALESCE(st.departure_time, st.arrival_time) AS time_str,
    COALESCE(st.departure_time_seconds, st.arrival_time_seconds) AS dep_sec,
    st.departure_time_seconds,
    t.route_id,
    t.service_id,
    t.trip_headsign,
    t.trip_short_name,
    r.route_short_name,
    r.route_long_name,
    r.route_desc,
    r.route_type,
    r.agency_id
  FROM public.stop_times st
  JOIN public.trips t ON t.trip_id = st.trip_id
  JOIN active_services a ON a.service_id = t.service_id
  LEFT JOIN public.routes r ON r.route_id = t.route_id
  WHERE st.stop_id = ANY($1::text[])
    AND COALESCE(st.departure_time_seconds, st.arrival_time_seconds) IS NOT NULL
    AND (
      ($3::int < 86400 AND COALESCE(st.departure_time_seconds, st.arrival_time_seconds) BETWEEN $2::int AND $3::int)
      OR
      ($3::int >= 86400 AND (
        COALESCE(st.departure_time_seconds, st.arrival_time_seconds) BETWEEN $2::int AND $3::int
        OR COALESCE(st.departure_time_seconds, st.arrival_time_seconds) BETWEEN 0 AND ($3::int - 86400)
      ))
    )
),
-- Keep all stops, including terminus; do not drop terminating rows
filtered AS (
  SELECT c.*
  FROM candidates c
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
  FROM filtered
  ORDER BY
    trip_id,
    stop_id,
    stop_sequence,
    (departure_time_seconds IS NULL) ASC, -- prefer true departure rows
    dep_sec ASC
)
SELECT *
FROM deduped
ORDER BY dep_sec ASC
LIMIT $4;
