import assert from "node:assert/strict";

import {
  buildDeparturesGrouped,
  classifyMode,
  detectNetworkFromStation,
  fetchJourneyDetails,
  parseApiDate,
} from "../logic.v2025-02-07.js";
import { appState, VIEW_MODE_LINE } from "../state.v2025-02-07.js";

// classifyMode should categorize common transport codes
assert.equal(classifyMode("IC"), "train");
assert.equal(classifyMode("RE"), "train");
assert.equal(classifyMode("BUS"), "bus");
assert.equal(classifyMode("T"), "bus"); // tram grouped with bus

// parseApiDate should normalize the +0100 offset format
const parsed = parseApiDate("2025-11-25T21:35:00+0100");
assert.ok(parsed instanceof Date);
assert.equal(parsed.toISOString(), "2025-11-25T20:35:00.000Z");

// detectNetworkFromStation should pick up city-specific networks
assert.equal(detectNetworkFromStation("Lausanne, gare"), "tl");
assert.equal(detectNetworkFromStation("Genève, Cornavin"), "tpg");
assert.equal(detectNetworkFromStation("Zurich HB"), "vbz");

// fetchJourneyDetails should prefer the bus section on mixed train+bus connection results
{
  const originalFetch = globalThis.fetch;
  const targetMs = Date.parse("2026-02-17T04:53:00+01:00");
  const targetTs = Math.floor(targetMs / 1000);

  appState.stationId = "Parent8501000";
  appState.STATION = "Coppet, gare";

  globalThis.fetch = async (url) => {
    const u = String(url || "");
    if (u.includes("/api/connections")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          connections: [
            {
              sections: [
                {
                  journey: {
                    category: "IR",
                    number: "",
                    passList: [
                      { station: { id: "Parent8501000", name: "Coppet" } },
                      { station: { id: "Parent8503000", name: "Nyon" } },
                    ],
                  },
                  departure: {
                    departureTimestamp: targetTs,
                    station: { name: "Coppet" },
                  },
                  arrival: {
                    station: { name: "Nyon" },
                  },
                },
                {
                  journey: {
                    category: "B",
                    number: "805",
                    passList: [
                      { station: { id: "Parent8501000", name: "Coppet, gare" } },
                      { station: { id: "Parent8502000", name: "Coppet, centre" } },
                    ],
                  },
                  departure: {
                    departureTimestamp: targetTs + 120,
                    station: { name: "Coppet, gare" },
                  },
                  arrival: {
                    station: { name: "Coppet, centre" },
                  },
                },
              ],
            },
          ],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL in test: ${u}`);
  };

  try {
    const detail = await fetchJourneyDetails({
      mode: "bus",
      number: "805",
      line: "805",
      simpleLineId: "805",
      category: "B",
      dest: "Coppet, centre",
      fromStationId: "Parent8501000",
      fromStationName: "Coppet, gare",
      scheduledTime: targetMs,
      scheduledTimestamp: targetTs,
      timeStr: "04:53",
    });
    assert.equal(String(detail?.section?.journey?.category || ""), "B");
    assert.equal(String(detail?.section?.journey?.number || ""), "805");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// buildDeparturesGrouped should keep replacement buses on main station boards (no comma)
{
  const previous = {
    station: appState.STATION,
    stationId: appState.stationId,
    trainFilter: appState.trainServiceFilter,
    platformFilter: appState.platformFilter,
    lineFilter: appState.lineFilter,
    favoritesOnly: appState.favoritesOnly,
    lastPlatforms: appState.lastPlatforms,
  };

  const base = new Date(Date.now() + 15 * 60 * 1000);
  const later = new Date(base.getTime() + 4 * 60 * 1000);
  const far = new Date(base.getTime() + 6 * 60 * 1000);

  appState.STATION = "Lausanne";
  appState.stationId = "Parent8501120";
  appState.trainServiceFilter = "train_all";
  appState.platformFilter = null;
  appState.lineFilter = null;
  appState.favoritesOnly = false;
  appState.lastPlatforms = {};

  const rows = buildDeparturesGrouped(
    {
      stationboard: [
        {
          category: "IR",
          number: "15",
          name: "IR15",
          to: "Luzern",
          source: "scheduled",
          tags: [],
          stop: {
            departure: base.toISOString(),
            platform: "1",
            prognosis: { departure: base.toISOString(), delay: 0, status: "OK" },
          },
        },
        {
          category: "B",
          number: "EV",
          name: "EV",
          to: "Bus de remplacement",
          source: "synthetic_alert",
          tags: ["replacement"],
          stop: {
            departure: later.toISOString(),
            platform: "",
            prognosis: { departure: later.toISOString(), delay: 0, status: "OK" },
          },
        },
        {
          category: "B",
          number: "21",
          name: "21",
          to: "Regular bus",
          source: "scheduled",
          tags: [],
          stop: {
            departure: far.toISOString(),
            platform: "",
            prognosis: { departure: far.toISOString(), delay: 0, status: "OK" },
          },
        },
      ],
    },
    VIEW_MODE_LINE,
  );

  try {
    assert.equal(rows.some((row) => row.mode === "bus" && row.simpleLineId === "EV"), true);
    assert.equal(rows.some((row) => row.mode === "bus" && row.simpleLineId === "21"), false);
  } finally {
    appState.STATION = previous.station;
    appState.stationId = previous.stationId;
    appState.trainServiceFilter = previous.trainFilter;
    appState.platformFilter = previous.platformFilter;
    appState.lineFilter = previous.lineFilter;
    appState.favoritesOnly = previous.favoritesOnly;
    appState.lastPlatforms = previous.lastPlatforms;
  }
}
