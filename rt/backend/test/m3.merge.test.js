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
  assert.equal(skipped.source, "scheduled");

  assert.equal(shortTurn.suppressedStop, false);
  assert.ok(shortTurn.tags.includes("short_turn"));
  assert.equal(noData.suppressedStop, false);
  assert.equal(noData.tags.includes("skipped_stop"), false);
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

test("synthesizeFromAlerts only creates timed replacement/extra candidates", () => {
  const now = new Date("2026-02-16T20:00:00.000Z");

  const alerts = {
    entities: [
      {
        id: "a1",
        effect: "MODIFIED_SERVICE",
        headerText: "Rail replacement buses",
        descriptionText: "Replacement between A and B",
        activePeriods: [{ start: new Date("2026-02-16T20:03:00.000Z"), end: null }],
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
        headerText: "SLOID replacement",
        descriptionText: "EV replacement",
        activePeriods: [{ start: new Date("2026-02-16T19:08:00.000Z"), end: null }],
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

  assert.equal(synthetic.length, 3);
  assert.ok(synthetic.every((row) => row.source === "synthetic_alert"));
  assert.ok(synthetic.every((row) => row.tags.includes("replacement")));
  assert.ok(synthetic.some((row) => row.line === "EV"));
});

test("synthesizeFromAlerts does not fallback stopless alerts without station signal", () => {
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

  const ids = new Set(synthetic.map((row) => row.trip_id.split(":")[1]));
  assert.equal(ids.has("no-stop-global"), false);
  assert.equal(ids.has("no-stop-route-overlap"), true);
  assert.equal(ids.has("no-stop-station-hit"), true);
});
