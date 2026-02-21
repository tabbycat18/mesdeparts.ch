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

      if (text.includes("FROM public.stop_search_index b")) {
        throw new Error("primary_query_failed");
      }

      if (text.includes("FROM public.stop_aliases sa")) {
        return { rows: [] };
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        return {
          rows: [
            {
              group_id: "Parent8503409",
              stop_id: "Parent8503409",
              stop_name: "Bad Zurzach",
              parent_station: null,
              location_type: "",
              city_name: "Bad Zurzach",
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

      if (text.includes("FROM public.stop_search_index b")) {
        primaryCalled = true;
        throw new Error("primary_should_not_run_without_unaccent");
      }

      if (text.includes("FROM public.gtfs_stops s")) {
        return {
          rows: [
            {
              group_id: "Parent8503409",
              stop_id: "Parent8503409",
              stop_name: "Bad Zurzach",
              parent_station: null,
              location_type: "",
              city_name: "Bad Zurzach",
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
          text.includes("b.name_lower LIKE '%' || p.q_norm || '%'") &&
          text.includes("b.name_simple LIKE '%' || p.q_norm || '%'");

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
