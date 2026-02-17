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
  assert.equal(merged[0].cancelled, false);
  assert.equal(merged[0].suppressedStop, true);
  assert.ok(Array.isArray(merged[0].tags));
  assert.ok(merged[0].tags.includes("skipped_stop"));
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
  assert.ok(merged[0].tags.includes("short_turn"));
  assert.ok(merged[0].tags.includes("short_turn_terminus"));
});
