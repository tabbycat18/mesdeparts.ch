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
