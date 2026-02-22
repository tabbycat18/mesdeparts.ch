/**
 * scripts/gtfsAlignmentHistoryReport.js
 *
 * Part C + D: Historical alignment report for the last 14 days.
 * Focuses on the Mon/Thu 10:00 static update vs 15:00 RT refresh gap.
 *
 * For each static ingest event:
 *   - Find RT polls in window [ingest_time - 1h, ingest_time + 6h]
 *   - For each RT poll with stored snapshot data, run alignment checks
 *     against the current static DB (best proxy we have without point-in-time DB)
 *   - Produce a time-series table per ingest event
 *   - Summarise: peak mismatches, first clean poll, gap persistence
 *
 * Output: /tmp/gtfs_alignment_history.json
 *
 * Usage:
 *   node scripts/gtfsAlignmentHistoryReport.js
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

import { ensureAlignmentAuditTables } from "../src/audit/alignmentLogs.js";

const OUTPUT_PATH = "/tmp/gtfs_alignment_history.json";
const WINDOW_BEFORE_HOURS = 1;
const WINDOW_AFTER_HOURS = 6;
const HISTORY_DAYS = 14;

// ── Per-poll alignment SQL (uses stored trip snapshot) ────────────────────────
// Returns counts of missing trip_ids, stop_ids, and inactive service
// against the CURRENT static DB (best proxy for historical point-in-time).
const MISSING_TRIPS_SQL = `
  SELECT COUNT(*)::int AS cnt
  FROM unnest($1::text[]) AS t(trip_id)
  LEFT JOIN public.gtfs_trips st ON st.trip_id = t.trip_id
  WHERE st.trip_id IS NULL
`;

const MISSING_STOPS_SQL = `
  SELECT COUNT(*)::int AS cnt
  FROM unnest($1::text[]) AS s(stop_id)
  LEFT JOIN public.gtfs_stops st ON st.stop_id = s.stop_id
  WHERE st.stop_id IS NULL
`;

const INACTIVE_SERVICE_SQL = `
WITH trip_services AS (
  SELECT DISTINCT t.trip_id, t.service_id
  FROM public.gtfs_trips t
  WHERE t.trip_id = ANY($1::text[])
),
audit_params AS (
  SELECT
    $2::date AS audit_date,
    to_char($2::date, 'YYYYMMDD') AS audit_date_str,
    EXTRACT(ISODOW FROM $2::date)::int AS iso_dow
),
cal_check AS (
  SELECT
    ts.trip_id,
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
          WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
          WHEN 4 THEN c.thursday WHEN 5 THEN c.friday WHEN 6 THEN c.saturday
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
SELECT COUNT(*)::int AS cnt
FROM cal_check
WHERE NOT (
  CASE
    WHEN override_type = 1 THEN true
    WHEN override_type = 2 THEN false
    WHEN cal_day_value = 1 THEN true
    ELSE false
  END
)
`;

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtTs(v) {
  if (!v) return "—";
  return new Date(v).toISOString();
}

function pad(s, n) {
  return String(s ?? "").padEnd(n);
}

function rpad(s, n) {
  return String(s ?? "").padStart(n);
}

// ── per-poll alignment check ──────────────────────────────────────────────────
async function auditPoll(client, poll) {
  // Load stored trip_update snapshot for this poll
  const snapRes = await client.query(
    `SELECT trip_id, route_id, stop_ids
     FROM public.gtfs_rt_poll_trip_updates
     WHERE poll_id = $1`,
    [poll.id]
  );

  const rows = snapRes.rows;
  const tripupdateCount = rows.length;

  if (tripupdateCount === 0) {
    return {
      poll_id: poll.id,
      polled_at: fmtTs(poll.polled_at),
      rt_age_seconds: poll.rt_age_seconds,
      rt_header_timestamp: fmtTs(poll.rt_header_timestamp),
      entity_count: poll.entity_count,
      tripupdate_count: poll.tripupdate_count,
      snapshot_rows: 0,
      rt_unique_trip_ids: 0,
      rt_unique_stop_ids: 0,
      missing_trip_id_count: null,
      missing_stop_id_count: null,
      inactive_service_count: null,
      note: "no_snapshot_data",
    };
  }

  const rtTripIds = [...new Set(rows.map((r) => r.trip_id).filter(Boolean))];
  const rtStopIds = [
    ...new Set(rows.flatMap((r) => (Array.isArray(r.stop_ids) ? r.stop_ids : [])).filter(Boolean)),
  ];

  // Missing trip_ids
  let missingTrips = 0;
  if (rtTripIds.length > 0) {
    const r = await client.query(MISSING_TRIPS_SQL, [rtTripIds]);
    missingTrips = r.rows[0]?.cnt ?? 0;
  }

  // Missing stop_ids
  let missingStops = 0;
  if (rtStopIds.length > 0) {
    const r = await client.query(MISSING_STOPS_SQL, [rtStopIds]);
    missingStops = r.rows[0]?.cnt ?? 0;
  }

  // Inactive service (only for trips that exist in static)
  const existingTripIds = rtTripIds; // approximate — excludes already-missing for full accuracy
  let inactiveService = 0;
  if (existingTripIds.length > 0) {
    const auditDate = new Date(poll.polled_at).toISOString().slice(0, 10);
    const r = await client.query(INACTIVE_SERVICE_SQL, [existingTripIds, auditDate]);
    inactiveService = r.rows[0]?.cnt ?? 0;
  }

  return {
    poll_id: poll.id,
    polled_at: fmtTs(poll.polled_at),
    rt_age_seconds: poll.rt_age_seconds,
    rt_header_timestamp: fmtTs(poll.rt_header_timestamp),
    entity_count: poll.entity_count,
    tripupdate_count: poll.tripupdate_count,
    snapshot_rows: tripupdateCount,
    rt_unique_trip_ids: rtTripIds.length,
    rt_unique_stop_ids: rtStopIds.length,
    missing_trip_id_count: missingTrips,
    missing_stop_id_count: missingStops,
    inactive_service_count: inactiveService,
    note: null,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

  const client = new Pool({
    connectionString: DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
    max: 3,
  });

  try {
    await ensureAlignmentAuditTables(client);

    const now = new Date();
    const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 3600 * 1000);

    console.log("\n[history] ━━━ GTFS Alignment History Report ━━━");
    console.log(`[history] Window: last ${HISTORY_DAYS} days`);
    console.log(`[history] Since:  ${since.toISOString()}`);
    console.log(`[history] Until:  ${now.toISOString()}`);

    // ── Inventory ───────────────────────────────────────────────────────────
    const [staticCntRes, rtCntRes, snapCntRes] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS cnt FROM public.gtfs_static_ingest_log WHERE ingested_at >= $1`,
        [since]
      ),
      client.query(
        `SELECT COUNT(*)::int AS cnt FROM public.gtfs_rt_poll_log WHERE polled_at >= $1`,
        [since]
      ),
      client.query(`SELECT COUNT(*)::int AS cnt FROM public.gtfs_rt_poll_trip_updates`),
    ]);

    const staticCount = staticCntRes.rows[0]?.cnt ?? 0;
    const rtCount = rtCntRes.rows[0]?.cnt ?? 0;
    const snapCount = snapCntRes.rows[0]?.cnt ?? 0;

    console.log(`\n[history] Inventory:`);
    console.log(`           static ingest events (last 14d): ${staticCount}`);
    console.log(`           RT poll events       (last 14d): ${rtCount}`);
    console.log(`           RT snapshot rows (total):        ${snapCount}`);

    const report = {
      meta: {
        generated_at: now.toISOString(),
        window_days: HISTORY_DAYS,
        since: since.toISOString(),
        until: now.toISOString(),
        static_ingest_events_found: staticCount,
        rt_poll_events_found: rtCount,
        rt_snapshot_rows_total: snapCount,
        notes: [],
      },
      ingest_events: [],
    };

    // ── No data: explain and exit ────────────────────────────────────────────
    if (staticCount === 0 && rtCount === 0) {
      const msg =
        "No historical data found. The audit pipeline has just been wired up.\n" +
        "  • gtfs_static_ingest_log is now written by refreshGtfsIfNeeded.js on every new static import.\n" +
        "  • gtfs_rt_poll_log + gtfs_rt_poll_trip_updates are now written by the RT loader on every feed fetch.\n" +
        "  Re-run this report after data accumulates (typically after the next Mon/Thu refresh cycle).";
      report.meta.notes.push(msg);
      console.log("\n[history] " + msg.replace(/\n/g, "\n[history] "));
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
      console.log(`\n[history] Report saved → ${OUTPUT_PATH}`);
      return report;
    }

    if (staticCount > 0 && rtCount === 0) {
      report.meta.notes.push(
        "Static ingest events exist but NO RT poll events found. " +
        "RT poll logging was just activated. Historical RT data will accumulate from now."
      );
    }
    if (staticCount === 0 && rtCount > 0) {
      report.meta.notes.push(
        "RT poll events exist but NO static ingest events in last 14 days. " +
        "Either no static refresh occurred, or static ingest logging was just activated."
      );
    }

    // ── Load static ingest events ────────────────────────────────────────────
    const ingestRes = await client.query(
      `SELECT * FROM public.gtfs_static_ingest_log
       WHERE ingested_at >= $1
       ORDER BY ingested_at ASC`,
      [since]
    );

    for (const ingestRow of ingestRes.rows) {
      const ingestTime = new Date(ingestRow.ingested_at);
      const windowStart = new Date(ingestTime.getTime() - WINDOW_BEFORE_HOURS * 3600 * 1000);
      const windowEnd = new Date(ingestTime.getTime() + WINDOW_AFTER_HOURS * 3600 * 1000);

      console.log(`\n[history] ── Static ingest id=${ingestRow.id} ingested_at=${ingestTime.toISOString()}`);
      console.log(`[history]    RT window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);

      // Find RT polls in window, join snapshot count
      const pollsRes = await client.query(
        `SELECT
           p.*,
           (SELECT COUNT(*)::int FROM public.gtfs_rt_poll_trip_updates WHERE poll_id = p.id) AS snapshot_rows
         FROM public.gtfs_rt_poll_log p
         WHERE p.polled_at >= $1 AND p.polled_at <= $2
         ORDER BY p.polled_at ASC`,
        [windowStart, windowEnd]
      );
      const polls = pollsRes.rows;
      console.log(`[history]    Polls in window: ${polls.length}`);

      const eventEntry = {
        static_ingest_id: ingestRow.id,
        ingested_at: ingestTime.toISOString(),
        feed_version: ingestRow.feed_version ?? null,
        static_counts: {
          stops: ingestRow.stops_count ?? null,
          routes: ingestRow.routes_count ?? null,
          trips: ingestRow.trips_count ?? null,
          stop_times: ingestRow.stop_times_count ?? null,
        },
        rt_poll_window: {
          from: windowStart.toISOString(),
          to: windowEnd.toISOString(),
        },
        rt_polls_in_window: polls.length,
        time_series: [],
        summary: {
          peak_missing_trip_id_count: 0,
          peak_missing_stop_id_count: 0,
          peak_inactive_service_count: 0,
          polls_with_any_mismatch: 0,
          polls_with_snapshot_data: 0,
          first_clean_poll_at: null,
          first_mismatch_drop_at: null,
          persisting_mismatches: false,
        },
      };

      // Track previous mismatch totals to detect the drop
      let prevMismatchTotal = null;

      for (const poll of polls) {
        const result = await auditPoll(client, poll);
        eventEntry.time_series.push(result);

        if (result.note === "no_snapshot_data") continue;
        eventEntry.summary.polls_with_snapshot_data += 1;

        const mismatchTotal =
          (result.missing_trip_id_count ?? 0) +
          (result.missing_stop_id_count ?? 0) +
          (result.inactive_service_count ?? 0);

        const hasMismatch = mismatchTotal > 0;

        if (hasMismatch) {
          eventEntry.summary.polls_with_any_mismatch += 1;
          eventEntry.summary.peak_missing_trip_id_count = Math.max(
            eventEntry.summary.peak_missing_trip_id_count,
            result.missing_trip_id_count ?? 0
          );
          eventEntry.summary.peak_missing_stop_id_count = Math.max(
            eventEntry.summary.peak_missing_stop_id_count,
            result.missing_stop_id_count ?? 0
          );
          eventEntry.summary.peak_inactive_service_count = Math.max(
            eventEntry.summary.peak_inactive_service_count,
            result.inactive_service_count ?? 0
          );
        } else if (!eventEntry.summary.first_clean_poll_at) {
          eventEntry.summary.first_clean_poll_at = result.polled_at;
        }

        // Detect drop: previous had mismatches, this one is clean
        if (prevMismatchTotal !== null && prevMismatchTotal > 0 && mismatchTotal === 0) {
          eventEntry.summary.first_mismatch_drop_at = result.polled_at;
        }

        prevMismatchTotal = mismatchTotal;
      }

      // Persisting mismatches: last poll with snapshot data still has mismatches
      const lastWithSnap = eventEntry.time_series
        .filter((ts) => ts.note !== "no_snapshot_data")
        .at(-1);
      if (lastWithSnap) {
        const lastTotal =
          (lastWithSnap.missing_trip_id_count ?? 0) +
          (lastWithSnap.missing_stop_id_count ?? 0) +
          (lastWithSnap.inactive_service_count ?? 0);
        eventEntry.summary.persisting_mismatches = lastTotal > 0;
      }

      // Print compact time-series table for this ingest event
      if (eventEntry.time_series.length > 0) {
        console.log(`\n[history]    Time series (polled_at | rt_age_s | miss_trips | miss_stops | inactive_svc)`);
        for (const ts of eventEntry.time_series) {
          const age = ts.rt_age_seconds != null ? String(ts.rt_age_seconds).padStart(6) : "     ?";
          const mt = ts.missing_trip_id_count != null ? String(ts.missing_trip_id_count).padStart(10) : "      null";
          const ms = ts.missing_stop_id_count != null ? String(ts.missing_stop_id_count).padStart(10) : "      null";
          const is = ts.inactive_service_count != null ? String(ts.inactive_service_count).padStart(12) : "        null";
          const note = ts.note ? `  ← ${ts.note}` : "";
          console.log(`[history]      ${ts.polled_at} | ${age} | ${mt} | ${ms} | ${is}${note}`);
        }
      }

      console.log(`\n[history]    Summary: peak_miss_trips=${eventEntry.summary.peak_missing_trip_id_count}, peak_miss_stops=${eventEntry.summary.peak_missing_stop_id_count}, peak_inactive_svc=${eventEntry.summary.peak_inactive_service_count}`);
      console.log(`[history]             first_clean_poll=${eventEntry.summary.first_clean_poll_at ?? "(none)"}`);
      console.log(`[history]             first_mismatch_drop=${eventEntry.summary.first_mismatch_drop_at ?? "(none)"}`);
      console.log(`[history]             persisting_mismatches=${eventEntry.summary.persisting_mismatches}`);

      report.ingest_events.push(eventEntry);
    }

    // ── If no static ingest events but RT data exists, show RT log stats ────
    if (ingestRes.rows.length === 0 && rtCount > 0) {
      console.log("\n[history] No static ingest events in last 14d — showing RT poll overview:");
      const rtOverviewRes = await client.query(
        `SELECT
           MIN(polled_at) AS first_poll,
           MAX(polled_at) AS last_poll,
           COUNT(*)::int AS total_polls,
           AVG(rt_age_seconds)::int AS avg_age_s,
           MIN(rt_age_seconds) AS min_age_s,
           MAX(rt_age_seconds) AS max_age_s,
           SUM(tripupdate_count)::bigint AS total_tripupdates
         FROM public.gtfs_rt_poll_log
         WHERE polled_at >= $1`,
        [since]
      );
      const ov = rtOverviewRes.rows[0];
      report.meta.rt_poll_overview = ov;
      console.log(`[history]   first_poll=${fmtTs(ov?.first_poll)}`);
      console.log(`[history]   last_poll=${fmtTs(ov?.last_poll)}`);
      console.log(`[history]   total_polls=${ov?.total_polls}`);
      console.log(`[history]   avg_age_s=${ov?.avg_age_s}  min=${ov?.min_age_s}  max=${ov?.max_age_s}`);
    }

    // ── Cross-event summary ──────────────────────────────────────────────────
    if (report.ingest_events.length > 0) {
      const withMismatch = report.ingest_events.filter(
        (ev) => ev.summary.polls_with_any_mismatch > 0
      );
      const withPersisting = report.ingest_events.filter(
        (ev) => ev.summary.persisting_mismatches
      );
      console.log("\n╔══════════════════════════════════════════════════════╗");
      console.log("║        HISTORICAL ALIGNMENT — CROSS-EVENT SUMMARY    ║");
      console.log("╚══════════════════════════════════════════════════════╝");
      console.log(`  Static ingest events found:          ${report.ingest_events.length}`);
      console.log(`  Events with ≥1 mismatched RT poll:   ${withMismatch.length}`);
      console.log(`  Events with PERSISTING mismatches:   ${withPersisting.length}`);
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n[history] Report saved → ${OUTPUT_PATH}`);
    return report;
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("[history] FATAL:", err?.stack || err?.message || err);
  process.exit(1);
});
