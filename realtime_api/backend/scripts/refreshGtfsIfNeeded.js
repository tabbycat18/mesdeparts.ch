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
const GTFS_REFRESH_LOCK_ID = 7_483_920;
const META_KEYS = Object.freeze({
  staticEtag: "gtfs_static_etag",
  staticLastModified: "gtfs_static_last_modified",
  staticSha256: "gtfs_static_sha256",
  currentFeedVersion: "gtfs_current_feed_version",
  staticCheckedAt: "gtfs_static_checked_at",
  stopSearchRebuildRequested: "gtfs_stop_search_rebuild_requested",
  stopSearchLastRebuildSha256: "gtfs_stop_search_last_rebuild_sha256",
  stopSearchLastRebuildAt: "gtfs_stop_search_last_rebuild_at",
});
const STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS = Math.max(
  1,
  Number(process.env.GTFS_STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS || "6")
);
const STOP_SEARCH_REBUILD_MIN_INTERVAL_MS =
  STOP_SEARCH_REBUILD_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
const REQUIRED_FILES = [
  "agency.txt",
  "stops.txt",
  "routes.txt",
  "trips.txt",
  "stop_times.txt",
  "calendar.txt",
  "calendar_dates.txt",
];
const CUTOVER_OLD_TABLES = [
  "gtfs_agency_old",
  "gtfs_stops_old",
  "gtfs_routes_old",
  "gtfs_trips_old",
  "gtfs_calendar_old",
  "gtfs_calendar_dates_old",
  "gtfs_stop_times_old",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SQL_DIR = path.resolve(__dirname, "../sql");

function redactSecrets(value) {
  let text = String(value ?? "");
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    text = text.split(dbUrl).join("[redacted:DATABASE_URL]");
  }
  text = text.replace(
    /\bpostgres(?:ql)?:\/\/([^:\s]+):([^@\s]+)@/gi,
    "postgresql://$1:[redacted]@"
  );
  return text;
}

function logSafe(level, prefix, payload) {
  const line = `${prefix}${payload == null ? "" : redactSecrets(payload)}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function attachClientErrorLog(client, label) {
  client.on("error", (err) => {
    logSafe("error", `[pg] unexpected error event on ${label}: `, err?.message || err);
  });
}

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
  try {
    await runCommand("psql", [env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", sqlFile]);
  } catch (err) {
    const message = redactSecrets(err?.message || String(err));
    throw new Error(`[refresh][sql] ${path.basename(sqlFile)} failed (psql ON_ERROR_STOP=1): ${message}`);
  }
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

function isTrueLike(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseIsoMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function buildStopSearchRebuildDecision({
  requested = false,
  currentSha256 = null,
  lastRebuildSha256 = null,
  lastRebuildAt = null,
  nowMs = Date.now(),
} = {}) {
  if (!currentSha256 && !requested) {
    return { shouldRebuild: false, reason: "missing_sha" };
  }

  const sameSha =
    !!currentSha256 &&
    !!lastRebuildSha256 &&
    String(currentSha256).trim() === String(lastRebuildSha256).trim();
  const lastRebuildAtMs = parseIsoMs(lastRebuildAt);
  const rebuiltRecently =
    sameSha &&
    Number.isFinite(lastRebuildAtMs) &&
    nowMs - lastRebuildAtMs < STOP_SEARCH_REBUILD_MIN_INTERVAL_MS;

  if (requested) {
    if (rebuiltRecently) {
      return { shouldRebuild: false, reason: "requested_but_rate_limited" };
    }
    return { shouldRebuild: true, reason: "requested" };
  }

  if (!sameSha) {
    return { shouldRebuild: true, reason: "sha_changed" };
  }

  return { shouldRebuild: false, reason: rebuiltRecently ? "same_sha_rate_limited" : "same_sha_already_built" };
}

export async function tryAcquireSessionAdvisoryLock(client, lockId) {
  const lockResult = await client.query(`SELECT pg_try_advisory_lock($1) AS acquired`, [lockId]);
  return lockResult.rows[0]?.acquired === true;
}

async function importIntoStage(cleanDir, env) {
  await runSqlFile(path.join(SQL_DIR, "create_stage_tables.sql"), env);
  await runCommand(path.resolve(__dirname, "importGtfsToStage.sh"), [cleanDir], {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  await runSqlFile(path.join(SQL_DIR, "validate_stage.sql"), env);
  await runSqlFile(path.join(SQL_DIR, "swap_stage_to_live_cutover.sql"), env);
}

async function runStopSearchSetup(env) {
  // optimize_stop_search.sql is fatal: any SQL error must surface and fail the workflow.
  await runSqlFile(path.join(SQL_DIR, "optimize_stop_search.sql"), env);
  console.log("[refresh][search-setup] optimize_stop_search.sql: ok");

  // syncStopSearchAliases is non-fatal
  try {
    await runCommand("node", [path.resolve(__dirname, "syncStopSearchAliases.js")], {
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    });
    console.log("[refresh][search-setup] syncStopSearchAliases.js: ok");
  } catch (err) {
    logSafe("warn", "[refresh][search-setup] syncStopSearchAliases.js failed (non-fatal): ", err?.message || err);
  }
}

async function cleanupOldAfterSwap(env) {
  try {
    await runSqlFile(path.join(SQL_DIR, "cleanup_old_after_swap.sql"), env);
    return { status: "ok", step: "cleanup_old_after_swap.sql" };
  } catch (err) {
    logSafe("warn", "[refresh] cleanup_old_after_swap.sql failed (non-fatal): ", err?.message || err);
    return {
      status: "failed",
      step: "cleanup_old_after_swap.sql",
      error: redactSecrets(String(err?.message || err)),
    };
  }
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
    logSafe("warn", "[refresh] HEAD check failed (network?); will proceed with download: ", err?.message || err);
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

async function findExistingOldGtfsTables(client) {
  const result = await client.query(
    `
      SELECT t.table_name
      FROM unnest($1::text[]) AS t(table_name)
      WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
      ORDER BY t.table_name
    `,
    [CUTOVER_OLD_TABLES]
  );
  return result.rows.map((row) => row.table_name);
}

async function logCutoverPreflight(client) {
  const oldTables = await findExistingOldGtfsTables(client);
  if (oldTables.length === 0) {
    console.log("[refresh][preflight] No leftover *_old GTFS tables detected.");
    return;
  }

  console.warn(
    `[refresh][preflight] Found leftover *_old GTFS tables: ${oldTables.join(", ")}. ` +
      "Cutover remains safe on rerun: swap_stage_to_live_cutover.sql drops stale *_old tables before live→old renames."
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function runRefreshGtfsIfNeeded() {
  const DATABASE_URL = requireEnv("DATABASE_URL");
  const OPENTDATA_GTFS_RT_KEY = process.env.OPENTDATA_GTFS_RT_KEY ?? "";
  const OPENTDATA_GTFS_SA_KEY = process.env.OPENTDATA_GTFS_SA_KEY ?? "";
  const nowIso = new Date().toISOString();

  // ── Step 1: HEAD check — free, unauthenticated, zero rate-limit impact ──────
  const { etag, lastModified } = await getStaticVersionHeaders();
  console.log(
    `[refresh] HEAD ${STATIC_PERMALINK}: etag=${etag ?? "(none)"}, last-modified=${lastModified ?? "(none)"}`
  );

  // ── Step 2a: Connect for initial DB checks only ─────────────────────────────
  // Do NOT keep this connection open during file operations (download/unzip/clean).
  console.log("[pg] connecting for initial checks…");
  const checkClient = new Client({ connectionString: DATABASE_URL });
  attachClientErrorLog(checkClient, "checkClient");
  await checkClient.connect();
  console.log("[pg] connected");

  try {
    await ensureAlignmentAuditTables(checkClient);

    const dbEmpty = await isGtfsLiveEmpty(checkClient);
    if (dbEmpty) {
      console.log("[refresh] Live GTFS tables are empty/missing — forcing full import regardless of version markers.");
    }

    const stored = await getMetaKvMulti(checkClient, [
      META_KEYS.staticEtag,
      META_KEYS.staticLastModified,
      META_KEYS.staticSha256,
      META_KEYS.currentFeedVersion,
      META_KEYS.stopSearchRebuildRequested,
      META_KEYS.stopSearchLastRebuildSha256,
      META_KEYS.stopSearchLastRebuildAt,
    ]);
    const storedSha256 = stored[META_KEYS.staticSha256] ?? null;
    const stopSearchRebuildRequested = isTrueLike(stored[META_KEYS.stopSearchRebuildRequested]);

    // ── Step 2b: ETag / Last-Modified comparison ────────────────────────────
    // Normalize stored ETag to match the same format as the live header value.
    const storedEtag = normalizeEtag(stored[META_KEYS.staticEtag]);
    const storedLastMod = stored[META_KEYS.staticLastModified] ?? null;

    const etagMatch = etag !== null && etag === storedEtag;
    const lastModMatch = etag === null && lastModified !== null && lastModified === storedLastMod;
    const headersMatch = !dbEmpty && (etagMatch || lastModMatch);

    if (headersMatch) {
      const rebuildDecision = buildStopSearchRebuildDecision({
        requested: stopSearchRebuildRequested,
        currentSha256: storedSha256,
        lastRebuildSha256: stored[META_KEYS.stopSearchLastRebuildSha256] ?? null,
        lastRebuildAt: stored[META_KEYS.stopSearchLastRebuildAt] ?? null,
      });
      if (!rebuildDecision.shouldRebuild) {
        console.log(
          `[refresh] Static GTFS unchanged (headers match). skip_import=1, skip_stop_search=1 (${rebuildDecision.reason}).`
        );
        await setMetaKv(checkClient, META_KEYS.staticCheckedAt, nowIso);
        return;
      }
      console.log(
        `[refresh] Static headers unchanged but stop_search rebuild requested (${rebuildDecision.reason}). import=0 rebuild=1.`
      );
      await checkClient.end();

      const dbClient = new Client({ connectionString: DATABASE_URL });
      attachClientErrorLog(dbClient, "dbClient");
      await dbClient.connect();
      try {
        const acquired = await tryAcquireSessionAdvisoryLock(dbClient, GTFS_REFRESH_LOCK_ID);
        if (!acquired) {
          console.log("[refresh] refresh already running; exiting without import/rebuild.");
          return;
        }
        console.log("[refresh] Advisory lock acquired.");

        const lockedMeta = await getMetaKvMulti(dbClient, [
          META_KEYS.staticSha256,
          META_KEYS.stopSearchRebuildRequested,
          META_KEYS.stopSearchLastRebuildSha256,
          META_KEYS.stopSearchLastRebuildAt,
        ]);
        const lockedDecision = buildStopSearchRebuildDecision({
          requested: isTrueLike(lockedMeta[META_KEYS.stopSearchRebuildRequested]),
          currentSha256: lockedMeta[META_KEYS.staticSha256] ?? storedSha256,
          lastRebuildSha256: lockedMeta[META_KEYS.stopSearchLastRebuildSha256] ?? null,
          lastRebuildAt: lockedMeta[META_KEYS.stopSearchLastRebuildAt] ?? null,
        });
        if (!lockedDecision.shouldRebuild) {
          console.log(
            `[refresh] stop_search rebuild skipped after lock (${lockedDecision.reason}); nothing else to do.`
          );
          await setMetaKv(dbClient, META_KEYS.staticCheckedAt, nowIso);
          return;
        }

        await runStopSearchSetup({ DATABASE_URL });
        const rebuildSha = lockedMeta[META_KEYS.staticSha256] ?? storedSha256;
        if (rebuildSha) {
          await setMetaKv(dbClient, META_KEYS.stopSearchLastRebuildSha256, rebuildSha);
        }
        await setMetaKv(dbClient, META_KEYS.stopSearchLastRebuildAt, new Date().toISOString());
        await setMetaKv(dbClient, META_KEYS.stopSearchRebuildRequested, "0");
        await setMetaKv(dbClient, META_KEYS.staticCheckedAt, nowIso);
      } finally {
        console.log("[pg] closing connection…");
        await dbClient.end();
        console.log("[pg] closed");
      }
      return;
    }

    // ── Step 3: Download zip for SHA preflight ──────────────────────────────
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gtfs-refresh-"));
    const zipPath = path.join(tempRoot, "static_gtfs.zip");
    const unzipDir = path.join(tempRoot, "unzipped");
    const cleanDir = path.join(tempRoot, "clean");
    let shouldImport = dbEmpty;

    await fsp.mkdir(unzipDir, { recursive: true });

    // Close the check connection BEFORE doing long-running file ops.
    console.log("[pg] closing connection before file operations…");
    await checkClient.end();
    console.log("[pg] closed");

    console.log(`[refresh] downloading static GTFS zip to ${zipPath}`);
    const downloadStart = Date.now();
    await downloadStaticZip(zipPath);
    const downloadTime = Date.now() - downloadStart;
    console.log(`[refresh] download completed in ${downloadTime}ms`);

    // ── Step 4: SHA-256 guard — skip import if content identical ───────────
    const zipSha256 = await computeFileSha256(zipPath);
    console.log(
      `[refresh] zip sha256=${zipSha256.slice(0, 16)}… (stored=${storedSha256?.slice(0, 16) ?? "none"})`
    );
    shouldImport = dbEmpty || zipSha256 !== storedSha256;
    const preflightRebuildDecision = buildStopSearchRebuildDecision({
      requested: stopSearchRebuildRequested,
      currentSha256: zipSha256,
      lastRebuildSha256: stored[META_KEYS.stopSearchLastRebuildSha256] ?? null,
      lastRebuildAt: stored[META_KEYS.stopSearchLastRebuildAt] ?? null,
    });

    if (!shouldImport && !preflightRebuildDecision.shouldRebuild) {
      console.log(
        `[refresh] static zip unchanged; skip_import=1 skip_stop_search=1 (${preflightRebuildDecision.reason}).`
      );
      // Reconnect for the metadata-only updates
      console.log("[pg] reconnecting for metadata-only update…");
      const updateClient = new Client({ connectionString: DATABASE_URL });
      attachClientErrorLog(updateClient, "updateClient");
      await updateClient.connect();
      console.log("[pg] connected");
      try {
        if (etag) await setMetaKv(updateClient, META_KEYS.staticEtag, etag);
        if (lastModified) await setMetaKv(updateClient, META_KEYS.staticLastModified, lastModified);
        await setMetaKv(updateClient, META_KEYS.staticCheckedAt, nowIso);
      } finally {
        console.log("[pg] closing connection…");
        await updateClient.end();
        console.log("[pg] closed");
      }
      return;
    }

    if (shouldImport) {
      // ── Step 5a: Unzip and clean files (disconnected) ────────────────────
      console.log("[refresh] unzipping static GTFS zip");
      const unzipStart = Date.now();
      await unzipToDir(zipPath, unzipDir);
      const unzipTime = Date.now() - unzipStart;
      console.log(`[refresh] unzip completed in ${unzipTime}ms`);

      console.log("[refresh] cleaning required GTFS files");
      const cleanStart = Date.now();
      await buildCleanGtfsFiles(unzipDir, cleanDir);
      const cleanTime = Date.now() - cleanStart;
      console.log(`[refresh] clean completed in ${cleanTime}ms`);
    }

    // ── Step 5b: Reconnect and acquire advisory lock ────────────────────────
    // Lock is held ONLY for the duration of DB mutations.
    console.log("[pg] reconnecting for database operations…");
    const dbClient = new Client({ connectionString: DATABASE_URL });
    attachClientErrorLog(dbClient, "dbClient");
    await dbClient.connect();
    console.log("[pg] connected");

    try {
      const acquired = await tryAcquireSessionAdvisoryLock(dbClient, GTFS_REFRESH_LOCK_ID);
      if (!acquired) {
        console.log("[refresh] refresh already running; exiting without import/rebuild.");
        return;
      }
      console.log("[refresh] Advisory lock acquired.");

      // ── Sanity check: ensure connection is still alive after lock acquire ────
      // (cheap defense against race conditions between lock and import)
      await dbClient.query("SELECT 1");
      const lockedMeta = await getMetaKvMulti(dbClient, [
        META_KEYS.staticSha256,
        META_KEYS.stopSearchRebuildRequested,
        META_KEYS.stopSearchLastRebuildSha256,
        META_KEYS.stopSearchLastRebuildAt,
      ]);
      const lockedRebuildDecision = buildStopSearchRebuildDecision({
        requested: isTrueLike(lockedMeta[META_KEYS.stopSearchRebuildRequested]),
        currentSha256: zipSha256,
        lastRebuildSha256: lockedMeta[META_KEYS.stopSearchLastRebuildSha256] ?? null,
        lastRebuildAt: lockedMeta[META_KEYS.stopSearchLastRebuildAt] ?? null,
      });

      if (shouldImport) {
        await logCutoverPreflight(dbClient);
        console.log("[refresh] importing cleaned GTFS into stage/live tables");
        await importIntoStage(cleanDir, { DATABASE_URL });
      } else {
        console.log("[refresh] import skipped (sha unchanged); lock held for optional stop_search rebuild only.");
      }

      if (lockedRebuildDecision.shouldRebuild) {
        console.log(`[refresh] running stop_search rebuild (${lockedRebuildDecision.reason}).`);
        await runStopSearchSetup({ DATABASE_URL });
        await setMetaKv(dbClient, META_KEYS.stopSearchLastRebuildSha256, zipSha256);
        await setMetaKv(dbClient, META_KEYS.stopSearchLastRebuildAt, new Date().toISOString());
        await setMetaKv(dbClient, META_KEYS.stopSearchRebuildRequested, "0");
      } else {
        console.log(`[refresh] stop_search rebuild skipped (${lockedRebuildDecision.reason}).`);
      }

      if (shouldImport) {
        const cleanupResult = await cleanupOldAfterSwap({ DATABASE_URL });
        console.log(`[refresh] cleanup result: ${JSON.stringify(cleanupResult)}`);
      }

      // ── Step 6: Fetch RT / SA meta — only after static import ──────────────
      let tripMeta = null;
      let alertsMeta = null;
      if (shouldImport && OPENTDATA_GTFS_RT_KEY) {
        try {
          tripMeta = await fetchTripUpdatesMeta(OPENTDATA_GTFS_RT_KEY);
        } catch (err) {
          logSafe("warn", "[refresh] Could not fetch trip-updates meta (non-fatal): ", err?.message || err);
        }
      }
      if (shouldImport && OPENTDATA_GTFS_SA_KEY) {
        try {
          alertsMeta = await fetchServiceAlertsMeta(OPENTDATA_GTFS_SA_KEY);
        } catch (err) {
          logSafe("warn", "[refresh] Could not fetch service-alerts meta (non-fatal): ", err?.message || err);
        }
      }

      // ── Step 7: Persist version markers ────────────────────────────────────
      if (etag) await setMetaKv(dbClient, META_KEYS.staticEtag, etag);
      if (lastModified) await setMetaKv(dbClient, META_KEYS.staticLastModified, lastModified);
      await setMetaKv(dbClient, META_KEYS.staticCheckedAt, nowIso);
      await setMetaKv(dbClient, META_KEYS.staticSha256, zipSha256);

      // Keep gtfs_current_feed_version: use RT version if available, else sha256 prefix.
      const newVersion = tripMeta?.feedVersion || zipSha256.slice(0, 16);
      await setMetaKv(dbClient, META_KEYS.currentFeedVersion, newVersion);

      if (shouldImport && tripMeta) {
        await upsertFeedMeta(dbClient, "trip_updates", tripMeta.feedVersion, tripMeta.headerTimestamp);
      }
      if (shouldImport && alertsMeta) {
        await upsertFeedMeta(
          dbClient,
          "service_alerts",
          tripMeta?.feedVersion ?? newVersion,
          alertsMeta.headerTimestamp
        );
      }

      // ── Step 8: Log static ingest for alignment auditing ───────────────────
      if (shouldImport) {
        try {
          const snap = await fetchCurrentStaticSnapshot(dbClient);
          await insertStaticIngestLog(dbClient, {
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
          console.log("[refresh] logged static ingest to gtfs_static_ingest_log");
        } catch (logErr) {
          logSafe("warn", "[refresh] non-fatal: failed to log static ingest: ", logErr?.message || logErr);
        }
      }

      console.log(
        `[refresh] completed: import=${shouldImport ? 1 : 0}, version=${newVersion}, sha256=${zipSha256.slice(0, 16)}…`
      );
    } finally {
      console.log("[pg] closing connection…");
      await dbClient.end();
      console.log("[pg] closed");
    }
  } catch (err) {
    logSafe("error", "[refresh] unhandled error: ", err?.stack || err?.message || err);
    throw err;
  } finally {
    // Ensure checkClient is closed if we took an early-exit path.
    try {
      await checkClient.end();
    } catch {
      // Already closed or closing, ignore
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRefreshGtfsIfNeeded().catch((error) => {
    logSafe("error", "", error?.stack || error?.message || error);
    process.exit(1);
  });
}
