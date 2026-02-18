#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { searchStops } from "../src/search/stopsSearch.js";

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

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.max(0, Math.ceil(sortedMs.length * p) - 1);
  return sortedMs[idx];
}

async function main() {
  loadDotEnvIfNeeded();
  const databaseUrl = normalizeText(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const iterations = Math.max(1, Number(process.env.SEARCH_BENCH_ITERATIONS || "10"));
  const queries = [
    "Zurich",
    "Zürich",
    "St Gallen",
    "St-Gallen",
    "St. Gallen",
    "geneve",
    "bel air",
    "cornavain",
  ];

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  });

  const samples = [];

  try {
    for (let i = 0; i < iterations; i += 1) {
      for (const query of queries) {
        const started = performance.now();
        await searchStops(pool, query, 7);
        const elapsedMs = Number((performance.now() - started).toFixed(3));
        samples.push({ query, elapsedMs });
      }
    }
  } finally {
    await pool.end();
  }

  const byQuery = new Map();
  for (const sample of samples) {
    if (!byQuery.has(sample.query)) byQuery.set(sample.query, []);
    byQuery.get(sample.query).push(sample.elapsedMs);
  }

  const overall = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const summary = {
    samples: samples.length,
    iterations,
    queries,
    overall_ms: {
      p50: Number(percentile(overall, 0.5).toFixed(2)),
      p95: Number(percentile(overall, 0.95).toFixed(2)),
      p99: Number(percentile(overall, 0.99).toFixed(2)),
    },
    per_query_ms: {},
  };

  for (const [query, values] of byQuery.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    summary.per_query_ms[query] = {
      p50: Number(percentile(sorted, 0.5).toFixed(2)),
      p95: Number(percentile(sorted, 0.95).toFixed(2)),
      max: Number(sorted[sorted.length - 1].toFixed(2)),
    };
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(err?.message || err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
