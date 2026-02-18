#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAliasKey } from "../src/resolve/resolveStop.js";

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
        (val.startsWith("\"") && val.endsWith("\"")) ||
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

function splitCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => String(v || "").trim());
}

function readAliasesFromCsv(filePath) {
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const head = splitCsvRow(lines[0]).map((v) => v.toLowerCase());
  const aliasIdx = head.indexOf("alias");
  const stopIdx = head.indexOf("stop_id");

  if (aliasIdx >= 0 && stopIdx >= 0) {
    return lines.slice(1).map((line) => {
      const row = splitCsvRow(line);
      return {
        alias: row[aliasIdx] || "",
        stop_id: row[stopIdx] || "",
      };
    });
  }

  // Fallback: plain two-column CSV with no header.
  return lines.map((line) => {
    const row = splitCsvRow(line);
    return {
      alias: row[0] || "",
      stop_id: row[1] || "",
    };
  });
}

function normalizeRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const alias = String(row?.alias || "").trim();
    const stopId = String(row?.stop_id || "").trim();
    if (!alias || !stopId) continue;

    const variants = [alias];
    const normalized = normalizeAliasKey(alias);
    if (normalized && normalized !== alias.toLowerCase()) {
      variants.push(normalized);
    }

    for (const key of variants) {
      const aliasKey = String(key || "").trim();
      if (!aliasKey) continue;
      const dedupeKey = `${aliasKey}::${stopId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ alias: aliasKey, stop_id: stopId });
    }
  }
  return out;
}

const DEFAULT_ALIASES = [
  { alias: "Lausanne, Motte", stop_id: "Parent8592082" },
  { alias: "lausanne motte", stop_id: "Parent8592082" },
  { alias: "8592082", stop_id: "Parent8592082" },
];

async function main() {
  loadDotEnvIfNeeded();
  const { pool } = await import("../db.js");

  const csvArg = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : "";
  const csvFromEnv = process.env.STOP_ALIASES_CSV
    ? path.resolve(process.cwd(), process.env.STOP_ALIASES_CSV)
    : "";
  const csvDefault = path.resolve(__dirname, "stop_aliases.csv");
  const csvPath = [csvArg, csvFromEnv, csvDefault].find((candidate) => candidate && fs.existsSync(candidate));

  const csvAliases = readAliasesFromCsv(csvPath);
  const rows = normalizeRows([...DEFAULT_ALIASES, ...csvAliases]);

  if (rows.length === 0) {
    console.log("[seedStopAliases] No aliases to seed.");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const res = await client.query(
        `
        INSERT INTO public.app_stop_aliases (alias, stop_id)
        SELECT $1::text, $2::text
        WHERE EXISTS (
          SELECT 1
          FROM public.gtfs_stops s
          WHERE s.stop_id = $2::text
        )
        ON CONFLICT (alias)
        DO UPDATE SET stop_id = EXCLUDED.stop_id
        WHERE public.app_stop_aliases.stop_id IS DISTINCT FROM EXCLUDED.stop_id
        RETURNING alias
        `,
        [row.alias, row.stop_id]
      );
      if ((res.rows || []).length > 0) inserted += 1;
      else skipped += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    `[seedStopAliases] done. upserted=${inserted} skipped=${skipped} source_csv=${csvPath || "none"}`
  );
}

main().catch((err) => {
  console.error("[seedStopAliases] failed:", err);
  process.exit(1);
});
