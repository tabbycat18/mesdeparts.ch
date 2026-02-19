import { createHash } from "node:crypto";

let auditTablesReady = false;
let auditTablesPromise = null;

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function asInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (typeof value === "object" && value !== null && typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function getEntities(feed) {
  if (Array.isArray(feed?.entities)) return feed.entities;
  if (Array.isArray(feed?.entity)) return feed.entity;
  return [];
}

export function getFeedHeaderTimestampSeconds(feed) {
  const direct = asInt(feed?.headerTimestamp);
  if (direct !== null) return direct;
  const header = pick(feed, "header");
  if (!header) return null;
  return asInt(pick(header, "timestamp", "headerTimestamp"));
}

export function epochSecondsToDate(value) {
  const n = asInt(value);
  if (n === null) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function computeObjectSha256(input) {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

export function extractTripUpdatesSnapshot(feed) {
  const entities = getEntities(feed);
  let tripupdateCount = 0;
  let vehicleCount = 0;
  let alertCount = 0;
  const tripUpdates = [];

  for (let i = 0; i < entities.length; i += 1) {
    const entity = entities[i];
    const tu = pick(entity, "trip_update", "tripUpdate");
    if (tu) {
      tripupdateCount += 1;
      const trip = pick(tu, "trip") || null;
      const stopTimeUpdates = Array.isArray(pick(tu, "stop_time_update", "stopTimeUpdate"))
        ? pick(tu, "stop_time_update", "stopTimeUpdate")
        : [];
      const stopIdsSet = new Set();
      for (const stu of stopTimeUpdates) {
        const stopId = normalizeText(pick(stu, "stop_id", "stopId"));
        if (stopId) stopIdsSet.add(stopId);
      }

      tripUpdates.push({
        entityId: normalizeText(pick(entity, "id")) || `idx:${i}`,
        tripId: normalizeText(pick(trip, "trip_id", "tripId")),
        routeId: normalizeText(pick(trip, "route_id", "routeId")),
        startDate: normalizeText(pick(trip, "start_date", "startDate")),
        directionId: asInt(pick(trip, "direction_id", "directionId")),
        stopIds: Array.from(stopIdsSet),
      });
    }

    if (pick(entity, "vehicle", "vehiclePosition")) vehicleCount += 1;
    if (pick(entity, "alert")) alertCount += 1;
  }

  return {
    entityCount: entities.length,
    tripupdateCount,
    vehicleCount,
    alertCount,
    tripUpdates,
  };
}

async function withClient(db, fn) {
  if (typeof db?.connect === "function") {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  return fn(db);
}

export async function ensureAlignmentAuditTables(db) {
  if (auditTablesReady) return;
  if (auditTablesPromise) return auditTablesPromise;

  auditTablesPromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.gtfs_static_ingest_log (
        id BIGSERIAL PRIMARY KEY,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        feed_name TEXT NOT NULL,
        feed_version TEXT NULL,
        start_date DATE NULL,
        end_date DATE NULL,
        stops_count INTEGER NULL,
        routes_count INTEGER NULL,
        trips_count INTEGER NULL,
        stop_times_count INTEGER NULL,
        sha256 TEXT NULL,
        notes TEXT NULL
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_static_ingest_log_ingested_at_idx
      ON public.gtfs_static_ingest_log (ingested_at DESC);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_static_ingest_log_feed_name_idx
      ON public.gtfs_static_ingest_log (feed_name);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS public.gtfs_rt_poll_log (
        id BIGSERIAL PRIMARY KEY,
        polled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        feed_name TEXT NOT NULL,
        rt_header_timestamp TIMESTAMPTZ NULL,
        rt_age_seconds INTEGER NULL,
        entity_count INTEGER NOT NULL DEFAULT 0,
        tripupdate_count INTEGER NOT NULL DEFAULT 0,
        vehicle_count INTEGER NOT NULL DEFAULT 0,
        alert_count INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NULL,
        notes TEXT NULL
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_rt_poll_log_polled_at_idx
      ON public.gtfs_rt_poll_log (polled_at DESC);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_rt_poll_log_feed_name_idx
      ON public.gtfs_rt_poll_log (feed_name);
    `);

    // Stores one normalized trip-update snapshot per poll to support historical audits.
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.gtfs_rt_poll_trip_updates (
        id BIGSERIAL PRIMARY KEY,
        poll_id BIGINT NOT NULL REFERENCES public.gtfs_rt_poll_log(id) ON DELETE CASCADE,
        entity_id TEXT NULL,
        trip_id TEXT NULL,
        route_id TEXT NULL,
        start_date TEXT NULL,
        direction_id INTEGER NULL,
        stop_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
        stop_ids_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_rt_poll_trip_updates_poll_id_idx
      ON public.gtfs_rt_poll_trip_updates (poll_id);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_rt_poll_trip_updates_trip_id_idx
      ON public.gtfs_rt_poll_trip_updates (trip_id);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS gtfs_rt_poll_trip_updates_route_id_idx
      ON public.gtfs_rt_poll_trip_updates (route_id);
    `);

    auditTablesReady = true;
  })();

  try {
    await auditTablesPromise;
  } finally {
    auditTablesPromise = null;
  }
}

export async function fetchCurrentStaticSnapshot(db) {
  const result = await db.query(`
    SELECT
      (SELECT COUNT(*)::INT FROM public.gtfs_stops) AS stops_count,
      (SELECT COUNT(*)::INT FROM public.gtfs_routes) AS routes_count,
      (SELECT COUNT(*)::INT FROM public.gtfs_trips) AS trips_count,
      (SELECT COUNT(*)::INT FROM public.gtfs_stop_times) AS stop_times_count,
      (SELECT MIN(to_date(start_date, 'YYYYMMDD')) FROM public.gtfs_calendar) AS start_date,
      (SELECT MAX(to_date(end_date, 'YYYYMMDD')) FROM public.gtfs_calendar) AS end_date
  `);
  return result.rows[0] || null;
}

export async function fetchCurrentFeedVersion(db) {
  const result = await db.query(
    `
      SELECT value
      FROM public.meta_kv
      WHERE key = 'gtfs_current_feed_version'
      LIMIT 1
    `
  );
  return result.rows[0]?.value || null;
}

export async function insertStaticIngestLog(
  db,
  {
    ingestedAt = new Date(),
    feedName = "opentransportdata_gtfs_static",
    feedVersion = null,
    startDate = null,
    endDate = null,
    stopsCount = null,
    routesCount = null,
    tripsCount = null,
    stopTimesCount = null,
    sha256 = null,
    notes = null,
  } = {}
) {
  await ensureAlignmentAuditTables(db);
  const result = await db.query(
    `
      INSERT INTO public.gtfs_static_ingest_log (
        ingested_at, feed_name, feed_version, start_date, end_date,
        stops_count, routes_count, trips_count, stop_times_count, sha256, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      ingestedAt,
      feedName,
      feedVersion,
      startDate,
      endDate,
      stopsCount,
      routesCount,
      tripsCount,
      stopTimesCount,
      sha256,
      notes,
    ]
  );
  return result.rows[0] || null;
}

export async function insertRtPollLog(
  db,
  {
    polledAt = new Date(),
    feedName = "trip_updates",
    feed = null,
    sha256 = null,
    notes = null,
  } = {}
) {
  await ensureAlignmentAuditTables(db);
  const snapshot = extractTripUpdatesSnapshot(feed);
  const headerSeconds = getFeedHeaderTimestampSeconds(feed);
  const headerTimestamp = epochSecondsToDate(headerSeconds);
  const pollDate = polledAt instanceof Date ? polledAt : new Date(polledAt);
  const rtAgeSeconds =
    headerTimestamp && !Number.isNaN(pollDate.getTime())
      ? Math.max(0, Math.round((pollDate.getTime() - headerTimestamp.getTime()) / 1000))
      : null;

  const resolvedSha = normalizeText(sha256) || computeObjectSha256(feed);
  const noteText =
    typeof notes === "string" ? notes : notes ? JSON.stringify(notes) : null;

  return withClient(db, async (client) => {
    await client.query("BEGIN");
    try {
      const inserted = await client.query(
        `
          INSERT INTO public.gtfs_rt_poll_log (
            polled_at, feed_name, rt_header_timestamp, rt_age_seconds,
            entity_count, tripupdate_count, vehicle_count, alert_count, sha256, notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `,
        [
          pollDate,
          feedName,
          headerTimestamp,
          rtAgeSeconds,
          snapshot.entityCount,
          snapshot.tripupdateCount,
          snapshot.vehicleCount,
          snapshot.alertCount,
          resolvedSha,
          noteText,
        ]
      );
      const pollRow = inserted.rows[0] || null;

      if (pollRow && snapshot.tripUpdates.length) {
        const chunkSize = 250;
        for (let i = 0; i < snapshot.tripUpdates.length; i += chunkSize) {
          const chunk = snapshot.tripUpdates.slice(i, i + chunkSize);
          const values = [];
          const params = [];
          let p = 1;
          for (const row of chunk) {
            values.push(
              pollRow.id,
              row.entityId,
              row.tripId,
              row.routeId,
              row.startDate,
              row.directionId,
              row.stopIds,
              row.stopIds.length
            );
            params.push(
              `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`
            );
            p += 8;
          }

          await client.query(
            `
              INSERT INTO public.gtfs_rt_poll_trip_updates (
                poll_id, entity_id, trip_id, route_id, start_date, direction_id, stop_ids, stop_ids_count
              )
              VALUES ${params.join(", ")}
            `,
            values
          );
        }
      }

      await client.query("COMMIT");
      return {
        pollRow,
        snapshot,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

