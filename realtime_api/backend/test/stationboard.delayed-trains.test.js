import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";

// ---------------------------------------------------------------------------
// Overnight service-date tests (regression for serviceDate fix)
// ---------------------------------------------------------------------------
//
// Swiss overnight buses/trams depart after 24:00 in GTFS (e.g. "25:30:00").
// Their GTFS service date is the *previous* calendar day (e.g. 20260222 for
// a bus running at 01:30 CET on Feb 23).  The RT entity's startDate is also
// 20260222. But `scheduledDeparture` as an ISO string is "2026-02-23T00:30:00Z",
// so `ymdZurichFromIso()` would return "20260223" — causing a date mismatch.
//
// The fix: buildStationboard now sets `row.serviceDate = "20260222"` from the
// SQL-side `_service_date_int`, and applyTripUpdates prefers that value.

test("applyTripUpdates: overnight trip WITH serviceDate matches RT entity on correct service date", () => {
  // GTFS departure_time "25:30:00" on service date 20260222 →
  // actual ISO departure is "2026-02-23T00:30:00.000Z" (01:30 CET).
  // RT entity startDate = "20260222".  serviceDate = "20260222" should match.

  const scheduledTime = new Date("2026-02-23T00:30:00.000Z"); // 01:30 CET, after midnight
  const realtimeTime  = new Date("2026-02-23T00:32:00.000Z"); // 2-minute delay

  const baseRows = [
    {
      trip_id: "overnight-trip",
      stop_id: "8587387",
      stop_sequence: 5,
      category: "B",
      number: "12",
      line: "12",
      name: "12",
      destination: "Genève, Cornavin",
      operator: "TPG",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      serviceDate: "20260222", // ← GTFS service date (Feb 22), NOT the calendar date
      delayMin: 0,
      minutesLeft: 0,
      platform: "",
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
            tripId: "overnight-trip",
            startDate: "20260222", // RT service date matches
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8587387",
              stopSequence: 5,
              departure: {
                delay: 120, // 2 minutes
                time: Math.floor(realtimeTime.getTime() / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 1);
  const row = merged[0];
  assert.equal(row._rtMatched, true, "RT should have matched using serviceDate");
  assert.equal(row.delayMin, 2, "Should show 2-minute delay");
  assert.equal(
    row.realtimeDeparture,
    realtimeTime.toISOString(),
    "Realtime departure should reflect the delay"
  );
});

test("applyTripUpdates: overnight trip WITHOUT serviceDate fails to match RT entity on previous service date", () => {
  // Regression guard: without the fix (no serviceDate field), ymdZurichFromIso
  // of "2026-02-23T00:30:00Z" returns "20260223", but RT startDate is "20260222".
  // The RT entity should NOT be matched.

  const scheduledTime = new Date("2026-02-23T00:30:00.000Z");
  const realtimeTime  = new Date("2026-02-23T00:32:00.000Z");

  const baseRows = [
    {
      trip_id: "overnight-trip-no-svcdate",
      stop_id: "8587387",
      stop_sequence: 5,
      category: "B",
      number: "12",
      line: "12",
      name: "12",
      destination: "Genève, Cornavin",
      operator: "TPG",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      // serviceDate intentionally omitted → falls back to ymdZurichFromIso → "20260223"
      delayMin: 0,
      minutesLeft: 0,
      platform: "",
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
            tripId: "overnight-trip-no-svcdate",
            startDate: "20260222", // RT service date is Feb 22 — won't match "20260223"
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8587387",
              stopSequence: 5,
              departure: {
                delay: 120,
                time: Math.floor(realtimeTime.getTime() / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 1);
  const row = merged[0];
  assert.equal(
    row._rtMatched,
    false,
    "Without serviceDate the date is wrong (20260223 vs 20260222) → no RT match"
  );
  assert.equal(row.delayMin, 0, "No delay should be applied without the fix");
});

test("applyTripUpdates: daytime trip WITHOUT serviceDate still matches correctly (unchanged behaviour)", () => {
  // Daytime departure: scheduledDeparture is on the same calendar day as the
  // GTFS service date.  ymdZurichFromIso gives the correct date regardless of
  // whether serviceDate is supplied, so existing behaviour is preserved.

  const scheduledTime = new Date("2026-02-22T13:30:00.000Z"); // 14:30 CET, daytime
  const realtimeTime  = new Date("2026-02-22T13:33:00.000Z"); // 3-minute delay

  const baseRows = [
    {
      trip_id: "daytime-trip",
      stop_id: "8587387",
      stop_sequence: 3,
      category: "B",
      number: "7",
      line: "7",
      name: "7",
      destination: "Genève, Bachet-de-Pesay",
      operator: "TPG",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      // No serviceDate — old code path via ymdZurichFromIso → "20260222"
      delayMin: 0,
      minutesLeft: 0,
      platform: "",
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
            tripId: "daytime-trip",
            startDate: "20260222",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8587387",
              stopSequence: 3,
              departure: {
                delay: 180, // 3 minutes
                time: Math.floor(realtimeTime.getTime() / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);

  assert.equal(merged.length, 1);
  const row = merged[0];
  assert.equal(row._rtMatched, true, "Daytime trip should match RT without serviceDate");
  assert.equal(row.delayMin, 3, "Should show 3-minute delay");
});

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
