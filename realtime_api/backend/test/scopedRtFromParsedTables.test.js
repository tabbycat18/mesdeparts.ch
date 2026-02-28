import test from "node:test";
import assert from "node:assert/strict";

async function loadScopedRtFromParsedTablesFn() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://localhost:5432/mesdeparts_test";
  }
  const mod = await import("../src/rt/loadScopedRtFromParsedTables.js");
  return mod.loadScopedRtFromParsedTables;
}

function makeQueryLike({
  stopRowsByTrip = [],
  stopRowsByStop = [],
  tripRows = [],
  error = null,
} = {}) {
  return async (sql) => {
    if (error) throw error;
    const query = String(sql || "");
    if (query.includes("FROM public.rt_stop_time_updates") && query.includes("stu.trip_id = ANY")) {
      return { rows: stopRowsByTrip };
    }
    if (query.includes("FROM public.rt_stop_time_updates") && query.includes("stu.stop_id = ANY")) {
      return { rows: stopRowsByStop };
    }
    if (query.includes("FROM public.rt_trip_updates")) {
      return { rows: tripRows };
    }
    return { rows: [] };
  };
}

test("loadScopedRtFromParsedTables returns applied parsed index and ADDED rows", async () => {
  const loadScopedRtFromParsedTables = await loadScopedRtFromParsedTablesFn();
  const nowMs = Date.now();
  const depEpoch = Math.floor((nowMs + 3 * 60_000) / 1000);

  const out = await loadScopedRtFromParsedTables({
    enabled: true,
    nowMs,
    scopeTripIds: ["trip-added-1"],
    scopeStopIds: ["8587387:0:A"],
    getRtCacheMetaLike: async () => ({
      last_successful_poll_at: new Date(nowMs - 2_000).toISOString(),
    }),
    queryLike: makeQueryLike({
      stopRowsByTrip: [
        {
          trip_id: "trip-added-1",
          stop_id: "8587387",
          stop_sequence: 5,
          departure_delay: 120,
          departure_time_rt: depEpoch,
          stop_schedule_relationship: "SCHEDULED",
          stop_updated_at: new Date(nowMs - 1000).toISOString(),
          start_date: "20260225",
          route_id: "R1",
          trip_schedule_relationship: "ADDED",
          trip_updated_at: new Date(nowMs - 1000).toISOString(),
        },
      ],
      tripRows: [
        {
          trip_id: "trip-added-1",
          route_id: "R1",
          start_date: "20260225",
          trip_schedule_relationship: "ADDED",
          trip_updated_at: new Date(nowMs - 1000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(out.meta.cacheStatus, "FRESH");
  assert.equal(out.meta.rtReadSource, "db");
  assert.equal(out.meta.rtPayloadFetchCountThisRequest, 0);
  assert.ok(out.tripUpdates.byKey["trip-added-1|8587387|5|20260225"]);
  assert.equal(Array.isArray(out.tripUpdates.addedTripStopUpdates), true);
  assert.equal(out.tripUpdates.addedTripStopUpdates.length, 1);
});

test("loadScopedRtFromParsedTables returns parsed_unavailable when parsed tables are missing", async () => {
  const loadScopedRtFromParsedTables = await loadScopedRtFromParsedTablesFn();
  const out = await loadScopedRtFromParsedTables({
    enabled: true,
    scopeTripIds: ["trip-1"],
    getRtCacheMetaLike: async () => ({
      last_successful_poll_at: new Date().toISOString(),
    }),
    queryLike: makeQueryLike({
      error: Object.assign(new Error("relation public.rt_stop_time_updates does not exist"), {
        code: "42P01",
      }),
    }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "parsed_unavailable");
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(out.meta.cacheStatus, "ERROR");
});

test("loadScopedRtFromParsedTables returns stale_cache when parsed rows are too old", async () => {
  const loadScopedRtFromParsedTables = await loadScopedRtFromParsedTablesFn();
  const nowMs = Date.now();
  const out = await loadScopedRtFromParsedTables({
    enabled: true,
    nowMs,
    freshnessThresholdMs: 10_000,
    scopeTripIds: ["trip-1"],
    getRtCacheMetaLike: async () => ({
      last_successful_poll_at: new Date(nowMs - 70_000).toISOString(),
    }),
    queryLike: makeQueryLike({
      stopRowsByTrip: [
        {
          trip_id: "trip-1",
          stop_id: "8503000:0:1",
          stop_sequence: 3,
          departure_delay: 60,
          departure_time_rt: Math.floor((nowMs + 60_000) / 1000),
          stop_schedule_relationship: "SCHEDULED",
          stop_updated_at: new Date(nowMs - 70_000).toISOString(),
          start_date: "20260225",
          route_id: "R1",
          trip_schedule_relationship: "SCHEDULED",
          trip_updated_at: new Date(nowMs - 70_000).toISOString(),
        },
      ],
      tripRows: [
        {
          trip_id: "trip-1",
          route_id: "R1",
          start_date: "20260225",
          trip_schedule_relationship: "SCHEDULED",
          trip_updated_at: new Date(nowMs - 70_000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "stale_cache");
  assert.equal(out.meta.cacheStatus, "STALE");
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(out.meta.freshnessAgeSource, "last_successful_poll");
});

test("loadScopedRtFromParsedTables stop-scope query stays on parsed tables and applies updated_at lookback", async () => {
  const loadScopedRtFromParsedTables = await loadScopedRtFromParsedTablesFn();
  const seenQueries = [];
  const nowMs = Date.now();

  const out = await loadScopedRtFromParsedTables({
    enabled: true,
    nowMs,
    scopeTripIds: [],
    scopeStopIds: ["8503000:0:1"],
    stopScopeLookbackMs: 30 * 60 * 1000,
    getRtCacheMetaLike: async () => ({
      last_successful_poll_at: new Date(nowMs - 1_000).toISOString(),
    }),
    queryLike: async (sql, params) => {
      const query = String(sql || "");
      seenQueries.push(query);
      if (query.includes("FROM public.rt_stop_time_updates") && query.includes("stu.stop_id = ANY")) {
        assert.equal(query.includes("stu.updated_at >="), true);
        assert.equal(Number(params?.[1]), 30 * 60 * 1000);
        return {
          rows: [
            {
              trip_id: "trip-stop-scope-1",
              stop_id: "8503000:0:1",
              stop_sequence: 4,
              departure_delay: 60,
              departure_time_rt: Math.floor((nowMs + 60_000) / 1000),
              stop_schedule_relationship: "SCHEDULED",
              stop_updated_at: new Date(nowMs - 500).toISOString(),
              start_date: "20260225",
              route_id: "R1",
              trip_schedule_relationship: "SCHEDULED",
              trip_updated_at: new Date(nowMs - 500).toISOString(),
            },
          ],
        };
      }
      if (query.includes("FROM public.rt_trip_updates")) {
        return {
          rows: [
            {
              trip_id: "trip-stop-scope-1",
              route_id: "R1",
              start_date: "20260225",
              trip_schedule_relationship: "SCHEDULED",
              trip_updated_at: new Date(nowMs - 500).toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(seenQueries.some((query) => query.toLowerCase().includes("from public.rt_cache")), false);
});

test("loadScopedRtFromParsedTables stays fresh when last write is old but last successful poll is recent", async () => {
  const loadScopedRtFromParsedTables = await loadScopedRtFromParsedTablesFn();
  const nowMs = Date.now();
  const out = await loadScopedRtFromParsedTables({
    enabled: true,
    nowMs,
    freshnessThresholdMs: 10_000,
    scopeTripIds: ["trip-1"],
    getRtCacheMetaLike: async () => ({
      last_successful_poll_at: new Date(nowMs - 2_000).toISOString(),
    }),
    queryLike: makeQueryLike({
      stopRowsByTrip: [
        {
          trip_id: "trip-1",
          stop_id: "8503000:0:1",
          stop_sequence: 3,
          departure_delay: 60,
          departure_time_rt: Math.floor((nowMs + 60_000) / 1000),
          stop_schedule_relationship: "SCHEDULED",
          stop_updated_at: new Date(nowMs - 70_000).toISOString(),
          start_date: "20260225",
          route_id: "R1",
          trip_schedule_relationship: "SCHEDULED",
          trip_updated_at: new Date(nowMs - 70_000).toISOString(),
        },
      ],
      tripRows: [
        {
          trip_id: "trip-1",
          route_id: "R1",
          start_date: "20260225",
          trip_schedule_relationship: "SCHEDULED",
          trip_updated_at: new Date(nowMs - 70_000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.freshnessAgeSource, "last_successful_poll");
  assert.ok(Number.isFinite(out.meta.pollAgeMs) && out.meta.pollAgeMs < 10_000);
  assert.ok(Number.isFinite(out.meta.cacheAgeMs) && out.meta.cacheAgeMs > 60_000);
});
