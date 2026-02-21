import test from "node:test";
import assert from "node:assert/strict";

async function loadScopedRtFromCacheFn() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://localhost:5432/mesdeparts_test";
  }
  const mod = await import("../src/rt/loadScopedRtFromCache.js");
  return mod.loadScopedRtFromCache;
}

function makeCachePayload({
  hasPayload = true,
  decodeError = null,
  fetchedAtMs = Date.now(),
  entities = [],
} = {}) {
  return {
    hasPayload,
    decodeError,
    fetchedAtMs,
    lastStatus: 200,
    lastError: null,
    etag: "etag-1",
    feed: {
      entities,
      entity: entities,
    },
  };
}

test("loadScopedRtFromCache returns disabled reason when RT is disabled", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const out = await loadScopedRtFromCache({
    enabled: false,
    readCacheLike: async () => {
      throw new Error("must_not_read");
    },
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "disabled");
  assert.equal(Array.isArray(out.tripUpdates.entities), true);
  assert.equal(out.tripUpdates.entities.length, 0);
});

test("loadScopedRtFromCache returns missing_cache when cache has no payload", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const out = await loadScopedRtFromCache({
    enabled: true,
    readCacheLike: async () => makeCachePayload({ hasPayload: false, entities: [] }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "missing_cache");
});

test("loadScopedRtFromCache returns stale_cache when payload is too old", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const nowMs = Date.now();
  const out = await loadScopedRtFromCache({
    enabled: true,
    nowMs,
    readCacheLike: async () =>
      makeCachePayload({
        fetchedAtMs: nowMs - 60_000,
        entities: [
          {
            id: "stale-entity",
            trip_update: {
              trip: { trip_id: "trip-stale" },
              stop_time_update: [],
            },
          },
        ],
      }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "stale_cache");
});

test("loadScopedRtFromCache returns decode_failed when decode failed", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const out = await loadScopedRtFromCache({
    enabled: true,
    readCacheLike: async () =>
      makeCachePayload({
        decodeError: new Error("decode_failed"),
        entities: [],
      }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "decode_failed");
});

test("loadScopedRtFromCache returns guard_tripped when scanned entity limit is exceeded", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const entities = new Array(250).fill(null).map((_, idx) => ({
    id: String(idx),
    trip_update: {
      trip: {
        trip_id: `trip-${idx}`,
      },
      stop_time_update: [],
    },
  }));

  const out = await loadScopedRtFromCache({
    enabled: true,
    maxScannedEntities: 100,
    readCacheLike: async () => makeCachePayload({ entities }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "guard_tripped");
});

test("loadScopedRtFromCache applies scoped filtering by trip/stop/window", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const entities = [
    {
      id: "hit-trip",
      trip_update: {
        trip: {
          trip_id: "trip-keep",
          schedule_relationship: "SCHEDULED",
        },
        stop_time_update: [
          {
            stop_id: "8503000:0:1",
            stop_sequence: 5,
            departure: {
              time: nowSec + 180,
              delay: 120,
            },
          },
        ],
      },
    },
    {
      id: "hit-added",
      trip_update: {
        trip: {
          trip_id: "trip-added",
          schedule_relationship: "ADDED",
        },
        stop_time_update: [
          {
            stop_id: "8503000:0:2",
            stop_sequence: 8,
            departure: {
              time: nowSec + 300,
              delay: 60,
            },
          },
        ],
      },
    },
    {
      id: "miss",
      trip_update: {
        trip: {
          trip_id: "trip-drop",
          schedule_relationship: "SCHEDULED",
        },
        stop_time_update: [
          {
            stop_id: "9999999:0:1",
            stop_sequence: 1,
            departure: {
              time: nowSec + 120,
              delay: 30,
            },
          },
        ],
      },
    },
  ];

  const out = await loadScopedRtFromCache({
    enabled: true,
    nowMs,
    windowStartEpochSec: nowSec - 60,
    windowEndEpochSec: nowSec + 900,
    scopeTripIds: ["trip-keep"],
    scopeStopIds: ["8503000:0:1", "8503000:0:2"],
    readCacheLike: async () => makeCachePayload({ entities }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.reason, "applied");
  assert.equal(Array.isArray(out.tripUpdates.entities), true);
  assert.equal(out.tripUpdates.entities.length, 2);
});
