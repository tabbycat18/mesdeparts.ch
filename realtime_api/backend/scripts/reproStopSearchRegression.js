#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectSearchCapabilities,
  normalizeSearchText,
  searchStopsWithDebug,
} from "../src/search/stopsSearch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERIES = [
  "foret",
  "lausanne foret",
  "grande borde",
  "grande-borde",
  "bel air",
  "bel aie",
  "bel air lausanne",
  "bel air geneve",
];

const EXPECTED_NAMES = {
  foret: ["lausanne, foret"],
  "lausanne foret": ["lausanne, foret"],
  "grande borde": ["lausanne, grande borde"],
  "grande-borde": ["lausanne, grande borde"],
  "bel air": ["lausanne, bel air", "geneve, bel air"],
  "bel aie": ["lausanne, bel air", "geneve, bel air"],
  "bel air lausanne": ["lausanne, bel air"],
  "bel air geneve": ["geneve, bel air"],
};

const BASE_URL = String(process.env.STOP_SEARCH_BASE_URL || "http://127.0.0.1:3001").trim();
const LIMIT = Math.max(1, Math.min(Number(process.env.STOP_SEARCH_LIMIT || "10"), 20));

function loadDotEnvIfNeeded() {
  if (process.env.DATABASE_URL) return;

  const candidates = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;

    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;

      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith("\"") && val.endsWith("\"")) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

function supportsPrimarySearch(caps) {
  return (
    caps?.hasStopSearchIndex === true &&
    caps?.hasStopAliases === true &&
    caps?.hasNormalizeFn === true &&
    caps?.hasStripFn === true &&
    caps?.hasPgTrgm === true &&
    caps?.hasUnaccent === true
  );
}

function inferMatchMode(scoreComponents = {}, tier = 0) {
  if (scoreComponents.exactName || scoreComponents.exactAlias || tier >= 4) {
    return "exact";
  }
  if (scoreComponents.prefixName || scoreComponents.prefixAlias || tier === 3) {
    return "prefix";
  }
  if (
    scoreComponents.containsName ||
    scoreComponents.containsAlias ||
    scoreComponents.startsMatch ||
    scoreComponents.tokenContains ||
    tier === 2
  ) {
    return "contains";
  }
  if (tier === 1) {
    return "fuzzy";
  }
  return "unknown";
}

function normalizeForExpectation(name) {
  return normalizeSearchText(String(name || "")).replace(/,/g, "");
}

function hasExpectedMatch(rows, query) {
  const expected = EXPECTED_NAMES[query] || [];
  if (expected.length === 0) return true;

  const normalizedRows = rows.map((row) =>
    normalizeForExpectation(String(row?.name || row?.stop_name || ""))
  );
  const expectedNorm = expected.map((name) => normalizeForExpectation(name));

  if (query === "bel air") {
    return expectedNorm.every((name) => normalizedRows.includes(name));
  }
  if (query === "bel aie") {
    return expectedNorm.some((name) => normalizedRows.includes(name));
  }
  return expectedNorm.some((name) => normalizedRows.includes(name));
}

async function fetchEndpointResults(query) {
  const url = new URL("/api/stops/search", BASE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("debug", "1");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
    },
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  const stops = Array.isArray(data?.stops) ? data.stops : [];
  return {
    ok: res.ok,
    status: res.status,
    stops: stops.slice(0, LIMIT).map((row) => ({
      id: String(row?.stop_id || row?.id || "").trim(),
      name: String(row?.stop_name || row?.name || "").trim(),
    })),
    fallbackApplied: res.headers.get("x-md-search-fallback") === "1",
    fallbackReason: res.headers.get("x-md-search-fallback-reason") || "",
  };
}

function printTopResults(title, rows) {
  console.log(title);
  if (!rows.length) {
    console.log("  (no results)");
    return;
  }

  rows.slice(0, LIMIT).forEach((row, idx) => {
    console.log(`  ${idx + 1}. ${row.id} | ${row.name}`);
  });
}

function printDebugTopRows(debugRows) {
  console.log("debug top rows (rank | id | name | score | tier | mode):");
  if (!debugRows.length) {
    console.log("  (no debug rows)");
    return;
  }
  for (const row of debugRows.slice(0, LIMIT)) {
    const mode = inferMatchMode(row?.score_components || {}, Number(row?.tier) || 0);
    console.log(
      `  ${row.rank}. ${row.stop_id || "-"} | ${row.stop_name || "-"} | score=${row.score ?? "-"} | tier=${row.tier ?? "-"} | mode=${mode}`
    );
  }
}

async function main() {
  loadDotEnvIfNeeded();

  const { pool } = await import("../db.js");
  try {
    const caps = await detectSearchCapabilities(pool, { force: true });
    const primary = supportsPrimarySearch(caps);

    console.log("=== stop search regression repro ===");
    console.log(`base_url: ${BASE_URL}`);
    console.log(`limit: ${LIMIT}`);
    console.log(`capabilities: ${JSON.stringify(caps)}`);
    console.log(
      `backend_path: ${primary ? "primary(stop_search_index + stop_aliases + pg_trgm + unaccent)" : "degraded_fallback"}`
    );
    console.log("");

    let failures = 0;

    for (const query of QUERIES) {
      const endpoint = await fetchEndpointResults(query);
      const debugResult = await searchStopsWithDebug(pool, query, LIMIT);
      const debugObj = debugResult?.debug || {};
      const rankedTop = Array.isArray(debugObj?.rankedTop) ? debugObj.rankedTop : [];

      const endpointPass = hasExpectedMatch(endpoint.stops, query);

      if (!endpointPass) failures += 1;

      console.log(`query: "${query}"`);
      console.log(`normalized_query(js): "${normalizeSearchText(query)}"`);
      if (debugObj.queryNorm) {
        console.log(`normalized_query(backend): "${debugObj.queryNorm}"`);
      }
      console.log(
        `endpoint_status: ${endpoint.status} (${endpoint.ok ? "ok" : "error"})` +
          (endpoint.fallbackApplied
            ? ` | fallback=1 reason=${endpoint.fallbackReason || "unknown"}`
            : "")
      );
      printTopResults("endpoint top results (rank | id | name):", endpoint.stops);
      printDebugTopRows(rankedTop);
      console.log(
        `acceptance_check: ${endpointPass ? "PASS" : "FAIL"}`
      );
      console.log("");
    }

    if (failures > 0) {
      console.log(`summary: ${failures} / ${QUERIES.length} queries FAIL acceptance.`);
      process.exitCode = 1;
      return;
    }

    console.log(`summary: all ${QUERIES.length} queries PASS acceptance.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[reproStopSearchRegression] failed:", err?.stack || err?.message || err);
  process.exit(1);
});

