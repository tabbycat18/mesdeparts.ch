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

const TIMESTAMP_COLUMN_PRIORITY = [
  "updated_at",
  "fetched_at",
  "seen_at",
  "created_at",
  "inserted_at",
  "active_start",
  "active_end",
  "header_timestamp",
  "start_date",
  "service_date",
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
        (value.startsWith('"') && value.endsWith('"')) ||
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

function quoteIdent(name) {
  const v = String(name || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
    throw new Error(`invalid_identifier:${v}`);
  }
  return `"${v}"`;
}

function toSafeRow(row) {
  if (!row || typeof row !== "object") return row;
  return JSON.parse(JSON.stringify(row));
}

function sanitizeSampleValue(key, value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSampleValue("", item));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeSampleValue(k, v);
    }
    return out;
  }
  if (typeof value === "string") {
    if (key.toLowerCase() === "payload") {
      return `<omitted payload hex, length=${value.length}>`;
    }
    if (value.length > 240) {
      return `${value.slice(0, 240)}...<truncated ${value.length - 240} chars>`;
    }
  }
  return value;
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
  return res.rows.map((row) => ({
    table_name: row.table_name,
    exists: row.exists === true,
    row_count: Number.isFinite(Number(row.row_count)) ? Number(row.row_count) : null,
  }));
}

async function fetchTableColumns(client, tableName) {
  const res = await client.query(
    `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );
  return res.rows;
}

function pickTimestampColumns(columns) {
  const byName = new Map(columns.map((c) => [String(c.column_name), c]));
  const ordered = [];

  for (const name of TIMESTAMP_COLUMN_PRIORITY) {
    if (byName.has(name)) ordered.push(byName.get(name));
  }

  for (const col of columns) {
    if (ordered.includes(col)) continue;
    if (
      col.data_type.includes("timestamp") ||
      col.data_type === "date" ||
      col.data_type.includes("time")
    ) {
      ordered.push(col);
    }
  }

  return ordered.slice(0, 4);
}

async function fetchTimestampStats(client, tableName, columns) {
  const out = [];
  for (const col of pickTimestampColumns(columns)) {
    const colName = String(col.column_name);
    const sql = `
      SELECT
        MIN(${quoteIdent(colName)})::text AS min_value,
        MAX(${quoteIdent(colName)})::text AS max_value
      FROM public.${quoteIdent(tableName)}
    `;
    const res = await client.query(sql);
    out.push({
      column: colName,
      data_type: col.data_type,
      min_value: res.rows[0]?.min_value || null,
      max_value: res.rows[0]?.max_value || null,
    });
  }
  return out;
}

async function fetchSampleRows(client, tableName, limit = 5) {
  const res = await client.query(
    `
      SELECT row_to_json(t) AS row
      FROM (
        SELECT *
        FROM public.${quoteIdent(tableName)}
        LIMIT $1
      ) t
    `,
    [limit]
  );
  return res.rows.map((row) => sanitizeSampleValue("", toSafeRow(row.row)));
}

async function fetchTableIndexes(client, tableName) {
  const res = await client.query(
    `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = $1
      ORDER BY indexname
    `,
    [tableName]
  );
  return res.rows.map((row) => ({
    index_name: row.indexname,
    index_def: row.indexdef,
  }));
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
  return res.rows.map((row) => ({
    feed_key: row.feed_key,
    payload_bytes: Number.isFinite(Number(row.payload_bytes)) ? Number(row.payload_bytes) : null,
    payload_size: row.payload_size,
    fetched_at: row.fetched_at,
    last_status: row.last_status,
  }));
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
          LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 700) AS query_sample
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

function scanCodePaths() {
  const patterns = [
    "SELECT payload, fetched_at, etag, last_status, last_error",
    "readTripUpdatesFeedFromCache\\(",
    "loadScopedRtFromCache",
    "loadAlertsFromCache",
    "loadScopedRtFromParsedTables",
    "loadAlertsFromParsedTables",
    "persistParsedTripUpdatesSnapshot",
    "persistParsedServiceAlertsSnapshot",
  ];
  const rg = spawnSync(
    "rg",
    ["-n", patterns.join("|"), "src", "loaders", "scripts", "server.js"],
    {
      cwd: backendRoot,
      encoding: "utf8",
    }
  );

  if (rg.status !== 0 && rg.status !== 1) {
    return {
      refs: [],
      error: safeErrorMessage(rg.stderr || "rg_failed"),
      stationboardReadsPayload: null,
    };
  }

  const refs = String(rg.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("scripts/modelAplusInventory.mjs:"));

  const stationboardReadsPayload = refs.some((line) =>
    /src\/api\/stationboard\.js|src\/rt\/loadScopedRtFromCache\.js|src\/rt\/loadAlertsFromCache\.js|loaders\/loadRealtime\.js/.test(
      line
    )
  );

  return {
    refs,
    error: null,
    stationboardReadsPayload,
  };
}

async function buildTableInventory(client, tableName) {
  const existsRes = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  );
  const exists = existsRes.rows[0]?.exists === true;
  if (!exists) {
    return {
      table_name: tableName,
      exists: false,
      row_count: null,
      timestamp_stats: [],
      sample_rows: [],
      indexes: [],
    };
  }

  const countRes = await client.query(`SELECT count(*)::bigint AS c FROM public.${quoteIdent(tableName)}`);
  const rowCount = Number(countRes.rows[0]?.c || 0);
  const columns = await fetchTableColumns(client, tableName);
  const timestampStats = await fetchTimestampStats(client, tableName, columns);
  const sampleRows = await fetchSampleRows(client, tableName, 5);
  const indexes = await fetchTableIndexes(client, tableName);

  return {
    table_name: tableName,
    exists: true,
    row_count: rowCount,
    timestamp_stats: timestampStats,
    sample_rows: sampleRows,
    indexes,
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
    title("Model A+ candidate table counts");
    const counts = await fetchTableCounts(client);
    console.table(counts);

    const inventories = [];
    for (const tableName of TARGET_TABLES) {
      const inv = await buildTableInventory(client, tableName);
      inventories.push(inv);
    }

    title("Table min/max timestamp-like columns");
    for (const inv of inventories) {
      console.log(`\n[${inv.table_name}] exists=${inv.exists} rows=${inv.row_count ?? "n/a"}`);
      if (!inv.exists) continue;
      if (!inv.timestamp_stats.length) {
        console.log("  (no timestamp-like columns found)");
      } else {
        console.table(inv.timestamp_stats);
      }
    }

    title("Sample rows (max 5 per table)");
    for (const inv of inventories) {
      console.log(`\n[${inv.table_name}]`);
      if (!inv.exists) {
        console.log("  (table missing)");
        continue;
      }
      if (!inv.sample_rows.length) {
        console.log("  (no rows)");
        continue;
      }
      console.log(JSON.stringify(inv.sample_rows, null, 2));
    }

    title("Indexes on candidate tables");
    for (const inv of inventories) {
      console.log(`\n[${inv.table_name}]`);
      if (!inv.exists) {
        console.log("  (table missing)");
        continue;
      }
      if (!inv.indexes.length) {
        console.log("  (no indexes)");
        continue;
      }
      console.table(inv.indexes);
    }

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
    const codeScan = scanCodePaths();
    if (codeScan.error) {
      console.log(`code-scan warning: ${codeScan.error}`);
    }
    if (!codeScan.refs.length) {
      console.log("(no matches)");
    } else {
      for (const ref of codeScan.refs) {
        console.log(ref);
      }
    }

    title("Stationboard payload-read confirmation");
    if (codeScan.stationboardReadsPayload === true) {
      console.log("stationboard_can_read_rt_cache_payload=true");
      console.log("reason: parsed loader is default, but blob fallback/readRealtime path is still wired.");
    } else if (codeScan.stationboardReadsPayload === false) {
      console.log("stationboard_can_read_rt_cache_payload=false");
    } else {
      console.log("stationboard_can_read_rt_cache_payload=unknown");
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[modelAplus-inventory] failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
