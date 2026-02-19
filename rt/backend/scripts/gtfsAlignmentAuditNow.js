/**
 * scripts/gtfsAlignmentAuditNow.js
 *
 * Part B + D: "NOW" alignment audit — verifies that the current live GTFS-RT
 * feed is consistent with the current static GTFS data in the database.
 *
 * Checks:
 *   A) Missing trip_ids   (RT trip_id not in gtfs_trips)
 *   B) Missing stop_ids   (RT stop_id not in gtfs_stops)
 *   C) Missing route_ids  (RT route_id not in gtfs_routes)
 *   D) Inactive service   (trip exists but its service_id is inactive today)
 *
 * Output: /tmp/gtfs_alignment_now.json
 *
 * Usage:
 *   node scripts/gtfsAlignmentAuditNow.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── env loader ────────────────────────────────────────────────────────────────
function loadDotEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

import { fetchTripUpdates } from "../src/loaders/fetchTripUpdates.js";
import {
  ensureAlignmentAuditTables,
  insertRtPollLog,
  insertStaticIngestLog,
  fetchCurrentStaticSnapshot,
  fetchCurrentFeedVersion,
  extractTripUpdatesSnapshot,
  getFeedHeaderTimestampSeconds,
  epochSecondsToDate,
} from "../src/audit/alignmentLogs.js";

const OUTPUT_PATH = "/tmp/gtfs_alignment_now.json";
const TOP_N = 20;

// ── calendar validity SQL ─────────────────────────────────────────────────────
// Returns rows where is_active = false (inactive trips that appear in RT).
const CALENDAR_INACTIVE_SQL = `
WITH trip_services AS (
  SELECT DISTINCT t.trip_id, t.service_id
  FROM public.gtfs_trips t
  WHERE t.trip_id = ANY($1::text[])
),
audit_params AS (
  SELECT
    $2::date AS audit_date,
    to_char($2::date, 'YYYYMMDD') AS audit_date_str,
    EXTRACT(ISODOW FROM $2::date)::int AS iso_dow  -- 1=Mon, 7=Sun
),
cal_check AS (
  SELECT
    ts.trip_id,
    ts.service_id,
    (
      SELECT cd.exception_type
      FROM public.gtfs_calendar_dates cd
      WHERE cd.service_id = ts.service_id
        AND cd.date = ap.audit_date_str
      LIMIT 1
    ) AS override_type,
    (
      SELECT
        CASE ap.iso_dow
          WHEN 1 THEN c.monday
          WHEN 2 THEN c.tuesday
          WHEN 3 THEN c.wednesday
          WHEN 4 THEN c.thursday
          WHEN 5 THEN c.friday
          WHEN 6 THEN c.saturday
          WHEN 7 THEN c.sunday
        END
      FROM public.gtfs_calendar c
      WHERE c.service_id = ts.service_id
        AND c.start_date <= ap.audit_date_str
        AND c.end_date   >= ap.audit_date_str
      LIMIT 1
    ) AS cal_day_value
  FROM trip_services ts
  CROSS JOIN audit_params ap
)
SELECT
  trip_id,
  service_id,
  override_type,
  cal_day_value,
  CASE
    WHEN override_type = 1 THEN true   -- calendar_dates: added
    WHEN override_type = 2 THEN false  -- calendar_dates: removed
    WHEN cal_day_value = 1 THEN true   -- calendar: active
    ELSE false                         -- no matching calendar row, or day=0
  END AS is_active
FROM cal_check
WHERE NOT (
  CASE
    WHEN override_type = 1 THEN true
    WHEN override_type = 2 THEN false
    WHEN cal_day_value = 1 THEN true
    ELSE false
  END
)
ORDER BY trip_id
`;

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

  // Use a Pool so insertRtPollLog (which uses withClient/transactions) works correctly.
  const client = new Pool({
    connectionString: DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
    max: 3,
  });

  try {
    // Ensure audit tables exist (idempotent)
    await ensureAlignmentAuditTables(client);

    const auditAt = new Date();
    console.log(`\n[audit-now] ━━━ GTFS Alignment Audit ━━━`);
    console.log(`[audit-now] audit_at = ${auditAt.toISOString()}`);

    // ── 1. Static snapshot ──────────────────────────────────────────────────
    console.log("\n[audit-now] 1/5  Loading static DB snapshot...");
    const staticSnap = await fetchCurrentStaticSnapshot(client);
    const feedVersion = await fetchCurrentFeedVersion(client);

    console.log(`[audit-now]       stops=${staticSnap?.stops_count ?? "?"}, routes=${staticSnap?.routes_count ?? "?"}, trips=${staticSnap?.trips_count ?? "?"}, stop_times=${staticSnap?.stop_times_count ?? "?"}`);
    console.log(`[audit-now]       feed_version=${feedVersion || "(unknown)"}`);
    console.log(`[audit-now]       calendar_range=${staticSnap?.start_date?.toISOString?.()?.slice(0, 10) ?? "?"} → ${staticSnap?.end_date?.toISOString?.()?.slice(0, 10) ?? "?"}`);

    // Get or create static ingest log entry
    const latestIngestRes = await client.query(
      `SELECT * FROM public.gtfs_static_ingest_log ORDER BY ingested_at DESC LIMIT 1`
    );
    let staticIngestRecord = latestIngestRes.rows[0] || null;

    if (!staticIngestRecord) {
      console.log("[audit-now]       No static ingest log found — creating synthetic entry from current DB state.");
      staticIngestRecord = await insertStaticIngestLog(client, {
        feedName: "opentransportdata_gtfs_static",
        feedVersion: feedVersion || null,
        startDate: staticSnap?.start_date || null,
        endDate: staticSnap?.end_date || null,
        stopsCount: staticSnap?.stops_count || null,
        routesCount: staticSnap?.routes_count || null,
        tripsCount: staticSnap?.trips_count || null,
        stopTimesCount: staticSnap?.stop_times_count || null,
        notes: "auto-created by gtfsAlignmentAuditNow; no prior ingest log",
      });
      console.log(`[audit-now]       Created synthetic ingest log id=${staticIngestRecord?.id}`);
    } else {
      console.log(`[audit-now]       Latest static ingest: id=${staticIngestRecord.id}, ingested_at=${new Date(staticIngestRecord.ingested_at).toISOString()}`);
    }

    // ── 2. Fetch live RT feed ───────────────────────────────────────────────
    console.log("\n[audit-now] 2/5  Fetching live GTFS-RT feed...");
    const rtFeed = await fetchTripUpdates();
    const polledAt = new Date();

    const headerSec = getFeedHeaderTimestampSeconds(rtFeed);
    const rtHeaderTimestamp = epochSecondsToDate(headerSec);
    const rtAgeSeconds =
      headerSec != null
        ? Math.max(0, Math.round(polledAt.getTime() / 1000 - headerSec))
        : null;

    // Log poll + snapshot to DB (non-fatal on failure)
    let pollRow = null;
    let snapshot = null;
    try {
      const result = await insertRtPollLog(client, {
        polledAt,
        feedName: "trip_updates",
        feed: rtFeed,
      });
      pollRow = result.pollRow;
      snapshot = result.snapshot;
    } catch (err) {
      console.warn("[audit-now]       Could not log RT poll:", err?.message || err);
      snapshot = extractTripUpdatesSnapshot(rtFeed);
    }

    console.log(`[audit-now]       entities=${snapshot.entityCount}, tripupdates=${snapshot.tripupdateCount}`);
    console.log(`[audit-now]       rt_header_ts=${rtHeaderTimestamp?.toISOString() ?? "(none)"}, rt_age=${rtAgeSeconds ?? "?"}s`);

    // ── 3. Extract unique IDs from RT ───────────────────────────────────────
    console.log("\n[audit-now] 3/5  Extracting unique RT IDs...");
    const rtTripIds = [...new Set(snapshot.tripUpdates.map((u) => u.tripId).filter(Boolean))];
    const rtStopIds = [
      ...new Set(snapshot.tripUpdates.flatMap((u) => u.stopIds || []).filter(Boolean)),
    ];
    const rtRouteIds = [...new Set(snapshot.tripUpdates.map((u) => u.routeId).filter(Boolean))];

    console.log(`[audit-now]       unique trip_ids=${rtTripIds.length}, stop_ids=${rtStopIds.length}, route_ids=${rtRouteIds.length}`);

    // ── 4A. Missing trip_ids ────────────────────────────────────────────────
    console.log("\n[audit-now] 4/5  Checking static alignment...");
    let missingTripIds = [];
    if (rtTripIds.length > 0) {
      const r = await client.query(
        `SELECT t.trip_id
         FROM unnest($1::text[]) AS t(trip_id)
         LEFT JOIN public.gtfs_trips st ON st.trip_id = t.trip_id
         WHERE st.trip_id IS NULL
         ORDER BY t.trip_id`,
        [rtTripIds]
      );
      missingTripIds = r.rows.map((r) => r.trip_id);
    }
    console.log(`[audit-now]       missing trip_ids:  ${missingTripIds.length} / ${rtTripIds.length}`);

    // ── 4B. Missing stop_ids ────────────────────────────────────────────────
    let missingStopIds = [];
    if (rtStopIds.length > 0) {
      const r = await client.query(
        `SELECT s.stop_id
         FROM unnest($1::text[]) AS s(stop_id)
         LEFT JOIN public.gtfs_stops st ON st.stop_id = s.stop_id
         WHERE st.stop_id IS NULL
         ORDER BY s.stop_id`,
        [rtStopIds]
      );
      missingStopIds = r.rows.map((r) => r.stop_id);
    }
    console.log(`[audit-now]       missing stop_ids:  ${missingStopIds.length} / ${rtStopIds.length}`);

    // ── 4C. Missing route_ids ───────────────────────────────────────────────
    let missingRouteIds = [];
    if (rtRouteIds.length > 0) {
      const r = await client.query(
        `SELECT r.route_id
         FROM unnest($1::text[]) AS r(route_id)
         LEFT JOIN public.gtfs_routes rt ON rt.route_id = r.route_id
         WHERE rt.route_id IS NULL
         ORDER BY r.route_id`,
        [rtRouteIds]
      );
      missingRouteIds = r.rows.map((r) => r.route_id);
    }
    console.log(`[audit-now]       missing route_ids: ${missingRouteIds.length} / ${rtRouteIds.length}`);

    // ── 5. Calendar validity ────────────────────────────────────────────────
    console.log("\n[audit-now] 5/5  Checking calendar validity...");
    const missingTripIdSet = new Set(missingTripIds);
    // Only check trips that actually exist in static (skip already-missing ones)
    const existingRtTripIds = rtTripIds.filter((id) => !missingTripIdSet.has(id));

    let inactiveTrips = [];
    if (existingRtTripIds.length > 0) {
      const auditDateStr = auditAt.toISOString().slice(0, 10); // YYYY-MM-DD
      const r = await client.query(CALENDAR_INACTIVE_SQL, [existingRtTripIds, auditDateStr]);
      inactiveTrips = r.rows;
    }
    console.log(`[audit-now]       inactive service:  ${inactiveTrips.length} / ${existingRtTripIds.length} existing RT trips`);

    // ── Build report ────────────────────────────────────────────────────────
    const pct = (n, d) =>
      d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "N/A";

    const report = {
      meta: {
        audit_at: auditAt.toISOString(),
        static_ingested_at: staticIngestRecord?.ingested_at
          ? new Date(staticIngestRecord.ingested_at).toISOString()
          : null,
        static_feed_version: staticIngestRecord?.feed_version || feedVersion || null,
        static_calendar_range: {
          start: staticSnap?.start_date?.toISOString?.()?.slice(0, 10) ?? null,
          end: staticSnap?.end_date?.toISOString?.()?.slice(0, 10) ?? null,
        },
        static_counts: {
          stops: staticSnap?.stops_count ?? null,
          routes: staticSnap?.routes_count ?? null,
          trips: staticSnap?.trips_count ?? null,
          stop_times: staticSnap?.stop_times_count ?? null,
        },
        rt_polled_at: polledAt.toISOString(),
        rt_header_timestamp: rtHeaderTimestamp?.toISOString() ?? null,
        rt_age_seconds: rtAgeSeconds,
        rt_poll_log_id: pollRow?.id ?? null,
      },
      summary: {
        total_entities: snapshot.entityCount,
        total_tripupdates: snapshot.tripupdateCount,
        rt_unique_trip_ids: rtTripIds.length,
        rt_unique_stop_ids: rtStopIds.length,
        rt_unique_route_ids: rtRouteIds.length,
        missing_trip_id_count: missingTripIds.length,
        missing_stop_id_count: missingStopIds.length,
        missing_route_id_count: missingRouteIds.length,
        inactive_service_count: inactiveTrips.length,
        missing_trip_id_pct: pct(missingTripIds.length, rtTripIds.length),
        missing_stop_id_pct: pct(missingStopIds.length, rtStopIds.length),
        missing_route_id_pct: pct(missingRouteIds.length, rtRouteIds.length),
        inactive_service_pct: pct(inactiveTrips.length, existingRtTripIds.length),
      },
      examples: {
        missing_trip_ids: missingTripIds.slice(0, TOP_N),
        missing_stop_ids: missingStopIds.slice(0, TOP_N),
        missing_route_ids: missingRouteIds.slice(0, TOP_N),
        inactive_service_trips: inactiveTrips.slice(0, TOP_N).map((r) => ({
          trip_id: r.trip_id,
          service_id: r.service_id,
          override_type: r.override_type ?? null,
          cal_day_value: r.cal_day_value ?? null,
        })),
      },
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

    // ── Print key findings ──────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║          GTFS ALIGNMENT AUDIT — NOW                 ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  audit_at:            ${report.meta.audit_at}`);
    console.log(`  static_ingested_at:  ${report.meta.static_ingested_at ?? "(none)"}`);
    console.log(`  static_feed_version: ${report.meta.static_feed_version ?? "(none)"}`);
    console.log(`  rt_polled_at:        ${report.meta.rt_polled_at}`);
    console.log(`  rt_header_ts:        ${report.meta.rt_header_timestamp ?? "(none)"}`);
    console.log(`  rt_age:              ${rtAgeSeconds != null ? rtAgeSeconds + "s" : "?"}`);
    console.log("");
    console.log(`  COUNTS`);
    console.log(`    RT entities:       ${report.summary.total_entities}`);
    console.log(`    RT tripupdates:    ${report.summary.total_tripupdates}`);
    console.log(`    unique trip_ids:   ${report.summary.rt_unique_trip_ids}`);
    console.log(`    unique stop_ids:   ${report.summary.rt_unique_stop_ids}`);
    console.log(`    unique route_ids:  ${report.summary.rt_unique_route_ids}`);
    console.log("");
    console.log(`  MISMATCHES`);
    console.log(`    missing trip_ids:  ${report.summary.missing_trip_id_count} (${report.summary.missing_trip_id_pct})`);
    console.log(`    missing stop_ids:  ${report.summary.missing_stop_id_count} (${report.summary.missing_stop_id_pct})`);
    console.log(`    missing route_ids: ${report.summary.missing_route_id_count} (${report.summary.missing_route_id_pct})`);
    console.log(`    inactive service:  ${report.summary.inactive_service_count} (${report.summary.inactive_service_pct})`);

    if (missingTripIds.length > 0) {
      console.log(`\n  TOP MISSING TRIP IDs (first 5):`);
      missingTripIds.slice(0, 5).forEach((id) => console.log(`    - ${id}`));
    }
    if (missingStopIds.length > 0) {
      console.log(`\n  TOP MISSING STOP IDs (first 5):`);
      missingStopIds.slice(0, 5).forEach((id) => console.log(`    - ${id}`));
    }
    if (missingRouteIds.length > 0) {
      console.log(`\n  TOP MISSING ROUTE IDs (first 5):`);
      missingRouteIds.slice(0, 5).forEach((id) => console.log(`    - ${id}`));
    }
    if (inactiveTrips.length > 0) {
      console.log(`\n  TOP INACTIVE SERVICE TRIPS (first 5):`);
      inactiveTrips.slice(0, 5).forEach((t) =>
        console.log(
          `    - trip=${t.trip_id}  svc=${t.service_id}  override=${t.override_type ?? "none"}  cal_day=${t.cal_day_value ?? "null"}`
        )
      );
    }

    console.log(`\n  Output saved → ${OUTPUT_PATH}`);

    return report;
  } finally {
    await client.end();  // Pool.end() drains all connections
  }
}

run().catch((err) => {
  console.error("[audit-now] FATAL:", err?.stack || err?.message || err);
  process.exit(1);
});
