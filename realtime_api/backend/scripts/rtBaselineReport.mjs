import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

const DEFAULT_URL = "https://api.mesdeparts.ch";
const DEFAULT_STOPS = ["Parent8587387", "Parent8501000", "Parent8501120"];
const DEFAULT_N = 30;

function asText(value) {
  return String(value || "").trim();
}

function asInt(value, fallback) {
  const out = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(out) ? out : fallback;
}

function parseArgs(argv) {
  let url = DEFAULT_URL;
  let n = DEFAULT_N;
  let stops = [...DEFAULT_STOPS];

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--url" && value) {
      url = asText(value) || DEFAULT_URL;
      i += 1;
      continue;
    }
    if (key === "--stops" && value) {
      const parsed = value
        .split(",")
        .map((v) => asText(v))
        .filter(Boolean);
      if (parsed.length > 0) stops = parsed;
      i += 1;
      continue;
    }
    if (key === "--n" && value) {
      n = Math.max(1, asInt(value, DEFAULT_N));
      i += 1;
      continue;
    }
  }

  return { url, stops, n };
}

function normalizeBaseUrl(raw) {
  return asText(raw).replace(/\/+$/, "");
}

function timestampSlug(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}`;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  const clampedP = Math.max(0, Math.min(100, Number(p)));
  const idx = Math.ceil((clampedP / 100) * nums.length) - 1;
  const safeIdx = Math.max(0, Math.min(nums.length - 1, idx));
  return nums[safeIdx];
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function roundMaybe(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeError(err, databaseUrl) {
  const raw = String(err?.message || err || "unknown_error");
  const dbUrl = asText(databaseUrl);
  if (!dbUrl) return raw;
  return raw.split(dbUrl).join("[redacted:DATABASE_URL]");
}

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

async function queryDbBaseline(client) {
  const payloadRes = await client.query(`
    SELECT
      feed_key,
      octet_length(payload) AS bytes,
      fetched_at,
      last_status
    FROM public.rt_cache
    ORDER BY bytes DESC NULLS LAST
  `);

  let statementsRows = [];
  let statementsError = null;
  try {
    const stmtRes = await client.query(`
      SELECT
        calls,
        rows,
        total_exec_time,
        query
      FROM pg_stat_statements
      WHERE query ILIKE '%rt_cache%'
      ORDER BY calls DESC
      LIMIT 20
    `);
    statementsRows = stmtRes.rows;
  } catch (err) {
    statementsError = String(err?.message || err || "pg_stat_statements_unavailable");
  }

  return {
    rtCachePayloads: payloadRes.rows,
    rtCacheStatements: statementsRows,
    rtCacheStatementsError: statementsError,
  };
}

async function fetchStationboardSample(baseUrl, stopId, sampleIndex) {
  const startedAt = Date.now();
  const url = new URL(`${baseUrl}/api/stationboard`);
  url.searchParams.set("stop_id", stopId);
  url.searchParams.set("limit", "8");
  // Keep each request key unique to avoid edge-cache reuse during baseline sampling.
  url.searchParams.set("_rtb", String(sampleIndex));

  let response;
  let responseJson = null;
  let responseText = null;
  let parseError = null;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
    });
    const bodyText = await response.text();
    responseText = bodyText;
    try {
      responseJson = JSON.parse(bodyText);
    } catch (err) {
      parseError = String(err?.message || err || "json_parse_failed");
    }
  } catch (err) {
    return {
      sampleIndex,
      stopId,
      url: url.toString(),
      ok: false,
      httpStatus: null,
      clientDurationMs: Date.now() - startedAt,
      error: String(err?.message || err || "fetch_failed"),
    };
  }

  const meta = responseJson?.meta || {};
  return {
    sampleIndex,
    stopId,
    url: url.toString(),
    ok: response.ok,
    httpStatus: response.status,
    clientDurationMs: Date.now() - startedAt,
    meta: {
      serverTime: asText(meta.serverTime) || null,
      totalBackendMs: Number.isFinite(Number(meta.totalBackendMs))
        ? Number(meta.totalBackendMs)
        : null,
      rtStatus: asText(meta.rtStatus) || null,
      rtAppliedCount: Number.isFinite(Number(meta.rtAppliedCount))
        ? Number(meta.rtAppliedCount)
        : null,
      rtFetchedAt: asText(meta.rtFetchedAt) || null,
      rtCacheAgeMs: Number.isFinite(Number(meta.rtCacheAgeMs))
        ? Number(meta.rtCacheAgeMs)
        : null,
      responseMode: asText(meta.responseMode) || null,
    },
    parseError,
    bodySnippet:
      parseError || !response.ok
        ? asText(responseText).slice(0, 300)
        : null,
  };
}

function summarizeSamples(samples) {
  const items = Array.isArray(samples) ? samples : [];
  const totalBackend = items
    .map((s) => Number(s?.meta?.totalBackendMs))
    .filter((v) => Number.isFinite(v));
  const cacheAges = items
    .map((s) => Number(s?.meta?.rtCacheAgeMs))
    .filter((v) => Number.isFinite(v));
  const statusCounts = {};
  let appliedCount = 0;

  for (const sample of items) {
    const key = asText(sample?.meta?.rtStatus) || "unknown";
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    if (key === "applied") appliedCount += 1;
  }

  return {
    requestCount: items.length,
    successCount: items.filter((s) => s.ok === true).length,
    p50TotalBackendMs: roundMaybe(percentile(totalBackend, 50), 2),
    p95TotalBackendMs: roundMaybe(percentile(totalBackend, 95), 2),
    rtStatusDistribution: statusCounts,
    avgRtCacheAgeMs: roundMaybe(avg(cacheAges), 2),
    medianRtCacheAgeMs: roundMaybe(median(cacheAges), 2),
    maxRtCacheAgeMs: roundMaybe(
      cacheAges.length ? Math.max(...cacheAges) : null,
      2
    ),
    percentRtApplied:
      items.length > 0 ? roundMaybe((appliedCount / items.length) * 100, 2) : null,
  };
}

function buildMarkdownReport({
  generatedAt,
  baseUrl,
  stops,
  summary,
  jsonFilename,
}) {
  const distributionLines = Object.entries(summary.rtStatusDistribution || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join("\n");

  return `# RT Baseline Report

- Timestamp (UTC): ${generatedAt}
- URL: \`${baseUrl}\`
- Stops: ${stops.map((s) => `\`${s}\``).join(", ")}
- Samples: ${summary.requestCount}

| Metric | Value |
| --- | --- |
| p50 totalBackendMs | ${summary.p50TotalBackendMs ?? "n/a"} |
| p95 totalBackendMs | ${summary.p95TotalBackendMs ?? "n/a"} |
| avg rtCacheAgeMs | ${summary.avgRtCacheAgeMs ?? "n/a"} |
| median rtCacheAgeMs | ${summary.medianRtCacheAgeMs ?? "n/a"} |
| max rtCacheAgeMs | ${summary.maxRtCacheAgeMs ?? "n/a"} |
| % responses rtStatus=applied | ${summary.percentRtApplied ?? "n/a"} |

## rtStatus distribution

${distributionLines || "- n/a"}

## Raw data

- JSON: \`${jsonFilename}\`
`;
}

async function main() {
  loadDotEnvIfNeeded();
  const { url, stops, n } = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(url);
  const databaseUrl = asText(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const now = new Date();
  const slug = timestampSlug(now);
  const diagnosticsDir = path.resolve(backendRoot, "docs/diagnostics");
  fs.mkdirSync(diagnosticsDir, { recursive: true });

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { require: true, rejectUnauthorized: false },
    application_name: "md_baseline_report",
  });

  let dbSection;
  await client.connect();
  try {
    dbSection = await queryDbBaseline(client);
  } finally {
    await client.end().catch(() => {});
  }

  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const stopId = stops[i % stops.length];
    const sample = await fetchStationboardSample(baseUrl, stopId, i + 1);
    samples.push(sample);
  }
  const summary = summarizeSamples(samples);

  const payload = {
    generatedAtUtc: now.toISOString(),
    baseUrl,
    stopIds: stops,
    requestCount: n,
    db: dbSection,
    stationboardSamples: samples,
    summary,
    notes: {
      pgStatStatementsResetPerformed: false,
    },
  };

  const jsonFilename = `rt-baseline-${slug}.json`;
  const mdFilename = `rt-baseline-${slug}.md`;
  const jsonPath = path.join(diagnosticsDir, jsonFilename);
  const mdPath = path.join(diagnosticsDir, mdFilename);
  const md = buildMarkdownReport({
    generatedAt: now.toISOString(),
    baseUrl,
    stops,
    summary,
    jsonFilename,
  });

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, md, "utf8");

  console.log(`[rt-baseline] wrote ${path.relative(backendRoot, jsonPath)}`);
  console.log(`[rt-baseline] wrote ${path.relative(backendRoot, mdPath)}`);
}

main().catch((err) => {
  const safe = safeError(err, process.env.DATABASE_URL);
  console.error(`[rt-baseline] failed: ${safe}`);
  process.exit(1);
});
