#!/usr/bin/env node

import {
  normalizeText,
  lower,
  routeLabel,
  toArray,
  departureReasons,
} from "../src/util/text.js";

function getDestination(dep) {
  return normalizeText(dep?.destination || dep?.to || dep?.name);
}

function getScheduled(dep) {
  return normalizeText(dep?.scheduledDeparture) || normalizeText(dep?.stop?.departure);
}

function getRealtime(dep) {
  return (
    normalizeText(dep?.realtimeDeparture) ||
    normalizeText(dep?.stop?.realtimeDeparture) ||
    normalizeText(dep?.stop?.prognosis?.departure)
  );
}

function getCancelled(dep) {
  return dep?.cancelled === true;
}

function getReasons(dep) {
  const out = [...departureReasons(dep)];
  const reasonCode = normalizeText(dep?.cancelReasonCode);
  if (reasonCode && !out.includes(reasonCode)) out.push(reasonCode);
  for (const flag of toArray(dep?.flags)) {
    const text = normalizeText(flag);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function mapDeparture(dep) {
  const line = routeLabel(dep);
  return {
    line,
    route: line,
    destination: getDestination(dep),
    scheduledDeparture: getScheduled(dep),
    realtimeDeparture: getRealtime(dep),
    cancelled: getCancelled(dep),
    status: normalizeText(dep?.status),
    cancelReasonCode: normalizeText(dep?.cancelReasonCode),
    stopEvent: normalizeText(dep?.stopEvent) || null,
    delayMin: dep?.delayMin ?? null,
    flags: toArray(dep?.flags),
    reasons: getReasons(dep),
    debugFlags: toArray(dep?.debug?.flags || dep?.debugFlags),
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let chunks = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      chunks += chunk;
    });
    process.stdin.on("end", () => resolve(chunks));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const query = lower(process.argv.slice(2).join(" "));
  const raw = await readStdin();
  if (!normalizeText(raw)) {
    console.error("No JSON on stdin. Example: node scripts/debugStationboard.js Parent8501120 | node scripts/filter-stationboard.js annemasse");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON on stdin: ${String(err?.message || err)}`);
    process.exit(1);
  }

  const departures = toArray(payload?.departures);
  const mapped = departures.map(mapDeparture);
  const filtered = query
    ? mapped.filter((dep) => lower(dep.destination).includes(query))
    : mapped;

  console.log(JSON.stringify({ found: filtered.length }, null, 2));
  console.log(JSON.stringify(filtered, null, 2));
}

main().catch((err) => {
  console.error(`filter-stationboard failed: ${String(err?.message || err)}`);
  process.exit(1);
});
