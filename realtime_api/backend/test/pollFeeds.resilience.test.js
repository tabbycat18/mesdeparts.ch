import test from "node:test";
import assert from "node:assert/strict";

async function loadPollFeedsHelpers() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../scripts/pollFeeds.js");
  return mod;
}

test("poll-feeds supervisor retries DB disconnects with increasing backoff", async () => {
  const { runPollerWithRestart } = await loadPollFeedsHelpers();
  const stop = new Error("stop_after_three_retries");
  const sleepCalls = [];
  const logs = [];
  let runForeverCalls = 0;

  await assert.rejects(
    () =>
      runPollerWithRestart({
        pollerName: "trip_updates",
        createPoller: () => ({
          runForever: async () => {
            runForeverCalls += 1;
            throw Object.assign(new Error("Connection terminated due to connection timeout"), {
              code: "57P01",
            });
          },
        }),
        randomLike: () => 1,
        logLike: (_level, payload) => logs.push(payload),
        sleepLike: async (ms) => {
          sleepCalls.push(ms);
          if (sleepCalls.length >= 3) throw stop;
        },
      }),
    stop
  );

  assert.equal(runForeverCalls, 3);
  assert.deepEqual(sleepCalls, [6000, 12000, 24000]);

  const dbReconnectLogs = logs.filter((entry) => entry?.event === "poller_db_error_reconnect");
  assert.equal(dbReconnectLogs.length, 3);
  assert.equal(dbReconnectLogs.every((entry) => entry?.reconnecting === true), true);
  assert.equal(dbReconnectLogs.every((entry) => entry?.errorCode === "57P01"), true);
  assert.equal(
    dbReconnectLogs.every((entry) => Number.isFinite(Number(entry?.nextBackoffMs))),
    true
  );
});
