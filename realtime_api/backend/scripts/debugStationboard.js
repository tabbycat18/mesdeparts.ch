#!/usr/bin/env node

import {
  normalizeText,
  routeLabel,
  toArray,
  departureReasons,
} from "../src/util/text.js";

function inferSource(dep) {
  return normalizeText(dep?.debug?.source || dep?.debugSource || dep?.source) || "unknown";
}

function getDebugFlags(dep) {
  const flags = toArray(dep?.debug?.flags).map((item) => normalizeText(item)).filter(Boolean);
  if (flags.length > 0) return flags;
  return toArray(dep?.debugFlags).map((item) => normalizeText(item)).filter(Boolean);
}

function bump(map, key) {
  const k = normalizeText(key) || "UNKNOWN";
  map[k] = (map[k] || 0) + 1;
}

function delayBucketValue(dep) {
  if (dep?.delayMin == null) return "null";
  const delayMin = Number(dep.delayMin);
  if (!Number.isFinite(delayMin)) return "null";
  if (delayMin === 0) return "0";
  if (delayMin > 0) return ">0";
  return "<0";
}

function sampleDeparture(dep) {
  return {
    line: routeLabel(dep),
    destination: normalizeText(dep?.destination),
    scheduledDeparture: normalizeText(dep?.scheduledDeparture),
    realtimeDeparture: normalizeText(dep?.realtimeDeparture),
    cancelled: dep?.cancelled === true,
    status: normalizeText(dep?.status),
    cancelReasonCode: normalizeText(dep?.cancelReasonCode),
    stopEvent: normalizeText(dep?.stopEvent) || null,
    flags: toArray(dep?.flags),
    debugFlags: getDebugFlags(dep),
    source: inferSource(dep),
    reasons: departureReasons(dep),
    delayMin: dep?.delayMin ?? null,
  };
}

async function main() {
  const stopId = normalizeText(process.argv[2]) || "Parent8501120";
  const baseUrl = normalizeText(process.env.STATIONBOARD_BASE_URL) || "http://localhost:3001";
  const limit = Number(process.env.STATIONBOARD_LIMIT || "200");
  const lang = normalizeText(process.env.STATIONBOARD_LANG || "");

  const url = new URL("/api/stationboard", baseUrl);
  url.searchParams.set("stop_id", stopId);
  url.searchParams.set("limit", String(Number.isFinite(limit) ? limit : 200));
  url.searchParams.set("debug", "1");
  if (lang) url.searchParams.set("lang", lang);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const departures = toArray(payload?.departures);
  const banners = toArray(payload?.banners);
  const tripRtDebug =
    payload?.debug &&
    typeof payload.debug === "object" &&
    payload.debug?.rt &&
    typeof payload.debug.rt === "object" &&
    payload.debug.rt?.tripUpdates &&
    typeof payload.debug.rt.tripUpdates === "object"
      ? payload.debug.rt.tripUpdates
      : null;

  const cancelledByReason = {};
  const delayBuckets = { null: 0, "0": 0, ">0": 0, "<0": 0 };
  const skippedStopSamples = [];

  for (const dep of departures) {
    if (dep?.cancelled === true) {
      bump(cancelledByReason, dep?.cancelReasonCode || "UNKNOWN");
    }

    const bucket = delayBucketValue(dep);
    delayBuckets[bucket] = (delayBuckets[bucket] || 0) + 1;

    const debugFlags = getDebugFlags(dep);
    if (debugFlags.includes("cancel:skipped_stop") && skippedStopSamples.length < 10) {
      skippedStopSamples.push(sampleDeparture(dep));
    }
  }

  const annemasse = departures
    .filter((dep) => normalizeText(dep?.destination).toLowerCase().includes("annemasse"))
    .map(sampleDeparture);

  const vallorbe = departures
    .filter((dep) => normalizeText(dep?.destination).toLowerCase().includes("vallorbe"))
    .map(sampleDeparture);

  const out = {
    stopId,
    url: url.toString(),
    counts: {
      departures: departures.length,
      cancelled: departures.filter((dep) => dep?.cancelled === true).length,
      banners: banners.length,
    },
    rtDiagnostics: tripRtDebug
      ? {
          rtEnabledForRequest: tripRtDebug.rtEnabledForRequest === true,
          rtMetaReason: normalizeText(tripRtDebug.rtMetaReason || null),
          reason: normalizeText(tripRtDebug.reason || null),
          scopedEntities:
            Number.isFinite(Number(tripRtDebug.scopedEntities))
              ? Number(tripRtDebug.scopedEntities)
              : null,
          scopedTripCount:
            Number.isFinite(Number(tripRtDebug.scopedTripCount))
              ? Number(tripRtDebug.scopedTripCount)
              : null,
          scopedStopCount:
            Number.isFinite(Number(tripRtDebug.scopedStopCount))
              ? Number(tripRtDebug.scopedStopCount)
              : null,
        }
      : null,
    cancelledByReason,
    delayBuckets,
    skippedStopSamples,
    annemasse,
    vallorbe,
    departures,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`debugStationboard failed: ${String(err?.message || err)}`);
  process.exit(1);
});
