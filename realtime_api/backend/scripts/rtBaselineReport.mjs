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
const DEFAULT_DURATION_MINUTES = 0;
const DEFAULT_ACCEPT_MAX_PAYLOAD_SELECT_CALLS = 2;
const DEFAULT_ACCEPT_MAX_PAYLOAD_UPSERT_CALLS = 2;
const DEFAULT_ACCEPT_MAX_GUARDED_ERROR_COUNT = 0;

function asText(value) {
  return String(value || "").trim();
}

function asInt(value, fallback) {
  const out = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(out) ? out : fallback;
}

function asNumber(value, fallback) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function parseArgs(argv) {
  let url = DEFAULT_URL;
  let n = DEFAULT_N;
  let stops = [...DEFAULT_STOPS];
  let durationMinutes = DEFAULT_DURATION_MINUTES;
  let resetStatements = false;
  let acceptMaxPayloadSelectCalls = DEFAULT_ACCEPT_MAX_PAYLOAD_SELECT_CALLS;
  let acceptMaxPayloadUpsertCalls = DEFAULT_ACCEPT_MAX_PAYLOAD_UPSERT_CALLS;
  let acceptMaxGuardedErrorCount = DEFAULT_ACCEPT_MAX_GUARDED_ERROR_COUNT;

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === "--reset-statements") {
      resetStatements = true;
      continue;
    }
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
      n = Math.max(0, asInt(value, DEFAULT_N));
      i += 1;
      continue;
    }
    if (key === "--duration-minutes" && value) {
      durationMinutes = Math.max(0, asNumber(value, DEFAULT_DURATION_MINUTES));
      i += 1;
      continue;
    }
    if (key === "--accept-max-payload-select-calls" && value) {
      acceptMaxPayloadSelectCalls = Math.max(
        0,
        asInt(value, DEFAULT_ACCEPT_MAX_PAYLOAD_SELECT_CALLS)
      );
      i += 1;
      continue;
    }
    if (key === "--accept-max-payload-upsert-calls" && value) {
      acceptMaxPayloadUpsertCalls = Math.max(
        0,
        asInt(value, DEFAULT_ACCEPT_MAX_PAYLOAD_UPSERT_CALLS)
      );
      i += 1;
      continue;
    }
    if (key === "--accept-max-guarded-error-count" && value) {
      acceptMaxGuardedErrorCount = Math.max(
        0,
        asInt(value, DEFAULT_ACCEPT_MAX_GUARDED_ERROR_COUNT)
      );
      i += 1;
      continue;
    }
  }

  return {
    url,
    stops,
    n,
    durationMinutes,
    resetStatements,
    acceptance: {
      maxPayloadSelectCalls: acceptMaxPayloadSelectCalls,
      maxPayloadUpsertCalls: acceptMaxPayloadUpsertCalls,
      maxGuardedErrorCount: acceptMaxGuardedErrorCount,
    },
  };
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

function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
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

function normalizeStatementRow(row) {
  return {
    query: asText(row?.query),
    calls: Number(row?.calls || 0),
    rows: Number(row?.rows || 0),
    totalExecMs: Number(row?.total_exec_time || 0),
    meanExecMs: Number(row?.mean_exec_time || 0),
  };
}

function analyzeRtCacheStatements(rows) {
  const out = {
    payloadSelectCalls: 0,
    payloadUpsertCalls: 0,
    metadataUpdateCalls: 0,
    totalRtCacheCalls: 0,
  };

  for (const row of rows) {
    const query = asText(row?.query).toLowerCase();
    const calls = Number(row?.calls || 0);
    if (!Number.isFinite(calls) || calls <= 0) continue;

    out.totalRtCacheCalls += calls;
    if (
      query.includes("select") &&
      query.includes("payload") &&
      query.includes("from public.rt_cache")
    ) {
      out.payloadSelectCalls += calls;
    }
    if (
      query.includes("insert into public.rt_cache") &&
      query.includes("do update") &&
      query.includes("payload")
    ) {
      out.payloadUpsertCalls += calls;
    }
    if (query.includes("update public.rt_cache") && !query.includes("payload")) {
      out.metadataUpdateCalls += calls;
    }
  }

  return out;
}

function buildStatementDelta(startRows, endRows) {
  const byStart = new Map(startRows.map((row) => [row.query, row]));
  const byEnd = new Map(endRows.map((row) => [row.query, row]));
  const allQueries = new Set([...byStart.keys(), ...byEnd.keys()]);

  const deltas = [];
  for (const query of allQueries) {
    const start = byStart.get(query) || { calls: 0, rows: 0, totalExecMs: 0 };
    const end = byEnd.get(query) || { calls: 0, rows: 0, totalExecMs: 0 };
    const deltaCalls = Number(end.calls || 0) - Number(start.calls || 0);
    const deltaRows = Number(end.rows || 0) - Number(start.rows || 0);
    const deltaTotalExecMs = Number(end.totalExecMs || 0) - Number(start.totalExecMs || 0);
    if (deltaCalls === 0 && deltaRows === 0 && deltaTotalExecMs === 0) continue;
    deltas.push({
      query,
      startCalls: Number(start.calls || 0),
      endCalls: Number(end.calls || 0),
      deltaCalls,
      deltaRows,
      deltaTotalExecMs: roundMaybe(deltaTotalExecMs, 3),
    });
  }

  return deltas.sort((a, b) => b.deltaCalls - a.deltaCalls);
}

async function queryPgStatSnapshot(client, { limit = 200 } = {}) {
  let rows = [];
  let error = null;
  try {
    const stmtRes = await client.query(
      `
      SELECT
        calls,
        rows,
        total_exec_time,
        mean_exec_time,
        query
      FROM pg_stat_statements
      WHERE query ILIKE '%rt_cache%'
      ORDER BY calls DESC
      LIMIT $1
    `,
      [limit]
    );
    rows = stmtRes.rows.map(normalizeStatementRow);
  } catch (err) {
    error = String(err?.message || err || "pg_stat_statements_unavailable");
  }

  return {
    capturedAtUtc: new Date().toISOString(),
    rows,
    error,
    counters: analyzeRtCacheStatements(rows),
  };
}

async function queryRtCachePayloadSnapshot(client) {
  const payloadRes = await client.query(`
    SELECT
      feed_key,
      octet_length(payload) AS bytes,
      fetched_at,
      last_status
    FROM public.rt_cache
    ORDER BY bytes DESC NULLS LAST
  `);
  return payloadRes.rows;
}

async function resetPgStatStatements(client) {
  await client.query("SELECT pg_stat_statements_reset();");
}

async function fetchStationboardSample(baseUrl, stopId, sampleIndex) {
  const startedAt = Date.now();
  const url = new URL(`${baseUrl}/api/stationboard`);
  url.searchParams.set("stop_id", stopId);
  url.searchParams.set("limit", "8");
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
  let guardedErrorCount = 0;

  for (const sample of items) {
    const key = asText(sample?.meta?.rtStatus) || "unknown";
    statusCounts[key] = (statusCounts[key] || 0) + 1;
    if (key === "applied") appliedCount += 1;
    if (key === "guarded_error") guardedErrorCount += 1;
  }

  return {
    requestCount: items.length,
    successCount: items.filter((s) => s.ok === true).length,
    p50TotalBackendMs: roundMaybe(percentile(totalBackend, 50), 2),
    p95TotalBackendMs: roundMaybe(percentile(totalBackend, 95), 2),
    rtStatusDistribution: statusCounts,
    avgRtCacheAgeMs: roundMaybe(avg(cacheAges), 2),
    medianRtCacheAgeMs: roundMaybe(median(cacheAges), 2),
    maxRtCacheAgeMs: roundMaybe(cacheAges.length ? Math.max(...cacheAges) : null, 2),
    percentRtApplied:
      items.length > 0 ? roundMaybe((appliedCount / items.length) * 100, 2) : null,
    guardedErrorCount,
    percentRtGuardedError:
      items.length > 0 ? roundMaybe((guardedErrorCount / items.length) * 100, 2) : null,
  };
}

function evaluateAcceptance({ startSnapshot, endSnapshot, thresholds, summary }) {
  const startCounters = startSnapshot?.counters || {};
  const endCounters = endSnapshot?.counters || {};

  const payloadSelectCallsStart = Number(startCounters.payloadSelectCalls || 0);
  const payloadSelectCallsEnd = Number(endCounters.payloadSelectCalls || 0);
  const payloadUpsertCallsStart = Number(startCounters.payloadUpsertCalls || 0);
  const payloadUpsertCallsEnd = Number(endCounters.payloadUpsertCalls || 0);
  const payloadSelectCallsDelta =
    payloadSelectCallsEnd - payloadSelectCallsStart;
  const payloadUpsertCallsDelta =
    payloadUpsertCallsEnd - payloadUpsertCallsStart;
  const guardedErrorCount = Number(summary?.guardedErrorCount || 0);

  const payloadSelectPass = payloadSelectCallsDelta <= Number(thresholds.maxPayloadSelectCalls || 0);
  const payloadUpsertPass = payloadUpsertCallsDelta <= Number(thresholds.maxPayloadUpsertCalls || 0);
  const guardedErrorPass = guardedErrorCount <= Number(thresholds.maxGuardedErrorCount || 0);

  return {
    thresholds,
    observed: {
      payloadSelectCallsStart,
      payloadSelectCallsEnd,
      payloadSelectCallsDelta,
      payloadUpsertCallsStart,
      payloadUpsertCallsEnd,
      payloadUpsertCallsDelta,
      guardedErrorCount,
    },
    checks: {
      payloadSelectNearZero: {
        pass: payloadSelectPass,
        description:
          "SELECT payload FROM rt_cache should be near-zero on stationboard path",
      },
      payloadUpsertNearZero: {
        pass: payloadUpsertPass,
        description:
          "UPSERT rt_cache with payload should be near-zero after parsed poller writes",
      },
      noGuardedErrorStatus: {
        pass: guardedErrorPass,
        description:
          "stationboard rtStatus=guarded_error should not appear in measurement window",
      },
    },
    overallPass: payloadSelectPass && payloadUpsertPass && guardedErrorPass,
  };
}

function buildMarkdownReport({
  generatedAt,
  baseUrl,
  stops,
  summary,
  jsonFilename,
  window,
  acceptance,
  startSnapshot,
  endSnapshot,
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
- Window minutes: ${window.durationMinutes}
- pg_stat_statements reset: ${window.resetStatements ? "yes" : "no"}

| Metric | Value |
| --- | --- |
| p50 totalBackendMs | ${summary.p50TotalBackendMs ?? "n/a"} |
| p95 totalBackendMs | ${summary.p95TotalBackendMs ?? "n/a"} |
| avg rtCacheAgeMs | ${summary.avgRtCacheAgeMs ?? "n/a"} |
| median rtCacheAgeMs | ${summary.medianRtCacheAgeMs ?? "n/a"} |
| max rtCacheAgeMs | ${summary.maxRtCacheAgeMs ?? "n/a"} |
| % responses rtStatus=applied | ${summary.percentRtApplied ?? "n/a"} |
| % responses rtStatus=guarded_error | ${summary.percentRtGuardedError ?? "n/a"} |

## Acceptance (10-minute thresholds)

| Check | Threshold | Observed | Pass |
| --- | --- | --- | --- |
| SELECT payload FROM rt_cache | <= ${acceptance.thresholds.maxPayloadSelectCalls} calls | ${acceptance.observed.payloadSelectCallsStart} -> ${acceptance.observed.payloadSelectCallsEnd} (delta ${acceptance.observed.payloadSelectCallsDelta}) | ${acceptance.checks.payloadSelectNearZero.pass ? "yes" : "no"} |
| UPSERT rt_cache with payload | <= ${acceptance.thresholds.maxPayloadUpsertCalls} calls | ${acceptance.observed.payloadUpsertCallsStart} -> ${acceptance.observed.payloadUpsertCallsEnd} (delta ${acceptance.observed.payloadUpsertCallsDelta}) | ${acceptance.checks.payloadUpsertNearZero.pass ? "yes" : "no"} |
| rtStatus=guarded_error occurrences | <= ${acceptance.thresholds.maxGuardedErrorCount} responses | ${acceptance.observed.guardedErrorCount} | ${acceptance.checks.noGuardedErrorStatus.pass ? "yes" : "no"} |

Overall acceptance: ${acceptance.overallPass ? "PASS" : "FAIL"}

## pg_stat_statements counters (start -> end)

- payloadSelectCalls: ${startSnapshot?.counters?.payloadSelectCalls ?? 0} -> ${endSnapshot?.counters?.payloadSelectCalls ?? 0}
- payloadUpsertCalls: ${startSnapshot?.counters?.payloadUpsertCalls ?? 0} -> ${endSnapshot?.counters?.payloadUpsertCalls ?? 0}
- metadataUpdateCalls: ${startSnapshot?.counters?.metadataUpdateCalls ?? 0} -> ${endSnapshot?.counters?.metadataUpdateCalls ?? 0}
- totalRtCacheCalls: ${startSnapshot?.counters?.totalRtCacheCalls ?? 0} -> ${endSnapshot?.counters?.totalRtCacheCalls ?? 0}

## rtStatus distribution

${distributionLines || "- n/a"}

## Raw data

- JSON: \`${jsonFilename}\`
`;
}

async function runWindowSamples({ baseUrl, stops, n, durationMinutes }) {
  const samples = [];
  const windowMs = Math.max(0, Number(durationMinutes || 0) * 60 * 1000);

  if (windowMs <= 0 || n <= 0) {
    for (let i = 0; i < n; i += 1) {
      const stopId = stops[i % stops.length];
      const sample = await fetchStationboardSample(baseUrl, stopId, i + 1);
      samples.push(sample);
    }
    return samples;
  }

  const startMs = Date.now();
  const intervalMs = Math.max(1, Math.floor(windowMs / n));
  for (let i = 0; i < n; i += 1) {
    const stopId = stops[i % stops.length];
    const sample = await fetchStationboardSample(baseUrl, stopId, i + 1);
    samples.push(sample);

    const targetMs = startMs + (i + 1) * intervalMs;
    const waitMs = targetMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }

  const remainingMs = startMs + windowMs - Date.now();
  if (remainingMs > 0) await sleep(remainingMs);

  return samples;
}

async function main() {
  loadDotEnvIfNeeded();
  const { url, stops, n, durationMinutes, resetStatements, acceptance } = parseArgs(
    process.argv.slice(2)
  );
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

  let startSnapshot;
  let endSnapshot;
  let rtCachePayloadsStart;
  let rtCachePayloadsEnd;
  let resetError = null;

  await client.connect();
  try {
    if (resetStatements) {
      try {
        await resetPgStatStatements(client);
      } catch (err) {
        resetError = String(err?.message || err || "pg_stat_statements_reset_failed");
      }
    }

    startSnapshot = await queryPgStatSnapshot(client);
    rtCachePayloadsStart = await queryRtCachePayloadSnapshot(client);
  } finally {
    await client.end().catch(() => {});
  }

  const windowStartedAtUtc = new Date().toISOString();
  const samples = await runWindowSamples({ baseUrl, stops, n, durationMinutes });
  const summary = summarizeSamples(samples);

  const clientEnd = new Client({
    connectionString: databaseUrl,
    ssl: { require: true, rejectUnauthorized: false },
    application_name: "md_baseline_report",
  });

  await clientEnd.connect();
  try {
    endSnapshot = await queryPgStatSnapshot(clientEnd);
    rtCachePayloadsEnd = await queryRtCachePayloadSnapshot(clientEnd);
  } finally {
    await clientEnd.end().catch(() => {});
  }

  const statementDelta = buildStatementDelta(startSnapshot?.rows || [], endSnapshot?.rows || []);
  const acceptanceResult = evaluateAcceptance({
    startSnapshot,
    endSnapshot,
    thresholds: acceptance,
    summary,
  });

  const payload = {
    generatedAtUtc: now.toISOString(),
    window: {
      startedAtUtc: windowStartedAtUtc,
      endedAtUtc: new Date().toISOString(),
      durationMinutes,
      resetStatements,
      resetError,
      sampleCount: n,
    },
    baseUrl,
    stopIds: stops,
    requestCount: n,
    db: {
      rtCachePayloadsStart,
      rtCachePayloadsEnd,
      pgStatStatements: {
        start: startSnapshot,
        end: endSnapshot,
        delta: statementDelta,
      },
    },
    stationboardSamples: samples,
    summary,
    acceptance: acceptanceResult,
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
    window: { durationMinutes, resetStatements },
    acceptance: acceptanceResult,
    startSnapshot,
    endSnapshot,
  });

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, md, "utf8");

  console.log(`[rt-baseline] wrote ${path.relative(backendRoot, jsonPath)}`);
  console.log(`[rt-baseline] wrote ${path.relative(backendRoot, mdPath)}`);
  console.log(
    `[rt-baseline] acceptance payload_select_delta=${acceptanceResult.observed.payloadSelectCallsDelta} threshold=${acceptanceResult.thresholds.maxPayloadSelectCalls}`
  );
  console.log(
    `[rt-baseline] acceptance payload_upsert_delta=${acceptanceResult.observed.payloadUpsertCallsDelta} threshold=${acceptanceResult.thresholds.maxPayloadUpsertCalls}`
  );
  console.log(
    `[rt-baseline] acceptance guarded_error_count=${acceptanceResult.observed.guardedErrorCount} threshold=${acceptanceResult.thresholds.maxGuardedErrorCount}`
  );
  console.log(`[rt-baseline] acceptance overall=${acceptanceResult.overallPass ? "PASS" : "FAIL"}`);
  if (!acceptanceResult.overallPass) {
    throw new Error(
      `model_a_plus_acceptance_failed payload_select_delta=${acceptanceResult.observed.payloadSelectCallsDelta} payload_upsert_delta=${acceptanceResult.observed.payloadUpsertCallsDelta} guarded_error_count=${acceptanceResult.observed.guardedErrorCount}`
    );
  }
}

main().catch((err) => {
  const safe = safeError(err, process.env.DATABASE_URL);
  console.error(`[rt-baseline] failed: ${safe}`);
  process.exit(1);
});
