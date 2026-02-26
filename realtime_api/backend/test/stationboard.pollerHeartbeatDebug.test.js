import test from "node:test";
import assert from "node:assert/strict";

async function loadFormatter() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../src/api/stationboard.js");
  return mod.toPollerHeartbeatDebug;
}

test("toPollerHeartbeatDebug computes ages and exposes last_error", async () => {
  const toPollerHeartbeatDebug = await loadFormatter();
  const nowMs = Date.parse("2026-02-26T10:00:00.000Z");
  const out = toPollerHeartbeatDebug(
    {
      updated_at: "2026-02-26T09:59:00.000Z",
      tripupdates_updated_at: "2026-02-26T09:58:30.000Z",
      alerts_updated_at: "2026-02-26T09:55:00.000Z",
      last_error: "Connection terminated due to connection timeout",
    },
    { nowMs }
  );

  assert.equal(out.pollerHeartbeatAgeMs, 60_000);
  assert.equal(out.pollerTripupdatesAgeMs, 90_000);
  assert.equal(out.pollerAlertsAgeMs, 300_000);
  assert.equal(out.pollerLastError, "Connection terminated due to connection timeout");
});

test("toPollerHeartbeatDebug returns null diagnostics when heartbeat row is missing", async () => {
  const toPollerHeartbeatDebug = await loadFormatter();
  const out = toPollerHeartbeatDebug(null, {
    nowMs: Date.parse("2026-02-26T10:00:00.000Z"),
  });

  assert.equal(out.pollerHeartbeatAgeMs, null);
  assert.equal(out.pollerTripupdatesAgeMs, null);
  assert.equal(out.pollerAlertsAgeMs, null);
  assert.equal(out.pollerLastError, null);
});
