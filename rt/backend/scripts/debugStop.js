#!/usr/bin/env node

function text(value) {
  return String(value || "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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
    url,
  };
}

function summarizeSearchStops(stops) {
  return toArray(stops).slice(0, 10).map((row, index) => {
    const stopId = text(row?.stop_id || row?.id);
    const parent = text(row?.parent_station);
    const locationType = text(row?.location_type);
    const isParent = !parent || locationType === "1" || stopId.startsWith("Parent");
    return {
      rank: index + 1,
      stop_id: stopId,
      stop_name: text(row?.stop_name || row?.name),
      parent_station: parent || null,
      location_type: locationType || null,
      isParent,
      isPlatform: !isParent,
    };
  });
}

async function main() {
  const query = text(process.argv[2] || "Lausanne, Bel-Air");
  const baseUrl = text(process.env.STATIONBOARD_BASE_URL || process.env.BACKEND_BASE_URL) || "http://localhost:3001";
  const searchLimit = Math.max(1, Math.min(Number(process.env.STOP_SEARCH_LIMIT || "10"), 50));
  const boardLimit = Math.max(1, Math.min(Number(process.env.STATIONBOARD_LIMIT || "20"), 200));

  const searchUrl = new URL("/api/stops/search", baseUrl);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", String(searchLimit));
  searchUrl.searchParams.set("debug", "1");
  const searchResponse = await fetchJson(searchUrl.toString());

  const stops = toArray(searchResponse?.payload?.stops);
  const searchTop = summarizeSearchStops(stops);
  const chosenStopId = text(stops[0]?.stop_id || stops[0]?.id);

  let boardResponse = null;
  if (chosenStopId) {
    const boardUrl = new URL("/api/stationboard", baseUrl);
    boardUrl.searchParams.set("stop_id", chosenStopId);
    boardUrl.searchParams.set("limit", String(boardLimit));
    boardUrl.searchParams.set("debug", "1");
    boardResponse = await fetchJson(boardUrl.toString());
  }

  const boardPayload = boardResponse?.payload || null;
  const boardDebug = boardPayload?.debug || {};

  const out = {
    query,
    baseUrl,
    search: {
      ok: !!searchResponse?.ok,
      status: Number(searchResponse?.status || 0),
      topCandidates: searchTop,
      chosenStopId: chosenStopId || null,
    },
    stationboard: boardResponse
      ? {
          ok: !!boardResponse.ok,
          status: Number(boardResponse.status || 0),
          error: text(boardPayload?.error) || null,
          departuresCount: toArray(boardPayload?.departures).length,
          resolution: boardDebug?.stopResolution || null,
          rowSources: toArray(boardDebug?.rowSources),
          stageCounts: toArray(boardDebug?.stageCounts).slice(-5),
          warnings: toArray(boardDebug?.warnings),
        }
      : {
          ok: false,
          status: 0,
          error: "no_search_result",
          departuresCount: 0,
          resolution: null,
          rowSources: [],
          stageCounts: [],
          warnings: [],
        },
  };

  console.log(JSON.stringify(out, null, 2));

  if (!searchResponse.ok || !chosenStopId || !boardResponse || !boardResponse.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(err?.message || err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
