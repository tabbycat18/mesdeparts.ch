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
