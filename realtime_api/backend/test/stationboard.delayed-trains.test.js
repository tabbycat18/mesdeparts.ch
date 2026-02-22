import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";

test("applyTripUpdates: scheduled time in past, realtime in future, row remains visible", () => {
  // REGRESSION TEST for PROBLEM A:
  // A train scheduled to depart at 10:00 UTC, but delayed to 10:30 UTC.
  // At time 10:15 UTC, the scheduled departure is 15 minutes in the past.
  // The train should STILL be in the departures list because realtime shows 10:30.
  //
  // This tests the merge logic side of the fix.
  // The SQL-side fix (increasing PAST_LOOKBACK_MINUTES) ensures the row
  // makes it to applyTripUpdates in the first place.

  const now = new Date("2026-02-16T10:15:00.000Z"); // Current time
  const scheduledTime = new Date("2026-02-16T10:00:00.000Z"); // 15 min in the past
  const realtimeTime = new Date("2026-02-16T10:30:00.000Z"); // Delayed to 10:30

  const baseRows = [
    {
      trip_id: "trip-delayed",
      stop_id: "8503000:0:2",
      stop_sequence: 8,
      category: "R",
      number: "8",
      line: "R8",
      name: "R8",
      destination: "Example Destination",
      operator: "op",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      delayMin: 0,
      minutesLeft: 0,
      platform: "2",
      platformChanged: false,
      source: "scheduled",
      tags: [],
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-delayed",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8503000:0:2",
              stopSequence: 8,
              departure: {
                delay: 1800, // 30 minutes delay
                time: Math.floor(realtimeTime.getTime() / 1000), // 10:30 UTC
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  // The merged row should still exist
  assert.equal(merged.length, 1, "Row should still exist after merge");

  const row = merged[0];

  // Verify scheduled time hasn't changed
  assert.equal(
    row.scheduledDeparture,
    scheduledTime.toISOString(),
    "Scheduled departure unchanged"
  );

  // Verify realtime departure was updated to the delayed time
  assert.equal(
    row.realtimeDeparture,
    realtimeTime.toISOString(),
    "Realtime departure updated to delayed time"
  );

  // Verify delay is correctly computed
  assert.equal(row.delayMin, 30, "Delay should be 30 minutes");

  // Verify source was marked as realtime-matched
  assert.equal(row.source, "tripupdate", "Source should be tripupdate");
  assert.equal(row._rtMatched, true, "RT matched flag should be set");
});

test("applyTripUpdates: scheduled time way in past, realtime still future, shown during grace window", () => {
  // More extreme case: train scheduled 60 minutes ago, delayed to 15 minutes future
  // With PAST_LOOKBACK_MINUTES=60, this row should be fetched by SQL.
  // After merge, it should be included in departures (within grace+window).

  const now = new Date("2026-02-16T11:00:00.000Z");
  const scheduledTime = new Date("2026-02-16T10:00:00.000Z"); // 1 hour in past (60 min before now)
  const realtimeTime = new Date("2026-02-16T11:15:00.000Z"); // 15 min in future (15 min after now)
  // Total delay from scheduled to realtime = 1h + 15m = 75 minutes

  const baseRows = [
    {
      trip_id: "trip-delayed-1h",
      stop_id: "8503000:0:3",
      stop_sequence: 5,
      category: "R",
      number: "12",
      line: "R12",
      name: "R12",
      destination: "Delayed Destination",
      operator: "op",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      delayMin: 0,
      minutesLeft: 0,
      platform: "3",
      platformChanged: false,
      source: "scheduled",
      tags: [],
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-delayed-1h",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8503000:0:3",
              stopSequence: 5,
              departure: {
                delay: 4500, // 75 minutes delay (1h 15m)
                time: Math.floor(realtimeTime.getTime() / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 1, "Row should exist");
  assert.equal(
    merged[0].realtimeDeparture,
    realtimeTime.toISOString(),
    "Realtime should be 1h 15m later"
  );
  assert.equal(merged[0].delayMin, 75, "Delay should be 75 minutes");
});

test("applyTripUpdates: cancelled train with past scheduled time is still marked cancelled", () => {
  // Ensure that cancelled trains scheduled in the past are still properly marked cancelled
  // after the PAST_LOOKBACK_MINUTES increase.

  const now = new Date("2026-02-16T10:20:00.000Z");
  const scheduledTime = new Date("2026-02-16T10:00:00.000Z"); // 20 min in past

  const baseRows = [
    {
      trip_id: "trip-cancelled",
      stop_id: "8503000:0:4",
      stop_sequence: 3,
      category: "R",
      number: "15",
      line: "R15",
      name: "R15",
      destination: "Cancelled Destination",
      operator: "op",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      delayMin: 0,
      minutesLeft: 0,
      platform: "4",
      platformChanged: false,
      source: "scheduled",
      tags: [],
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
              stopId: "8503000:0:4",
              stopSequence: 3,
              departure: {
                delay: 0,
                time: Math.floor(scheduledTime.getTime() / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 1, "Row should exist");
  assert.equal(merged[0].cancelled, true, "Row should be marked cancelled");
  assert.equal(merged[0]._rtMatched, true, "RT matched should be set");
});
