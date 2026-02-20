import test from "node:test";
import assert from "node:assert/strict";

async function loadMergeDelayIndexes() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://localhost:5432/mesdeparts_test";
  }
  const mod = await import("../loaders/loadRealtime.js");
  return mod.mergeDelayIndexes;
}

function emptyIndex() {
  return {
    byKey: Object.create(null),
    cancelledTripIds: new Set(),
    cancelledTripByStartKey: Object.create(null),
    cancelledTripStartDatesByTripId: Object.create(null),
    stopStatusByKey: Object.create(null),
    tripFlagsByTripId: Object.create(null),
    tripFlagsByTripStartKey: Object.create(null),
    addedTripStopUpdates: [],
  };
}

test("mergeDelayIndexes keeps last-known delay when next poll omits unchanged entity", async () => {
  const mergeDelayIndexes = await loadMergeDelayIndexes();
  const nowMs = Date.now();
  const depEpoch = Math.floor((nowMs + 10 * 60 * 1000) / 1000);
  const previous = emptyIndex();
  previous.byKey["trip-1|8503000:0:2|8|20260216"] = {
    tripId: "trip-1",
    stopId: "8503000:0:2",
    stopSequence: 8,
    delaySec: 180,
    delayMin: 3,
    updatedDepartureEpoch: depEpoch,
    tripStartDate: "20260216",
    _lastSeenAtMs: nowMs - 15_000,
  };

  const merged = mergeDelayIndexes(previous, emptyIndex(), {
    nowMs,
    prevSeenAtMs: nowMs - 15_000,
  });

  assert.ok(merged.byKey["trip-1|8503000:0:2|8|20260216"]);
  assert.equal(merged.byKey["trip-1|8503000:0:2|8|20260216"].delayMin, 3);
});

test("mergeDelayIndexes expires stale rows that are too old after departure", async () => {
  const mergeDelayIndexes = await loadMergeDelayIndexes();
  const nowMs = Date.now();
  const depEpoch = Math.floor((nowMs - 31 * 60 * 1000) / 1000);
  const previous = emptyIndex();
  previous.byKey["trip-2|8503000:0:3|2|20260216"] = {
    tripId: "trip-2",
    stopId: "8503000:0:3",
    stopSequence: 2,
    delaySec: 120,
    delayMin: 2,
    updatedDepartureEpoch: depEpoch,
    tripStartDate: "20260216",
    _lastSeenAtMs: nowMs - 5_000,
  };

  const merged = mergeDelayIndexes(previous, emptyIndex(), {
    nowMs,
    prevSeenAtMs: nowMs - 5_000,
  });

  assert.equal(Object.keys(merged.byKey).length, 0);
});
