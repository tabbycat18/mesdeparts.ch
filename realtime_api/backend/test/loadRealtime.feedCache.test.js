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

test("readTripUpdatesFeedFromCache uses one payload SELECT within TTL", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt = new Date("2026-02-25T13:40:00.000Z");
  let reads = 0;
  const getRtCacheMetaLike = async () => ({
    fetched_at: fetchedAt,
    last_status: 200,
    payload_bytes: payload.length,
    etag: "etag-1",
    last_error: null,
  });
  const getRtCacheLike = async () => {
    reads += 1;
    return {
      payloadBytes: payload,
      fetched_at: fetchedAt,
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  const first = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });

  assert.equal(reads, 1);
  assert.equal(first.rtReadSource, "db");
  assert.equal(first.rtPayloadFetchCountThisRequest, 1);
  assert.equal(Number.isFinite(first.rtDecodeMs), true);
  assert.ok(Number(first.payloadBytes) > 0);
  assert.equal(second.rtReadSource, "memory");
  assert.equal(second.rtPayloadFetchCountThisRequest, 0);
  assert.equal(second.rtCacheHit, true);
  assert.equal(second.payloadBytes, first.payloadBytes);
});

test("readTripUpdatesFeedFromCache coalesces concurrent payload SELECTs", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt = new Date("2026-02-25T13:41:00.000Z");
  let reads = 0;
  const getRtCacheMetaLike = async () => ({
    fetched_at: fetchedAt,
    last_status: 200,
    payload_bytes: payload.length,
    etag: "etag-1",
    last_error: null,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const getRtCacheLike = async () => {
    reads += 1;
    await gate;
    return {
      payloadBytes: payload,
      fetched_at: fetchedAt,
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  const p1 = mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  const p2 = mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  release();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(reads, 1);
  assert.equal(r1.rtReadSource, "db");
  assert.equal(r1.rtPayloadFetchCountThisRequest, 1);
  assert.equal(r2.rtReadSource, "memory");
  assert.equal(r2.rtPayloadFetchCountThisRequest, 0);
  assert.equal(r2.rtCacheHit, true);
  assert.equal(r1.payloadBytes, r2.payloadBytes);
});

test("readTripUpdatesFeedFromCache skips payload SELECT when etag is unchanged even if fetched_at changes", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt1 = new Date("2026-02-25T13:42:00.000Z");
  const fetchedAt2 = new Date("2026-02-25T13:42:10.000Z");
  let metaReads = 0;
  let payloadReads = 0;
  const getRtCacheMetaLike = async () => {
    metaReads += 1;
    const fetchedAt = metaReads < 2 ? fetchedAt1 : fetchedAt2;
    return {
      fetched_at: fetchedAt,
      last_status: 200,
      payload_bytes: payload.length,
      etag: "etag-1",
      last_error: null,
    };
  };
  const getRtCacheLike = async () => {
    payloadReads += 1;
    return {
      payloadBytes: payload,
      fetched_at: fetchedAt1,
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  const first = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  mod.__expireDecodedRtFeedMemoryCacheForTests("la_tripupdates");
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });

  assert.equal(metaReads, 2);
  assert.equal(payloadReads, 1);
  assert.equal(first.rtReadSource, "db");
  assert.equal(first.rtPayloadFetchCountThisRequest, 1);
  assert.equal(second.rtReadSource, "memory");
  assert.equal(second.rtPayloadFetchCountThisRequest, 0);
  assert.equal(second.rtCacheHit, true);
});

test("readTripUpdatesFeedFromCache fetches payload when etag changes", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt1 = new Date("2026-02-25T13:43:00.000Z");
  const fetchedAt2 = new Date("2026-02-25T13:43:10.000Z");
  let payloadReads = 0;
  let metaCall = 0;
  const getRtCacheMetaLike = async () => {
    metaCall += 1;
    const fetchedAt = metaCall < 2 ? fetchedAt1 : fetchedAt2;
    return {
      fetched_at: fetchedAt,
      last_status: 200,
      payload_bytes: payload.length,
      etag: metaCall < 2 ? "etag-1" : "etag-2",
      last_error: null,
    };
  };
  const getRtCacheLike = async () => {
    payloadReads += 1;
    const fetchedAt = payloadReads < 2 ? fetchedAt1 : fetchedAt2;
    return {
      payloadBytes: payload,
      fetched_at: fetchedAt,
      etag: "etag-1",
      last_status: 200,
      last_error: null,
    };
  };

  await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  mod.__expireDecodedRtFeedMemoryCacheForTests("la_tripupdates");
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });

  assert.equal(payloadReads, 2);
  assert.equal(second.rtReadSource, "db");
  assert.equal(second.rtPayloadFetchCountThisRequest, 1);
  assert.equal(second.rtCacheHit, false);
});

test("readTripUpdatesFeedFromCache uses payload_sha when etag is absent", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt1 = new Date("2026-02-25T13:44:00.000Z");
  const fetchedAt2 = new Date("2026-02-25T13:44:10.000Z");
  let metaCall = 0;
  let payloadReads = 0;

  const getRtCacheMetaLike = async () => {
    metaCall += 1;
    return {
      fetched_at: metaCall < 2 ? fetchedAt1 : fetchedAt2,
      last_status: 200,
      payload_bytes: payload.length,
      etag: null,
      last_error: null,
    };
  };
  const getRtCachePayloadShaLike = async () =>
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const getRtCacheLike = async () => {
    payloadReads += 1;
    return {
      payloadBytes: payload,
      fetched_at: fetchedAt1,
      etag: null,
      last_status: 200,
      last_error: null,
    };
  };

  await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike,
    getRtCacheLike,
  });
  mod.__expireDecodedRtFeedMemoryCacheForTests("la_tripupdates");
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike,
    getRtCacheLike,
  });

  assert.equal(payloadReads, 1);
  assert.equal(second.rtReadSource, "memory");
  assert.equal(second.rtPayloadFetchCountThisRequest, 0);
  assert.equal(second.rtCacheHit, true);
});

test("readTripUpdatesFeedFromCache falls back to fetched_at when etag and sha are absent", async () => {
  const mod = await loadRealtimeModule();
  mod.__resetDecodedRtFeedMemoryCacheForTests();
  const payload = buildTripUpdatesPayload();
  const fetchedAt1 = new Date("2026-02-25T13:45:00.000Z");
  const fetchedAt2 = new Date("2026-02-25T13:45:10.000Z");
  let metaCall = 0;
  let payloadReads = 0;

  const getRtCacheMetaLike = async () => {
    metaCall += 1;
    return {
      fetched_at: metaCall < 2 ? fetchedAt1 : fetchedAt2,
      last_status: 200,
      payload_bytes: payload.length,
      etag: null,
      last_error: null,
    };
  };
  const getRtCacheLike = async () => {
    payloadReads += 1;
    return {
      payloadBytes: payload,
      fetched_at: payloadReads < 2 ? fetchedAt1 : fetchedAt2,
      etag: null,
      last_status: 200,
      last_error: null,
    };
  };

  await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });
  mod.__expireDecodedRtFeedMemoryCacheForTests("la_tripupdates");
  const second = await mod.readTripUpdatesFeedFromCache({
    feedKey: "la_tripupdates",
    getRtCacheMetaLike,
    getRtCachePayloadShaLike: async () => null,
    getRtCacheLike,
  });

  assert.equal(payloadReads, 2);
  assert.equal(second.rtReadSource, "db");
  assert.equal(second.rtPayloadFetchCountThisRequest, 1);
  assert.equal(second.rtCacheHit, false);
});
