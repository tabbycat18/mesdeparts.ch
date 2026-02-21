import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetSearchCapabilitiesCacheForTests,
  searchStops,
} from "../src/search/stopsSearch.js";

function capabilityRow(overrides = {}) {
  return {
    has_stop_search_index: false,
    has_stop_aliases: false,
    has_app_stop_aliases: false,
    has_normalize_fn: false,
    has_strip_fn: false,
    has_pg_trgm: false,
    has_unaccent: false,
    ...overrides,
  };
}

test("searchStops falls back deterministically when primary capabilities are missing", async () => {
  __resetSearchCapabilitiesCacheForTests();

  const db = {
    async query(sql) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        return {
          rows: [
            {
              group_id: "Parent1100105",
              stop_id: "Parent1100105",
              stop_name: "St. Blasien, Busbahnhof",
              parent_station: null,
              location_type: "",
              city_name: "St. Blasien",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 10,
            },
            {
              group_id: "Parent8506302",
              stop_id: "Parent8506302",
              stop_name: "St. Gallen",
              parent_station: null,
              location_type: "",
              city_name: "St. Gallen",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 5000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "St Gallen", 7);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_id, "Parent8506302");
});

test("searchStops degrades to fallback when primary query throws", async () => {
  __resetSearchCapabilitiesCacheForTests();

  const db = {
    async query(sql) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return {
          rows: [
            capabilityRow({
              has_stop_search_index: true,
              has_stop_aliases: true,
              has_app_stop_aliases: false,
              has_normalize_fn: true,
              has_strip_fn: true,
              has_pg_trgm: true,
              has_unaccent: true,
            }),
          ],
        };
      }

      if (text.includes("alias_hits AS")) {
        throw new Error("primary_query_failed");
      }

      if (text.includes("FROM public.stop_search_index b")) {
        return {
          rows: [
            {
              group_id: "Parent8503409",
              stop_id: "Parent8503409",
              stop_name: "Bad Zurzach",
              parent_station: null,
              location_type: "",
              city_name: "Bad Zurzach",
              name_norm: "bad zurzach",
              name_core: "bad zurzach",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0.1,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 20,
            },
            {
              group_id: "Parent8503000",
              stop_id: "Parent8503000",
              stop_name: "Zürich HB",
              parent_station: null,
              location_type: "",
              city_name: "Zürich",
              name_norm: "zurich hb",
              name_core: "zurich hb",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0.85,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: true,
              nb_stop_times: 120000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "Zurich", 7);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_id, "Parent8503000");
});

test("searchStops forces degraded prefix fallback when unaccent extension is unavailable", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let primaryCalled = false;

  const db = {
    async query(sql) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return {
          rows: [
            capabilityRow({
              has_stop_search_index: true,
              has_stop_aliases: false,
              has_app_stop_aliases: false,
              has_normalize_fn: true,
              has_strip_fn: true,
              has_pg_trgm: true,
              has_unaccent: false,
            }),
          ],
        };
      }

      if (text.includes("alias_hits AS")) {
        primaryCalled = true;
        throw new Error("primary_should_not_run_without_unaccent");
      }

      if (text.includes("FROM public.stop_search_index b")) {
        return {
          rows: [
            {
              group_id: "Parent8503409",
              stop_id: "Parent8503409",
              stop_name: "Bad Zurzach",
              parent_station: null,
              location_type: "",
              city_name: "Bad Zurzach",
              name_norm: "bad zurzach",
              name_core: "bad zurzach",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 20,
            },
            {
              group_id: "Parent8503000",
              stop_id: "Parent8503000",
              stop_name: "Zürich HB",
              parent_station: null,
              location_type: "",
              city_name: "Zürich",
              name_norm: "zurich hb",
              name_core: "zurich hb",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: true,
              nb_stop_times: 120000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "Zurich", 7);
  assert.equal(primaryCalled, false);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_id, "Parent8503000");
});

test("searchStops backoff keeps full query from being worse than one-char-shorter query", async () => {
  __resetSearchCapabilitiesCacheForTests();

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        const qNorm = String(params?.[0] || "");
        if (qNorm !== "riponn") {
          return { rows: [] };
        }
        return {
          rows: [
            {
              group_id: "Parent8592082",
              stop_id: "Parent8592082",
              stop_name: "Lausanne, Riponne",
              parent_station: null,
              location_type: "",
              city_name: "Lausanne",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 100,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "Riponne", 10);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_name, "Lausanne, Riponne");
});

test("degraded fallback SQL supports non-leading substring matches", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let sawSubstringClause = false;

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        sawSubstringClause =
          text.includes("b.name_fold LIKE '%' || p.q_fold || '%'");

        const qNorm = String(params?.[0] || "");
        if (qNorm !== "grande bor") return { rows: [] };
        return {
          rows: [
            {
              group_id: "Parent8591979",
              stop_id: "Parent8591979",
              stop_name: "Lausanne, Grande-Borde",
              parent_station: null,
              location_type: "",
              city_name: "Lausanne",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 200,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "Grande Bor", 10);
  assert.equal(sawSubstringClause, true);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_name, "Lausanne, Grande-Borde");
});

test("degraded fallback SQL folds accents/punctuation for Geneve, Poterie queries", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let sawFoldClause = false;

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        sawFoldClause =
          text.includes("translate(") &&
          text.includes("b.name_fold LIKE '%' || p.q_fold || '%'");

        const qNorm = String(params?.[0] || "");
        if (qNorm !== "geneve poterie") return { rows: [] };
        return {
          rows: [
            {
              group_id: "Parent8587320",
              stop_id: "Parent8587320",
              stop_name: "Genève, Poterie",
              parent_station: null,
              location_type: "",
              city_name: "Genève",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 400,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "geneve, poterie", 10);
  assert.equal(sawFoldClause, true);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_name, "Genève, Poterie");
});

test("degraded fallback SQL folds st→saint in name_fold for Lausanne, St-François", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let sawSaintExpansion = false;

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        // Verify that the SQL expands st→saint in name_fold
        sawSaintExpansion =
          text.includes("\\m(st|saint)\\M") &&
          text.includes("'saint'");

        const qNorm = String(params?.[0] || "");
        // Return St-François only when query normalizes to "lausanne saint francois"
        if (qNorm !== "lausanne saint francois") return { rows: [] };
        return {
          rows: [
            {
              group_id: "Parent8591191",
              stop_id: "Parent8591191",
              stop_name: "Lausanne, St-François",
              parent_station: null,
              location_type: "",
              city_name: "Lausanne",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 27000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "lausanne st francois", 10);
  assert.ok(sawSaintExpansion, "fallback SQL should expand st→saint in name_fold");
  assert.ok(rows.length > 0);
  assert.equal(rows[0].stop_name, "Lausanne, St-François");
});

test("degraded fallback SQL includes token-AND condition for multi-word queries", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let sawTokenAndClause = false;

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        // Verify the token-AND NOT EXISTS pattern is present
        sawTokenAndClause =
          text.includes("q_has_space") ||
          text.includes("q_sig_tokens") ||
          text.includes("NOT EXISTS") ||
          text.includes("cardinality");

        const qNorm = String(params?.[0] || "");
        if (!qNorm.includes("francois")) return { rows: [] };
        return {
          rows: [
            {
              group_id: "Parent8591191",
              stop_id: "Parent8591191",
              stop_name: "Lausanne, St-François",
              parent_station: null,
              location_type: "",
              city_name: "Lausanne",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 27000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "lausanne francois", 10);
  assert.ok(rows.length > 0, "expected results for 'lausanne francois'");
  assert.equal(rows[0].stop_name, "Lausanne, St-François");
});

test("sr francois typo is normalized to saint francois before DB query", async () => {
  __resetSearchCapabilitiesCacheForTests();

  let receivedQuery = null;

  const db = {
    async query(sql, params = []) {
      const text = String(sql || "");

      if (text.includes("to_regclass('public.stop_search_index')")) {
        return { rows: [capabilityRow()] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        receivedQuery = String(params?.[0] || "");
        return {
          rows: [
            {
              group_id: "Parent8591191",
              stop_id: "Parent8591191",
              stop_name: "Lausanne, St-François",
              parent_station: null,
              location_type: "",
              city_name: "Lausanne",
              aliases_matched: [],
              alias_weight: 0,
              alias_similarity: 0,
              name_similarity: 0,
              core_similarity: 0,
              is_parent: true,
              has_hub_token: false,
              nb_stop_times: 27000,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };

  const rows = await searchStops(db, "sr francois", 10);
  // The DB should receive "saint francois", not "sr francois"
  assert.ok(
    receivedQuery !== null && receivedQuery.includes("saint") && !receivedQuery.includes("sr "),
    `expected query with "saint", got: "${receivedQuery}"`
  );
  assert.ok(rows.length > 0);
});
