#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const FRONTEND_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_CONFIG_PATH = path.join(FRONTEND_ROOT, "config", "network-map.json");

function parseArgs(argv) {
  const out = {
    base: "http://localhost:3001",
    stops: [],
    limit: 60,
    config: DEFAULT_CONFIG_PATH,
    inputDir: "",
    out: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--base" && next) {
      out.base = next;
      i += 1;
    } else if (token === "--stops" && next) {
      out.stops = next.split(",").map((v) => v.trim()).filter(Boolean);
      i += 1;
    } else if (token === "--limit" && next) {
      out.limit = Math.max(1, Number(next) || 60);
      i += 1;
    } else if (token === "--config" && next) {
      out.config = path.resolve(next);
      i += 1;
    } else if (token === "--input-dir" && next) {
      out.inputDir = path.resolve(next);
      i += 1;
    } else if (token === "--out" && next) {
      out.out = path.resolve(next);
      i += 1;
    }
  }
  return out;
}

function compilePatterns(list) {
  return (Array.isArray(list) ? list : [])
    .map((pattern) => String(pattern || "").trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildOperatorMatchers(configJson) {
  const networks = configJson && typeof configJson === "object" ? configJson.networks : null;
  const entries = networks && typeof networks === "object" ? Object.entries(networks) : [];
  const out = [];
  for (const [networkIdRaw, cfg] of entries) {
    const network = String(networkIdRaw || "").trim().toLowerCase();
    if (!network) continue;
    compilePatterns(cfg?.operatorPatterns).forEach((regex) => out.push({ network, regex }));
  }
  return out;
}

function detectNetworkFromOperator(operatorName, operatorMatchers) {
  const op = String(operatorName || "").trim();
  if (!op) return "";
  for (const matcher of operatorMatchers) {
    if (matcher.regex.test(op)) return matcher.network;
  }
  return "";
}

function suggestNetworks(operator) {
  const op = String(operator || "").toLowerCase();
  const suggestions = [];
  if (/genevois|\btpg\b/.test(op)) suggestions.push("tpg");
  if (/nyonnais|\btpn\b|nyon/.test(op)) suggestions.push("tpn");
  if (/lausannoise|\btl\b|lausanne/.test(op)) suggestions.push("tl");
  if (/zvv|vbz|verkehrsbetriebe|zuercher|zürcher|zurich|zürich/.test(op)) suggestions.push("zvv");
  if (/mbc|morges|cossonay|biere|bière/.test(op)) suggestions.push("mbc");
  if (/vmcv|vevey|montreux/.test(op)) suggestions.push("vmcv");
  if (/postauto|carpostal|autopostale/.test(op)) suggestions.push("postauto");
  return Array.from(new Set(suggestions));
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function collectRowsFromInputDir(inputDir) {
  if (!inputDir) return [];
  const rows = [];
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(inputDir, entry.name);
    try {
      const payload = await readJsonFile(filePath);
      const list = Array.isArray(payload?.stationboard) ? payload.stationboard : [];
      for (const row of list) {
        rows.push({ row, source: `file:${entry.name}` });
      }
    } catch {
      // ignore malformed files
    }
  }
  return rows;
}

async function collectRowsFromApi({ base, stops, limit }) {
  const rows = [];
  for (const stopId of stops) {
    const url = `${String(base || "").replace(/\/$/, "")}/api/stationboard?stop_id=${encodeURIComponent(
      stopId,
    )}&limit=${encodeURIComponent(String(limit || 60))}&include_alerts=1`;
    try {
      const payload = await fetch(url, { cache: "no-store" }).then((res) => res.json());
      const list = Array.isArray(payload?.stationboard) ? payload.stationboard : [];
      for (const row of list) {
        rows.push({ row, source: `api:${stopId}` });
      }
    } catch {
      // ignore fetch failures per stop
    }
  }
  return rows;
}

function extractOperatorName(row) {
  const op = row?.operator;
  if (typeof op === "string") return op.trim();
  if (op && typeof op === "object") {
    return String(op.name || op.display || op.short || "").trim();
  }
  return "";
}

async function main() {
  const args = parseArgs(process.argv);
  const configJson = await readJsonFile(args.config);
  const operatorMatchers = buildOperatorMatchers(configJson);

  const collected = [
    ...(await collectRowsFromInputDir(args.inputDir)),
    ...(await collectRowsFromApi(args)),
  ];

  const unknown = new Map();
  let totalBusRows = 0;
  for (const { row, source } of collected) {
    if (String(row?.mode || "").toLowerCase() !== "bus") continue;
    totalBusRows += 1;
    const operatorName = extractOperatorName(row);
    if (!operatorName) continue;
    const knownNetwork = detectNetworkFromOperator(operatorName, operatorMatchers);
    if (knownNetwork) continue;

    const key = operatorName;
    const prev = unknown.get(key) || {
      operator: key,
      count: 0,
      lines: new Set(),
      sources: new Set(),
      suggestions: suggestNetworks(key),
    };
    prev.count += 1;
    prev.lines.add(String(row?.simpleLineId || row?.line || row?.number || "").trim());
    prev.sources.add(source);
    unknown.set(key, prev);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    configPath: args.config,
    totalRowsScanned: collected.length,
    totalBusRows,
    unknownOperators: Array.from(unknown.values())
      .sort((a, b) => b.count - a.count)
      .map((item) => ({
        operator: item.operator,
        count: item.count,
        lines: Array.from(item.lines).filter(Boolean).sort(),
        sources: Array.from(item.sources).sort(),
        suggestedNetworks: item.suggestions,
        suggestedConfigEntry: {
          operatorPattern: item.operator
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .toLowerCase(),
          network: item.suggestions[0] || "<choose-network>",
        },
      })),
  };

  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});
