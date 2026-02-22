#!/usr/bin/env node

function text(value) {
  return String(value || "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function countTripupdateCoverage(payload) {
  const auditRows = toArray(payload?.debug?.departureAudit);
  if (auditRows.length > 0) {
    return auditRows.reduce(
      (acc, row) => acc + (toArray(row?.sourceTags).includes("tripupdate") ? 1 : 0),
      0
    );
  }

  return toArray(payload?.departures).reduce((acc, row) => {
    const source = text(row?.source).toLowerCase();
    return acc + (source === "tripupdate" || source === "rt_added" ? 1 : 0);
  }, 0);
}

function countDelayCoverage(payload) {
  return toArray(payload?.departures).reduce(
    (acc, row) => acc + (row?.delayMin !== null && row?.delayMin !== undefined ? 1 : 0),
    0
  );
}

function buildRequestUrl(baseUrl, { lang = "fr", block = false, stopId = "Parent8503000", limit = 30 } = {}) {
  const url = new URL("/api/stationboard", baseUrl);
  url.searchParams.set("stop_id", stopId);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("debug", "1");
  url.searchParams.set("lang", lang);
  if (block) {
    url.searchParams.set("debug_rt", "block");
  }
  return url;
}

async function runOne(url) {
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload) {
    return {
      ok: false,
      status: response.status,
      error: text(payload?.error) || `http_${response.status}`,
      instanceId: null,
      cacheStatus: null,
      delayCoverage: 0,
      tripupdateCoverage: 0,
      signature: `error:${response.status}`,
    };
  }

  const instanceId = text(payload?.debug?.instanceId) || null;
  const cacheStatus = text(payload?.debug?.rt?.tripUpdates?.cacheStatus) || null;
  const delayCoverage = countDelayCoverage(payload);
  const tripupdateCoverage = countTripupdateCoverage(payload);

  return {
    ok: true,
    status: response.status,
    error: null,
    instanceId,
    cacheStatus,
    delayCoverage,
    tripupdateCoverage,
    signature: [
      instanceId || "instance:unknown",
      cacheStatus || "cache:unknown",
      `delay:${delayCoverage}`,
      `tripupdate:${tripupdateCoverage}`,
    ].join("|"),
  };
}

async function runSeries({ baseUrl, runs, block, lang }) {
  const out = [];
  for (let i = 0; i < runs; i += 1) {
    const url = buildRequestUrl(baseUrl, { block, lang });
    const row = await runOne(url);
    out.push(row);
    console.log(
      `${block ? "BLOCK" : "FREE "} run#${String(i + 1).padStart(2, "0")} instance=${row.instanceId || "-"} cache=${row.cacheStatus || "-"} delayCoverage=${row.delayCoverage} tripupdateCoverage=${row.tripupdateCoverage}${row.ok ? "" : ` error=${row.error}`}`
    );
  }
  return out;
}

async function main() {
  const baseUrl = text(process.env.STATIONBOARD_BASE_URL || "https://mesdeparts-ch.fly.dev");
  const runs = Math.max(1, toFiniteInt(process.argv[2], 10));
  const lang = text(process.env.STATIONBOARD_LANG || "fr");

  console.log(`Target: ${baseUrl}`);
  console.log(`Runs per mode: ${runs}`);
  console.log(`Language: ${lang}`);

  const freeRows = await runSeries({ baseUrl, runs, block: false, lang });
  const blockRows = await runSeries({ baseUrl, runs, block: true, lang });

  const blockSignatures = new Set(blockRows.map((row) => row.signature));
  const hasBlockFailure = blockRows.some((row) => !row.ok);
  const unstableBlock = blockSignatures.size > 1;

  console.log(`FREE unique signatures: ${new Set(freeRows.map((row) => row.signature)).size}`);
  console.log(`BLOCK unique signatures: ${blockSignatures.size}`);

  if (hasBlockFailure || unstableBlock) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`verifyRtDeterminism failed: ${String(err?.message || err)}`);
  process.exit(1);
});
