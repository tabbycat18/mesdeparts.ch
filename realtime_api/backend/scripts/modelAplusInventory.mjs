import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

const TARGET_TABLES = [
  "rt_trip_updates",
  "rt_stop_time_updates",
  "rt_service_alerts",
  "rt_updates",
  "rt_cache",
  "rt_feed_meta",
  "meta_kv",
];

function loadDotEnvIfNeeded() {
  if (process.env.DATABASE_URL) return;
  const candidates = [
    path.resolve(backendRoot, ".env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    if (process.env.DATABASE_URL) return;
  }
}

function safeErrorMessage(err) {
  const raw = String(err?.message || err || "unknown_error");
  const dbUrl = String(process.env.DATABASE_URL || "").trim();
  if (!dbUrl) return raw;
  return raw.split(dbUrl).join("[redacted:DATABASE_URL]");
}

function title(text) {
  console.log(`\n=== ${text} ===`);
}

async function fetchTableCounts(client) {
  const res = await client.query(
    `
      WITH target(table_name) AS (
        SELECT UNNEST($1::text[])
      )
      SELECT
        t.table_name,
        (to_regclass('public.' || t.table_name) IS NOT NULL) AS exists,
        CASE
          WHEN to_regclass('public.' || t.table_name) IS NOT NULL THEN
            (xpath(
              '/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.table_name), true, true, '')
            ))[1]::text::bigint
          ELSE NULL
        END AS row_count
      FROM target t
      ORDER BY t.table_name
    `,
    [TARGET_TABLES]
  );
  return res.rows;
}

async function fetchRtCachePayloads(client) {
  const res = await client.query(`
    SELECT
      feed_key,
      octet_length(payload) AS payload_bytes,
      pg_size_pretty(COALESCE(octet_length(payload), 0)::bigint) AS payload_size,
      fetched_at,
      last_status
    FROM public.rt_cache
    ORDER BY payload_bytes DESC NULLS LAST, feed_key
  `);
  return res.rows;
}

async function fetchRtCachePayloadStatements(client, limit = 20) {
  try {
    const res = await client.query(
      `
        SELECT
          calls,
          rows,
          ROUND(total_exec_time::numeric, 3) AS total_exec_ms,
          ROUND(mean_exec_time::numeric, 3) AS mean_exec_ms,
          LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 500) AS query_sample
        FROM pg_stat_statements
        WHERE query ILIKE '%rt_cache%'
          AND query ILIKE '%payload%'
        ORDER BY calls DESC
        LIMIT $1
      `,
      [limit]
    );
    return { rows: res.rows, error: null };
  } catch (err) {
    return { rows: [], error: safeErrorMessage(err) };
  }
}

function fetchPayloadReadCodePaths() {
  const patterns = [
    "SELECT payload, fetched_at, etag, last_status, last_error",
    "getRtCache\\(",
    "readTripUpdatesFeedFromCache\\(",
    "loadScopedRtFromCache\\(",
    "loadAlertsFromCache\\(",
  ];
  const args = [
    "-n",
    patterns.join("|"),
    "src",
    "loaders",
    "scripts",
    "server.js",
  ];
  const rg = spawnSync("rg", args, {
    cwd: backendRoot,
    encoding: "utf8",
  });
  if (rg.status === 0) {
    return {
      refs: rg.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("scripts/modelAplusInventory.mjs:")),
      error: null,
    };
  }
  if (rg.status === 1) {
    return { refs: [], error: null };
  }
  return {
    refs: [],
    error: safeErrorMessage(rg.stderr || "rg_failed"),
  };
}

async function main() {
  loadDotEnvIfNeeded();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { require: true, rejectUnauthorized: false },
    application_name: "md_modelAplus_inventory",
  });

  await client.connect();
  try {
    title("Model A+ table inventory");
    const counts = await fetchTableCounts(client);
    console.table(counts);

    title("rt_cache payload lengths");
    const payloadRows = await fetchRtCachePayloads(client);
    console.table(payloadRows);

    title("Top payload-moving rt_cache statements (pg_stat_statements)");
    const statements = await fetchRtCachePayloadStatements(client, 20);
    if (statements.error) {
      console.log(`pg_stat_statements unavailable: ${statements.error}`);
    } else {
      console.table(statements.rows);
    }

    title("Code paths referencing rt_cache payload reads");
    const codeRefs = fetchPayloadReadCodePaths();
    if (codeRefs.error) {
      console.log(`code-scan warning: ${codeRefs.error}`);
    }
    if (!codeRefs.refs.length) {
      console.log("(no matches)");
    } else {
      for (const ref of codeRefs.refs) {
        console.log(ref);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[modelAplus-inventory] failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
