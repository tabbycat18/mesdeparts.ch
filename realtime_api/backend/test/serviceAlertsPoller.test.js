import test from "node:test";
import assert from "node:assert/strict";

async function loadPollerFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../scripts/pollLaServiceAlerts.js");
  return mod.createLaServiceAlertsPoller;
}

function rateLimitResponse() {
  return {
    status: 429,
    headers: new Headers(),
    text: async () => "Rate Limit Exceeded",
  };
}

function okResponse(payload, etag = "etag-200") {
  return {
    status: 200,
    headers: new Headers({ etag }),
    arrayBuffer: async () => Buffer.from(payload),
  };
}

test("service alerts poller tick calls upstream once and returns >=60s backoff on 429", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  let fetchCalls = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => {
      fetchCalls += 1;
      return rateLimitResponse();
    },
    getRtCacheLike: async () => ({
      payloadBytes: Buffer.from("cached"),
      fetched_at: new Date(Date.now() - 30_000),
      etag: null,
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    upsertRtCacheLike: async () => null,
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(fetchCalls, 1);
  assert.ok(waitMs >= 60_000);
});

test("service alerts poller run loop sleeps backoff before any next upstream fetch", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  let fetchCalls = 0;
  let sleptMs = null;
  const stop = new Error("stop_after_first_sleep");

  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => {
      fetchCalls += 1;
      return rateLimitResponse();
    },
    getRtCacheLike: async () => ({
      payloadBytes: Buffer.from("cached"),
      fetched_at: new Date(Date.now() - 30_000),
      etag: null,
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    upsertRtCacheLike: async () => null,
    sleepLike: async (ms) => {
      sleptMs = ms;
      throw stop;
    },
    logLike: () => {},
  });

  await assert.rejects(() => poller.runForever(), stop);
  assert.equal(fetchCalls, 1);
  assert.ok(Number.isFinite(sleptMs) && sleptMs >= 60_000);
});

test("service alerts poller skips payload upsert on unchanged 200 payload within write interval", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const upsertCalls = [];
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheLike: async () => ({
      payloadBytes: payload,
      fetched_at: new Date(Date.now() - 2_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    upsertRtCacheLike: async (...args) => {
      upsertCalls.push(args);
      return null;
    },
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(upsertCalls.length, 0);
});

test("service alerts poller unchanged payload skips payload upsert and logs skip_write_unchanged", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const logs = [];
  let payloadUpserts = 0;
  let metadataUpdates = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheLike: async () => ({
      payloadBytes: payload,
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => {
      metadataUpdates += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    upsertRtCacheLike: async () => {
      payloadUpserts += 1;
      return null;
    },
    logLike: (entry) => logs.push(entry),
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(payloadUpserts, 0);
  assert.equal(metadataUpdates, 1);
  assert.equal(
    logs.some((entry) => entry?.event === "service_alerts_poller_skip_write_unchanged"),
    true
  );
});

test("service alerts poller treats advisory-lock write skip as clean no-op", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  let upsertCalls = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(Buffer.from("new-alerts-payload"), "etag-new"),
    getRtCacheLike: async () => ({
      payloadBytes: Buffer.from("old-alerts-payload"),
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-old",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    upsertRtCacheLike: async () => {
      upsertCalls += 1;
      return { writeSkippedByLock: true };
    },
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(upsertCalls, 1);
});
