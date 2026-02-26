#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BASE_URL = "https://api.mesdeparts.ch";
const DEFAULT_OUT_DIR = path.resolve(__dirname, "../docs/diagnostics/live-captures");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    if (eqIndex > 2) {
      const key = arg.slice(2, eqIndex);
      const value = arg.slice(eqIndex + 1);
      out[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || String(next).startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function text(value) {
  return String(value ?? "").trim();
}

function toInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toBoolish01(value, fallback) {
  const raw = text(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return 1;
  if (["0", "false", "no", "n", "off"].includes(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n === 0 ? 0 : 1;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..+$/, "Z");
}

function safeForFileName(value) {
  const raw = text(value);
  if (!raw) return "unknown-stop";
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function pickFirstString(object, keys) {
  for (const key of keys) {
    const raw = object?.[key];
    const value = text(raw);
    if (value) return value;
  }
  return "";
}

function clip(value, width) {
  const raw = text(value) || "-";
  if (raw.length <= width) return raw.padEnd(width, " ");
  if (width < 4) return raw.slice(0, width);
  return `${raw.slice(0, width - 3)}...`;
}

function clipRight(value, width) {
  const raw = text(value) || "-";
  if (raw.length <= width) return raw.padStart(width, " ");
  if (width < 4) return raw.slice(0, width);
  return `${raw.slice(0, width - 3)}...`;
}

function printDeparturesTable(departures) {
  const rows = Array.isArray(departures) ? departures : [];
  const columns = [
    { key: "index", title: "idx", width: 3, right: true },
    { key: "line", title: "line", width: 7 },
    { key: "operator", title: "operator", width: 12 },
    { key: "mode", title: "mode", width: 7 },
    { key: "planned", title: "planned", width: 20 },
    { key: "realtime", title: "realtime", width: 20 },
    { key: "route_id", title: "route_id", width: 17 },
    { key: "trip_id", title: "trip_id", width: 24 },
    { key: "service_id", title: "service_id", width: 16 },
    { key: "key", title: "key", width: 26 },
    { key: "stop_id", title: "stop_id", width: 16 },
    { key: "stop_sequence", title: "stop_seq", width: 8, right: true },
  ];

  const mapped = rows.map((dep, index) => ({
    index: String(index + 1),
    line: pickFirstString(dep, ["line", "number", "category"]),
    operator: pickFirstString(dep, [
      "operator",
      "operator_id",
      "operatorId",
      "agency",
      "agency_id",
      "agencyId",
      "agencyName",
    ]),
    mode: pickFirstString(dep, ["mode", "transportMode", "transport_mode", "vehicleMode", "category"]),
    planned: pickFirstString(dep, ["scheduledDeparture", "plannedDeparture"]),
    realtime: pickFirstString(dep, ["realtimeDeparture", "departureRealtime"]),
    route_id: pickFirstString(dep, ["route_id", "routeId"]),
    trip_id: pickFirstString(dep, ["trip_id", "tripId"]),
    service_id: pickFirstString(dep, ["service_id", "serviceId"]),
    key: pickFirstString(dep, ["key"]),
    stop_id: pickFirstString(dep, ["stop_id", "stopId"]),
    stop_sequence: pickFirstString(dep, ["stop_sequence", "stopSequence"]),
  }));

  const header = columns
    .map((col) => (col.right ? clipRight(col.title, col.width) : clip(col.title, col.width)))
    .join(" ");
  const divider = columns.map((col) => "-".repeat(col.width)).join(" ");

  console.log(header);
  console.log(divider);

  for (const row of mapped) {
    const line = columns
      .map((col) =>
        col.right ? clipRight(row[col.key], col.width) : clip(row[col.key], col.width)
      )
      .join(" ");
    console.log(line);
  }

  if (mapped.length === 0) {
    console.log("(no departures)");
  }
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/captureWrongTripDetails.mjs --stop-id <STOP_ID> [options]",
      "",
      "Options:",
      "  --stop-id <id>           Required",
      "  --limit <n>              Default: 10",
      "  --include-alerts <0|1>   Default: 0",
      "  --debug <0|1>            Default: 1",
      "  --out-dir <path>         Default: realtime_api/backend/docs/diagnostics/live-captures",
      "",
      "Env:",
      "  API_BASE_URL             Base URL (default: https://api.mesdeparts.ch)",
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const stopId = text(args["stop-id"]);
  if (!stopId) {
    printUsage();
    throw new Error("--stop-id is required");
  }

  const limit = toInt(args.limit, 10, 1, 200);
  const includeAlerts = toBoolish01(args["include-alerts"], 0);
  const debug = toBoolish01(args.debug, 1);
  const baseUrl = text(process.env.API_BASE_URL) || DEFAULT_BASE_URL;
  const outDir = text(args["out-dir"])
    ? path.resolve(process.cwd(), text(args["out-dir"]))
    : DEFAULT_OUT_DIR;

  const requestUrl = new URL("/api/stationboard", baseUrl);
  requestUrl.searchParams.set("stop_id", stopId);
  requestUrl.searchParams.set("limit", String(limit));
  requestUrl.searchParams.set("include_alerts", String(includeAlerts));
  requestUrl.searchParams.set("debug", String(debug));

  const response = await fetch(requestUrl.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  const bodyText = await response.text();

  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(
      `Response is not valid JSON (status=${response.status}). Body preview: ${bodyText.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Stationboard request failed (${response.status}). Body preview: ${bodyText.slice(0, 300)}`
    );
  }

  await fs.mkdir(outDir, { recursive: true });
  const fileName = `stationboard_${safeForFileName(stopId)}_${nowStamp()}.json`;
  const outputPath = path.resolve(outDir, fileName);
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const departures = Array.isArray(payload?.departures) ? payload.departures : [];

  console.log(`Captured: ${requestUrl.toString()}`);
  console.log(`Saved JSON: ${outputPath}`);
  console.log(`Departures: ${departures.length}`);
  console.log("");
  printDeparturesTable(departures);
}

main().catch((err) => {
  console.error(`captureWrongTripDetails failed: ${String(err?.message || err)}`);
  process.exit(1);
});
