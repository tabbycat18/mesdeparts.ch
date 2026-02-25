import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function loadPollerFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../scripts/pollLaTripUpdates.js");
  return mod.createLaTripUpdatesPoller;
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

test("poller tick calls upstream once and returns >=60s backoff on 429", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  let fetchCalls = 0;
  const poller = createLaTripUpdatesPoller({
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
    persistParsedTripUpdatesSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(fetchCalls, 1);
  assert.ok(waitMs >= 60_000);
});

test("poller run loop sleeps backoff before any next upstream fetch", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  let fetchCalls = 0;
  let sleptMs = null;
  const stop = new Error("stop_after_first_sleep");

  const poller = createLaTripUpdatesPoller({
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
    persistParsedTripUpdatesSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
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

test("poller writes parsed trip updates on changed 200 payload", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("new-payload");
  let parsedWrites = 0;
  const poller = createLaTripUpdatesPoller({
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
    persistParsedTripUpdatesSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 15_000);
  assert.equal(parsedWrites, 1);
});

test("poller skips parsed write on unchanged 200 payload within write interval", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("same-payload");
  const payloadSha = payloadSha256Hex(payload);
  let parsedWrites = 0;
  const poller = createLaTripUpdatesPoller({
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
    persistParsedTripUpdatesSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 15_000);
  assert.equal(parsedWrites, 0);
});

test("poller treats advisory-lock parsed write skip as clean no-op", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  let parsedWrites = 0;
  const poller = createLaTripUpdatesPoller({
    token: "test-token",
    fetchLike: async () => okResponse(Buffer.from("new-payload"), "etag-new"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-old",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedTripUpdatesSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: false, writeSkippedByLock: true };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 15_000);
  assert.equal(parsedWrites, 1);
});

test("poller unchanged payload skips parsed write and logs skip_write_unchanged when cache is old", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("same-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
  let parsedWrites = 0;
  let metadataUpdates = 0;
  const poller = createLaTripUpdatesPoller({
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
    persistParsedTripUpdatesSnapshotLike: async () => {
      parsedWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 15_000);
  assert.equal(parsedWrites, 0);
  assert.equal(metadataUpdates, 1);
  assert.equal(logs.some((entry) => entry?.event === "poller_skip_write_unchanged"), true);
});
