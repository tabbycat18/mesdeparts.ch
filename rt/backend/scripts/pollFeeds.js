import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTripUpdatesApiKey } from "../src/loaders/fetchTripUpdates.js";
import { resolveServiceAlertsApiKey } from "../src/loaders/fetchServiceAlerts.js";
import { createLaTripUpdatesPoller } from "./pollLaTripUpdates.js";
import { createLaServiceAlertsPoller } from "./pollLaServiceAlerts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnvIfNeeded() {
  if (process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN) return;

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
    if (process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN) return;
  }
}

async function main() {
  loadDotEnvIfNeeded();

  const tripToken = resolveTripUpdatesApiKey();
  const alertsToken = resolveServiceAlertsApiKey();
  if (!tripToken && !alertsToken) {
    throw new Error("poller_missing_token");
  }

  const runners = [];
  if (tripToken) {
    const tripPoller = createLaTripUpdatesPoller({ token: tripToken });
    runners.push(tripPoller.runForever());
    console.log("[poll-feeds] trip updates poller started");
  } else {
    console.warn("[poll-feeds] trip updates token missing, trip poller disabled");
  }

  if (alertsToken) {
    const alertsPoller = createLaServiceAlertsPoller({ token: alertsToken });
    runners.push(alertsPoller.runForever());
    console.log("[poll-feeds] service alerts poller started");
  } else {
    console.warn("[poll-feeds] service alerts token missing, alerts poller disabled");
  }

  await Promise.all(runners);
}

main().catch((err) => {
  console.error("[poll-feeds] fatal", err?.message || err);
  process.exit(1);
});
