#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function text(value) {
  return String(value || "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultQueries() {
  return [
    "Zurich",
    "Zürich",
    "Zuerich",
    "Zürich HB",
    "St Gallen",
    "St. Gallen",
    "geneve",
    "Genève Cornavin",
    "Lausanne, Bel-Air",
  ];
}

function loadQueriesFromFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("query file must be a JSON array of strings");
  }
  return parsed.map((value) => text(value)).filter(Boolean);
}

async function fetchJson(url) {
  const response = await fetch(url, {
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
    payload = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
    bodyText,
  };
}

async function verifyOne(baseUrl, query) {
  const searchUrl = new URL("/api/stops/search", baseUrl);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", "10");
  searchUrl.searchParams.set("debug", "1");
  const searchRes = await fetchJson(searchUrl.toString());
  const stops = toArray(searchRes.payload?.stops);
  const chosenStopId = text(stops[0]?.stop_id || stops[0]?.id);

  if (!searchRes.ok || !chosenStopId) {
    return {
      query,
      ok: false,
      stage: "search",
      stopId: chosenStopId || null,
      rowCount: 0,
      flags: [],
      versionSkew: null,
      reason: searchRes.ok ? "empty_search_results" : `search_http_${searchRes.status}`,
    };
  }

  const boardUrl = new URL("/api/stationboard", baseUrl);
  boardUrl.searchParams.set("stop_id", chosenStopId);
  boardUrl.searchParams.set("limit", "10");
  boardUrl.searchParams.set("debug", "1");
  const boardRes = await fetchJson(boardUrl.toString());
  const payload = boardRes.payload || {};
  const departures = toArray(payload.departures);
  const debug = payload.debug || {};
  const flags = toArray(debug.flags).map((item) => text(item)).filter(Boolean);
  const warnings = toArray(debug.warnings);
  const versionSkewWarning = warnings.find(
    (item) => text(item?.code) === "static_rt_version_skew"
  );

  const hasStructuredNoService = !!payload.noService && typeof payload.noService === "object";
  const boardOk =
    boardRes.ok &&
    text(payload.error) !== "stop_not_found" &&
    (departures.length > 0 || hasStructuredNoService);

  return {
    query,
    ok: boardOk,
    stage: "stationboard",
    stopId: chosenStopId,
    rowCount: departures.length,
    flags,
    versionSkew: versionSkewWarning
      ? {
          staticVersion: text(versionSkewWarning.staticVersion) || null,
          rtVersion: text(versionSkewWarning.rtVersion) || null,
        }
      : null,
    reason: boardOk
      ? null
      : boardRes.ok
        ? text(payload.error) || "empty_stationboard_without_noService"
        : `stationboard_http_${boardRes.status}`,
  };
}

async function main() {
  const baseUrl =
    text(process.env.STATIONBOARD_BASE_URL || process.env.BACKEND_BASE_URL) ||
    "http://localhost:3001";
  const listPath = text(process.argv[2] || "");
  const queries = listPath ? loadQueriesFromFile(listPath) : defaultQueries();
  if (queries.length === 0) {
    throw new Error("no queries to verify");
  }

  const results = [];
  for (const query of queries) {
    const report = await verifyOne(baseUrl, query);
    results.push(report);
    console.log(
      `${report.ok ? "OK" : "FAIL"} | query="${query}" | stop_id=${report.stopId || "-"} | departures=${report.rowCount} | flags=${report.flags.join(",") || "-"} | skew=${report.versionSkew ? `${report.versionSkew.staticVersion || "?"}!=${report.versionSkew.rtVersion || "?"}` : "-"}${report.reason ? ` | reason=${report.reason}` : ""}`
    );
  }

  const failures = results.filter((item) => !item.ok);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`verifyStops failed: ${String(err?.message || err)}`);
  process.exit(1);
});
