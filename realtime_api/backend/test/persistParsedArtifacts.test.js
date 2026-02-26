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

test("persistParsedTripUpdatesIncremental still runs retention deletes", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();
  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM public.rt_stop_time_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 3 };
    }
    if (sql.includes("DELETE FROM public.rt_trip_updates") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 2 };
    }
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
    { writeLockId: 7483921, retentionHours: 4, poolLike }
  );

  assert.equal(result.deletedByRetentionStopRows, 3);
  assert.equal(result.deletedByRetentionTripRows, 2);
  assert.equal(result.tripRows, 1);
  assert.equal(result.stopRows, 1);
  assert.equal(result.retentionHours, 4);

  const retentionStopCalled = calls.some(
    (c) => c.sql.includes("DELETE FROM public.rt_stop_time_updates") && c.sql.includes("WHERE updated_at <")
  );
  const retentionTripCalled = calls.some(
    (c) => c.sql.includes("DELETE FROM public.rt_trip_updates") && c.sql.includes("WHERE updated_at <")
  );
  assert.equal(retentionStopCalled, true, "must run retention DELETE for rt_stop_time_updates");
  assert.equal(retentionTripCalled, true, "must run retention DELETE for rt_trip_updates");
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

// ─── batch-size / multi-batch behaviour ──────────────────────────────────────

test("persistParsedTripUpdatesIncremental issues multiple batches for trip rows exceeding batch size (200)", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();

  // Build 201 distinct trips so we cross the 200-row batch boundary.
  const entities = Array.from({ length: 201 }, (_, i) => ({
    trip_update: {
      trip: { trip_id: `trip-batch-${i}`, route_id: "MB", start_date: "20260225" },
      stop_time_update: [],
    },
  }));

  const { calls, poolLike } = makePoolLike((sql) => {
    if (sql.includes("DELETE FROM") && sql.includes("WHERE updated_at <")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO public.rt_trip_updates") && sql.includes("ON CONFLICT")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const result = await persistParsedTripUpdatesIncremental(
    { entity: entities },
    { writeLockId: 7483921, poolLike }
  );

  const tripUpsertCalls = calls.filter(
    (c) => c.sql.includes("INSERT INTO public.rt_trip_updates") && c.sql.includes("ON CONFLICT")
  );
  assert.equal(result.tripRows, 201);
  assert.equal(tripUpsertCalls.length, 2, "201 trip rows at batch-size 200 must produce exactly 2 INSERT statements");
  // First batch should carry 200 rows (200 × 4 params = 800 params)
  assert.equal(tripUpsertCalls[0].params.length, 800);
  // Second batch carries the 1 remaining row (1 × 4 params = 4 params)
  assert.equal(tripUpsertCalls[1].params.length, 4);
});

test("persistParsedTripUpdatesIncremental issues multiple batches for stop rows exceeding batch size (100)", async () => {
  const { persistParsedTripUpdatesIncremental } = await loadPersistors();

  // One trip, 101 distinct stop-time updates so we cross the 100-row batch boundary.
  const stopTimeUpdates = Array.from({ length: 101 }, (_, i) => ({
    stop_id: `stop-${i}`,
    stop_sequence: i,
    departure: { delay: i },
  }));

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

  const result = await persistParsedTripUpdatesIncremental(
    {
      entity: [
        {
          trip_update: {
            trip: { trip_id: "trip-stop-batch", route_id: "MB", start_date: "20260225" },
            stop_time_update: stopTimeUpdates,
          },
        },
      ],
    },
    { writeLockId: 7483921, poolLike }
  );

  const stopUpsertCalls = calls.filter(
    (c) => c.sql.includes("INSERT INTO public.rt_stop_time_updates") && c.sql.includes("ON CONFLICT")
  );
  assert.equal(result.stopRows, 101);
  assert.equal(stopUpsertCalls.length, 2, "101 stop rows at batch-size 100 must produce exactly 2 INSERT statements");
  // First batch: 100 rows × 9 params = 900 params
  assert.equal(stopUpsertCalls[0].params.length, 900);
  // Second batch: 1 row × 9 params = 9 params
  assert.equal(stopUpsertCalls[1].params.length, 9);
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
