import test from "node:test";
import assert from "node:assert/strict";

function emptyDelayIndex() {
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

test("stationboard RT loader never fetches upstream TripUpdates and serves stale cache under concurrency", async () => {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";

  const realtime = await import("../loaders/loadRealtime.js");

  realtime.__resetRealtimeDelayIndexCacheForTests();

  const stale = emptyDelayIndex();
  stale.byKey["trip-1|8503000:0:2|3|20260220"] = {
    tripId: "trip-1",
    stopId: "8503000:0:2",
    stopSequence: 3,
    delaySec: 120,
    delayMin: 2,
    updatedDepartureEpoch: Math.floor((Date.now() + 5 * 60_000) / 1000),
    tripStartDate: "20260220",
  };
  realtime.__seedRealtimeDelayIndexCacheForTests(stale, Date.now() - 5 * 60_000);

  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("unexpected_fetch_call");
  };

  try {
    const firstWave = await Promise.all(
      Array.from({ length: 50 }, () =>
        realtime.loadRealtimeDelayIndexOnce({ allowStale: true, maxWaitMs: 0 })
      )
    );

    assert.equal(
      upstreamCalls,
      0,
      "stationboard path must not call upstream TripUpdates directly"
    );
    assert.ok(
      firstWave.every((value) => value?.byKey?.["trip-1|8503000:0:2|3|20260220"]),
      "all concurrent callers should receive stale cache data"
    );
  } finally {
    globalThis.fetch = originalFetch;
    realtime.__resetRealtimeDelayIndexCacheForTests();
  }
});
