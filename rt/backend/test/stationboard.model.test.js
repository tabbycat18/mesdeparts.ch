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
