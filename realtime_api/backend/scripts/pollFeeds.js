import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTripUpdatesApiKey } from "../src/loaders/fetchTripUpdates.js";
import { resolveServiceAlertsApiKey } from "../src/loaders/fetchServiceAlerts.js";
import { createLaTripUpdatesPoller } from "./pollLaTripUpdates.js";
import { createLaServiceAlertsPoller } from "./pollLaServiceAlerts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESTART_BACKOFF_BASE_MS = 5_000;
const RESTART_BACKOFF_MAX_MS = 60_000;
const RESTART_BACKOFF_JITTER_RATIO = 0.2;
const DB_ERROR_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
]);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function asTrimmedText(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function defaultLogLike(level, payload) {
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function computeRestartBackoffMs({
  attempt,
  baseMs = RESTART_BACKOFF_BASE_MS,
  maxMs = RESTART_BACKOFF_MAX_MS,
  jitterRatio = RESTART_BACKOFF_JITTER_RATIO,
  randomLike = Math.random,
} = {}) {
  const safeAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  const rawMs = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jitterWindowMs = Math.max(0, Math.trunc(rawMs * Math.max(0, Number(jitterRatio) || 0)));
  if (!jitterWindowMs) return Math.max(0, Math.trunc(rawMs));

  const jitterUnit = Math.min(1, Math.max(0, Number(randomLike?.()) || 0));
  const signedJitter = Math.round((jitterUnit * 2 - 1) * jitterWindowMs);
  return Math.max(0, Math.min(Math.trunc(maxMs), Math.trunc(rawMs + signedJitter)));
}

export function isLikelyDbDisconnectError(error) {
  const code = asTrimmedText(error?.code)?.toUpperCase() || null;
  if (code && DB_ERROR_CODES.has(code)) return true;

  const message = asTrimmedText(error?.message || error)?.toLowerCase() || "";
  return (
    message.includes("connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("could not connect") ||
    message.includes("database") ||
    message.includes("postgres")
  );
}

export async function runPollerWithRestart({
  pollerName,
  createPoller,
  sleepLike = sleep,
  randomLike = Math.random,
  logLike = defaultLogLike,
} = {}) {
  if (typeof createPoller !== "function") {
    throw new Error("poller_create_fn_required");
  }
  const name = asTrimmedText(pollerName) || "unknown_poller";

  let restartAttempt = 0;
  for (;;) {
    try {
      logLike("info", {
        event: "poller_supervisor_start",
        poller: name,
        restartAttempt,
      });

      const poller = createPoller();
      if (!poller || typeof poller.runForever !== "function") {
        throw new Error("poller_instance_invalid");
      }

      await poller.runForever();
      restartAttempt += 1;
      const nextBackoffMs = computeRestartBackoffMs({
        attempt: restartAttempt,
        randomLike,
      });
      logLike("error", {
        event: "poller_runner_unexpected_exit",
        poller: name,
        reconnecting: true,
        nextBackoffMs,
        restartAttempt,
      });
      await sleepLike(nextBackoffMs);
    } catch (error) {
      restartAttempt += 1;
      const nextBackoffMs = computeRestartBackoffMs({
        attempt: restartAttempt,
        randomLike,
      });
      const dbError = isLikelyDbDisconnectError(error);
      logLike("error", {
        event: dbError ? "poller_db_error_reconnect" : "poller_runner_error_reconnect",
        poller: name,
        errorCode: asTrimmedText(error?.code),
        errorMessage: asTrimmedText(error?.message || error) || "unknown_error",
        reconnecting: true,
        nextBackoffMs,
        restartAttempt,
      });
      await sleepLike(nextBackoffMs);
    }
  }
}

export async function main() {
  loadDotEnvIfNeeded();

  const tripToken = resolveTripUpdatesApiKey();
  const alertsToken = resolveServiceAlertsApiKey();
  if (!tripToken && !alertsToken) {
    throw new Error("poller_missing_token");
  }

  const runners = [];
  if (tripToken) {
    runners.push(
      runPollerWithRestart({
        pollerName: "trip_updates",
        createPoller: () => createLaTripUpdatesPoller({ token: tripToken }),
      })
    );
    console.log("[poll-feeds] trip updates poller supervisor started");
  } else {
    console.warn("[poll-feeds] trip updates token missing, trip poller disabled");
  }

  if (alertsToken) {
    runners.push(
      runPollerWithRestart({
        pollerName: "service_alerts",
        createPoller: () => createLaServiceAlertsPoller({ token: alertsToken }),
      })
    );
    console.log("[poll-feeds] service alerts poller supervisor started");
  } else {
    console.warn("[poll-feeds] service alerts token missing, alerts poller disabled");
  }

  await Promise.all(runners);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[poll-feeds] fatal", err?.message || err);
    process.exit(1);
  });
}
