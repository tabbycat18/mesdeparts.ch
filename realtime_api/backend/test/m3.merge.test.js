import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";
import { applyAddedTrips } from "../src/merge/applyAddedTrips.js";
import { synthesizeFromAlerts } from "../src/merge/synthesizeFromAlerts.js";

test("applyTripUpdates marks skipped stop suppression and short-turn tags", () => {
  const baseRows = [
    {
      trip_id: "trip-skip-here",
      stop_id: "8501120:0:3",
      stop_sequence: 5,
      scheduledDeparture: "2026-02-16T23:00:00.000Z",
      realtimeDeparture: "2026-02-16T23:00:00.000Z",
      delayMin: 0,
    },
    {
      trip_id: "trip-short-turn",
      stop_id: "8501120:0:4",
      stop_sequence: 2,
      scheduledDeparture: "2026-02-16T23:05:00.000Z",
      realtimeDeparture: "2026-02-16T23:05:00.000Z",
      delayMin: 0,
    },
    {
      trip_id: "trip-no-data",
      stop_id: "8501120:0:5",
      stop_sequence: 3,
      scheduledDeparture: "2026-02-16T23:07:00.000Z",
      realtimeDeparture: "2026-02-16T23:07:00.000Z",
      delayMin: 0,
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-skip-here",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:3",
              stopSequence: 5,
              scheduleRelationship: "SKIPPED",
              departure: { time: 1771282800 },
            },
          ],
        },
      },
      {
        tripUpdate: {
          trip: {
            tripId: "trip-short-turn",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:9",
              stopSequence: 6,
              scheduleRelationship: "SKIPPED",
              departure: { time: 1771283100 },
            },
          ],
        },
      },
      {
        tripUpdate: {
          trip: {
            tripId: "trip-no-data",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:5",
              stopSequence: 3,
              scheduleRelationship: "NO_DATA",
              departure: { time: 1771283200 },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 3);

  const skipped = merged.find((row) => row.trip_id === "trip-skip-here");
  const shortTurn = merged.find((row) => row.trip_id === "trip-short-turn");
  const noData = merged.find((row) => row.trip_id === "trip-no-data");
  assert.ok(skipped);
  assert.ok(shortTurn);
  assert.ok(noData);

  assert.equal(skipped.suppressedStop, true);
  assert.ok(skipped.tags.includes("skipped_stop"));
  assert.equal(skipped.cancelled, true);
  assert.equal(skipped.source, "tripupdate");

  assert.equal(shortTurn.suppressedStop, false);
  assert.ok(shortTurn.tags.includes("short_turn"));
  assert.equal(noData.suppressedStop, false);
  assert.equal(noData.tags.includes("skipped_stop"), false);
});

test("applyTripUpdates delay source preference: departure.time first, then departure.delay fallback", () => {
  const baseRows = [
    {
      trip_id: "trip-delay-source",
      stop_id: "8501120:0:3",
      stop_sequence: 5,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
  ];

  const byKeyTimePreferred = {
    byKey: {
      "trip-delay-source|8501120:0:3|5": {
        updatedDepartureEpoch: Math.floor(
          Date.parse("2026-02-20T10:02:59.000Z") / 1000
        ),
        delaySec: 300,
        delayMin: 5,
      },
    },
    cancelledTripIds: new Set(),
    cancelledTripStartDatesByTripId: Object.create(null),
    stopStatusByKey: Object.create(null),
    tripFlagsByTripId: Object.create(null),
    tripFlagsByTripStartKey: Object.create(null),
  };

  const mergedTimePreferred = applyTripUpdates(baseRows, byKeyTimePreferred);
  assert.equal(mergedTimePreferred[0].delayMin, 3);
  assert.equal(
    mergedTimePreferred[0].realtimeDeparture,
    "2026-02-20T10:02:59.000Z"
  );
  assert.equal(mergedTimePreferred[0]._delaySourceUsed, "rt_time_diff");

  const byKeyDelayFallback = {
    byKey: {
      "trip-delay-source|8501120:0:3|5": {
        updatedDepartureEpoch: Math.floor(
          Date.parse("2026-02-20T18:00:00.000Z") / 1000
        ),
        delaySec: 181,
        delayMin: 4,
      },
    },
    cancelledTripIds: new Set(),
    cancelledTripStartDatesByTripId: Object.create(null),
    stopStatusByKey: Object.create(null),
    tripFlagsByTripId: Object.create(null),
    tripFlagsByTripStartKey: Object.create(null),
  };

  const mergedDelayFallback = applyTripUpdates(baseRows, byKeyDelayFallback);
  assert.equal(
    mergedDelayFallback[0].realtimeDeparture,
    "2026-02-20T10:03:01.000Z"
  );
  assert.equal(mergedDelayFallback[0].delayMin, 4);
  assert.equal(mergedDelayFallback[0]._delaySourceUsed, "rt_delay_field");
});

test("applyTripUpdates matches RT even when stop_sequence drifts (trip+stop fallback)", () => {
  const baseRows = [
    {
      trip_id: "trip-seq-drift",
      stop_id: "8591988:0:C",
      stop_sequence: 11,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-seq-drift",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8591988:0:C",
              stopSequence: 12,
              departure: {
                time: Math.floor(Date.parse("2026-02-20T10:02:59.000Z") / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._rtMatched, true);
  assert.equal(merged[0]._rtMatchReason, "stop_noseq");
  assert.equal(merged[0].source, "tripupdate");
  assert.equal(merged[0].realtimeDeparture, "2026-02-20T10:02:59.000Z");
  assert.equal(merged[0].delayMin, 3);
});

test("applyTripUpdates falls back to nearest trip stop delay when stop-level update is missing", () => {
  const baseRows = [
    {
      trip_id: "trip-missing-stop-update",
      stop_id: "8591988:0:A",
      stop_sequence: 15,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-missing-stop-update",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8579254:0:A",
              stopSequence: 14,
              departure: { delay: 90 },
            },
            {
              stopId: "8592004:0:10001",
              stopSequence: 18,
              departure: { delay: 102 },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._rtMatched, true);
  assert.equal(merged[0]._rtMatchReason, "trip_fallback");
  assert.equal(merged[0].source, "tripupdate");
  assert.equal(merged[0].delayMin, 2);
  assert.equal(merged[0].realtimeDeparture, "2026-02-20T10:01:30.000Z");
  assert.equal(merged[0]._delaySourceUsed, "rt_trip_fallback_delay_field");
  assert.equal(merged[0]._rawRtDelaySecUsed, 90);
});

test("applyTripUpdates matches stop variant without sequence as stop_noseq", () => {
  const baseRows = [
    {
      trip_id: "trip-stop-variant-noseq",
      stop_id: "8591988:0:C",
      stop_sequence: 11,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-stop-variant-noseq",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8591988:0",
              departure: { delay: 126 },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._rtMatched, true);
  assert.equal(merged[0]._rtMatchReason, "stop_noseq");
  assert.equal(merged[0].source, "tripupdate");
  assert.equal(merged[0].delayMin, 3);
  assert.equal(merged[0]._delaySourceUsed, "rt_delay_field");
  assert.equal(merged[0]._rawRtDelaySecUsed, 126);
});

// ---------------------------------------------------------------------------
// Regression B: numeric root (parent) stop ID matching
// ---------------------------------------------------------------------------
//
// Swiss static GTFS uses child stop IDs like "8587387:0:A" (platform-level),
// while RT feeds often publish the parent/numeric stop ID "8587387".
// applyTripUpdates must match across this boundary.
//
// Also includes a negative test to confirm a *different* numeric root (a
// distinct station) does NOT produce a false match.

test("applyTripUpdates: GTFS child stop '8587387:0:A' matches RT numeric root '8587387' (platform/parent variant)", () => {
  const scheduledTime = new Date("2026-02-22T10:00:00.000Z");
  const realtimeTime  = new Date("2026-02-22T10:02:00.000Z"); // 2-min delay

  const baseRows = [
    {
      trip_id: "trip-bel-air",
      stop_id: "8587387:0:A",      // child stop from static GTFS
      stop_sequence: 5,
      category: "B",
      number: "3",
      line: "3",
      name: "3",
      destination: "Genève, Nations",
      operator: "TPG",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      serviceDate: "20260222",
      delayMin: 0,
      minutesLeft: 0,
      platform: "A",
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
            tripId: "trip-bel-air",
            startDate: "20260222",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8587387",    // numeric root from RT feed
              stopSequence: 5,
              departure: {
                delay: 120,         // 2 minutes
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
  assert.equal(row._rtMatched, true,  "GTFS child stop must match RT numeric root");
  assert.equal(row.delayMin, 2,       "2-minute delay should be applied");
  assert.equal(
    row.realtimeDeparture,
    realtimeTime.toISOString(),
    "realtimeDeparture must reflect the delay"
  );
  assert.equal(row.source, "tripupdate");
});

test("applyTripUpdates: numeric root 8587388 does NOT match scheduled child stop 8587387:0:A (negative guard)", () => {
  // "8587388" is a different station than "8587387".
  // Stop-level matching must be exact per variant — wrong root must not match.
  //
  // NOTE: The trip-fallback mechanism (propagates delay to nearby stop_sequences)
  // is intentionally avoided here by placing the RT stop_sequence far outside
  // the default gap window (RT_TRIP_FALLBACK_MAX_SEQ_GAP = 4):
  //   |50 - 5| = 45  →  no trip-fallback match either.
  const scheduledTime = new Date("2026-02-22T10:00:00.000Z");

  const baseRows = [
    {
      trip_id: "trip-bel-air-neg",
      stop_id: "8587387:0:A",
      stop_sequence: 5,
      category: "B",
      number: "3",
      line: "3",
      name: "3",
      destination: "Genève, Nations",
      operator: "TPG",
      scheduledDeparture: scheduledTime.toISOString(),
      realtimeDeparture: scheduledTime.toISOString(),
      serviceDate: "20260222",
      delayMin: 0,
      minutesLeft: 0,
      platform: "A",
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
            tripId: "trip-bel-air-neg",
            startDate: "20260222",
            scheduleRelationship: "SCHEDULED",
          },
          stopTimeUpdate: [
            {
              stopId: "8587388",    // DIFFERENT numeric root — wrong station
              stopSequence: 50,     // far from seq 5 → trip-fallback gap 45 > max(4) → no fallback
              departure: {
                delay: 120,
                time: Math.floor(new Date("2026-02-22T10:02:00.000Z").getTime() / 1000),
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
  assert.equal(row._rtMatched, false, "Different numeric root must NOT produce stop-level match");
  assert.equal(row.delayMin, 0,       "No delay should be applied for wrong station");
  assert.equal(row.source, "scheduled");
});

test("applyTripUpdates marks platformChanged when RT stop_id points to another platform", () => {
  const baseRows = [
    {
      trip_id: "trip-platform-change",
      stop_id: "8501120:0:3",
      stop_sequence: 5,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
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
            tripId: "trip-platform-change",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:4",
              stopSequence: 5,
              departure: {
                time: Math.floor(Date.parse("2026-02-20T10:02:00.000Z") / 1000),
              },
            },
          ],
        },
      },
    ],
  };

  const platformByStopId = new Map([
    ["8501120:0:3", "3"],
    ["8501120:0:4", "4"],
  ]);

  const merged = applyTripUpdates(baseRows, tripUpdates, { platformByStopId });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._rtMatched, true);
  assert.equal(merged[0].platform, "4");
  assert.equal(merged[0].platformChanged, true);
  assert.equal(merged[0].source, "tripupdate");
});

test("applyTripUpdates preserves realtimeDeparture for early/jitter while keeping display delay clamped", () => {
  const baseRows = [
    {
      trip_id: "trip-early-clamp",
      stop_id: "8591988:0:A",
      stop_sequence: 15,
      scheduledDeparture: "2026-02-20T10:00:00.000Z",
      realtimeDeparture: "2026-02-20T10:00:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
    {
      trip_id: "trip-jitter-clamp",
      stop_id: "8591988:0:B",
      stop_sequence: 12,
      scheduledDeparture: "2026-02-20T10:01:00.000Z",
      realtimeDeparture: "2026-02-20T10:01:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
    {
      trip_id: "trip-early-subminute-clamp",
      stop_id: "8591988:0:C",
      stop_sequence: 9,
      scheduledDeparture: "2026-02-20T10:02:00.000Z",
      realtimeDeparture: "2026-02-20T10:02:00.000Z",
      delayMin: 0,
      source: "scheduled",
    },
  ];

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "trip-early-clamp",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8591988:0:A",
              stopSequence: 15,
              departure: { delay: -61 },
            },
          ],
        },
      },
      {
        tripUpdate: {
          trip: {
            tripId: "trip-jitter-clamp",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8591988:0:B",
              stopSequence: 12,
              departure: { delay: 20 },
            },
          ],
        },
      },
      {
        tripUpdate: {
          trip: {
            tripId: "trip-early-subminute-clamp",
            scheduleRelationship: "SCHEDULED",
            startDate: "20260220",
          },
          stopTimeUpdate: [
            {
              stopId: "8591988:0:C",
              stopSequence: 9,
              departure: { delay: -30 },
            },
          ],
        },
      },
    ],
  };

  const merged = applyTripUpdates(baseRows, tripUpdates);
  const early = merged.find((row) => row.trip_id === "trip-early-clamp");
  const jitter = merged.find((row) => row.trip_id === "trip-jitter-clamp");
  const earlySubMinute = merged.find((row) => row.trip_id === "trip-early-subminute-clamp");

  assert.equal(early.delayMin, 0);
  assert.equal(early.realtimeDeparture, "2026-02-20T09:58:59.000Z");
  assert.equal(jitter.delayMin, 0);
  assert.equal(jitter.realtimeDeparture, "2026-02-20T10:01:20.000Z");
  assert.equal(earlySubMinute.delayMin, 0);
  assert.equal(earlySubMinute.realtimeDeparture, "2026-02-20T10:01:30.000Z");
});

test("applyAddedTrips emits only ADDED stop_time_updates matching station scope", () => {
  const now = new Date("2026-02-16T23:55:00.000Z");
  const depEpoch = Math.floor(now.getTime() / 1000) + 4 * 60;

  const tripUpdates = {
    entities: [
      {
        tripUpdate: {
          trip: {
            tripId: "added-trip-1",
            routeId: "EV1",
            scheduleRelationship: "ADDED",
            tripHeadsign: "Replacement service",
          },
          stopTimeUpdate: [
            {
              stopId: "8501120:0:3",
              stopSequence: 1,
              departure: { time: depEpoch },
            },
            {
              stopId: "8501120:0:9",
              stopSequence: 2,
              scheduleRelationship: "SKIPPED",
              departure: { time: depEpoch + 120 },
            },
          ],
        },
      },
    ],
  };

  const out = applyAddedTrips({
    tripUpdates,
    stationStopIds: ["Parent8501120", "8501120:0:3"],
    platformByStopId: new Map([["8501120:0:3", "3"]]),
    stationName: "Lausanne",
    now,
    windowMinutes: 30,
    departedGraceSeconds: 45,
    limit: 20,
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].source, "rt_added");
  assert.equal(out[0].trip_id, "added-trip-1");
  assert.equal(out[0].stop_id, "8501120:0:3");
  assert.ok(out[0].tags.includes("replacement"));
});

test("synthesizeFromAlerts only creates rows when explicit timing exists", () => {
  const now = new Date("2026-02-16T20:00:00.000Z");

  const alerts = {
    entities: [
      {
        id: "a1",
        effect: "MODIFIED_SERVICE",
        headerText: "Rail replacement buses at 21:03",
        descriptionText: "Replacement between A and B",
        activePeriods: [{ start: null, end: null }],
        informedEntities: [{ stop_id: "Parent8501120", route_id: "EV" }],
      },
      {
        id: "a2",
        effect: "MODIFIED_SERVICE",
        headerText: "No timing available",
        descriptionText: "Replacement",
        activePeriods: [{ start: null, end: null }],
        informedEntities: [{ stop_id: "Parent8501120", route_id: "EV" }],
      },
      {
        id: "a3",
        effect: "MODIFIED_SERVICE",
        headerText: "Structured replacement",
        descriptionText: "EV replacement",
        departureTimestamp: Math.floor(new Date("2026-02-16T20:11:00.000Z").getTime() / 1000),
        activePeriods: [{ start: null, end: null }],
        informedEntities: [{ stop_id: "ch:1:sloid:1120", route_id: "EV" }],
      },
    ],
  };

  const synthetic = synthesizeFromAlerts({
    alerts,
    stopId: "Parent8501120",
    departures: [],
    stationName: "Lausanne",
    now,
    windowMinutes: 60,
  });

  assert.equal(synthetic.length, 2);
  assert.ok(synthetic.every((row) => row.source === "synthetic_alert"));
  assert.ok(synthetic.every((row) => row.tags.includes("replacement")));
  const ids = new Set(synthetic.map((row) => row.trip_id.split(":")[1]));
  assert.equal(ids.has("a1"), true);
  assert.equal(ids.has("a2"), false);
  assert.equal(ids.has("a3"), true);
});

test("synthesizeFromAlerts keeps banner-like alerts out of departures when no explicit times", () => {
  const now = new Date("2026-02-16T20:00:00.000Z");
  const alerts = {
    entities: [
      {
        id: "no-stop-global",
        effect: "MODIFIED_SERVICE",
        headerText: "Der Bahnverkehr zwischen Liestal und Muttenz ist eingeschränkt.",
        descriptionText: "Ersatzverkehr",
        activePeriods: [{ start: new Date("2026-02-16T20:05:00.000Z"), end: null }],
        informedEntities: [{ route_id: "" }],
      },
      {
        id: "no-stop-route-overlap",
        effect: "MODIFIED_SERVICE",
        headerText: "Route-specific issue",
        descriptionText: "Ersatzverkehr",
        activePeriods: [{ start: new Date("2026-02-16T20:06:00.000Z"), end: null }],
        informedEntities: [{ route_id: "EV" }],
      },
      {
        id: "no-stop-station-hit",
        effect: "MODIFIED_SERVICE",
        headerText: "Der Bahnverkehr zwischen Lausanne und Renens VD ist eingeschränkt.",
        descriptionText: "Ersatzverkehr",
        activePeriods: [{ start: new Date("2026-02-16T20:07:00.000Z"), end: null }],
        informedEntities: [{ route_id: "" }],
      },
    ],
  };

  const synthetic = synthesizeFromAlerts({
    alerts,
    stopId: "Parent8501120",
    departures: [{ route_id: "EV", stop_id: "8501120:0:1" }],
    stationName: "Lausanne",
    now,
    windowMinutes: 60,
  });

  assert.equal(synthetic.length, 0);
});
