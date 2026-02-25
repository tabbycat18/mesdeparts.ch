import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function loadPollerFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../scripts/pollLaServiceAlerts.js");
  return mod.createLaServiceAlertsPoller;
}

function payloadSha256Hex(payloadBytes) {
  const payloadBuffer = Buffer.isBuffer(payloadBytes)
    ? payloadBytes
    : Buffer.from(payloadBytes || []);
  return createHash("sha256").update(payloadBuffer).digest("hex");
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
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 30_000),
      etag: null,
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
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
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 30_000),
      etag: null,
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
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

test("service alerts poller writes parsed alerts on changed 200 payload", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("new-alerts-payload");
  let parsedWrites = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-new"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-old",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    setRtCachePayloadShaLike: async () => ({ updated: true, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(parsedWrites, 1);
});

test("service alerts poller skips parsed write on unchanged 200 payload within write interval", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const payloadSha = payloadSha256Hex(payload);
  let parsedWrites = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 2_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => payloadSha,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(parsedWrites, 0);
});

test("service alerts poller treats advisory-lock parsed write skip as clean no-op", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  let parsedWrites = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(Buffer.from("new-alerts-payload"), "etag-new"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-old",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: false, writeSkippedByLock: true };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(parsedWrites, 1);
});

test("service alerts poller unchanged payload skips parsed write and logs skip_write_unchanged", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
  let parsedWrites = 0;
  let metadataUpdates = 0;
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => payloadSha,
    updateRtCacheStatusLike: async () => {
      metadataUpdates += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 60_000);
  assert.equal(parsedWrites, 0);
  assert.equal(metadataUpdates, 1);
  assert.equal(
    logs.some((entry) => entry?.event === "service_alerts_poller_skip_write_unchanged"),
    true
  );
});
