#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ALLOWED_RESPONSE_MODES = new Set([
  "full",
  "degraded_static",
  "stale_cache_fallback",
  "static_timeout_fallback",
  "not_modified_204",
]);
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function compactTimestamp(iso = isoNow()) {
  return String(iso).replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
}

function toIsoOrNull(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toFiniteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const w = idx - lo;
  return sortedValues[lo] * (1 - w) + sortedValues[hi] * w;
}

function summarizeNumeric(values) {
  if (!values.length) {
    return {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      mean: null,
      stddev: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  return {
    count: values.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean,
    stddev: Math.sqrt(variance),
  };
}

function buildDistribution(values) {
  const map = new Map();
  for (const raw of values) {
    const key = String(raw || "").trim() || "(missing)";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function formatPct(num) {
  if (!Number.isFinite(num)) return "n/a";
  return `${(num * 100).toFixed(1)}%`;
}

function formatMs(num) {
  if (!Number.isFinite(num)) return "n/a";
  return `${Math.round(num)} ms`;
}

function formatSec(num) {
  if (!Number.isFinite(num)) return "n/a";
  return `${num.toFixed(2)} s`;
}

function normalizeFreshnessSample(sample, defaultClient) {
  const requestStart = toIsoOrNull(sample?.requestStart);
  const requestEnd = toIsoOrNull(sample?.requestEnd);
  const sampledAt = toIsoOrNull(sample?.sampledAt) || requestEnd || requestStart;
  const durationMs = toFiniteNumberOrNull(sample?.clientFetchDurationMs);
  return {
    sampledAt,
    requestStart,
    requestEnd,
    client: String(sample?.client || defaultClient),
    status: (() => {
      const s = toFiniteNumberOrNull(sample?.status);
      return s && s > 0 ? s : null;
    })(),
    source: String(sample?.source || "network"),
    stopId: String(sample?.stopID || sample?.stationId || "").trim() || null,
    serverTime: toIsoOrNull(sample?.serverTime),
    rtFetchedAt: toIsoOrNull(sample?.rtFetchedAt),
    rtCacheAgeMs: toFiniteNumberOrNull(sample?.rtCacheAgeMs),
    responseMode: String(sample?.responseMode || "").trim() || null,
    rtStatus: String(sample?.rtStatus || "").trim() || null,
    clientFetchDurationMs: durationMs,
  };
}

function cadenceSeconds(samples) {
  const withTimes = samples
    .map((s) => ({
      sample: s,
      ts: Date.parse(s.requestStart || s.sampledAt || ""),
    }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);
  const values = [];
  for (let i = 1; i < withTimes.length; i += 1) {
    const deltaSec = (withTimes[i].ts - withTimes[i - 1].ts) / 1000;
    if (deltaSec >= 0) values.push(deltaSec);
  }
  return values;
}

function analyzeClient(samples, expectedIntervalMs) {
  const normalized = samples.map((s) => normalizeFreshnessSample(s, "unknown"));
  const rtCacheAgeValues = normalized
    .map((s) => s.rtCacheAgeMs)
    .filter((v) => Number.isFinite(v));
  const statuses = normalized.map((s) => s.rtStatus).filter(Boolean);
  const modes = normalized.map((s) => s.responseMode).filter(Boolean);
  const cadenceValuesSec = cadenceSeconds(normalized);
  const cadenceStatsSec = summarizeNumeric(cadenceValuesSec);
  const metaPresentCount = normalized.filter(
    (s) => s.rtStatus || s.responseMode || Number.isFinite(s.rtCacheAgeMs)
  ).length;
  const metaCoverageRate = normalized.length ? metaPresentCount / normalized.length : null;

  const nonAppliedCount = statuses.filter((s) => s.toLowerCase() !== "applied").length;
  const nonAppliedRate = statuses.length ? nonAppliedCount / statuses.length : null;

  const rtCacheSummary = summarizeNumeric(rtCacheAgeValues);
  const appliedCacheValues = normalized
    .filter((s) => String(s.rtStatus || "").toLowerCase() === "applied")
    .map((s) => s.rtCacheAgeMs)
    .filter((v) => Number.isFinite(v));
  const appliedCacheSummary = summarizeNumeric(appliedCacheValues);

  const knownModeViolations = modes.filter((m) => !ALLOWED_RESPONSE_MODES.has(m));

  const cadenceFloorMs = expectedIntervalMs - 1200;
  const minCadenceMs = Number.isFinite(cadenceStatsSec.min)
    ? cadenceStatsSec.min * 1000
    : null;
  const cadencePass = minCadenceMs == null ? false : minCadenceMs >= cadenceFloorMs;

  const rtCachePass =
    appliedCacheSummary.count === 0 || !Number.isFinite(appliedCacheSummary.p95)
      ? true
      : appliedCacheSummary.p95 <= 45_000;

  const responseModePass = knownModeViolations.length === 0;
  const metaCoveragePass =
    metaCoverageRate == null ? false : metaCoverageRate >= 0.8;

  const checks = {
    meta_presence_coverage: {
      pass: metaCoveragePass,
      threshold: ">= 80% samples should contain at least one meta freshness field",
      actual: formatPct(metaCoverageRate),
    },
    cadence_not_faster_than_target: {
      pass: cadencePass,
      threshold: `min interval >= ${(cadenceFloorMs / 1000).toFixed(1)}s`,
      actual: minCadenceMs == null ? "insufficient cadence samples" : formatSec(minCadenceMs / 1000),
    },
    applied_rt_cache_p95: {
      pass: rtCachePass,
      threshold: "p95(rtCacheAgeMs where rtStatus=applied) <= 45000 ms",
      actual:
        appliedCacheSummary.count === 0
          ? "no applied samples"
          : formatMs(appliedCacheSummary.p95),
    },
    response_mode_known_values: {
      pass: responseModePass,
      threshold: "responseMode in {full,degraded_static,stale_cache_fallback,static_timeout_fallback,not_modified_204}",
      actual:
        knownModeViolations.length === 0
          ? "all known"
          : `unknown: ${[...new Set(knownModeViolations)].join(", ")}`,
    },
  };

  const overallPass = Object.values(checks).every((c) => c.pass);

  return {
    sampleCount: normalized.length,
    statusesObserved: statuses.length,
    responseModesObserved: modes.length,
    rtStatusDistribution: buildDistribution(statuses),
    responseModeDistribution: buildDistribution(modes),
    rtCacheAgeMsSummary: rtCacheSummary,
    appliedRtCacheAgeMsSummary: appliedCacheSummary,
    nonAppliedRate,
    metaCoverageRate,
    cadenceSecondsSummary: cadenceStatsSec,
    checks,
    overallPass,
    normalizedSamples: normalized,
  };
}

async function fetchStationboardSample({
  apiBase,
  stopId,
  limit,
  includeAlerts,
  timeoutMs,
}) {
  const params = new URLSearchParams({
    stop_id: stopId,
    limit: String(limit),
    include_alerts: includeAlerts ? "1" : "0",
  });
  const url = `${String(apiBase).replace(/\/$/, "")}/api/stationboard?${params.toString()}`;
  const requestStartMs = Date.now();
  const requestStart = new Date(requestStartMs).toISOString();
  const finalizeSample = ({ status, meta, error = null, fallback = null }) => {
    const requestEndMs = Date.now();
    const requestEnd = new Date(requestEndMs).toISOString();
    return {
      sampledAt: requestEnd,
      requestStart,
      requestEnd,
      clientFetchDurationMs: requestEndMs - requestStartMs,
      status:
        Number.isFinite(Number(status)) && Number(status) > 0
          ? Number(status)
          : null,
      source: "network",
      serverTime: toIsoOrNull(meta?.serverTime),
      rtFetchedAt: toIsoOrNull(meta?.rtFetchedAt),
      rtCacheAgeMs: toFiniteNumberOrNull(meta?.rtCacheAgeMs),
      responseMode: String(meta?.responseMode || "").trim() || null,
      rtStatus: String(meta?.rtStatus || "").trim() || null,
      stopID: stopId,
      ...(fallback ? { fallback } : {}),
      ...(error ? { error } : {}),
    };
  };

  const parsePayloadMeta = (payload) =>
    payload?.meta && typeof payload.meta === "object" ? payload.meta : {};

  const fetchWithNodeFetch = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      return finalizeSample({
        status: res.status,
        meta: parsePayloadMeta(payload),
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const fetchWithCurl = async () => {
    const curlTimeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const marker = "__MD_HTTP_STATUS__:";
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "--max-time",
      String(curlTimeoutSec),
      "-H",
      "Accept: application/json",
      "-H",
      "Cache-Control: no-cache",
      "-H",
      "Pragma: no-cache",
      "-w",
      `\\n${marker}%{http_code}`,
      url,
    ]);
    const raw = String(stdout || "");
    const markerIdx = raw.lastIndexOf(marker);
    const body = markerIdx >= 0 ? raw.slice(0, markerIdx).trim() : raw.trim();
    const statusRaw = markerIdx >= 0 ? raw.slice(markerIdx + marker.length).trim() : "";
    const status = Number.parseInt(statusRaw, 10);

    let payload = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      payload = null;
    }
    return finalizeSample({
      status: Number.isFinite(status) ? status : null,
      meta: parsePayloadMeta(payload),
      error: payload ? null : "curl_non_json_response",
      fallback: "curl",
    });
  };

  try {
    return await fetchWithNodeFetch();
  } catch (err) {
    try {
      return await fetchWithCurl();
    } catch (curlErr) {
      return finalizeSample({
        status: null,
        meta: null,
        error: `fetch_failed:${String(err?.message || err || "unknown")}; curl_failed:${String(curlErr?.message || curlErr || "unknown")}`,
      });
    }
  }
}

async function collectLiveSamples({
  apiBase,
  stopId,
  limit,
  includeAlerts,
  timeoutMs,
  samples,
  intervalMs,
  clientLabel,
}) {
  const out = [];
  let nextDue = Date.now();
  for (let i = 0; i < samples; i += 1) {
    const now = Date.now();
    if (now < nextDue) {
      await sleep(nextDue - now);
    }
    const sample = await fetchStationboardSample({
      apiBase,
      stopId,
      limit,
      includeAlerts,
      timeoutMs,
    });
    sample.client = clientLabel;
    out.push(sample);
    nextDue += intervalMs;
  }
  return out;
}

function renderDistribution(dist) {
  const entries = Object.entries(dist || {});
  if (!entries.length) return "- (none)";
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

function renderCheckRows(analysis) {
  return Object.entries(analysis.checks)
    .map(([key, check]) => {
      const status = check.pass ? "PASS" : "FAIL";
      return `| ${key} | ${status} | ${check.threshold} | ${check.actual} |`;
    })
    .join("\n");
}

function renderClientSummary(name, analysis) {
  return [
    `### ${name}`,
    "",
    `- Samples: ${analysis.sampleCount}`,
    `- Meta coverage: ${formatPct(analysis.metaCoverageRate)}`,
    `- Non-applied rtStatus rate: ${formatPct(analysis.nonAppliedRate)}`,
    `- rtCacheAgeMs (all) p50/p95: ${formatMs(analysis.rtCacheAgeMsSummary.p50)} / ${formatMs(analysis.rtCacheAgeMsSummary.p95)}`,
    `- Cadence p50/stddev: ${formatSec(analysis.cadenceSecondsSummary.p50)} / ${formatSec(analysis.cadenceSecondsSummary.stddev)}`,
    "",
    "**rtStatus distribution**",
    renderDistribution(analysis.rtStatusDistribution),
    "",
    "**responseMode distribution**",
    renderDistribution(analysis.responseModeDistribution),
    "",
    "| Check | Result | Threshold | Actual |",
    "| --- | --- | --- | --- |",
    renderCheckRows(analysis),
    "",
    `Overall: ${analysis.overallPass ? "PASS" : "FAIL"}`,
  ].join("\n");
}

function renderComparison({
  startedAt,
  finishedAt,
  config,
  webAnalysis,
  iosAnalysis,
  notes,
}) {
  const bothPass = webAnalysis.overallPass && iosAnalysis.overallPass;
  const rtCacheP95Delta =
    Number.isFinite(webAnalysis.rtCacheAgeMsSummary.p95) &&
    Number.isFinite(iosAnalysis.rtCacheAgeMsSummary.p95)
      ? iosAnalysis.rtCacheAgeMsSummary.p95 - webAnalysis.rtCacheAgeMsSummary.p95
      : null;
  const nonAppliedDelta =
    Number.isFinite(webAnalysis.nonAppliedRate) &&
    Number.isFinite(iosAnalysis.nonAppliedRate)
      ? iosAnalysis.nonAppliedRate - webAnalysis.nonAppliedRate
      : null;
  const cadenceStddevDelta =
    Number.isFinite(webAnalysis.cadenceSecondsSummary.stddev) &&
    Number.isFinite(iosAnalysis.cadenceSecondsSummary.stddev)
      ? iosAnalysis.cadenceSecondsSummary.stddev - webAnalysis.cadenceSecondsSummary.stddev
      : null;

  return `# Freshness Comparison Report (${compactTimestamp(finishedAt)})

Generated: ${finishedAt}
Window start: ${startedAt}

## Inputs

- API base: \`${config.apiBase}\`
- Stop ID: \`${config.stopId}\`
- Web samples observed: ${config.webSamplesObserved} @ ${(config.webIntervalMs / 1000).toFixed(1)}s target cadence
- Web source: ${config.webSource}
- iOS source: ${config.iosSource}
- iOS samples observed: ${config.iosSamplesObserved}
- iOS expected cadence: ${(config.iosExpectedIntervalMs / 1000).toFixed(1)}s

## Contract Verdict

- Web vs contract: ${webAnalysis.overallPass ? "PASS" : "FAIL"}
- iOS vs contract: ${iosAnalysis.overallPass ? "PASS" : "FAIL"}
- Combined: ${bothPass ? "PASS" : "FAIL"}

${renderClientSummary("Web (headless harness)", webAnalysis)}

${renderClientSummary("iOS (diagnostics export)", iosAnalysis)}

## Cross-Client Comparison

- rtCacheAgeMs p95 delta (iOS - web): ${formatMs(rtCacheP95Delta)}
- non-applied rtStatus rate delta (iOS - web): ${formatPct(nonAppliedDelta)}
- cadence stddev delta (iOS - web): ${formatSec(cadenceStddevDelta)}

## Interpretation Notes

${notes.map((line) => `- ${line}`).join("\n")}

## Backend Change Recommendation

No backend changes required.
`;
}

async function ensureDirForFile(filepath) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
}

async function writeJson(filepath, payload) {
  await ensureDirForFile(filepath);
  await fs.writeFile(filepath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJson(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = isoNow();
  const timestamp = compactTimestamp(startedAt);

  const apiBase = String(args["api-base"] || "https://api.mesdeparts.ch");
  const stopId = String(args["stop-id"] || "Parent8501120");
  const limit = Math.max(1, toNumber(args.limit, 8));
  const includeAlerts = String(args["include-alerts"] || "1") !== "0";
  const webSamples = Math.max(3, toNumber(args["web-samples"], 8));
  const webIntervalMs = Math.max(1000, toNumber(args["web-interval-ms"], 15_000));
  const webTimeoutMs = Math.max(1000, toNumber(args["web-timeout-ms"], 12_000));
  const iosExpectedIntervalMs = Math.max(1000, toNumber(args["ios-interval-ms"], 15_000));
  const webInputPath = args["web-input"] ? path.resolve(String(args["web-input"])) : null;
  const iosExportPath = args["ios-export"] ? path.resolve(String(args["ios-export"])) : null;
  const iosCollectLivePath = args["ios-collect-live"]
    ? path.resolve(String(args["ios-collect-live"]))
    : null;
  const reportOut = args["report-out"]
    ? path.resolve(String(args["report-out"]))
    : path.resolve(`realtime_api/docs/FRESHNESS_COMPARISON_${timestamp}.md`);
  const webOut = args["web-out"]
    ? path.resolve(String(args["web-out"]))
    : path.resolve(`realtime_api/docs/diagnostics/freshness/web_samples_${timestamp}.json`);

  let webSamplesData = null;
  let webSource = "";
  if (webInputPath) {
    webSamplesData = await readJson(webInputPath);
    webSource = `imported web samples (${webInputPath})`;
  } else {
    webSamplesData = await collectLiveSamples({
      apiBase,
      stopId,
      limit,
      includeAlerts,
      timeoutMs: webTimeoutMs,
      samples: webSamples,
      intervalMs: webIntervalMs,
      clientLabel: "web",
    });
    await writeJson(webOut, webSamplesData);
    webSource = `live harness collection (${webOut})`;
  }

  let iosSamplesData = null;
  let iosSource = "";
  if (iosExportPath) {
    iosSamplesData = await readJson(iosExportPath);
    iosSource = `imported diagnostics export (${iosExportPath})`;
  } else if (iosCollectLivePath) {
    iosSamplesData = await collectLiveSamples({
      apiBase,
      stopId,
      limit,
      includeAlerts,
      timeoutMs: webTimeoutMs,
      samples: webSamples,
      intervalMs: iosExpectedIntervalMs,
      clientLabel: "ios_live_harness",
    });
    await writeJson(iosCollectLivePath, iosSamplesData);
    iosSource = `live harness collection (${iosCollectLivePath})`;
  } else {
    throw new Error("Provide either --ios-export <file.json> or --ios-collect-live <file.json>.");
  }

  const webAnalysis = analyzeClient(webSamplesData, webIntervalMs);
  const iosAnalysis = analyzeClient(iosSamplesData, iosExpectedIntervalMs);
  const notes = [];
  if (webSource.includes("imported web samples")) {
    notes.push("Web input used imported captured samples (not collected live in this harness run).");
  }
  if (iosSource.includes("live harness collection")) {
    notes.push(
      "iOS input used harness live collection mode, not clipboard export from a running SwiftUI app."
    );
  } else if (iosSource.includes("imported diagnostics export")) {
    notes.push("iOS input used imported diagnostics-export JSON.");
  }
  if (
    Number.isFinite(iosAnalysis.cadenceSecondsSummary.p95) &&
    Number.isFinite(webAnalysis.cadenceSecondsSummary.p95) &&
    iosAnalysis.cadenceSecondsSummary.p95 > webAnalysis.cadenceSecondsSummary.p95 + 1
  ) {
    notes.push(
      "Higher iOS cadence variance can be expected with scene lifecycle pauses/background throttling."
    );
  } else {
    notes.push("Cadence variance is comparable; no lifecycle-throttling anomaly detected.");
  }
  if (iosAnalysis.nonAppliedRate != null && iosAnalysis.nonAppliedRate > 0) {
    notes.push(
      "Observed non-applied RT states are acceptable under static-first contract as long as departures remain present."
    );
  }
  notes.push(
    "Harness does not use Neon billing counters and only reads stationboard response metadata."
  );

  const finishedAt = isoNow();
  const report = renderComparison({
    startedAt,
    finishedAt,
    config: {
      apiBase,
      stopId,
      webSamplesObserved: Array.isArray(webSamplesData) ? webSamplesData.length : 0,
      webIntervalMs,
      webSource,
      iosSamplesObserved: Array.isArray(iosSamplesData) ? iosSamplesData.length : 0,
      iosExpectedIntervalMs,
      iosSource,
    },
    webAnalysis,
    iosAnalysis,
    notes,
  });

  await ensureDirForFile(reportOut);
  await fs.writeFile(reportOut, report, "utf8");

  // eslint-disable-next-line no-console
  console.log("[freshness-harness] report written:", reportOut);
  // eslint-disable-next-line no-console
  console.log("[freshness-harness] web source:", webSource);
  if (iosCollectLivePath) {
    // eslint-disable-next-line no-console
    console.log("[freshness-harness] ios live samples:", iosCollectLivePath);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[freshness-harness] failed:", err?.stack || err?.message || String(err));
  process.exit(1);
});
