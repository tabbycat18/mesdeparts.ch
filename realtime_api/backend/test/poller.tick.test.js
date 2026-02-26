import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

async function loadPollerFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  process.env.RT_POLLER_HEARTBEAT_ENABLED = "0";
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
  assert.ok(Number.isFinite(sleptMs) && sleptMs >= 59_000 && sleptMs <= 60_000);
});

test("poller run loop compensates tick duration before sleeping", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("same-payload");
  const payloadSha = payloadSha256Hex(payload);
  let sleptMs = null;
  let fakeNow = 1_000_000;
  const stop = new Error("stop_after_first_sleep");

  const poller = createLaTripUpdatesPoller({
    token: "test-token",
    nowLike: () => fakeNow,
    fetchLike: async () => {
      fakeNow += 20_000;
      return okResponse(payload, "etag-same");
    },
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 120_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => payloadSha,
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
  assert.equal(sleptMs, 0);
});

test("poller run loop continues after transient DB failure without exiting", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const stop = new Error("stop_after_second_sleep");
  const sleepCalls = [];
  let getMetaCalls = 0;
  let fetchCalls = 0;

  const poller = createLaTripUpdatesPoller({
    token: "test-token",
    getRtCacheMetaLike: async () => {
      getMetaCalls += 1;
      if (getMetaCalls === 1) {
        const err = new Error("Connection terminated due to connection timeout");
        err.code = "08006";
        throw err;
      }
      return {
        fetched_at: new Date(Date.now() - 30_000),
        etag: null,
        last_status: 200,
        last_error: null,
      };
    },
    fetchLike: async () => {
      fetchCalls += 1;
      return rateLimitResponse();
    },
    getRtCachePayloadShaLike: async () => null,
    updateRtCacheStatusLike: async () => ({ updated: true, writeSkippedByLock: false }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedTripUpdatesSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: () => {},
    sleepLike: async (ms) => {
      sleepCalls.push(ms);
      if (sleepCalls.length >= 2) throw stop;
    },
  });

  await assert.rejects(() => poller.runForever(), stop);
  assert.equal(getMetaCalls >= 2, true);
  assert.equal(fetchCalls, 1);
  assert.equal(sleepCalls[0] >= 15_000, true);
  assert.equal(sleepCalls[1] >= 60_000, true);
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

test("poller tx lifecycle log reports success path with committed+released client", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const logs = [];
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
    setRtCachePayloadShaLike: async () => ({ updated: true, writeSkippedByLock: false }),
    persistParsedTripUpdatesSnapshotLike: async () => ({
      updated: true,
      writeSkippedByLock: false,
      txDiagnostics: {
        transactionClientUsed: true,
        transactionCommitted: true,
        transactionRolledBack: false,
        clientReleased: true,
      },
    }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  await poller.tick();
  const lifecycle = logs.find((entry) => entry?.event === "poller_tx_client_lifecycle");
  assert.equal(lifecycle?.transactionClientUsed, true);
  assert.equal(lifecycle?.transactionCommitted, true);
  assert.equal(lifecycle?.transactionRolledBack, false);
  assert.equal(lifecycle?.clientReleased, true);
  assert.equal(lifecycle?.lifecycleOk, true);
});

test("poller tx lifecycle log reports unchanged path with no tx client and lifecycleOk=true", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("same-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
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
    persistParsedTripUpdatesSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  await poller.tick();
  const lifecycle = logs.find((entry) => entry?.event === "poller_tx_client_lifecycle");
  assert.equal(lifecycle?.transactionClientUsed, false);
  assert.equal(lifecycle?.transactionCommitted, null);
  assert.equal(lifecycle?.transactionRolledBack, null);
  assert.equal(lifecycle?.clientReleased, null);
  assert.equal(lifecycle?.lifecycleOk, true);
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

test("poller emits lock-contention warning on repeated write-lock skips with stale cache age", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("same-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
  const poller = createLaTripUpdatesPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 180_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => payloadSha,
    updateRtCacheStatusLike: async () => ({ updated: false, writeSkippedByLock: true }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedTripUpdatesSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  for (let i = 0; i < 6; i += 1) {
    const waitMs = await poller.tick();
    assert.equal(waitMs, 15_000);
  }

  const warnings = logs.filter((entry) => entry?.event === "poller_write_lock_contention_warning");
  assert.equal(warnings.length, 1);
  assert.ok(Number(warnings[0]?.consecutiveWriteLockSkips) >= 6);
  const state = poller._getStateForTests();
  assert.equal(state.lockSkipWarningEmitted, true);
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

test("poller source keeps blob payload UPSERT path disabled", () => {
  const source = readFileSync(
    new URL("../scripts/pollLaTripUpdates.js", import.meta.url),
    "utf8"
  );

  assert.equal(source.includes("upsertRtCache"), false);
  assert.equal(source.includes("INSERT INTO public.rt_cache"), false);
  assert.equal(source.includes("payload = EXCLUDED.payload"), false);
});

test("poller changed 200 writes parsed snapshot + metadata only", async () => {
  const createLaTripUpdatesPoller = await loadPollerFactory();
  const payload = Buffer.from("parsed-snapshot-payload");
  const decodedFeed = { entity: [{ id: "ent-1" }] };
  let persistArgs = null;
  let statusArgs = null;
  let shaWrites = 0;

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
    decodeFeedLike: () => decodedFeed,
    persistParsedTripUpdatesSnapshotLike: async (...args) => {
      persistArgs = args;
      return { updated: true, writeSkippedByLock: false, tripRows: 1, stopRows: 1 };
    },
    updateRtCacheStatusLike: async (...args) => {
      statusArgs = args;
      return { updated: true, writeSkippedByLock: false };
    },
    setRtCachePayloadShaLike: async () => {
      shaWrites += 1;
      return { updated: true, writeSkippedByLock: false };
    },
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    logLike: () => {},
  });

  const waitMs = await poller.tick();
  assert.equal(waitMs, 15_000);
  assert.ok(Array.isArray(persistArgs));
  assert.equal(persistArgs[0], decodedFeed);
  assert.ok(Array.isArray(statusArgs));
  assert.equal(String(statusArgs[0]), "la_tripupdates");
  assert.equal(Buffer.isBuffer(statusArgs[1]), false);
  assert.equal(shaWrites, 1);
});
