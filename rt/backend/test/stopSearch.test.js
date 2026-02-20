import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSearchText, rankStopCandidates } from "../src/search/stopsSearch.js";

function fixtureRows() {
  return [
    {
      group_id: "Parent8503000",
      stop_id: "Parent8503000",
      stop_name: "Zürich HB",
      parent_station: "",
      location_type: "1",
      city_name: "Zürich",
      aliases_matched: ["zurich", "zurich hb", "zurich hbf", "hauptbahnhof zurich"],
      alias_weight: 9,
      alias_similarity: 0.94,
      name_similarity: 0.9,
      core_similarity: 0.9,
      nb_stop_times: 120000,
      is_parent: true,
      has_hub_token: true,
    },
    {
      group_id: "8503000:0:41",
      stop_id: "8503000:0:41",
      stop_name: "Zürich HB",
      parent_station: "Parent8503000",
      location_type: "",
      city_name: "Zürich",
      aliases_matched: [],
      alias_weight: 0,
      alias_similarity: 0,
      name_similarity: 0.88,
      core_similarity: 0.88,
      nb_stop_times: 2000,
      is_parent: false,
      has_hub_token: true,
    },
    {
      group_id: "Parent8503016",
      stop_id: "Parent8503016",
      stop_name: "Zürich Oerlikon",
      parent_station: "",
      location_type: "1",
      city_name: "Zürich",
      aliases_matched: [],
      alias_weight: 0,
      alias_similarity: 0,
      name_similarity: 0.82,
      core_similarity: 0.82,
      nb_stop_times: 38000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8503003",
      stop_id: "Parent8503003",
      stop_name: "Zürich Hardbrücke",
      parent_station: "",
      location_type: "1",
      city_name: "Zürich",
      aliases_matched: [],
      alias_weight: 0,
      alias_similarity: 0,
      name_similarity: 0.8,
      core_similarity: 0.8,
      nb_stop_times: 26000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8501008",
      stop_id: "Parent8501008",
      stop_name: "Genève",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["geneve", "genève"],
      alias_weight: 8,
      alias_similarity: 0.92,
      name_similarity: 0.88,
      core_similarity: 0.88,
      nb_stop_times: 110000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8587057",
      stop_id: "Parent8587057",
      stop_name: "Genève, gare Cornavin",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["cornavin", "gare cornavin", "geneve cornavin"],
      alias_weight: 9,
      alias_similarity: 0.95,
      name_similarity: 0.86,
      core_similarity: 0.86,
      nb_stop_times: 90000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8501020",
      stop_id: "Parent8501020",
      stop_name: "Genève-Aéroport",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["geneve aeroport"],
      alias_weight: 1,
      alias_similarity: 0.5,
      name_similarity: 0.74,
      core_similarity: 0.74,
      nb_stop_times: 24000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8587387",
      stop_id: "Parent8587387",
      stop_name: "Genève, Bel-Air",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["bel air", "geneve bel air"],
      alias_weight: 1.5,
      alias_similarity: 0.75,
      name_similarity: 0.72,
      core_similarity: 0.72,
      nb_stop_times: 32000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8501120",
      stop_id: "Parent8501120",
      stop_name: "Lausanne",
      parent_station: "",
      location_type: "1",
      city_name: "Lausanne",
      aliases_matched: ["lausanne gare"],
      alias_weight: 7,
      alias_similarity: 0.88,
      name_similarity: 0.9,
      core_similarity: 0.9,
      nb_stop_times: 98000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8587055",
      stop_id: "Parent8587055",
      stop_name: "Lausanne, Bel-Air",
      parent_station: "",
      location_type: "0",
      city_name: "Lausanne",
      aliases_matched: ["bel air lausanne", "lausanne bel air"],
      alias_weight: 9,
      alias_similarity: 0.96,
      name_similarity: 0.94,
      core_similarity: 0.94,
      nb_stop_times: 25000,
      is_parent: false,
      has_hub_token: false,
    },
    {
      group_id: "Parent8587055",
      stop_id: "8587055:0:1",
      stop_name: "Bel-Air, Lausanne",
      parent_station: "Parent8587055",
      location_type: "0",
      city_name: "Lausanne",
      aliases_matched: ["bel air lausanne"],
      alias_weight: 1,
      alias_similarity: 0.65,
      name_similarity: 0.72,
      core_similarity: 0.72,
      nb_stop_times: 25000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8506302",
      stop_id: "Parent8506302",
      stop_name: "St. Gallen",
      parent_station: "",
      location_type: "1",
      city_name: "St. Gallen",
      aliases_matched: ["st gallen", "st. gallen", "saint gallen"],
      alias_weight: 8.8,
      alias_similarity: 0.92,
      name_similarity: 0.9,
      core_similarity: 0.9,
      nb_stop_times: 76000,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent1201427",
      stop_id: "Parent1201427",
      stop_name: "St Gallenkirch, Badmunt",
      parent_station: "",
      location_type: "1",
      city_name: "St Gallenkirch",
      aliases_matched: [],
      alias_weight: 0,
      alias_similarity: 0,
      name_similarity: 0.6,
      core_similarity: 0.6,
      nb_stop_times: 200,
      is_parent: true,
      has_hub_token: false,
    },
    {
      group_id: "Parent8500010",
      stop_id: "Parent8500010",
      stop_name: "Basel SBB",
      parent_station: "",
      location_type: "1",
      city_name: "Basel",
      aliases_matched: ["basel main station"],
      alias_weight: 1,
      alias_similarity: 0.2,
      name_similarity: 0.2,
      core_similarity: 0.2,
      nb_stop_times: 1000,
      is_parent: true,
      has_hub_token: false,
    },
  ];
}

test("normalizeSearchText strips diacritics, punctuation and abbreviations", () => {
  assert.equal(normalizeSearchText("  Genève-Bel_Air.  "), "geneve bel air");
  assert.equal(normalizeSearchText("Zürich"), "zurich");
  assert.equal(normalizeSearchText("St. Gallen"), "saint gallen");
  assert.equal(normalizeSearchText("Zürich Hauptbahnhof"), "zurich hb");
});

test("Zurich includes Zürich HB in top 3", () => {
  const ranked = rankStopCandidates(fixtureRows(), "Zurich", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8503000"));
});

test("Zürich ranks Zürich HB first", () => {
  const ranked = rankStopCandidates(fixtureRows(), "Zürich", 7);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].stop_id, "Parent8503000");
});

test("St. Gallen query returns St. Gallen in top results", () => {
  const ranked = rankStopCandidates(fixtureRows(), "St. Gallen", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8506302"));
});

test("St Gallen query returns St. Gallen in top results", () => {
  const ranked = rankStopCandidates(fixtureRows(), "St Gallen", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8506302"));
});

test("St-Gallen query returns St. Gallen in top results", () => {
  const ranked = rankStopCandidates(fixtureRows(), "St-Gallen", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8506302"));
});

test("geneve query includes Genève main and Genève, gare Cornavin", () => {
  const ranked = rankStopCandidates(fixtureRows(), "geneve", 7);
  const topIds = ranked.slice(0, 7).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8501008"));
  assert.ok(topIds.includes("Parent8587057"));
});

test("bel air matches Genève, Bel-Air", () => {
  const ranked = rankStopCandidates(fixtureRows(), "bel air", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8587387") || topIds.includes("Parent8587055"));
});

test("Lausanne, Bel-Air ranks specific stop ahead of generic Lausanne parent", () => {
  const ranked = rankStopCandidates(fixtureRows(), "Lausanne, Bel-Air", 10);
  const belAirIdx = ranked.findIndex((row) =>
    normalizeSearchText(row.stop_name).includes("lausanne, bel air")
  );
  const lausanneIdx = ranked.findIndex(
    (row) => normalizeSearchText(row.stop_name) === "lausanne"
  );

  assert.ok(belAirIdx >= 0, "expected Lausanne, Bel-Air to be present");
  assert.ok(lausanneIdx >= 0, "expected Lausanne parent to be present");
  assert.ok(
    belAirIdx < lausanneIdx,
    `expected Lausanne, Bel-Air rank < Lausanne rank, got ${belAirIdx + 1} vs ${lausanneIdx + 1}`
  );
});

test("Bel Air and Bel-Air queries resolve to same top station", () => {
  const plain = rankStopCandidates(fixtureRows(), "Bel Air", 5);
  const hyphen = rankStopCandidates(fixtureRows(), "Bel-Air", 5);
  assert.ok(plain.length > 0);
  assert.ok(hyphen.length > 0);
  assert.equal(
    normalizeSearchText(plain[0].stop_name),
    normalizeSearchText(hyphen[0].stop_name)
  );
});

test("golden variants keep stable top result and canonical fields", () => {
  const cases = [
    { query: "Zurich", expectedTop: "zurich hb" },
    { query: "Zürich", expectedTop: "zurich hb" },
    { query: "Zuerich", expectedTop: "zurich hb" },
    { query: "Zürich Hbf", expectedTop: "zurich hb" },
    { query: "St Gallen", expectedTop: "saint gallen" },
    { query: "St. Gallen", expectedTop: "saint gallen" },
    { query: "geneve", expectedTopAny: ["geneve", "geneve, gare cornavin"] },
    { query: "Genève Cornavin", expectedTop: "geneve, gare cornavin" },
    { query: "Lausanne, Bel-Air", expectedTop: "lausanne, bel air" },
  ];

  for (const item of cases) {
    const ranked = rankStopCandidates(fixtureRows(), item.query, 7);
    assert.ok(ranked.length > 0, `expected results for query ${item.query}`);
    const top = ranked[0];
    const normalizedTop = normalizeSearchText(top.stop_name);
    if (item.expectedTopAny) {
      assert.ok(
        item.expectedTopAny.includes(normalizedTop),
        `unexpected top result for ${item.query}: ${normalizedTop}`
      );
    } else {
      assert.equal(normalizedTop, item.expectedTop);
    }
    assert.ok(top.stop_id, `missing stop_id for ${item.query}`);
    assert.ok(top.stationId, `missing stationId for ${item.query}`);
    assert.equal(typeof top.isParent, "boolean");
    assert.equal(typeof top.isPlatform, "boolean");
  }
});

test("cornavin ranks Geneve Cornavin first", () => {
  const ranked = rankStopCandidates(fixtureRows(), "cornavin", 7);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].stop_id, "Parent8587057");
});

test("cornavain typo still returns Geneve Cornavin in top 3", () => {
  const ranked = rankStopCandidates(fixtureRows(), "cornavain", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8587057"));
});
