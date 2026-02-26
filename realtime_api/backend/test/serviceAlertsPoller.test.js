import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

async function loadPollerFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  process.env.RT_POLLER_HEARTBEAT_ENABLED = "0";
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
  assert.ok(Number.isFinite(sleptMs) && sleptMs >= 59_000 && sleptMs <= 60_000);
});

test("service alerts poller run loop compensates tick duration before sleeping", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const payloadSha = payloadSha256Hex(payload);
  let sleptMs = null;
  let fakeNow = 1_000_000;
  const stop = new Error("stop_after_first_sleep");

  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    nowLike: () => fakeNow,
    fetchLike: async () => {
      fakeNow += 75_000;
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
    persistParsedServiceAlertsSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
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

test("service alerts poller tx lifecycle log reports success path with committed+released client", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const logs = [];
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
    setRtCachePayloadShaLike: async () => ({ updated: true, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => ({
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
  const lifecycle = logs.find(
    (entry) => entry?.event === "service_alerts_poller_tx_client_lifecycle"
  );
  assert.equal(lifecycle?.transactionClientUsed, true);
  assert.equal(lifecycle?.transactionCommitted, true);
  assert.equal(lifecycle?.transactionRolledBack, false);
  assert.equal(lifecycle?.clientReleased, true);
  assert.equal(lifecycle?.lifecycleOk, true);
});

test("service alerts poller tx lifecycle log reports unchanged path with no tx client and lifecycleOk=true", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
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
    persistParsedServiceAlertsSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  await poller.tick();
  const lifecycle = logs.find(
    (entry) => entry?.event === "service_alerts_poller_tx_client_lifecycle"
  );
  assert.equal(lifecycle?.transactionClientUsed, false);
  assert.equal(lifecycle?.transactionCommitted, null);
  assert.equal(lifecycle?.transactionRolledBack, null);
  assert.equal(lifecycle?.clientReleased, null);
  assert.equal(lifecycle?.lifecycleOk, true);
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

test("service alerts poller emits lock-contention warning on repeated write-lock skips with stale cache age", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("same-alerts-payload");
  const payloadSha = payloadSha256Hex(payload);
  const logs = [];
  const poller = createLaServiceAlertsPoller({
    token: "test-token",
    fetchLike: async () => okResponse(payload, "etag-same"),
    getRtCacheMetaLike: async () => ({
      fetched_at: new Date(Date.now() - 240_000),
      etag: "etag-same",
      last_status: 200,
      last_error: null,
    }),
    getRtCachePayloadShaLike: async () => payloadSha,
    updateRtCacheStatusLike: async () => ({ updated: false, writeSkippedByLock: true }),
    ensureRtCacheMetadataRowLike: async () => ({ inserted: false, writeSkippedByLock: false }),
    persistParsedServiceAlertsSnapshotLike: async () => ({ updated: true, writeSkippedByLock: false }),
    decodeFeedLike: () => ({ entity: [] }),
    logLike: (entry) => logs.push(entry),
  });

  for (let i = 0; i < 6; i += 1) {
    const waitMs = await poller.tick();
    assert.equal(waitMs, 60_000);
  }

  const warnings = logs.filter(
    (entry) => entry?.event === "service_alerts_poller_write_lock_contention_warning"
  );
  assert.equal(warnings.length, 1);
  assert.ok(Number(warnings[0]?.consecutiveWriteLockSkips) >= 6);
  const state = poller._getStateForTests();
  assert.equal(state.lockSkipWarningEmitted, true);
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

test("service alerts poller source keeps blob payload UPSERT path disabled", () => {
  const source = readFileSync(
    new URL("../scripts/pollLaServiceAlerts.js", import.meta.url),
    "utf8"
  );

  assert.equal(source.includes("upsertRtCache"), false);
  assert.equal(source.includes("INSERT INTO public.rt_cache"), false);
  assert.equal(source.includes("payload = EXCLUDED.payload"), false);
});

test("service alerts changed 200 writes parsed snapshot + metadata only", async () => {
  const createLaServiceAlertsPoller = await loadPollerFactory();
  const payload = Buffer.from("parsed-alerts-payload");
  const decodedFeed = { entity: [{ id: "alert-1" }] };
  let persistArgs = null;
  let statusArgs = null;
  let shaWrites = 0;

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
    decodeFeedLike: () => decodedFeed,
    persistParsedServiceAlertsSnapshotLike: async (...args) => {
      persistArgs = args;
      return { updated: true, writeSkippedByLock: false, alertRows: 1 };
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
  assert.equal(waitMs, 60_000);
  assert.ok(Array.isArray(persistArgs));
  assert.equal(persistArgs[0], decodedFeed);
  assert.ok(Array.isArray(statusArgs));
  assert.equal(String(statusArgs[0]), "la_servicealerts");
  assert.equal(Buffer.isBuffer(statusArgs[1]), false);
  assert.equal(shaWrites, 1);
});
