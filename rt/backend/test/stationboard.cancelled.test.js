import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";

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
