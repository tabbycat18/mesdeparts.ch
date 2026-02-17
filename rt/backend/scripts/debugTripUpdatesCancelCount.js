import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchTripUpdates } from "../src/rt/fetchTripUpdates.js";
import { summarizeTripUpdates } from "../src/rt/tripUpdatesSummary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnvIfNeeded() {
  const hasToken =
    !!process.env.GTFS_RT_TOKEN ||
    !!process.env.OPENDATA_SWISS_TOKEN ||
    !!process.env.OPENTDATA_GTFS_RT_KEY;
  if (hasToken) return;

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
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
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
    if (
      process.env.GTFS_RT_TOKEN ||
      process.env.OPENDATA_SWISS_TOKEN ||
      process.env.OPENTDATA_GTFS_RT_KEY
    ) {
      return;
    }
  }
}

function formatHeaderTimestamp(headerTimestamp) {
  if (!Number.isFinite(headerTimestamp)) return "null";
  const iso = new Date(headerTimestamp * 1000).toISOString();
  return `${headerTimestamp} (${iso})`;
}

async function main() {
  loadDotEnvIfNeeded();

  const feed = await fetchTripUpdates();
  const summary = summarizeTripUpdates(feed, { sampleLimit: 5 });

  console.log(`total_entities: ${summary.totalEntities}`);
  console.log(
    `trip_descriptor_canceled: ${summary.tripDescriptorCanceledCount}`
  );
  console.log(`stop_time_skipped: ${summary.stopTimeSkippedCount}`);
  console.log(`stop_time_no_data: ${summary.stopTimeNoDataCount}`);
  console.log(`header_timestamp: ${formatHeaderTimestamp(summary.headerTimestamp)}`);
  console.log("sample_cancel_signals:");
  if (!summary.sampleCancellationSignals.length) {
    console.log("  (none)");
    return;
  }
  for (const sample of summary.sampleCancellationSignals) {
    const stopId = sample.stopId || "-";
    const stopSequence = sample.stopSequence == null ? "-" : sample.stopSequence;
    console.log(
      `  trip_id=${sample.tripId} relationship=${sample.relationship} stop_id=${stopId} stop_sequence=${stopSequence}`
    );
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});

