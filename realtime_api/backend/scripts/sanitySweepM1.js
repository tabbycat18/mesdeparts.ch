#!/usr/bin/env node

function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(values));
}

function bool(value) {
  return value === true;
}

const STATIONS = [
  {
    label: "Lausanne",
    preferredStopId: "Parent8501120",
    searchQuery: "Lausanne",
  },
  {
    label: "Zurich HB",
    preferredStopId: "Parent8503000",
    searchQuery: "Zurich HB",
  },
  {
    label: "Geneve",
    preferredStopId: "Parent8501008",
    searchQuery: "Geneve",
  },
];

function asLowerSet(values) {
  return new Set(toArray(values).map((v) => normalizeText(v).toLowerCase()).filter(Boolean));
}

function hasAny(set, candidates) {
  return candidates.some((value) => set.has(value.toLowerCase()));
}

function isRtConfirmed(dep) {
  const flags = asLowerSet(dep?.flags);
  const debugFlags = asLowerSet(dep?.debug?.flags);
  const source = normalizeText(dep?.debug?.source || dep?.source).toLowerCase();

  if (flags.has("rt_confirmed")) return true;
  if (hasAny(debugFlags, ["delay:rt_equal_confirmed_zero", "delay:from_rt_diff"])) return true;
  return source !== "scheduled";
}

function byReasonOrFlag(dep, { reason, flag }) {
  const reasonCode = normalizeText(dep?.cancelReasonCode).toUpperCase();
  const flags = asLowerSet(dep?.flags);
  return reasonCode === String(reason || "").toUpperCase() || flags.has(String(flag || "").toLowerCase());
}

function analyzeStationboard(payload) {
  const departures = toArray(payload?.departures);

  const skippedCandidates = departures.filter((dep) =>
    byReasonOrFlag(dep, { reason: "SKIPPED_STOP", flag: "STOP_SKIPPED" })
  );
  const skippedViolations = skippedCandidates.filter((dep) => dep?.cancelled !== true);

  const tripCancelledCandidates = departures.filter((dep) =>
    byReasonOrFlag(dep, { reason: "CANCELED_TRIP", flag: "TRIP_CANCELLED" })
  );
  const tripCancelledViolations = tripCancelledCandidates.filter((dep) => dep?.cancelled !== true);

  const delayZero = departures.filter((dep) => Number(dep?.delayMin) === 0);
  const delayNull = departures.filter((dep) => dep?.delayMin == null);
  const delayZeroViolations = delayZero.filter((dep) => !isRtConfirmed(dep));
  const delayNullViolations = delayNull.filter((dep) =>
    asLowerSet(dep?.debug?.flags).has("delay:rt_equal_confirmed_zero")
  );

  const checks = [
    {
      key: "skipped_stop->cancelled",
      pass: skippedCandidates.length > 0 && skippedViolations.length === 0,
      found: skippedCandidates.length,
      violations: skippedViolations.length,
      sample: skippedViolations.slice(0, 3).map((dep) => dep?.key || dep?.trip_id || null),
    },
    {
      key: "trip_cancelled->cancelled",
      pass: tripCancelledCandidates.length > 0 && tripCancelledViolations.length === 0,
      found: tripCancelledCandidates.length,
      violations: tripCancelledViolations.length,
      sample: tripCancelledViolations.slice(0, 3).map((dep) => dep?.key || dep?.trip_id || null),
    },
    {
      key: "delayMin-null-vs-0",
      pass: delayZeroViolations.length === 0 && delayNullViolations.length === 0,
      found: delayZero.length + delayNull.length,
      violations: delayZeroViolations.length + delayNullViolations.length,
      sample: unique([
        ...delayZeroViolations.slice(0, 2).map((dep) => dep?.key || dep?.trip_id || null),
        ...delayNullViolations.slice(0, 2).map((dep) => dep?.key || dep?.trip_id || null),
      ]).filter(Boolean),
    },
  ];

  return {
    departuresCount: departures.length,
    checks,
    pass: checks.every((check) => check.pass),
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url} ${body.slice(0, 220)}`);
  }
  return res.json();
}

async function tryStationboard(baseUrl, stopId) {
  const url = new URL("/api/stationboard", baseUrl);
  url.searchParams.set("stop_id", stopId);
  url.searchParams.set("limit", String(Number(process.env.M1_SWEEP_LIMIT || "180")));
  url.searchParams.set("debug", "1");
  return fetchJson(url.toString());
}

async function resolveStopId(baseUrl, station) {
  const preferred = normalizeText(station?.preferredStopId);
  if (preferred) {
    try {
      await tryStationboard(baseUrl, preferred);
      return preferred;
    } catch {
      // fallback to search
    }
  }

  const query = normalizeText(station?.searchQuery || station?.label);
  const url = new URL("/api/stops/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");
  const payload = await fetchJson(url.toString());
  const stops = toArray(payload?.stops);

  const parent = stops.find((stop) => normalizeText(stop?.stop_id).startsWith("Parent"));
  const first = parent || stops[0];
  const stopId = normalizeText(first?.stop_id);
  if (!stopId) {
    throw new Error(`no stop_id resolved for station "${station?.label}"`);
  }
  return stopId;
}

function printStationReport(station, resolvedStopId, analysis) {
  const prefix = analysis.pass ? "PASS" : "FAIL";
  console.log(`${prefix} ${station.label} (${resolvedStopId}) departures=${analysis.departuresCount}`);
  for (const check of analysis.checks) {
    const mark = check.pass ? "PASS" : "FAIL";
    const sample = check.sample?.length ? ` sample=${check.sample.join(",")}` : "";
    console.log(
      `  - ${mark} ${check.key} found=${check.found} violations=${check.violations}${sample}`
    );
  }
}

async function main() {
  const baseUrl = normalizeText(process.env.STATIONBOARD_BASE_URL) || "http://localhost:3001";
  const results = [];

  for (const station of STATIONS) {
    try {
      const stopId = await resolveStopId(baseUrl, station);
      const payload = await tryStationboard(baseUrl, stopId);
      const analysis = analyzeStationboard(payload);
      results.push({ station, stopId, analysis, error: null });
      printStationReport(station, stopId, analysis);
    } catch (err) {
      const message = normalizeText(err?.message || err);
      results.push({ station, stopId: null, analysis: null, error: message });
      console.log(`FAIL ${station.label} (unresolved) error=${message}`);
    }
  }

  const failures = results.filter((row) => row.error || row.analysis?.pass !== true);
  const summary = `${results.length - failures.length}/${results.length} stations PASS`;
  console.log(`Summary: ${summary}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`m1 sanity sweep failed: ${normalizeText(err?.message || err)}`);
  process.exit(1);
});

