#!/usr/bin/env node

const DEFAULT_CALLS = 10;
const DEFAULT_TOTAL_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

function header(response, name) {
  const value = response.headers.get(name);
  return value == null || value === "" ? "-" : value;
}

async function run() {
  const url = String(process.argv[2] || "").trim();
  if (!url) {
    console.error(
      "Usage: node scripts/probeStationboardRt.js \"https://api.mesdeparts.ch/api/stationboard?stop_id=Parent8501120&limit=5\" [calls=10] [totalMs=30000]"
    );
    process.exit(1);
  }

  const calls = toInt(process.argv[3], DEFAULT_CALLS);
  const totalMs = toInt(process.argv[4], DEFAULT_TOTAL_MS);
  const waitMs = calls <= 1 ? 0 : Math.max(100, Math.round(totalMs / (calls - 1)));

  console.log(
    JSON.stringify(
      {
        probe: "stationboard_rt",
        url,
        calls,
        totalMs,
        intervalMs: waitMs,
      },
      null,
      2
    )
  );

  for (let i = 0; i < calls; i += 1) {
    const startedAt = Date.now();
    let response;
    let status = -1;
    let error = null;
    let rtAppliedBody = "-";
    let rtReasonBody = "-";

    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
      status = response.status;
      try {
        const body = await response.clone().json();
        rtAppliedBody = body?.rt?.applied === true ? "1" : body?.rt?.applied === false ? "0" : "-";
        rtReasonBody = String(body?.rt?.reason || "-");
      } catch {
        rtAppliedBody = "-";
        rtReasonBody = "-";
      }
    } catch (err) {
      error = String(err?.message || err);
    }

    const elapsedMs = Date.now() - startedAt;
    const line = {
      idx: i + 1,
      at: new Date().toISOString(),
      ms: elapsedMs,
      status,
      cfCacheStatus: response ? header(response, "cf-cache-status") : "-",
      rtAppliedHeader: response ? header(response, "x-md-rt-applied") : "-",
      rtReasonHeader: response ? header(response, "x-md-rt-reason") : "-",
      rtAgeMsHeader: response ? header(response, "x-md-rt-age-ms") : "-",
      instance: response ? header(response, "x-md-instance") : "-",
      cacheKey: response ? header(response, "x-md-cache-key") : "-",
      rtAppliedBody,
      rtReasonBody,
      error,
    };
    console.log(JSON.stringify(line));

    if (i < calls - 1) {
      await sleep(waitMs);
    }
  }
}

run().catch((err) => {
  console.error("probe_failed", String(err?.message || err));
  process.exit(1);
});
