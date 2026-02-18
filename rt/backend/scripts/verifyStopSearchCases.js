#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  searchStops,
  normalizeSearchText,
  detectSearchCapabilities,
} from "../src/search/stopsSearch.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    if (process.env.DATABASE_URL) return;
  }
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function isParentLike(row) {
  const stopId = normalizeText(row?.stop_id);
  const parentStation = normalizeText(row?.parent_station);
  const locationType = normalizeText(row?.location_type);
  return !parentStation || locationType === "1" || stopId.startsWith("Parent");
}

async function resolveCanonicalTargets(pool) {
  const [specRes, stopsRes] = await Promise.all([
    pool.query(`
      SELECT canonical_key, target_name
      FROM public.stop_alias_seed_specs
      WHERE active = TRUE
      GROUP BY canonical_key, target_name
      ORDER BY canonical_key
    `),
    pool.query(`
      SELECT
        s.stop_id,
        s.stop_name,
        NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
        COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type
      FROM public.gtfs_stops s
    `),
  ]);

  const specs = specRes.rows || [];
  const stops = stopsRes.rows || [];

  const out = new Map();
  const unresolved = [];

  for (const spec of specs) {
    const canonicalKey = normalizeText(spec.canonical_key);
    const targetName = normalizeText(spec.target_name);
    const targetNorm = normalizeSearchText(targetName);

    const matches = stops
      .filter((row) => normalizeSearchText(row.stop_name) === targetNorm)
      .filter((row) => isParentLike(row))
      .sort((a, b) => {
        const aParent = normalizeText(a.stop_id).startsWith("Parent") ? 1 : 0;
        const bParent = normalizeText(b.stop_id).startsWith("Parent") ? 1 : 0;
        if (aParent !== bParent) return bParent - aParent;
        return normalizeText(a.stop_id).localeCompare(normalizeText(b.stop_id));
      });

    if (matches.length !== 1) {
      unresolved.push({
        canonical_key: canonicalKey,
        target_name: targetName,
        candidates: matches.map((row) => ({
          stop_id: normalizeText(row.stop_id),
          stop_name: normalizeText(row.stop_name),
        })),
      });
      continue;
    }

    const selected = matches[0];
    out.set(canonicalKey, {
      stopId: normalizeText(selected.stop_id),
      stopName: normalizeText(selected.stop_name),
      targetName,
    });
  }

  return { targets: out, unresolved };
}

function findRank(rows, stopId) {
  const idx = rows.findIndex((row) => normalizeText(row.stop_id) === stopId);
  return idx >= 0 ? idx + 1 : -1;
}

async function main() {
  loadDotEnvIfNeeded();
  const databaseUrl = normalizeText(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  });

  const report = {
    timestamp: new Date().toISOString(),
    ok: true,
    capabilities: null,
    unresolved_targets: [],
    checks: [],
  };

  try {
    report.capabilities = await detectSearchCapabilities(pool, { force: true });

    const { targets, unresolved } = await resolveCanonicalTargets(pool);
    report.unresolved_targets = unresolved;

    const checks = [
      {
        query: "Zurich",
        expect: [{ key: "zurich_hb", maxRank: 3, required: true }],
      },
      {
        query: "Zürich",
        expect: [{ key: "zurich_hb", maxRank: 1, required: true }],
      },
      {
        query: "St. Gallen",
        expect: [{ key: "st_gallen", maxRank: 5, required: true }],
      },
      {
        query: "St Gallen",
        expect: [{ key: "st_gallen", maxRank: 5, required: true }],
      },
      {
        query: "St-Gallen",
        expect: [{ key: "st_gallen", maxRank: 5, required: true }],
      },
      {
        query: "geneve",
        expect: [
          { key: "geneve_main", maxRank: 5, required: true },
          { key: "geneve_cornavin", maxRank: 7, required: false },
        ],
      },
      {
        query: "bel air",
        expect: [{ key: "geneve_bel_air", maxRank: 7, required: true }],
      },
      {
        query: "cornavain",
        expect: [{ key: "geneve_cornavin", maxRank: 3, required: true }],
      },
    ];

    for (const testCase of checks) {
      const rows = await searchStops(pool, testCase.query, 7);
      const rowSummary = rows.slice(0, 7).map((row, idx) => ({
        rank: idx + 1,
        stop_id: normalizeText(row.stop_id),
        stop_name: normalizeText(row.stop_name),
      }));

      const expectations = [];
      for (const expected of testCase.expect) {
        const target = targets.get(expected.key);
        if (!target) {
          expectations.push({
            canonical_key: expected.key,
            status: expected.required ? "failed" : "warning",
            reason: "unresolved_canonical_target",
          });
          if (expected.required) report.ok = false;
          continue;
        }

        const rank = findRank(rows, target.stopId);
        const passes = rank > 0 && rank <= expected.maxRank;
        const status = passes ? "passed" : expected.required ? "failed" : "warning";

        expectations.push({
          canonical_key: expected.key,
          expected_stop_id: target.stopId,
          expected_stop_name: target.stopName,
          rank,
          max_rank: expected.maxRank,
          status,
        });

        if (!passes && expected.required) report.ok = false;
      }

      report.checks.push({
        query: testCase.query,
        expectations,
        top_results: rowSummary,
      });
    }
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        ok: false,
        error: String(err?.message || err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
