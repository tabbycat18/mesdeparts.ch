import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDeparture } from "../src/models/stationboard.js";

test("normalizeDeparture marks skipped stop as cancelled", () => {
  const dep = normalizeDeparture({
    trip_id: "trip-skip",
    route_id: "route-1",
    stop_id: "8501120:0:3",
    scheduledDeparture: "2026-02-17T04:49:00.000Z",
    realtimeDeparture: "2026-02-17T04:49:00.000Z",
    cancelled: false,
    suppressedStop: true,
    tags: ["skipped_stop"],
    source: "scheduled",
  });

  assert.equal(dep.cancelled, true);
  assert.equal(dep.cancelReasonCode, "SKIPPED_STOP");
  assert.equal(dep.stopEvent, "SKIPPED");
  assert.equal(dep.status, "SKIPPED_STOP");
  assert.ok(dep.flags.includes("STOP_SKIPPED"));
});

test("normalizeDeparture keeps both trip-cancelled and skipped-stop truths", () => {
  const dep = normalizeDeparture({
    trip_id: "trip-both",
    route_id: "route-2",
    stop_id: "8501120:0:4",
    scheduledDeparture: "2026-02-17T05:01:00.000Z",
    realtimeDeparture: "2026-02-17T05:01:00.000Z",
    cancelled: true,
    suppressedStop: true,
    tags: ["skipped_stop"],
    cancelReasons: ["trip_schedule_relationship_canceled"],
    source: "tripupdate",
    _rtMatched: true,
  });

  assert.equal(dep.cancelled, true);
  assert.equal(dep.cancelReasonCode, "CANCELED_TRIP");
  assert.equal(dep.status, "CANCELLED");
  assert.ok(dep.flags.includes("TRIP_CANCELLED"));
  assert.ok(dep.flags.includes("STOP_SKIPPED"));
  assert.equal(dep.stopEvent, "SKIPPED");
});

test("normalizeDeparture delay: realtime missing -> null", () => {
  const dep = normalizeDeparture({
    trip_id: "trip-no-rt",
    stop_id: "8501120:0:5",
    scheduledDeparture: "2026-02-17T05:10:00.000Z",
    realtimeDeparture: null,
    source: "scheduled",
  });

  assert.equal(dep.delayMin, null);
  assert.ok(dep.debug.flags.includes("delay:unknown_no_rt"));
});

test("normalizeDeparture delay: equal schedule with RT-confirmed -> 0", () => {
  const dep = normalizeDeparture({
    trip_id: "trip-on-time-rt",
    stop_id: "8501120:0:6",
    scheduledDeparture: "2026-02-17T05:15:00.000Z",
    realtimeDeparture: "2026-02-17T05:15:00.000Z",
    source: "tripupdate",
    _rtMatched: true,
  });

  assert.equal(dep.delayMin, 0);
  assert.ok(dep.debug.flags.includes("delay:rt_equal_confirmed_zero"));
});

test("normalizeDeparture delay: equal schedule with fallback source -> null", () => {
  const dep = normalizeDeparture({
    trip_id: "trip-fallback",
    stop_id: "8501120:0:7",
    scheduledDeparture: "2026-02-17T05:20:00.000Z",
    realtimeDeparture: "2026-02-17T05:20:00.000Z",
    source: "scheduled",
  });

  assert.equal(dep.delayMin, null);
  assert.ok(dep.debug.flags.includes("delay:unknown_scheduled_fallback"));
});

test("normalizeDeparture delay rounding uses ceil with jitter threshold and no-early clamp", () => {
  const scheduledIso = "2026-02-17T10:00:00.000Z";
  const scheduledMs = Date.parse(scheduledIso);

  const cases = [
    { label: "+120s", deltaSec: 120, expectedDelayMin: 2 },
    { label: "+179s", deltaSec: 179, expectedDelayMin: 3 },
    { label: "+180s", deltaSec: 180, expectedDelayMin: 3 },
    { label: "+181s", deltaSec: 181, expectedDelayMin: 4 },
    { label: "+29s jitter", deltaSec: 29, expectedDelayMin: 0 },
    { label: "-30s early", deltaSec: -30, expectedDelayMin: 0 },
    { label: "-61s early", deltaSec: -61, expectedDelayMin: 0 },
  ];

  for (const item of cases) {
    const dep = normalizeDeparture({
      trip_id: `trip-${item.label}`,
      stop_id: "8501120:0:10",
      scheduledDeparture: scheduledIso,
      realtimeDeparture: new Date(scheduledMs + item.deltaSec * 1000).toISOString(),
      source: "tripupdate",
      _rtMatched: true,
    });
    assert.equal(dep.delayMin, item.expectedDelayMin, item.label);
  }
});

test("normalizeDeparture includes delay computation debug fields only when requested", () => {
  const depWithoutDebug = normalizeDeparture({
    trip_id: "trip-delay-debug-off",
    stop_id: "8501120:0:11",
    scheduledDeparture: "2026-02-17T10:00:00.000Z",
    realtimeDeparture: "2026-02-17T10:02:59.000Z",
    source: "tripupdate",
    _rtMatched: true,
  });
  assert.equal(depWithoutDebug.debug?.delayComputation, undefined);

  const depWithDebug = normalizeDeparture(
    {
      trip_id: "trip-delay-debug-on",
      stop_id: "8501120:0:12",
      scheduledDeparture: "2026-02-17T10:00:00.000Z",
      realtimeDeparture: "2026-02-17T10:02:59.000Z",
      source: "tripupdate",
      _rtMatched: true,
    },
    { includeDelayDebug: true }
  );

  assert.equal(depWithDebug.delayMin, 3);
  assert.equal(depWithDebug.debug?.delayComputation?.sourceUsed, "rt_time_diff");
  assert.equal(
    depWithDebug.debug?.delayComputation?.rawScheduledISO,
    "2026-02-17T10:00:00.000Z"
  );
  assert.equal(
    depWithDebug.debug?.delayComputation?.rawRealtimeISO,
    "2026-02-17T10:02:59.000Z"
  );
  assert.equal(depWithDebug.debug?.delayComputation?.rawScheduledEpochSec, 1771322400);
  assert.equal(depWithDebug.debug?.delayComputation?.rawRealtimeEpochSec, 1771322579);
  assert.equal(depWithDebug.debug?.delayComputation?.rawRtDelaySecUsed, null);
  assert.equal(depWithDebug.debug?.delayComputation?.computedDelaySec, 179);
  assert.equal(depWithDebug.debug?.delayComputation?.computedDelayMinBeforeClamp, 3);
  assert.equal(depWithDebug.debug?.delayComputation?.computedDelayMinAfterClamp, 3);
  assert.equal(depWithDebug.debug?.delayComputation?.roundingMethodUsed, "ceil");

  const depWithDelayFieldDebug = normalizeDeparture(
    {
      trip_id: "trip-delay-debug-delay-field",
      stop_id: "8501120:0:13",
      scheduledDeparture: "2026-02-17T10:00:00.000Z",
      realtimeDeparture: "2026-02-17T10:03:01.000Z",
      source: "tripupdate",
      _rtMatched: true,
      _delaySourceUsed: "rt_delay_field",
      _rawRtDelaySecUsed: 181,
    },
    { includeDelayDebug: true }
  );
  assert.equal(depWithDelayFieldDebug.delayMin, 4);
  assert.equal(depWithDelayFieldDebug.debug?.delayComputation?.sourceUsed, "rt_delay_field");
  assert.equal(depWithDelayFieldDebug.debug?.delayComputation?.rawRtDelaySecUsed, 181);

  const depWithTripFallbackDebug = normalizeDeparture(
    {
      trip_id: "trip-delay-debug-trip-fallback",
      stop_id: "8501120:0:14",
      scheduledDeparture: "2026-02-17T10:00:00.000Z",
      realtimeDeparture: "2026-02-17T10:01:30.000Z",
      source: "tripupdate",
      _rtMatched: true,
      _delaySourceUsed: "rt_trip_fallback_delay_field",
      _rawRtDelaySecUsed: 90,
    },
    { includeDelayDebug: true }
  );
  assert.equal(depWithTripFallbackDebug.delayMin, 2);
  assert.equal(
    depWithTripFallbackDebug.debug?.delayComputation?.sourceUsed,
    "rt_trip_fallback_delay_field"
  );
  assert.equal(depWithTripFallbackDebug.debug?.delayComputation?.rawRtDelaySecUsed, 90);
});
