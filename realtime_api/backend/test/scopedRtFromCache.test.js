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
  payloadBytes = null,
  rtReadSource = "db",
  rtCacheHit = false,
  rtDecodeMs = 3,
} = {}) {
  return {
    hasPayload,
    decodeError,
    fetchedAtMs,
    payloadBytes,
    lastStatus: 200,
    lastError: null,
    etag: "etag-1",
    rtReadSource,
    rtCacheHit,
    rtDecodeMs,
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
  assert.equal(out.meta.rtPayloadFetchCountThisRequest, 0);
  assert.equal(out.meta.feedKey, "la_tripupdates");
  assert.equal(typeof out.meta.freshnessThresholdMs, "number");
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
  assert.equal(
    out.meta.cacheFetchedAt == null || typeof out.meta.cacheFetchedAt === "string",
    true
  );
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
  assert.equal(Number.isFinite(out.meta.cacheAgeMs), true);
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

test("loadScopedRtFromCache guard timer excludes cache read/decode latency", async () => {
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
  ];

  const out = await loadScopedRtFromCache({
    enabled: true,
    nowMs,
    maxProcessMs: 20,
    scopeTripIds: ["trip-keep"],
    scopeStopIds: ["8503000:0:1"],
    readCacheLike: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return makeCachePayload({ entities });
    },
  });

  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.applied, true);
  assert.equal(out.tripUpdates.entities.length, 1);
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
    readCacheLike: async () => makeCachePayload({ entities, payloadBytes: 8192 }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.feedKey, "la_tripupdates");
  assert.equal(out.meta.rtReadSource, "db");
  assert.equal(out.meta.rtCacheHit, false);
  assert.equal(out.meta.rtPayloadFetchCountThisRequest, 0);
  assert.equal(Number.isFinite(out.meta.rtDecodeMs), true);
  assert.equal(out.meta.rtPayloadBytes, 8192);
  assert.equal(typeof out.meta.instance, "string");
  assert.equal(Array.isArray(out.tripUpdates.entities), true);
  assert.equal(out.tripUpdates.entities.length, 2);
});

// ---------------------------------------------------------------------------
// Regression: ADDED trip with numeric root stop ID must be scoped in when
// scopeStopIds contains child stop IDs.
//
// Before the fix, loadScopedRtFromCache.stopIdVariants() did not include the
// numeric root, so scopeStops built from "8503000:0:3" (child stop) did not
// contain "8503000". An ADDED RT entity with stop_id "8503000" was therefore
// excluded by the stop-based inclusion filter.
// ---------------------------------------------------------------------------

test("loadScopedRtFromCache: ADDED trip with numeric root stop_id is scoped in via child scopeStopId (regression)", async () => {
  const loadScopedRtFromCache = await loadScopedRtFromCacheFn();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const entities = [
    {
      id: "added-numeric-root",
      trip_update: {
        trip: {
          trip_id: "trip-ev-added",
          schedule_relationship: "ADDED",
        },
        stop_time_update: [
          {
            stop_id: "8503000",     // numeric root — no trip_id in scopeTrips
            stop_sequence: 1,
            departure: {
              time: nowSec + 300,   // within window
            },
          },
        ],
      },
    },
    {
      id: "unrelated-added",
      trip_update: {
        trip: {
          trip_id: "trip-ev-other",
          schedule_relationship: "ADDED",
        },
        stop_time_update: [
          {
            stop_id: "9990000",     // completely different station — must be excluded
            stop_sequence: 1,
            departure: {
              time: nowSec + 300,
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
    scopeTripIds: [],                        // no scheduled trips in scope
    scopeStopIds: ["8503000:0:3"],           // child stop — numeric root "8503000" must expand
    readCacheLike: async () => makeCachePayload({ entities }),
  });

  assert.equal(out.meta.applied, true, "RT should be applied");
  assert.equal(out.tripUpdates.entities.length, 1, "only the matching ADDED entity should be included");
  assert.equal(
    out.tripUpdates.entities[0].trip_update.trip.trip_id,
    "trip-ev-added",
    "correct entity included"
  );
});
