import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPollerHeartbeat } from "../src/db/rtPollerHeartbeat.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_TRIP_THRESHOLD_S = Math.max(
  10,
  Number(process.env.POLLER_HEARTBEAT_TRIP_MAX_AGE_S || "90")
);
const DEFAULT_ALERTS_THRESHOLD_S = Math.max(
  30,
  Number(process.env.POLLER_HEARTBEAT_ALERTS_MAX_AGE_S || "300")
);

function loadDotEnvIfNeeded() {
  if (process.env.DATABASE_URL || process.env.DATABASE_URL_POLLER) return;
  const candidates = [
    path.resolve(__dirname, "../.env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    if (process.env.DATABASE_URL || process.env.DATABASE_URL_POLLER) return;
  }
}

function parseThresholdArg(flagName, fallback) {
  const index = process.argv.indexOf(flagName);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.trunc(value));
}

function ageSecondsFrom(tsValue, nowMs) {
  if (!tsValue) return null;
  const ms = new Date(tsValue).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

async function main() {
  loadDotEnvIfNeeded();
  const tripThresholdS = parseThresholdArg("--trip-threshold-s", DEFAULT_TRIP_THRESHOLD_S);
  const alertsThresholdS = parseThresholdArg("--alerts-threshold-s", DEFAULT_ALERTS_THRESHOLD_S);

  const row = await getPollerHeartbeat();
  if (!row) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: "missing_heartbeat_row",
          tripThresholdS,
          alertsThresholdS,
        },
        null,
        2
      )
    );
    process.exit(2);
  }

  const nowMs = Date.now();
  const tripAgeS = ageSecondsFrom(row.tripupdates_updated_at, nowMs);
  const alertsAgeS = ageSecondsFrom(row.alerts_updated_at, nowMs);
  const updatedAgeS = ageSecondsFrom(row.updated_at, nowMs);
  const tripStale = tripAgeS == null || tripAgeS > tripThresholdS;
  const alertsStale = alertsAgeS == null || alertsAgeS > alertsThresholdS;
  const ok = !tripStale && !alertsStale;

  const output = {
    ok,
    nowISO: new Date(nowMs).toISOString(),
    instanceId: row.instance_id || null,
    lastError: row.last_error || null,
    updatedAt: row.updated_at || null,
    updatedAgeS,
    tripupdates: {
      updatedAt: row.tripupdates_updated_at || null,
      ageS: tripAgeS,
      thresholdS: tripThresholdS,
      stale: tripStale,
    },
    alerts: {
      updatedAt: row.alerts_updated_at || null,
      ageS: alertsAgeS,
      thresholdS: alertsThresholdS,
      stale: alertsStale,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  if (!ok) process.exit(2);
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: "heartbeat_check_failed",
        error: String(err?.message || err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
