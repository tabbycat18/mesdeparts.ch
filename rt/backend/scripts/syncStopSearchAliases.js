#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { normalizeSearchText } from "../src/search/stopsSearch.js";

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

function dedupeByKey(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of values || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function groupSpecs(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const canonicalKey = normalizeText(row?.canonical_key);
    const targetName = normalizeText(row?.target_name);
    const aliasText = normalizeText(row?.alias_text);
    const weight = Number(row?.weight);
    if (!canonicalKey || !targetName || !aliasText) continue;

    if (!out.has(canonicalKey)) {
      out.set(canonicalKey, {
        canonicalKey,
        targetName,
        targetNorm: normalizeSearchText(targetName),
        aliases: [],
      });
    }

    const entry = out.get(canonicalKey);
    entry.aliases.push({
      aliasText,
      aliasNorm: normalizeSearchText(aliasText),
      weight: Number.isFinite(weight) ? weight : 1,
    });
  }

  for (const value of out.values()) {
    value.aliases = dedupeByKey(value.aliases, (alias) => alias.aliasNorm || alias.aliasText);
  }

  return Array.from(out.values()).sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
}

function pickRepresentative(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aParent = isParentLike(a) ? 1 : 0;
    const bParent = isParentLike(b) ? 1 : 0;
    if (aParent !== bParent) return bParent - aParent;

    const aParentPrefix = normalizeText(a.stop_id).startsWith("Parent") ? 1 : 0;
    const bParentPrefix = normalizeText(b.stop_id).startsWith("Parent") ? 1 : 0;
    if (aParentPrefix !== bParentPrefix) return bParentPrefix - aParentPrefix;

    const aName = normalizeText(a.stop_name);
    const bName = normalizeText(b.stop_name);
    const byName = aName.localeCompare(bName, "en", { sensitivity: "base" });
    if (byName !== 0) return byName;

    return normalizeText(a.stop_id).localeCompare(normalizeText(b.stop_id));
  });

  return sorted[0] || null;
}

function selectTargetCandidate(stopsByGroupId, targetNorm) {
  const matches = [];

  for (const [groupId, candidates] of stopsByGroupId.entries()) {
    const matching = candidates.filter(
      (row) => normalizeSearchText(row.stop_name) === targetNorm
    );
    if (matching.length === 0) continue;
    const representative = pickRepresentative(matching) || pickRepresentative(candidates);
    if (!representative) continue;
    matches.push({
      groupId,
      stopId: normalizeText(representative.stop_id),
      stopName: normalizeText(representative.stop_name),
      parentStation: normalizeText(representative.parent_station),
      locationType: normalizeText(representative.location_type),
      candidates: dedupeByKey(
        candidates.map((row) => ({
          stop_id: normalizeText(row.stop_id),
          stop_name: normalizeText(row.stop_name),
          parent_station: normalizeText(row.parent_station),
          location_type: normalizeText(row.location_type),
        })),
        (row) => row.stop_id
      ),
    });
  }

  matches.sort((a, b) => {
    const aParent = isParentLike(a) ? 1 : 0;
    const bParent = isParentLike(b) ? 1 : 0;
    if (aParent !== bParent) return bParent - aParent;

    const aParentPrefix = a.stopId.startsWith("Parent") ? 1 : 0;
    const bParentPrefix = b.stopId.startsWith("Parent") ? 1 : 0;
    if (aParentPrefix !== bParentPrefix) return bParentPrefix - aParentPrefix;

    const byName = a.stopName.localeCompare(b.stopName, "en", { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.stopId.localeCompare(b.stopId);
  });

  return matches;
}

async function loadStops(client) {
  const result = await client.query(`
    SELECT
      s.stop_id,
      s.stop_name,
      NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
      COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type
    FROM public.gtfs_stops s
  `);

  const rows = Array.isArray(result.rows) ? result.rows : [];
  const byStopId = new Map();
  const byGroupId = new Map();

  for (const row of rows) {
    const stopId = normalizeText(row.stop_id);
    if (!stopId) continue;

    const parentStation = normalizeText(row.parent_station);
    const groupId = parentStation || stopId;

    const normalized = {
      stop_id: stopId,
      stop_name: normalizeText(row.stop_name),
      parent_station: parentStation,
      location_type: normalizeText(row.location_type),
      group_id: groupId,
    };

    byStopId.set(stopId, normalized);
    if (!byGroupId.has(groupId)) byGroupId.set(groupId, []);
    byGroupId.get(groupId).push(normalized);
  }

  return { byStopId, byGroupId };
}

async function loadSpecs(client) {
  const result = await client.query(`
    SELECT canonical_key, target_name, alias_text, weight, active
    FROM public.stop_alias_seed_specs
    WHERE active = TRUE
    ORDER BY canonical_key, alias_text
  `);
  return groupSpecs(result.rows || []);
}

async function loadExistingCanonicalTargets(client) {
  const result = await client.query(`
    SELECT canonical_key, stop_id
    FROM public.stop_aliases
    WHERE canonical_key IS NOT NULL
      AND canonical_key <> ''
  `);

  const map = new Map();
  for (const row of result.rows || []) {
    const key = normalizeText(row.canonical_key);
    const stopId = normalizeText(row.stop_id);
    if (!key || !stopId) continue;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(stopId);
  }
  return map;
}

function selectPreviousStopId(existingSet, byStopId) {
  if (!existingSet || existingSet.size === 0) return "";

  const valid = Array.from(existingSet)
    .map((stopId) => byStopId.get(stopId))
    .filter((row) => !!row)
    .filter((row) => isParentLike(row))
    .sort((a, b) => normalizeText(a.stop_id).localeCompare(normalizeText(b.stop_id)));

  if (valid.length !== 1) return "";
  return normalizeText(valid[0].stop_id);
}

async function upsertAliasesForTarget(client, spec, stopId) {
  const aliasTexts = spec.aliases.map((alias) => alias.aliasText);

  await client.query(
    `
      DELETE FROM public.stop_aliases
      WHERE canonical_key = $1::text
        AND source = 'seed_spec'
        AND NOT (alias_text = ANY($2::text[]))
    `,
    [spec.canonicalKey, aliasTexts]
  );

  for (const alias of spec.aliases) {
    await client.query(
      `
        INSERT INTO public.stop_aliases (
          alias_text,
          alias_norm,
          stop_id,
          weight,
          canonical_key,
          source,
          updated_at
        )
        VALUES ($1::text, $2::text, $3::text, $4::real, $5::text, 'seed_spec', NOW())
        ON CONFLICT (alias_text)
        DO UPDATE SET
          alias_norm = EXCLUDED.alias_norm,
          stop_id = EXCLUDED.stop_id,
          weight = EXCLUDED.weight,
          canonical_key = EXCLUDED.canonical_key,
          source = EXCLUDED.source,
          updated_at = NOW()
      `,
      [alias.aliasText, alias.aliasNorm, stopId, alias.weight, spec.canonicalKey]
    );
  }
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
    status: "success",
    degraded: false,
    resolved: [],
    kept_previous: [],
    skipped_ambiguous: [],
    missing_target: [],
    errors: [],
  };

  try {
    const client = await pool.connect();
    try {
      const [specs, stops, existingCanonicalTargets] = await Promise.all([
        loadSpecs(client),
        loadStops(client),
        loadExistingCanonicalTargets(client),
      ]);

      if (specs.length === 0) {
        report.status = "success_with_degraded_search";
        report.degraded = true;
        report.errors.push({
          reason: "missing_seed_specs",
          detail: "public.stop_alias_seed_specs has no active rows",
        });
      }

      for (const spec of specs) {
        const candidates = selectTargetCandidate(stops.byGroupId, spec.targetNorm);
        const previousStopId = selectPreviousStopId(
          existingCanonicalTargets.get(spec.canonicalKey),
          stops.byStopId
        );

        if (candidates.length === 1) {
          const selected = candidates[0];
          await upsertAliasesForTarget(client, spec, selected.stopId);

          report.resolved.push({
            canonical_key: spec.canonicalKey,
            target_name: spec.targetName,
            stop_id: selected.stopId,
            stop_name: selected.stopName,
            aliases_upserted: spec.aliases.length,
          });
          continue;
        }

        if (candidates.length > 1) {
          if (previousStopId) {
            await upsertAliasesForTarget(client, spec, previousStopId);
            const previousRow = stops.byStopId.get(previousStopId);
            report.kept_previous.push({
              canonical_key: spec.canonicalKey,
              target_name: spec.targetName,
              stop_id: previousStopId,
              stop_name: normalizeText(previousRow?.stop_name),
              reason: "ambiguous_resolution",
              aliases_upserted: spec.aliases.length,
              candidates: candidates.map((candidate) => ({
                stop_id: candidate.stopId,
                stop_name: candidate.stopName,
              })),
            });
          } else {
            report.skipped_ambiguous.push({
              canonical_key: spec.canonicalKey,
              target_name: spec.targetName,
              reason: "ambiguous_resolution",
              candidates: candidates.map((candidate) => ({
                stop_id: candidate.stopId,
                stop_name: candidate.stopName,
              })),
            });
          }
          continue;
        }

        if (previousStopId) {
          await upsertAliasesForTarget(client, spec, previousStopId);
          const previousRow = stops.byStopId.get(previousStopId);
          report.kept_previous.push({
            canonical_key: spec.canonicalKey,
            target_name: spec.targetName,
            stop_id: previousStopId,
            stop_name: normalizeText(previousRow?.stop_name),
            reason: "target_not_found_keep_previous",
            aliases_upserted: spec.aliases.length,
          });
          continue;
        }

        report.missing_target.push({
          canonical_key: spec.canonicalKey,
          target_name: spec.targetName,
          reason: "target_not_found",
        });
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  report.degraded =
    report.errors.length > 0 ||
    report.skipped_ambiguous.length > 0 ||
    report.missing_target.length > 0;
  report.status = report.degraded ? "success_with_degraded_search" : "success";

  const json = JSON.stringify(report, null, 2);
  console.log(json);

  const outPath = normalizeText(process.env.STOP_SEARCH_ALIAS_REPORT_PATH);
  if (outPath) {
    fs.writeFileSync(outPath, `${json}\n`, "utf8");
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: "failed",
        degraded: true,
        error: String(err?.message || err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
