import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";
import { pickPreferredMergedDeparture } from "../src/merge/pickPreferredDeparture.js";

test("applyTripUpdates adds cancelled flag using trip schedule_relationship", () => {
  const baseRows = [
    {
      trip_id: "trip-cancelled",
      stop_id: "8503000:0:2",
      stop_sequence: 8,
      category: "R",
      number: "8",
      line: "R8",
      name: "R8",
      destination: "Sample Destination",
      operator: "op",
      scheduledDeparture: "2026-02-16T10:00:00.000Z",
      realtimeDeparture: "2026-02-16T10:00:00.000Z",
      delayMin: 0,
      minutesLeft: 0,
      platform: "2",
      platformChanged: false,
    },
    {
      trip_id: "trip-normal",
      stop_id: "8503000:0:3",
      stop_sequence: 2,
      category: "R",
      number: "10",
      line: "R10",
      name: "R10",
      destination: "Other Destination",
      operator: "op",
      scheduledDeparture: "2026-02-16T10:05:00.000Z",
      realtimeDeparture: "2026-02-16T10:05:00.000Z",
      delayMin: 0,
      minutesLeft: 0,
      platform: "3",
      platformChanged: false,
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-cancelled",
            scheduleRelationship: "CANCELED",
          },
          stopTimeUpdate: [
            {
              stopId: "8503000:0:2",
              stopSequence: 8,
              departure: {
                delay: 180,
                time: 1760954580,
              },
            },
          ],
        },
      },
      {
        tripUpdate: {
          trip: {
            tripId: "trip-normal",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8503000:0:3",
              stopSequence: 2,
              departure: {
                delay: 0,
                time: 1760954700,
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].cancelled, true);
  assert.equal(merged[1].cancelled, false);
  assert.ok(merged[0].cancelReasons.includes("trip_schedule_relationship_canceled"));

  // Existing shape is preserved.
  assert.equal(merged[0].trip_id, "trip-cancelled");
  assert.equal(typeof merged[0].scheduledDeparture, "string");
  assert.equal(typeof merged[0].realtimeDeparture, "string");
  assert.equal(typeof merged[0].delayMin, "number");
  assert.equal(typeof merged[0].platformChanged, "boolean");
});

test("applyTripUpdates marks suppressed stop for SKIPPED stop_time_update", () => {
  const baseRows = [
    {
      trip_id: "trip-skip",
      stop_id: "8503000:0:2",
      stop_sequence: 8,
      category: "R",
      number: "8",
      line: "R8",
      name: "R8",
      destination: "Sample Destination",
      operator: "op",
      scheduledDeparture: "2026-02-16T10:00:00.000Z",
      realtimeDeparture: "2026-02-16T10:00:00.000Z",
      delayMin: 0,
      minutesLeft: 0,
      platform: "2",
      platformChanged: false,
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-skip",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8503000:0:2",
              stopSequence: 8,
              scheduleRelationship: "SKIPPED",
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cancelled, true);
  assert.equal(merged[0].suppressedStop, true);
  assert.equal(merged[0].source, "tripupdate");
  assert.ok(Array.isArray(merged[0].tags));
  assert.ok(merged[0].tags.includes("skipped_stop"));
  assert.ok(merged[0].cancelReasons.includes("skipped_stop"));
});

test("applyTripUpdates ignores trip-level cancellation when start_date is for another service day", () => {
  const baseRows = [
    {
      trip_id: "trip-startdate-safe",
      stop_id: "8503000:0:2",
      stop_sequence: 8,
      scheduledDeparture: "2026-02-16T10:00:00.000Z",
      realtimeDeparture: "2026-02-16T10:00:00.000Z",
      delayMin: 0,
      cancelled: false,
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-startdate-safe",
            startDate: "20260217",
            scheduleRelationship: "CANCELED",
          },
          stopTimeUpdate: [],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cancelled, false);
  assert.ok(
    !Array.isArray(merged[0].cancelReasons) ||
      !merged[0].cancelReasons.includes("trip_schedule_relationship_canceled")
  );
});

test("dedupe preference keeps cancelled departure when duplicates collide", () => {
  const active = {
    trip_id: "trip-dup",
    stop_id: "8503000:0:2",
    stop_sequence: 8,
    scheduledDeparture: "2026-02-16T10:00:00.000Z",
    realtimeDeparture: "2026-02-16T10:00:00.000Z",
    cancelled: false,
    suppressedStop: false,
  };
  const cancelled = {
    ...active,
    cancelled: true,
    suppressedStop: true,
  };

  assert.equal(pickPreferredMergedDeparture(active, cancelled), cancelled);
  assert.equal(pickPreferredMergedDeparture(cancelled, active), cancelled);

  const byKey = new Map();
  for (const row of [active, cancelled]) {
    const key = `${row.trip_id}|${row.stop_id}|${row.stop_sequence}|${row.scheduledDeparture}`;
    const previous = byKey.get(key);
    byKey.set(key, pickPreferredMergedDeparture(previous, row));
  }

  const dedupedSorted = Array.from(byKey.values()).sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    return aMs - bMs;
  });

  assert.equal(dedupedSorted.length, 1);
  assert.equal(dedupedSorted[0].trip_id, "trip-dup");
  assert.equal(dedupedSorted[0].cancelled, true);
});

test("dedupe preference keeps replacement EV row when same-minute keys collide", () => {
  const scheduled = {
    trip_id: "trip-ev-collision",
    stop_id: "8503000:0:2",
    stop_sequence: 8,
    scheduledDeparture: "2026-02-16T10:00:00.000Z",
    realtimeDeparture: "2026-02-16T10:00:00.000Z",
    delayMin: 0,
    source: "scheduled",
    tags: [],
    cancelled: false,
    suppressedStop: false,
    line: "17",
  };
  const replacement = {
    ...scheduled,
    source: "rt_added",
    line: "EV1",
    tags: ["replacement"],
  };

  const byKey = new Map();
  for (const row of [scheduled, replacement]) {
    const key = `${row.trip_id}|${row.stop_id}|${row.stop_sequence}|${row.scheduledDeparture}`;
    const previous = byKey.get(key);
    byKey.set(key, pickPreferredMergedDeparture(previous, row));
  }

  const out = Array.from(byKey.values());
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "rt_added");
  assert.equal(out[0].line, "EV1");
  assert.ok(out[0].tags.includes("replacement"));
});

test("applyTripUpdates cancels row when suppression starts at next stop", () => {
  const baseRows = [
    {
      trip_id: "trip-short-turn-terminus",
      stop_id: "8501120:0:8",
      stop_sequence: 8,
      scheduledDeparture: "2026-02-17T04:49:00.000Z",
      realtimeDeparture: "2026-02-17T04:49:00.000Z",
      delayMin: 0,
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-short-turn-terminus",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:8",
              stopSequence: 8,
              scheduleRelationship: "SCHEDULED",
            },
            {
              stopId: "8501118:0:2",
              stopSequence: 9,
              scheduleRelationship: "SKIPPED",
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].suppressedStop, false);
  assert.equal(merged[0].cancelled, true);
  assert.ok(merged[0].cancelReasons.includes("short_turn_terminus_next_stop_skipped"));
  assert.ok(merged[0].tags.includes("short_turn"));
  assert.ok(merged[0].tags.includes("short_turn_terminus"));
});
