import test from "node:test";
import assert from "node:assert/strict";

async function loadPersistors() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  return import("../src/rt/persistParsedArtifacts.js");
}

function makePoolLike(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql || "").trim();
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
      return handler(text, params);
    },
    release() {},
  };

  return {
    calls,
    poolLike: {
      async connect() {
        return client;
      },
    },
  };
}

function makeTrackedPoolLike(handler) {
  const state = {
    checkedOut: 0,
    transactionOpen: false,
    released: 0,
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql || "").trim();
      if (text === "BEGIN") {
        state.transactionOpen = true;
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        state.transactionOpen = false;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        state.transactionOpen = false;
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return handler(text, params);
    },
    release() {
      state.checkedOut -= 1;
      state.released += 1;
    },
  };
  return {
    state,
    poolLike: {
      async connect() {
        state.checkedOut += 1;
        return client;
      },
    },
  };
}

test("persistParsedTripUpdatesSnapshot applies retention delete before snapshot replace", async () => {
  const { persistParsedTripUpdatesSnapshot } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_stop_time_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 2 };
    }
    if (sql.includes("DELETE FROM public.rt_trip_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql === "DELETE FROM public.rt_stop_time_updates") return { rows: [], rowCount: 6 };
    if (sql === "DELETE FROM public.rt_trip_updates") return { rows: [], rowCount: 3 };
    if (sql.includes("INSERT INTO public.rt_trip_updates")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesSnapshot(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-1", route_id: "M1", start_date: "20260225" },
            stop_time_update: [
              {
                stop_id: "8501120",
                stop_sequence: 5,
                departure: { delay: 120, time: 1740500000 },
              },
            ],
          },
        },
      ],
    },
    { writeLockId: 123, retentionHours: 4, poolLike }
  );

  assert.equal(result.retentionHours, 4);
  assert.equal(result.deletedByRetentionStopRows, 2);
  assert.equal(result.deletedByRetentionTripRows, 1);
  assert.equal(result.deletedBySnapshotStopRows, 6);
  assert.equal(result.deletedBySnapshotTripRows, 3);
  assert.equal(result.stopRows, 1);
  assert.equal(result.tripRows, 1);

  const retentionStopIdx = calls.findIndex(
    (call) => call.sql.includes("DELETE FROM public.rt_stop_time_updates") && call.sql.includes("WHERE updated_at <")
  );
  const snapshotStopIdx = calls.findIndex((call) => call.sql === "DELETE FROM public.rt_stop_time_updates");
  assert.ok(retentionStopIdx >= 0 && snapshotStopIdx > retentionStopIdx);
});

// ─── persistParsedTripUpdatesIncremental ─────────────────────────────────────

test("persistParsedTripUpdatesIncremental does NOT execute bare DELETE FROM rt_stop_time_updates or rt_trip_updates", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_stop_time_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM public.rt_trip_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-1", route_id: "M1", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501120", stop_sequence: 5, departure: { delay: 120, time: 1740500000 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, retentionHours: 4, poolLike }
  );

  const bareDeleteStop = calls.some(
    (c) => c.sql === "DELETE FROM public.rt_stop_time_updates"
  );
  const bareDeleteTrip = calls.some(
    (c) => c.sql === "DELETE FROM public.rt_trip_updates"
  );
  assert.equal(bareDeleteStop, false, "must NOT issue bare DELETE FROM rt_stop_time_updates");
  assert.equal(bareDeleteTrip, false, "must NOT issue bare DELETE FROM rt_trip_updates");
});

test("persistParsedTripUpdatesIncremental executes INSERT ... ON CONFLICT for both tables", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-2", route_id: "M2", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501200", stop_sequence: 1, departure: { delay: 60 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, retentionHours: 6, poolLike }
  );

  const upsertTrip = calls.some(
    (c) => c.sql.includes("INSERT INTO public.rt_trip_updates") && c.sql.includes("ON CONFLICT")
  );
  const upsertStop = calls.some(
    (c) => c.sql.includes("INSERT INTO public.rt_stop_time_updates") && c.sql.includes("ON CONFLICT")
  );
  assert.equal(upsertTrip, true, "must execute INSERT ... ON CONFLICT for rt_trip_updates");
  assert.equal(upsertStop, true, "must execute INSERT ... ON CONFLICT for rt_stop_time_updates");
});

test("persistParsedTripUpdatesIncremental uses ON CONFLICT (trip_id, stop_sequence) DO UPDATE for stop_time_updates", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  let capturedStopSql = null;
  const { poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      capturedStopSql = sql;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-conflict-target", route_id: "MC", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501100", stop_sequence: 1, departure: { delay: 30 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  assert.ok(capturedStopSql, "INSERT INTO rt_stop_time_updates must have been called");
  assert.ok(
    capturedStopSql.includes("ON CONFLICT (trip_id, stop_sequence) DO UPDATE"),
    `stop upsert must use ON CONFLICT (trip_id, stop_sequence) DO UPDATE, got: ${capturedStopSql}`
  );
  assert.ok(
    capturedStopSql.includes("stop_id") && capturedStopSql.includes("EXCLUDED.stop_id"),
    "DO UPDATE SET must include stop_id = EXCLUDED.stop_id"
  );
});

test("persistParsedTripUpdatesIncremental does NOT run retention deletes (pruning externalized to pruneRtTripUpdates)", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-3", route_id: "M3", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501300", stop_sequence: 2, departure: { delay: 0 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  const retentionStopCalled = calls.some(
    (c) => c.sql.includes("DELETE FROM public.rt_stop_time_updates") && c.sql.includes("WHERE updated_at <")
  );
  const retentionTripCalled = calls.some(
    (c) => c.sql.includes("DELETE FROM public.rt_trip_updates") && c.sql.includes("WHERE updated_at <")
  );
  assert.equal(retentionStopCalled, false, "must NOT run retention DELETE for rt_stop_time_updates");
  assert.equal(retentionTripCalled, false, "must NOT run retention DELETE for rt_trip_updates");
  assert.equal(result.deletedByRetentionStopRows, undefined, "return value must not include deleted retention rows");
  assert.equal(result.deletedByRetentionTripRows, undefined, "return value must not include deleted retention rows");
  assert.equal(result.retentionHours, undefined, "return value must not include retentionHours");
  assert.equal(result.tripRows, 1);
  assert.equal(result.stopRows, 1);
});

// ─── pruneRtTripUpdates ───────────────────────────────────────────────────────

test("pruneRtTripUpdates deletes rows older than cutoff in chunks from both tables", async () => {
  const { pruneRtTripUpdates } = await loadPersistors();
  const cutoff = new Date("2026-02-28T00:00:00Z");
  const calls = [];
  const poolLike = {
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql: String(sql || "").trim(), params });
          if (String(sql).includes("rt_trip_updates")) return { rowCount: 3 };
          if (String(sql).includes("rt_stop_time_updates")) return { rowCount: 7 };
          return { rowCount: 0 };
        },
        release() {},
      };
    },
  };

  const result = await pruneRtTripUpdates({ cutoff, poolLike });

  assert.equal(result.deletedTripRows, 3);
  assert.equal(result.deletedStopRows, 7);
  assert.equal(result.tripChunksRun, 1);
  assert.equal(result.stopChunksRun, 1);
  assert.ok(calls.some((c) => c.sql.includes("rt_trip_updates") && c.sql.includes("updated_at")));
  assert.ok(calls.some((c) => c.sql.includes("rt_stop_time_updates") && c.sql.includes("updated_at")));
  assert.ok(calls.some((c) => c.params && c.params[0] === cutoff), "cutoff Date must be passed as query param");
});

test("pruneRtTripUpdates runs multiple chunks when rowCount equals chunkSize", async () => {
  const { pruneRtTripUpdates, RT_PRUNE_CHUNK_SIZE } = await loadPersistors();
  const cutoff = new Date("2026-02-28T00:00:00Z");
  let tripCallCount = 0;
  const poolLike = {
    async connect() {
      return {
        async query(sql) {
          if (String(sql).includes("rt_trip_updates")) {
            tripCallCount++;
            return { rowCount: tripCallCount === 1 ? RT_PRUNE_CHUNK_SIZE : 0 };
          }
          return { rowCount: 0 };
        },
        release() {},
      };
    },
  };

  const result = await pruneRtTripUpdates({ cutoff, poolLike, maxChunks: 5 });
  assert.equal(result.tripChunksRun, 2);
  assert.equal(result.deletedTripRows, RT_PRUNE_CHUNK_SIZE);
});

test("pruneRtTripUpdates caps at maxChunks even when table still has rows", async () => {
  const { pruneRtTripUpdates, RT_PRUNE_CHUNK_SIZE } = await loadPersistors();
  const cutoff = new Date("2026-02-28T00:00:00Z");
  const poolLike = {
    async connect() {
      return {
        async query() { return { rowCount: RT_PRUNE_CHUNK_SIZE }; },
        release() {},
      };
    },
  };

  const result = await pruneRtTripUpdates({ cutoff, poolLike, maxChunks: 3 });
  assert.equal(result.tripChunksRun, 3);
  assert.equal(result.stopChunksRun, 3);
  assert.equal(result.deletedTripRows, RT_PRUNE_CHUNK_SIZE * 3);
  assert.equal(result.deletedStopRows, RT_PRUNE_CHUNK_SIZE * 3);
});

test("pruneRtTripUpdates throws on invalid cutoff", async () => {
  const { pruneRtTripUpdates } = await loadPersistors();
  await assert.rejects(
    () => pruneRtTripUpdates({ cutoff: "not-a-date", poolLike: { connect: async () => ({}) } }),
    /pruneRtTripUpdates: cutoff must be a valid Date/
  );
  await assert.rejects(
    () => pruneRtTripUpdates({ cutoff: null, poolLike: { connect: async () => ({}) } }),
    /pruneRtTripUpdates: cutoff must be a valid Date/
  );
});

test("persistParsedTripUpdatesIncremental commits and releases client without leaking transaction", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { state, poolLike } = makeTrackedPoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const out = await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-4", route_id: "M4", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501400", stop_sequence: 3, departure: { delay: 30, time: 1740500000 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  assert.equal(out?.txDiagnostics?.transactionClientUsed, true);
  assert.equal(out?.txDiagnostics?.transactionCommitted, true);
  assert.equal(out?.txDiagnostics?.transactionRolledBack, false);
  assert.equal(out?.txDiagnostics?.clientReleased, true);
  assert.equal(state.transactionOpen, false);
  assert.equal(state.checkedOut, 0);
  assert.equal(state.released, 1);
});

test("persistParsedTripUpdatesIncremental rolls back and releases client on upsert failure", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { state, poolLike } = makeTrackedPoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) {
      throw new Error("forced_upsert_failure");
    }
    return { rows: [], rowCount: 0 };
  });

  let err = null;
  try {
    await persistParsedTripUpdatesIncremental(
      {
        entity: [
          {
            trip_update: {
              trip: { trip_id: "trip-5", route_id: "M5", start_date: "20260225" },
              stop_time_update: [
                { stop_id: "8501500", stop_sequence: 4, departure: { delay: 90, time: 1740500000 } },
              ],
            },
          },
        ],
      },
      { writeLockId: 7483921, poolLike }
    );
  } catch (error) {
    err = error;
  }

  assert.match(String(err?.message || ""), /forced_upsert_failure/);
  assert.equal(err?.txDiagnostics?.transactionClientUsed, true);
  assert.equal(err?.txDiagnostics?.transactionCommitted, false);
  assert.equal(err?.txDiagnostics?.transactionRolledBack, true);
  assert.equal(err?.txDiagnostics?.clientReleased, true);
  assert.equal(state.transactionOpen, false);
  assert.equal(state.checkedOut, 0);
  assert.equal(state.released, 1);
});

// ─── batch-size / MAX_PARAMS invariant tests ──────────────────────────────────
// These tests verify properties that must hold regardless of the exact batch
// size constants, so they remain valid if batch sizes are tuned later.

test("upsert trip batches: no batch exceeds UPSERT_MAX_PARAMS bound parameters and all rows accounted for", async () => {
  const { persistParsedTripUpdatesIncremental, UPSERT_MAX_PARAMS, TRIP_PARAMS_PER_ROW, TRIP_UPSERT_BATCH_SIZE } =
    await loadPersistors();

  // Use a row count large enough to guarantee > 1 batch for any reasonable batch size.
  const n = TRIP_UPSERT_BATCH_SIZE * 2 + 1;
  const entities = Array.from({ length: n }, (_, i) => ({
    trip_update: {
      trip: { trip_id: `trip-inv-${i}`, route_id: "MI", start_date: "20260225" },
      stop_time_update: [],
    },
  }));

  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesIncremental(
    { entity: entities },
    { writeLockId: 7483921, poolLike }
  );

  const tripCalls = calls.filter(
    (c) => c.sql.includes("INSERT INTO public.rt_trip_updates") && c.sql.includes("ON CONFLICT")
  );

  assert.equal(result.tripRows, n, "all trip rows must be processed");
  assert.ok(tripCalls.length > 1, `must use multiple batches for ${n} rows (got ${tripCalls.length})`);
  assert.equal(result.tripBatchCount, tripCalls.length, "tripBatchCount in return value must match actual call count");

  // Invariant: no batch may exceed UPSERT_MAX_PARAMS bound parameters.
  for (const call of tripCalls) {
    assert.ok(
      call.params.length <= UPSERT_MAX_PARAMS,
      `batch used ${call.params.length} params, exceeds UPSERT_MAX_PARAMS ${UPSERT_MAX_PARAMS}`
    );
    assert.equal(call.params.length % TRIP_PARAMS_PER_ROW, 0, "params count must be a multiple of TRIP_PARAMS_PER_ROW");
  }

  // Total params across all batches must equal n * TRIP_PARAMS_PER_ROW.
  const totalParams = tripCalls.reduce((sum, c) => sum + c.params.length, 0);
  assert.equal(totalParams, n * TRIP_PARAMS_PER_ROW, "sum of params across batches must equal total rows × params-per-row");
});

test("upsert stop batches: no batch exceeds UPSERT_MAX_PARAMS bound parameters and all rows accounted for", async () => {
  const { persistParsedTripUpdatesIncremental, UPSERT_MAX_PARAMS, STOP_PARAMS_PER_ROW, STOP_UPSERT_BATCH_SIZE } =
    await loadPersistors();

  const n = STOP_UPSERT_BATCH_SIZE * 2 + 1;
  const stopTimeUpdates = Array.from({ length: n }, (_, i) => ({
    stop_id: `stop-inv-${i}`,
    stop_sequence: i,
    departure: { delay: i },
  }));

  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-stop-inv", route_id: "MI", start_date: "20260225" },
            stop_time_update: stopTimeUpdates,
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  const stopCalls = calls.filter(
    (c) => c.sql.includes("INSERT INTO public.rt_stop_time_updates") && c.sql.includes("ON CONFLICT")
  );

  assert.equal(result.stopRows, n, "all stop rows must be processed");
  assert.ok(stopCalls.length > 1, `must use multiple batches for ${n} rows (got ${stopCalls.length})`);
  assert.equal(result.stopBatchCount, stopCalls.length, "stopBatchCount in return value must match actual call count");

  // Invariant: no batch may exceed UPSERT_MAX_PARAMS bound parameters.
  for (const call of stopCalls) {
    assert.ok(
      call.params.length <= UPSERT_MAX_PARAMS,
      `batch used ${call.params.length} params, exceeds UPSERT_MAX_PARAMS ${UPSERT_MAX_PARAMS}`
    );
    assert.equal(call.params.length % STOP_PARAMS_PER_ROW, 0, "params count must be a multiple of STOP_PARAMS_PER_ROW");
  }

  const totalParams = stopCalls.reduce((sum, c) => sum + c.params.length, 0);
  assert.equal(totalParams, n * STOP_PARAMS_PER_ROW, "sum of params across batches must equal total rows × params-per-row");
});

test("upsert batch stats: return value includes tripBatchCount, stopBatchCount, maxBatchSize fields", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();

  const { poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates") && sql.includes("ON CONFLICT")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-stats", route_id: "MS", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8500001", stop_sequence: 1, departure: { delay: 10 } },
              { stop_id: "8500002", stop_sequence: 2, departure: { delay: 20 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  assert.equal(typeof result.tripBatchCount, "number");
  assert.equal(typeof result.tripMaxBatchSize, "number");
  assert.equal(typeof result.stopBatchCount, "number");
  assert.equal(typeof result.stopMaxBatchSize, "number");
  assert.ok(result.tripBatchCount >= 1);
  assert.ok(result.stopBatchCount >= 1);
  assert.ok(result.tripMaxBatchSize >= 1);
  assert.ok(result.stopMaxBatchSize >= 1);
});

// ─── persistParsedServiceAlertsSnapshot ──────────────────────────────────────

test("persistParsedServiceAlertsSnapshot keeps snapshot bounded and reports delete/insert counts", async () => {
  const { persistParsedServiceAlertsSnapshot } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_service_alerts") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 4 };
    }
    if (sql === "DELETE FROM public.rt_service_alerts") return { rows: [], rowCount: 11 };
    if (sql.includes("INSERT INTO public.rt_service_alerts")) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedServiceAlertsSnapshot(
    {
      entity: [
        {
          id: "alert-1",
          alert: {
            effect: "DETOUR",
            informed_entity: [{ stop_id: "8501120" }],
            active_period: [{ start: 1740500000, end: 1740503600 }],
            header_text: { translation: [{ text: "Alert 1", language: "en" }] },
          },
        },
      ],
    },
    { writeLockId: 456, poolLike }
  );

  assert.equal(result.retentionHours, 6);
  assert.equal(result.deletedByRetentionAlertRows, 4);
  assert.equal(result.deletedBySnapshotAlertRows, 11);
  assert.equal(result.alertRows, 1);

  assert.equal(
    calls.some((call) => call.sql.includes("DELETE FROM public.rt_service_alerts") && call.sql.includes("WHERE updated_at <")),
    true
  );
  assert.equal(calls.some((call) => call.sql === "DELETE FROM public.rt_service_alerts"), true);
});

test("persistParsedTripUpdatesSnapshot commits and releases client without leaking transaction", async () => {
  const { persistParsedTripUpdatesSnapshot } = await loadPersistors();
  const { state, poolLike } = makeTrackedPoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_stop_time_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("DELETE FROM public.rt_trip_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql === "DELETE FROM public.rt_stop_time_updates") return { rows: [], rowCount: 0 };
    if (sql === "DELETE FROM public.rt_trip_updates") return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const out = await persistParsedTripUpdatesSnapshot(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-1", route_id: "M1", start_date: "20260225" },
            stop_time_update: [
              { stop_id: "8501120", stop_sequence: 5, departure: { delay: 120, time: 1740500000 } },
            ],
          },
        },
      ],
    },
    { writeLockId: 321, poolLike }
  );

  assert.equal(out?.txDiagnostics?.transactionClientUsed, true);
  assert.equal(out?.txDiagnostics?.transactionCommitted, true);
  assert.equal(out?.txDiagnostics?.transactionRolledBack, false);
  assert.equal(out?.txDiagnostics?.clientReleased, true);
  assert.equal(state.transactionOpen, false);
  assert.equal(state.checkedOut, 0);
  assert.equal(state.released, 1);
});

test("persistParsedTripUpdatesSnapshot rolls back and releases client on write failure", async () => {
  const { persistParsedTripUpdatesSnapshot } = await loadPersistors();
  const { state, poolLike } = makeTrackedPoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_stop_time_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("DELETE FROM public.rt_trip_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql === "DELETE FROM public.rt_stop_time_updates") return { rows: [], rowCount: 0 };
    if (sql === "DELETE FROM public.rt_trip_updates") return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_trip_updates")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO public.rt_stop_time_updates")) {
      throw new Error("forced_insert_failure");
    }
    return { rows: [], rowCount: 0 };
  });

  let err = null;
  try {
    await persistParsedTripUpdatesSnapshot(
      {
        entity: [
          {
            trip_update: {
              trip: { trip_id: "trip-1", route_id: "M1", start_date: "20260225" },
              stop_time_update: [
                { stop_id: "8501120", stop_sequence: 5, departure: { delay: 120, time: 1740500000 } },
              ],
            },
          },
        ],
      },
      { writeLockId: 654, poolLike }
    );
  } catch (error) {
    err = error;
  }

  assert.match(String(err?.message || ""), /forced_insert_failure/);

  assert.equal(err?.txDiagnostics?.transactionClientUsed, true);
  assert.equal(err?.txDiagnostics?.transactionCommitted, false);
  assert.equal(err?.txDiagnostics?.transactionRolledBack, true);
  assert.equal(err?.txDiagnostics?.clientReleased, true);
  assert.equal(state.transactionOpen, false);
  assert.equal(state.checkedOut, 0);
  assert.equal(state.released, 1);
});

test("persistParsedServiceAlertsSnapshot includes header_translations and description_translations in INSERT", async () => {
  const { persistParsedServiceAlertsSnapshot } = await loadPersistors();
  let capturedInsertSql = null;
  let capturedInsertParams = null;

  const { poolLike } = makePoolLike((sql, params) => {
    if (sql.includes("DELETE FROM public.rt_service_alerts")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_service_alerts")) {
      capturedInsertSql = sql;
      capturedInsertParams = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await persistParsedServiceAlertsSnapshot(
    {
      entity: [
        {
          id: "alert-ml",
          alert: {
            effect: "DETOUR",
            informed_entity: [{ stop_id: "8501120" }],
            active_period: [{ start: 1740500000, end: 1740503600 }],
            header_text: {
              translation: [
                { text: "Bauarbeiten", language: "de" },
                { text: "Travaux", language: "fr" },
              ],
            },
            description_text: {
              translation: [
                { text: "Quai geschlossen", language: "de" },
                { text: "Quai fermé", language: "fr" },
              ],
            },
          },
        },
      ],
    },
    { writeLockId: 789, poolLike }
  );

  assert.ok(capturedInsertSql, "INSERT must have been called");
  assert.ok(capturedInsertSql.includes("header_translations"), "INSERT SQL must include header_translations column");
  assert.ok(capturedInsertSql.includes("description_translations"), "INSERT SQL must include description_translations column");
  assert.ok(capturedInsertSql.includes("::jsonb"), "INSERT must cast JSONB columns");

  // Params contain 11 values per row (p += 11). Check that the JSONB translation
  // params are non-null JSON strings containing the expected language entries.
  const headerTranslationParam = capturedInsertParams.find(
    (p) => typeof p === "string" && p.includes("\"de\"") && p.includes("Bauarbeiten")
  );
  const descTranslationParam = capturedInsertParams.find(
    (p) => typeof p === "string" && p.includes("\"de\"") && p.includes("Quai geschlossen")
  );
  assert.ok(headerTranslationParam, "header_translations param must be a JSON string with 'de' translation");
  assert.ok(descTranslationParam, "description_translations param must be a JSON string with 'de' translation");

  const headerParsed = JSON.parse(headerTranslationParam);
  const descParsed = JSON.parse(descTranslationParam);
  assert.equal(headerParsed.length, 2, "header must have 2 translations");
  assert.equal(descParsed.length, 2, "description must have 2 translations");
  assert.ok(headerParsed.some((t) => t.language === "fr" && t.text === "Travaux"), "French header translation must be present");
  assert.ok(descParsed.some((t) => t.language === "fr" && t.text === "Quai fermé"), "French description translation must be present");
});

test("persistParsedServiceAlertsSnapshot populates header_translations from plain-string header_text", async () => {
  const { persistParsedServiceAlertsSnapshot } = await loadPersistors();
  let capturedInsertParams = null;

  const { poolLike } = makePoolLike((sql, params) => {
    if (sql.includes("DELETE FROM public.rt_service_alerts")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.rt_service_alerts")) {
      capturedInsertParams = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await persistParsedServiceAlertsSnapshot(
    {
      entity: [
        {
          id: "alert-no-trans",
          alert: {
            effect: "DETOUR",
            informed_entity: [{ stop_id: "8501120" }],
            active_period: [],
            // No translation arrays — only a plain string for header
            header_text: "Plain text only",
          },
        },
      ],
    },
    { writeLockId: 790, poolLike }
  );

  assert.ok(capturedInsertParams, "INSERT must have been called");
  // The plain header text normalizes to a single-entry translations JSON array
  const headerTranslationParam = capturedInsertParams.find(
    (p) => typeof p === "string" && p.startsWith("[") && p.includes("Plain text only")
  );
  assert.ok(headerTranslationParam, "header_translations should still be populated from plain text");
  const parsed = JSON.parse(headerTranslationParam);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "Plain text only");
});
