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
      aliases_matched: ["zurich hb", "zurich hbf", "hauptbahnhof zurich"],
      alias_weight: 9,
      alias_similarity: 0.94,
      name_similarity: 0.9,
      core_similarity: 0.9,
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
    },
    {
      group_id: "Parent8501008",
      stop_id: "Parent8501008",
      stop_name: "Genève, Cornavin",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["cornavin", "gare cornavin", "geneve cornavin"],
      alias_weight: 9,
      alias_similarity: 0.95,
      name_similarity: 0.86,
      core_similarity: 0.86,
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
    },
    {
      group_id: "Parent8592949",
      stop_id: "Parent8592949",
      stop_name: "Genève, Bel-Air",
      parent_station: "",
      location_type: "1",
      city_name: "Genève",
      aliases_matched: ["bel air"],
      alias_weight: 1.5,
      alias_similarity: 0.75,
      name_similarity: 0.72,
      core_similarity: 0.72,
    },
    {
      group_id: "Parent8587055",
      stop_id: "Parent8587055",
      stop_name: "Bel-Air, Lausanne",
      parent_station: "",
      location_type: "1",
      city_name: "Lausanne",
      aliases_matched: ["bel air lausanne"],
      alias_weight: 1,
      alias_similarity: 0.65,
      name_similarity: 0.72,
      core_similarity: 0.72,
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
    },
  ];
}

test("normalizeSearchText strips diacritics and punctuation", () => {
  assert.equal(normalizeSearchText("  Genève-Bel_Air.  "), "geneve bel air");
  assert.equal(normalizeSearchText("Zürich"), "zurich");
});

test("geneve query returns Geneve/Cornavin in top results", () => {
  const ranked = rankStopCandidates(fixtureRows(), "geneve", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8501008"));
});

test("bel air matches Bel-Air", () => {
  const ranked = rankStopCandidates(fixtureRows(), "bel air", 7);
  assert.ok(ranked.length > 0);
  assert.match(ranked[0].stop_name, /Bel-Air/i);
});

test("zurich ranks Zurich HB first", () => {
  const ranked = rankStopCandidates(fixtureRows(), "zurich", 7);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].stop_id, "Parent8503000");
});

test("Zürich (with diacritics) ranks Zurich HB first", () => {
  const ranked = rankStopCandidates(fixtureRows(), "Zürich", 7);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].stop_id, "Parent8503000");
});

test("cornavin ranks Geneve Cornavin first", () => {
  const ranked = rankStopCandidates(fixtureRows(), "cornavin", 7);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].stop_id, "Parent8501008");
});

test("cornavain typo still returns Geneve Cornavin in top 3", () => {
  const ranked = rankStopCandidates(fixtureRows(), "cornavain", 7);
  const topIds = ranked.slice(0, 3).map((row) => row.stop_id);
  assert.ok(topIds.includes("Parent8501008"));
});
