import test from "node:test";
import assert from "node:assert/strict";

async function loadLockHelper() {
  const mod = await import("../scripts/refreshGtfsIfNeeded.js");
  return mod.tryAcquireSessionAdvisoryLock;
}

test("GTFS refresh lock helper returns false when advisory lock is already held", async () => {
  const tryAcquireSessionAdvisoryLock = await loadLockHelper();
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ acquired: false }] };
    },
  };

  const acquired = await tryAcquireSessionAdvisoryLock(client, 7_483_920);
  assert.equal(acquired, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].sql || ""), /pg_try_advisory_lock/);
});
