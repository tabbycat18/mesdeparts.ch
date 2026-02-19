import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

const FILES = [
  "schema_gtfs.sql",
  "src/sql/stationboard.sql",
  "sql/create_stage_tables.sql",
  "sql/validate_stage.sql",
  "sql/swap_stage_to_live_cutover.sql",
  "sql/cleanup_old_after_swap.sql",
  "sql/optimize_stationboard.sql",
  "scripts/legacy/DANGEROUS-direct-live-import.sh",
  "scripts/importGtfsToStage.sh",
  "src/resolve/resolveStop.js",
  "src/logic/buildStationboard.js",
];

const LEGACY_NAMES = new Set([
  "agencies",
  "stops",
  "routes",
  "trips",
  "stop_times",
  "calendar",
  "calendar_dates",
  "stop_aliases",
]);

function formatList(values) {
  if (values.length === 0) return "none";
  return values.join(", ");
}

function parseTables(content) {
  const out = new Set();
  const re = /public\.([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.add(m[1]);
  }
  return out;
}

async function main() {
  const foundByFile = new Map();
  const allTables = new Set();

  for (const rel of FILES) {
    const abs = path.resolve(backendRoot, rel);
    try {
      const content = await fs.readFile(abs, "utf8");
      const tables = parseTables(content);
      foundByFile.set(rel, tables);
      for (const t of tables) allTables.add(t);
    } catch (err) {
      foundByFile.set(rel, new Set([`[read_error:${String(err?.message || err)}]`]));
    }
  }

  const sortedAll = Array.from(allTables).sort();
  const canonical = sortedAll.filter((t) => t.startsWith("gtfs_"));
  const stage = sortedAll.filter((t) => t.endsWith("_stage"));
  const legacy = sortedAll.filter((t) => LEGACY_NAMES.has(t));

  console.log("Schema Drift Task Report");
  console.log("========================");
  console.log(`Backend root: ${backendRoot}`);
  console.log("");
  console.log("Tables referenced by repo code/SQL:");
  console.log(formatList(sortedAll));
  console.log("");
  console.log("Buckets:");
  console.log(`- canonical gtfs_*: ${formatList(canonical)}`);
  console.log(`- stage *_stage: ${formatList(stage)}`);
  console.log(`- legacy non-prefixed: ${formatList(legacy)}`);
  console.log("");

  console.log("Per-file reference summary:");
  for (const rel of FILES) {
    const values = Array.from(foundByFile.get(rel) || []).sort();
    console.log(`- ${rel}: ${formatList(values)}`);
  }
  console.log("");

  console.log("Actionable drift-resolution task (non-breaking):");
  console.log("1. Keep runtime canonical naming as gtfs_* (plus app_stop_aliases, rt_updates).");
  console.log("2. Mark schema_gtfs.sql as legacy if it is not used to bootstrap current gtfs_* runtime.");
  console.log("3. Add or locate one canonical migration that creates gtfs_* + app_stop_aliases.");
  console.log("4. Ensure import scripts and runtime SQL reference only the canonical schema.");
  console.log("5. Keep a compatibility window only if live environments still depend on legacy names.");
}

main().catch((err) => {
  console.error("schema drift report failed:", String(err?.stack || err));
  process.exit(1);
});

