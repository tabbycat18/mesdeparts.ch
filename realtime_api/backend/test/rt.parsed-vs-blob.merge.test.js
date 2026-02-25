import test from "node:test";
import assert from "node:assert/strict";

import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";
import { applyAddedTrips } from "../src/merge/applyAddedTrips.js";

function normalizeRows(rows = []) {
  return rows
    .map((row) => ({
      trip_id: String(row.trip_id || ""),
      stop_id: String(row.stop_id || ""),
      cancelled: row.cancelled === true,
      delayMin: Number.isFinite(Number(row.delayMin)) ? Number(row.delayMin) : null,
      realtimeDeparture: String(row.realtimeDeparture || ""),
      tags: Array.isArray(row.tags) ? [...row.tags].sort() : [],
    }))
    .sort((a, b) => {
      if (a.trip_id !== b.trip_id) return a.trip_id.localeCompare(b.trip_id);
      return a.stop_id.localeCompare(b.stop_id);
    });
}

function normalizeAdded(rows = []) {
  return rows
    .map((row) => ({
      trip_id: String(row.trip_id || ""),
      stop_id: String(row.stop_id || ""),
      source: String(row.source || ""),
      realtimeDeparture: String(row.realtimeDeparture || ""),
      tags: Array.isArray(row.tags) ? [...row.tags].sort() : [],
    }))
    .sort((a, b) => {
      if (a.trip_id !== b.trip_id) return a.trip_id.localeCompare(b.trip_id);
      return a.stop_id.localeCompare(b.stop_id);
    });
}

test("parsed RT payload produces same merge outcome as blob-style payload for equivalent fixture", () => {
  const now = new Date("2026-02-25T12:00:00.000Z");
  const depT1 = new Date("2026-02-25T12:05:00.000Z");
  const rtDepT1Epoch = Math.floor(new Date("2026-02-25T12:07:00.000Z").getTime() / 1000);
  const addedDepEpoch = Math.floor(new Date("2026-02-25T12:09:00.000Z").getTime() / 1000);

  const baseRows = [
    {
      trip_id: "trip-1",
      route_id: "R1",
      stop_id: "8587387:0:A",
      stop_sequence: 5,
      scheduledDeparture: depT1.toISOString(),
      realtimeDeparture: depT1.toISOString(),
      serviceDate: "20260225",
      delayMin: 0,
      minutesLeft: 0,
      platform: "A",
      platformChanged: false,
      source: "scheduled",
      tags: [],
    },
    {
      trip_id: "trip-2",
      route_id: "R2",
      stop_id: "8587387:0:B",
      stop_sequence: 7,
      scheduledDeparture: new Date("2026-02-25T12:08:00.000Z").toISOString(),
      realtimeDeparture: new Date("2026-02-25T12:08:00.000Z").toISOString(),
      serviceDate: "20260225",
      delayMin: 0,
      minutesLeft: 0,
      platform: "B",
      platformChanged: false,
      source: "scheduled",
      tags: [],
    },
  ];

  const blobTripUpdates = {
    entities: [
      {
        trip_update: {
          trip: {
            trip_id: "trip-1",
            start_date: "20260225",
            schedule_relationship: "SCHEDULED",
          },
          stop_time_update: [
            {
              stop_id: "8587387",
              stop_sequence: 5,
              departure: {
                time: rtDepT1Epoch,
                delay: 120,
              },
              schedule_relationship: "SCHEDULED",
            },
          ],
        },
      },
      {
        trip_update: {
          trip: {
            trip_id: "trip-2",
            start_date: "20260225",
            schedule_relationship: "CANCELED",
          },
          stop_time_update: [
            {
              stop_id: "8587387:0:B",
              stop_sequence: 7,
              schedule_relationship: "SKIPPED",
            },
          ],
        },
      },
      {
        trip_update: {
          trip: {
            trip_id: "trip-added-1",
            route_id: "R9",
            start_date: "20260225",
            schedule_relationship: "ADDED",
          },
          stop_time_update: [
            {
              stop_id: "8587387:0:A",
              stop_sequence: 9,
              departure: {
                time: addedDepEpoch,
                delay: 0,
              },
              schedule_relationship: "SCHEDULED",
            },
          ],
        },
      },
    ],
  };

  const parsedTripUpdates = {
    byKey: {
      "trip-1|8587387|5|20260225": {
        tripId: "trip-1",
        stopId: "8587387",
        rtStopId: "8587387",
        stopSequence: 5,
        delaySec: 120,
        delayMin: 2,
        updatedDepartureEpoch: rtDepT1Epoch,
        tripStartDate: "20260225",
      },
      "trip-1|8587387||20260225": {
        tripId: "trip-1",
        stopId: "8587387",
        rtStopId: "8587387",
        stopSequence: 5,
        delaySec: 120,
        delayMin: 2,
        updatedDepartureEpoch: rtDepT1Epoch,
        tripStartDate: "20260225",
      },
    },
    tripFallbackByTripStart: {
      "trip-1|20260225": [
        {
          tripId: "trip-1",
          tripStartDate: "20260225",
          stopSequence: 5,
          delaySec: 120,
          delayMin: 2,
          updatedDepartureEpoch: rtDepT1Epoch,
        },
      ],
    },
    cancelledTripIds: new Set(["trip-2"]),
    cancelledTripStartDatesByTripId: {
      "trip-2": new Set(["20260225"]),
    },
    stopStatusByKey: {
      "trip-2|8587387:0:B|7|20260225": {
        relationship: "SKIPPED",
        updatedDepartureEpoch: null,
        tripStartDate: "20260225",
      },
    },
    tripFlagsByTripId: {
      "trip-2": {
        hasSuppressedStop: true,
        maxSuppressedStopSequence: 7,
        minSuppressedStopSequence: 7,
        hasUnknownSuppressedSequence: false,
      },
    },
    tripFlagsByTripStartKey: {
      "trip-2|20260225": {
        tripId: "trip-2",
        tripStartDate: "20260225",
        hasSuppressedStop: true,
        maxSuppressedStopSequence: 7,
        minSuppressedStopSequence: 7,
        hasUnknownSuppressedSequence: false,
      },
    },
    addedTripStopUpdates: [
      {
        tripId: "trip-added-1",
        routeId: "R9",
        stopId: "8587387:0:A",
        stopSequence: 9,
        departureEpoch: addedDepEpoch,
        delaySec: 0,
        delayMin: 0,
        tripStartDate: "20260225",
        tripShortName: "",
        tripHeadsign: "",
      },
    ],
  };

  const mergedBlob = applyTripUpdates(baseRows, blobTripUpdates);
  const mergedParsed = applyTripUpdates(baseRows, parsedTripUpdates);
  assert.deepEqual(normalizeRows(mergedParsed), normalizeRows(mergedBlob));

  const addedBlob = applyAddedTrips({
    tripUpdates: blobTripUpdates,
    stationStopIds: ["8587387:0:A", "8587387:0:B"],
    stationName: "Test Station",
    now,
    windowMinutes: 30,
    departedGraceSeconds: 45,
  });
  const addedParsed = applyAddedTrips({
    tripUpdates: parsedTripUpdates,
    stationStopIds: ["8587387:0:A", "8587387:0:B"],
    stationName: "Test Station",
    now,
    windowMinutes: 30,
    departedGraceSeconds: 45,
  });
  assert.deepEqual(normalizeAdded(addedParsed), normalizeAdded(addedBlob));
});
