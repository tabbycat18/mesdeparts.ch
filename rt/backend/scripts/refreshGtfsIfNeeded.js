process.setMaxListeners(50);

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { parse as parseCsvLine } from "csv-parse/sync";
import { stringify as stringifyCsvLine } from "csv-stringify/sync";
import { Client } from "pg";

import { fetchTripUpdatesMeta } from "./getRtFeedVersion.js";
import { fetchServiceAlertsMeta } from "./fetchAlertsFeedMeta.js";
import {
  ensureAlignmentAuditTables,
  insertStaticIngestLog,
  fetchCurrentStaticSnapshot,
} from "../src/audit/alignmentLogs.js";

const STATIC_PERMALINK = "https://data.opentransportdata.swiss/fr/dataset/timetable-2026-gtfs2020/permalink";
// Stable integer used as a PostgreSQL session-level advisory lock key.
// Any concurrent caller (CI, manual, local) that cannot acquire this lock will
// exit cleanly rather than racing against an in-progress import.
const GTFS_IMPORT_LOCK_ID = 7_483_920;
const REQUIRED_FILES = [
  "agency.txt",
  "stops.txt",
  "routes.txt",
  "trips.txt",
  "stop_times.txt",
  "calendar.txt",
  "calendar_dates.txt",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SQL_DIR = path.resolve(__dirname, "../sql");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function downloadStaticZip(targetPath) {
  const response = await fetch(STATIC_PERMALINK, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download static GTFS zip: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Static GTFS download returned an empty body");
  }

  const file = fs.createWriteStream(targetPath);
  const nodeReadable = Readable.fromWeb(response.body);
  await new Promise((resolve, reject) => {
    nodeReadable.pipe(file);
    nodeReadable.on("error", reject);
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

async function unzipToDir(zipPath, outDir) {
  await runCommand("unzip", ["-q", zipPath, "-d", outDir]);
}

async function findFileRecursively(rootDir, fileName) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFileRecursively(fullPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function parseSingleCsvRecord(rawLine) {
  const records = parseCsvLine(rawLine, {
    bom: true,
    relax_quotes: true,
    skip_empty_lines: false,
  });
  if (records.length !== 1) {
    throw new Error("Expected one CSV record per line");
  }
  return records[0];
}

async function cleanCsvFile(inputPath, outputPath, rejectPath) {
  const inStream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });

  const outStream = fs.createWriteStream(outputPath, { encoding: "utf8" });
  const rejectStream = fs.createWriteStream(rejectPath, { encoding: "utf8" });

  let header = null;
  let lineNumber = 0;
  let rejected = 0;

  for await (const line of rl) {
    lineNumber += 1;

    if (line.trim() === "") {
      continue;
    }

    if (!header) {
      header = parseSingleCsvRecord(line);
      outStream.write(stringifyCsvLine([header], { header: false }));
      continue;
    }

    try {
      const row = parseSingleCsvRecord(line);
      if (row.length !== header.length) {
        throw new Error(`Column mismatch at line ${lineNumber}`);
      }
      outStream.write(stringifyCsvLine([row], { header: false }));
    } catch {
      rejected += 1;
      rejectStream.write(`${line}\n`);
    }
  }

  await Promise.all([
    new Promise((resolve) => outStream.end(resolve)),
    new Promise((resolve) => rejectStream.end(resolve)),
  ]);

  if (!header) {
    throw new Error(`Missing CSV header in file: ${inputPath}`);
  }

  return { rejected };
}

async function buildCleanGtfsFiles(unzipDir, cleanDir) {
  await fsp.mkdir(cleanDir, { recursive: true });

  for (const fileName of REQUIRED_FILES) {
    const source = await findFileRecursively(unzipDir, fileName);
    if (!source) {
      throw new Error(`Required GTFS file not found in zip: ${fileName}`);
    }

    const outPath = path.join(cleanDir, fileName);
    const rejectPath = path.join(cleanDir, `${fileName}.rejects.txt`);
    const { rejected } = await cleanCsvFile(source, outPath, rejectPath);
    if (rejected > 0) {
      console.warn(`[clean] ${fileName}: rejected ${rejected} rows`);
    }
  }
}

async function runSqlFile(sqlFile, env) {
  await runCommand("psql", [env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", sqlFile]);
}

function toPgTimestampValue(headerTimestamp) {
  if (headerTimestamp == null) {
    return null;
  }

  if (headerTimestamp instanceof Date) {
    return headerTimestamp;
  }

  if (typeof headerTimestamp === "number") {
    // GTFS-RT protobuf header timestamps are epoch seconds.
    return new Date(headerTimestamp * 1000);
  }

  const parsed = new Date(headerTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function upsertFeedMeta(client, feedName, feedVersion, headerTimestamp) {
  const headerTimestampValue = toPgTimestampValue(headerTimestamp);
  await client.query(
    `
      INSERT INTO public.rt_feed_meta (feed_name, feed_version, header_timestamp, fetched_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (feed_name)
      DO UPDATE SET
        feed_version = EXCLUDED.feed_version,
        header_timestamp = EXCLUDED.header_timestamp,
        fetched_at = NOW(),
        updated_at = NOW()
    `,
    [feedName, feedVersion, headerTimestampValue]
  );
}

async function setMetaKv(client, key, value) {
  await client.query(
    `
      INSERT INTO public.meta_kv (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, value]
  );
}

async function getMetaKvMulti(client, keys) {
  const result = await client.query(
    `SELECT key, value FROM public.meta_kv WHERE key = ANY($1)`,
    [keys]
  );
  const out = {};
  for (const row of result.rows) out[row.key] = row.value;
  return out;
}

async function importIntoStage(cleanDir, env) {
  await runSqlFile(path.join(SQL_DIR, "create_stage_tables.sql"), env);
  await runCommand(path.resolve(__dirname, "importGtfsToStage.sh"), [cleanDir], {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  await runSqlFile(path.join(SQL_DIR, "validate_stage.sql"), env);
  await runSqlFile(path.join(SQL_DIR, "swap_stage_to_live.sql"), env);
}

async function runStopSearchSetup(env) {
  const report = {
    status: "success",
    degraded: false,
    steps: [],
    errors: [],
  };

  try {
    await runSqlFile(path.join(SQL_DIR, "optimize_stop_search.sql"), env);
    report.steps.push({ step: "optimize_stop_search.sql", status: "ok" });
  } catch (err) {
    report.steps.push({ step: "optimize_stop_search.sql", status: "failed" });
    report.errors.push({
      step: "optimize_stop_search.sql",
      error: String(err?.message || err),
    });
  }

  try {
    await runCommand("node", [path.resolve(__dirname, "syncStopSearchAliases.js")], {
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    });
    report.steps.push({ step: "syncStopSearchAliases.js", status: "ok" });
  } catch (err) {
    report.steps.push({ step: "syncStopSearchAliases.js", status: "failed" });
    report.errors.push({
      step: "syncStopSearchAliases.js",
      error: String(err?.message || err),
    });
  }

  report.degraded = report.errors.length > 0;
  if (report.degraded) {
    report.status = "success_with_degraded_search";
  }

  console.log(`[refresh][search-setup] ${JSON.stringify(report)}`);
  return report;
}

// ── Static version helpers ────────────────────────────────────────────────────

/**
 * Normalize an ETag value for stable comparison:
 *   - Strip weak prefix  W/"..."  →  "..."
 *   - Strip surrounding double-quotes
 *   - Return null for empty/missing values
 */
function normalizeEtag(raw) {
  if (!raw) return null;
  let s = raw.startsWith("W/") ? raw.slice(2) : raw;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s || null;
}

/**
 * HEAD request to STATIC_PERMALINK — unauthenticated, no rate limit.
 * Returns { etag, lastModified }; fields are null if the server omits them.
 * ETag is normalized (weak prefix and quotes stripped).
 */
async function getStaticVersionHeaders() {
  try {
    const response = await fetch(STATIC_PERMALINK, { method: "HEAD", redirect: "follow" });
    return {
      etag: normalizeEtag(response.headers.get("etag")),
      lastModified: response.headers.get("last-modified") ?? null,
    };
  } catch (err) {
    console.warn("[refresh] HEAD check failed (network?); will proceed with download:", err?.message || err);
    return { etag: null, lastModified: null };
  }
}

/** SHA-256 of an on-disk file. */
async function computeFileSha256(filePath) {
  const data = await fsp.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Returns true if the live GTFS tables are absent or empty.
 * Used to bypass version-header gating on a fresh DB so the first run always imports.
 */
async function isGtfsLiveEmpty(client) {
  try {
    const exists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'gtfs_stops'
       ) AS table_exists`
    );
    if (!exists.rows[0].table_exists) return true;
    const count = await client.query(`SELECT COUNT(*) FROM public.gtfs_stops`);
    return parseInt(count.rows[0].count, 10) === 0;
  } catch {
    return true; // treat errors as empty → force import
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  const DATABASE_URL = requireEnv("DATABASE_URL");
  const OPENTDATA_GTFS_RT_KEY = process.env.OPENTDATA_GTFS_RT_KEY ?? "";
  const OPENTDATA_GTFS_SA_KEY = process.env.OPENTDATA_GTFS_SA_KEY ?? "";

  // ── Step 1: HEAD check — free, unauthenticated, zero rate-limit impact ──────
  const { etag, lastModified } = await getStaticVersionHeaders();
  console.log(
    `[refresh] HEAD ${STATIC_PERMALINK}: etag=${etag ?? "(none)"}, last-modified=${lastModified ?? "(none)"}`
  );

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureAlignmentAuditTables(client);

    const dbEmpty = await isGtfsLiveEmpty(client);
    if (dbEmpty) {
      console.log("[refresh] Live GTFS tables are empty/missing — forcing full import regardless of version markers.");
    }

    const stored = await getMetaKvMulti(client, [
      "gtfs_static_etag",
      "gtfs_static_last_modified",
      "gtfs_static_sha256",
      "gtfs_current_feed_version",
    ]);

    // ── Step 2: ETag / Last-Modified comparison ─────────────────────────────
    // Normalize stored ETag to match the same format as the live header value.
    const storedEtag = normalizeEtag(stored["gtfs_static_etag"]);
    const storedLastMod = stored["gtfs_static_last_modified"] ?? null;

    const etagMatch = etag !== null && etag === storedEtag;
    const lastModMatch = etag === null && lastModified !== null && lastModified === storedLastMod;

    if (!dbEmpty && (etagMatch || lastModMatch)) {
      console.log("[refresh] Static GTFS unchanged (ETag/Last-Modified match). No update needed.");
      await setMetaKv(client, "gtfs_static_checked_at", new Date().toISOString());
      await runStopSearchSetup({ DATABASE_URL });
      return;
    }

    // ── Step 3: Download zip ────────────────────────────────────────────────
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gtfs-refresh-"));
    const zipPath = path.join(tempRoot, "static_gtfs.zip");
    const unzipDir = path.join(tempRoot, "unzipped");
    const cleanDir = path.join(tempRoot, "clean");

    await fsp.mkdir(unzipDir, { recursive: true });

    console.log(`[refresh] downloading static GTFS zip to ${zipPath}`);
    await downloadStaticZip(zipPath);

    // ── Step 4: SHA-256 guard — skip import if content identical ───────────
    const zipSha256 = await computeFileSha256(zipPath);
    const storedSha256 = stored["gtfs_static_sha256"] ?? null;
    console.log(
      `[refresh] zip sha256=${zipSha256.slice(0, 16)}… (stored=${storedSha256?.slice(0, 16) ?? "none"})`
    );

    if (!dbEmpty && zipSha256 === storedSha256) {
      console.log("[refresh] Zip content unchanged (sha256 match). Refreshing markers only.");
      if (etag) await setMetaKv(client, "gtfs_static_etag", etag);
      if (lastModified) await setMetaKv(client, "gtfs_static_last_modified", lastModified);
      await setMetaKv(client, "gtfs_static_checked_at", new Date().toISOString());
      await runStopSearchSetup({ DATABASE_URL });
      return;
    }

    // ── Step 5a: Acquire advisory lock ─────────────────────────────────────
    // pg_try_advisory_lock is session-scoped and released on client.end().
    // Using try-variant so concurrent callers skip rather than queue.
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [GTFS_IMPORT_LOCK_ID]
    );
    if (!lockResult.rows[0].acquired) {
      console.log("[refresh] Advisory lock not available — another import is already in progress. Skipping.");
      return;
    }
    console.log("[refresh] Advisory lock acquired.");

    // ── Step 5b: Full import ────────────────────────────────────────────────
    console.log("[refresh] unzipping static GTFS zip");
    await unzipToDir(zipPath, unzipDir);

    console.log("[refresh] cleaning required GTFS files");
    await buildCleanGtfsFiles(unzipDir, cleanDir);

    console.log("[refresh] importing cleaned GTFS into stage/live tables");
    await importIntoStage(cleanDir, { DATABASE_URL });
    await runStopSearchSetup({ DATABASE_URL });

    // ── Step 6: Fetch RT / SA meta — ONLY now, only for logging ────────────
    let tripMeta = null;
    let alertsMeta = null;
    if (OPENTDATA_GTFS_RT_KEY) {
      try {
        tripMeta = await fetchTripUpdatesMeta(OPENTDATA_GTFS_RT_KEY);
      } catch (err) {
        console.warn("[refresh] Could not fetch trip-updates meta (non-fatal):", err?.message || err);
      }
    }
    if (OPENTDATA_GTFS_SA_KEY) {
      try {
        alertsMeta = await fetchServiceAlertsMeta(OPENTDATA_GTFS_SA_KEY);
      } catch (err) {
        console.warn("[refresh] Could not fetch service-alerts meta (non-fatal):", err?.message || err);
      }
    }

    // ── Step 7: Persist version markers ────────────────────────────────────
    if (etag) await setMetaKv(client, "gtfs_static_etag", etag);
    if (lastModified) await setMetaKv(client, "gtfs_static_last_modified", lastModified);
    await setMetaKv(client, "gtfs_static_sha256", zipSha256);

    // Keep gtfs_current_feed_version: use RT version if available, else sha256 prefix.
    const newVersion = tripMeta?.feedVersion || zipSha256.slice(0, 16);
    await setMetaKv(client, "gtfs_current_feed_version", newVersion);

    if (tripMeta) {
      await upsertFeedMeta(client, "trip_updates", tripMeta.feedVersion, tripMeta.headerTimestamp);
    }
    if (alertsMeta) {
      await upsertFeedMeta(
        client,
        "service_alerts",
        tripMeta?.feedVersion ?? newVersion,
        alertsMeta.headerTimestamp
      );
    }

    // ── Step 8: Log static ingest for alignment auditing ───────────────────
    try {
      const snap = await fetchCurrentStaticSnapshot(client);
      await insertStaticIngestLog(client, {
        feedName: "opentransportdata_gtfs_static",
        feedVersion: newVersion,
        startDate: snap?.start_date || null,
        endDate: snap?.end_date || null,
        stopsCount: snap?.stops_count || null,
        routesCount: snap?.routes_count || null,
        tripsCount: snap?.trips_count || null,
        stopTimesCount: snap?.stop_times_count || null,
        notes: `refreshGtfsIfNeeded: sha256=${zipSha256.slice(0, 16)}, etag=${etag ?? "none"}`,
      });
      console.log(`[refresh] logged static ingest to gtfs_static_ingest_log`);
    } catch (logErr) {
      console.warn(`[refresh] non-fatal: failed to log static ingest:`, logErr?.message || logErr);
    }

    console.log(`[refresh] completed: version=${newVersion}, sha256=${zipSha256.slice(0, 16)}…`);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
