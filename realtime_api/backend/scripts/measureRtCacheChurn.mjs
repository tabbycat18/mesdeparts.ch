import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toInt(value, fallback) {
  const out = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(out) ? out : fallback;
}

function toBoolFlag(argv, name) {
  return argv.includes(name);
}

function loadDotEnvIfNeeded() {
  if (process.env.DATABASE_URL) return;
  const candidates = [
    path.resolve(__dirname, "../.env"),
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

async function maybeResetPgStatStatements(client, enabled) {
  if (!enabled) return;
  try {
    await client.query("SELECT pg_stat_statements_reset()");
    console.log("[measure] pg_stat_statements reset completed");
  } catch (err) {
    console.log(`[measure] pg_stat_statements reset skipped: ${safeErrorMessage(err)}`);
  }
}

async function printTopRtCachePayloads(client, limit) {
  title("Top rt_cache payload sizes");
  const res = await client.query(
    `
      SELECT
        feed_key,
        octet_length(payload) AS payload_bytes,
        pg_size_pretty(COALESCE(octet_length(payload), 0)::bigint) AS payload_size,
        fetched_at,
        last_status
      FROM public.rt_cache
      ORDER BY octet_length(payload) DESC NULLS LAST, feed_key
      LIMIT $1
    `,
    [limit]
  );
  console.table(res.rows);
}

async function printTopRtCacheStatements(client, limit) {
  title("Top rt_cache-related pg_stat_statements");
  try {
    const res = await client.query(
      `
        SELECT
          calls,
          ROUND(total_exec_time::numeric, 2) AS total_exec_ms,
          ROUND(mean_exec_time::numeric, 3) AS mean_exec_ms,
          rows,
          LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 220) AS query_sample
        FROM pg_stat_statements
        WHERE query ILIKE '%rt_cache%'
           OR query ILIKE '%rt_cache_payload_sha256:%'
        ORDER BY calls DESC
        LIMIT $1
      `,
      [limit]
    );
    console.table(res.rows);
  } catch (err) {
    console.log(`[measure] pg_stat_statements unavailable: ${safeErrorMessage(err)}`);
  }
}

async function printPgStatActivityByApp(client) {
  title("pg_stat_activity grouped by application_name");
  const res = await client.query(`
    SELECT
      COALESCE(NULLIF(application_name, ''), '(empty)') AS application_name,
      COALESCE(state, '(null)') AS state,
      COUNT(*) AS connections
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY application_name, state
    ORDER BY application_name, state
  `);
  console.table(res.rows);
}

async function main() {
  loadDotEnvIfNeeded();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const argv = process.argv.slice(2);
  const windowMin = toInt(process.env.MEASURE_WINDOW_MIN, 10);
  const topN = toInt(process.env.MEASURE_TOP_N, 20);
  const shouldReset = toBoolFlag(argv, "--reset");

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + windowMin * 60_000);
  console.log(`[measure] started_at=${startedAt.toISOString()}`);
  console.log(`[measure] sample_window_minutes=${windowMin}`);
  console.log(`[measure] suggested_end_at=${endsAt.toISOString()}`);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { require: true, rejectUnauthorized: false },
    application_name: "md_measure",
  });

  await client.connect();
  try {
    await maybeResetPgStatStatements(client, shouldReset);
    await printTopRtCachePayloads(client, topN);
    await printTopRtCacheStatements(client, topN);
    await printPgStatActivityByApp(client);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[measure] failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
