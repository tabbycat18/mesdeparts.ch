import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { parse as parseCsvLine } from "csv-parse/sync";
import { stringify as stringifyCsvLine } from "csv-stringify/sync";
import { Client } from "pg";

import { fetchTripUpdatesMeta } from "./getRtFeedVersion.js";
import { fetchServiceAlertsMeta } from "./fetchAlertsFeedMeta.js";

const STATIC_PERMALINK = "https://data.opentransportdata.swiss/fr/dataset/timetable-2026-gtfs2020/permalink";
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

async function getDbFeedVersion(client) {
  const result = await client.query(
    `
      SELECT value
      FROM public.meta_kv
      WHERE key = 'gtfs_current_feed_version'
      LIMIT 1
    `
  );

  return result.rows[0]?.value || "";
}

async function setDbFeedVersion(client, version) {
  await client.query(
    `
      INSERT INTO public.meta_kv (key, value, updated_at)
      VALUES ('gtfs_current_feed_version', $1, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [version]
  );
}

async function importIntoStage(cleanDir, env) {
  await runSqlFile(path.join(SQL_DIR, "create_stage_tables.sql"), env);
  await runCommand(path.resolve(__dirname, "importGtfsToStage.sh"), [cleanDir], {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  await runSqlFile(path.join(SQL_DIR, "validate_stage.sql"), env);
  await runSqlFile(path.join(SQL_DIR, "swap_stage_to_live.sql"), env);
}

async function run() {
  const DATABASE_URL = requireEnv("DATABASE_URL");
  const OPENTDATA_GTFS_RT_KEY = requireEnv("OPENTDATA_GTFS_RT_KEY");
  const OPENTDATA_GTFS_SA_KEY = requireEnv("OPENTDATA_GTFS_SA_KEY");

  // exactly one /la/gtfs-rt request and one /la/gtfs-sa request per run
  const tripMeta = await fetchTripUpdatesMeta(OPENTDATA_GTFS_RT_KEY);
  const alertsMeta = await fetchServiceAlertsMeta(OPENTDATA_GTFS_SA_KEY);

  const rtVersion = tripMeta.feedVersion;
  if (!rtVersion) {
    throw new Error("GTFS-RT feed_version is empty");
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const dbVersion = await getDbFeedVersion(client);

    if (dbVersion === rtVersion) {
      console.log("no update");
      await upsertFeedMeta(client, "service_alerts", rtVersion, alertsMeta.headerTimestamp);
      await upsertFeedMeta(client, "trip_updates", rtVersion, tripMeta.headerTimestamp);
      return;
    }

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gtfs-refresh-"));
    const zipPath = path.join(tempRoot, "static_gtfs.zip");
    const unzipDir = path.join(tempRoot, "unzipped");
    const cleanDir = path.join(tempRoot, "clean");

    await fsp.mkdir(unzipDir, { recursive: true });

    console.log(`[refresh] downloading static GTFS zip to ${zipPath}`);
    await downloadStaticZip(zipPath);

    console.log("[refresh] unzipping static GTFS zip");
    await unzipToDir(zipPath, unzipDir);

    console.log("[refresh] cleaning required GTFS files");
    await buildCleanGtfsFiles(unzipDir, cleanDir);

    console.log("[refresh] importing cleaned GTFS into stage/live tables");
    await importIntoStage(cleanDir, { DATABASE_URL });

    await setDbFeedVersion(client, rtVersion);
    await upsertFeedMeta(client, "service_alerts", rtVersion, alertsMeta.headerTimestamp);
    await upsertFeedMeta(client, "trip_updates", rtVersion, tripMeta.headerTimestamp);

    console.log(`[refresh] updated gtfs_current_feed_version=${rtVersion}`);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
