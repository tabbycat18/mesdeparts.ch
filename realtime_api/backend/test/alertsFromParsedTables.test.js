import test from "node:test";
import assert from "node:assert/strict";

async function loadAlertsFromParsedTablesFn() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../src/rt/loadAlertsFromParsedTables.js");
  return mod.loadAlertsFromParsedTables;
}

function makeQueryLike({ rows = [], error = null } = {}) {
  return async () => {
    if (error) throw error;
    return { rows };
  };
}

test("loadAlertsFromParsedTables returns disabled when alerts are disabled", async () => {
  const loadAlertsFromParsedTables = await loadAlertsFromParsedTablesFn();
  const out = await loadAlertsFromParsedTables({
    enabled: false,
    queryLike: async () => {
      throw new Error("must_not_query");
    },
  });

  assert.equal(out.meta.reason, "disabled");
  assert.equal(out.meta.alertsSource, "parsed");
  assert.equal(Array.isArray(out.alerts.entities), true);
  assert.equal(out.alerts.entities.length, 0);
});

test("loadAlertsFromParsedTables uses parsed rows and scopes by stop_id", async () => {
  const loadAlertsFromParsedTables = await loadAlertsFromParsedTablesFn();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const out = await loadAlertsFromParsedTables({
    enabled: true,
    nowMs,
    scopeStopIds: ["8503000:0:1"],
    queryLike: makeQueryLike({
      rows: [
        {
          alert_id: "alert-hit",
          effect: "DETOUR",
          cause: "CONSTRUCTION",
          severity: "warning",
          header_text: "Travaux",
          description_text: "Quai fermé",
          active_start: nowSec - 60,
          active_end: nowSec + 600,
          informed_entities: [{ stop_id: "8503000:0:1" }],
          updated_at: new Date(nowMs - 2000).toISOString(),
        },
        {
          alert_id: "alert-miss",
          effect: "DETOUR",
          cause: "CONSTRUCTION",
          severity: "warning",
          header_text: "Autre",
          description_text: "Autre",
          active_start: nowSec - 60,
          active_end: nowSec + 600,
          informed_entities: [{ stop_id: "8503999:0:1" }],
          updated_at: new Date(nowMs - 3000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.alertsSource, "parsed");
  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.cacheStatus, "FRESH");
  assert.equal(out.alerts.entities.length, 1);
  assert.equal(out.alerts.entities[0].id, "alert-hit");
});

test("loadAlertsFromParsedTables returns parsed_unavailable when table is missing", async () => {
  const loadAlertsFromParsedTables = await loadAlertsFromParsedTablesFn();
  const out = await loadAlertsFromParsedTables({
    enabled: true,
    queryLike: makeQueryLike({
      error: Object.assign(new Error("relation public.rt_service_alerts does not exist"), {
        code: "42P01",
      }),
    }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "parsed_unavailable");
  assert.equal(out.meta.cacheStatus, "ERROR");
  assert.equal(out.meta.alertsSource, "parsed");
});

test("loadAlertsFromParsedTables uses scoped SQL with lookback and avoids rt_cache reads", async () => {
  const loadAlertsFromParsedTables = await loadAlertsFromParsedTablesFn();
  const seenSql = [];
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const out = await loadAlertsFromParsedTables({
    enabled: true,
    nowMs,
    scopeStopIds: ["8503000:0:1"],
    scopeLookbackMs: 30 * 60 * 1000,
    queryLike: async (sql, params) => {
      const query = String(sql || "");
      seenSql.push(query);
      assert.equal(query.includes("FROM public.rt_service_alerts"), true);
      assert.equal(query.includes("updated_at >="), true);
      assert.equal(query.includes("jsonb_array_elements"), true);
      assert.equal(Number(params?.[0]), 30 * 60 * 1000);
      assert.deepEqual(params?.[1], ["8503000:0:1"]);
      return {
        rows: [
          {
            alert_id: "alert-sql-scope",
            effect: "DETOUR",
            cause: "CONSTRUCTION",
            severity: "warning",
            header_text: "Travaux",
            description_text: "Quai fermé",
            active_start: nowSec - 60,
            active_end: nowSec + 600,
            informed_entities: [{ stop_id: "8503000:0:1" }],
            updated_at: new Date(nowMs - 1000).toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.alertsSource, "parsed");
  assert.equal(out.alerts.entities.length, 1);
  assert.equal(
    seenSql.some((query) => query.toLowerCase().includes("from public.rt_cache")),
    false
  );
});
