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

test("loadAlertsFromParsedTables reads JSONB multi-language translations when available", async () => {
  const loadAlertsFromParsedTables = await loadAlertsFromParsedTablesFn();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const headerTranslations = [
    { language: "de", text: "Bauarbeiten" },
    { language: "fr", text: "Travaux" },
    { language: "it", text: "Lavori in corso" },
    { language: "en", text: "Construction" },
  ];
  const descriptionTranslations = [
    { language: "de", text: "Quai geschlossen" },
    { language: "fr", text: "Quai fermé" },
    { language: "it", text: "Banchina chiusa" },
    { language: "en", text: "Platform closed" },
  ];

  const out = await loadAlertsFromParsedTables({
    enabled: true,
    nowMs,
    scopeStopIds: ["8503000:0:1"],
    queryLike: makeQueryLike({
      rows: [
        {
          alert_id: "alert-multilang",
          effect: "DETOUR",
          cause: "CONSTRUCTION",
          severity: "warning",
          header_text: "Travaux",
          description_text: "Quai fermé",
          // JSONB columns (as JSON-stringified arrays)
          header_translations: JSON.stringify(headerTranslations),
          description_translations: JSON.stringify(descriptionTranslations),
          active_start: nowSec - 60,
          active_end: nowSec + 600,
          informed_entities: [{ stop_id: "8503000:0:1" }],
          updated_at: new Date(nowMs - 1000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.alerts.entities.length, 1);

  const alert = out.alerts.entities[0];
  assert.equal(alert.id, "alert-multilang");
  assert.equal(Array.isArray(alert.headerTranslations), true);
  assert.equal(Array.isArray(alert.descriptionTranslations), true);
  assert.equal(alert.headerTranslations.length, 4);
  assert.equal(alert.descriptionTranslations.length, 4);

  // Verify all languages are present
  const headerLangs = new Set(alert.headerTranslations.map((t) => t.language));
  assert.ok(headerLangs.has("de"), "German must be present in header translations");
  assert.ok(headerLangs.has("fr"), "French must be present in header translations");
  assert.ok(headerLangs.has("it"), "Italian must be present in header translations");
  assert.ok(headerLangs.has("en"), "English must be present in header translations");

  const descLangs = new Set(alert.descriptionTranslations.map((t) => t.language));
  assert.ok(descLangs.has("de"), "German must be present in description translations");
  assert.ok(descLangs.has("fr"), "French must be present in description translations");
  assert.ok(descLangs.has("it"), "Italian must be present in description translations");
  assert.ok(descLangs.has("en"), "English must be present in description translations");
});

test("loadAlertsFromParsedTables falls back to single-language text columns when JSONB is absent", async () => {
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
          alert_id: "alert-single-lang",
          effect: "DETOUR",
          cause: "CONSTRUCTION",
          severity: "warning",
          header_text: "Travaux",
          description_text: "Quai fermé",
          // JSONB columns absent (null or undefined)
          header_translations: null,
          description_translations: null,
          active_start: nowSec - 60,
          active_end: nowSec + 600,
          informed_entities: [{ stop_id: "8503000:0:1" }],
          updated_at: new Date(nowMs - 1000).toISOString(),
        },
      ],
    }),
  });

  assert.equal(out.meta.applied, true);
  assert.equal(out.alerts.entities.length, 1);

  const alert = out.alerts.entities[0];
  assert.equal(alert.id, "alert-single-lang");
  // Should fall back to single-language format
  assert.equal(Array.isArray(alert.headerTranslations), true);
  assert.equal(alert.headerTranslations.length, 1);
  assert.equal(alert.headerTranslations[0].language, "");
  assert.equal(alert.headerTranslations[0].text, "Travaux");
});
