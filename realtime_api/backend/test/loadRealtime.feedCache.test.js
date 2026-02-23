import test from "node:test";
import assert from "node:assert/strict";

async function loadRealtimeModule() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://localhost:5432/mesdeparts_test";
  }
  return import("../loaders/loadRealtime.js");
}

function buildTripUpdatesPayload() {
  return Buffer.from(
    JSON.stringify({
      header: {
        feed_version: "test-v1",
        timestamp: Math.floor(Date.now() / 1000),
      },
      entity: [],
    })
  );
}

test("readTripUpdatesFeedFromCache uses memory cache within TTL", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  let reads = 0;
  const getRtCacheLike = async () => {
    reads += 1;
    return {
      payloadBytes: payload,
      fetched_at: new Date(),
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  const first = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheLike,
  });
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheLike,
  });

  assert.equal(reads, 1);
  assert.equal(first.rtReadSource, "db");
  assert.equal(second.rtReadSource, "memory");
  assert.equal(second.rtCacheHit, true);
});

test("readTripUpdatesFeedFromCache coalesces concurrent cold reads", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const getRtCacheLike = async () => {
    reads += 1;
    await gate;
    return {
      payloadBytes: payload,
      fetched_at: new Date(),
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  const p1 = mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheLike,
  });
  const p2 = mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheLike,
  });
  release();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(reads, 1);
  assert.equal(r1.rtReadSource, "db");
  assert.equal(r2.rtReadSource, "memory");
});
