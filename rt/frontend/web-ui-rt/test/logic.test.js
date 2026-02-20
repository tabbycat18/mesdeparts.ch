import assert from "node:assert/strict";

import {
  buildDeparturesGrouped,
  classifyMode,
  computeDeltaMinutes,
  fetchStationSuggestions,
  fetchStationboardRaw,
  detectNetworkFromStation,
  fetchJourneyDetails,
  parseApiDate,
} from "../logic.v2026-02-20.js";
import { appState, VIEW_MODE_LINE, VIEW_MODE_TIME } from "../state.v2026-02-20.js";

// classifyMode should categorize common transport codes
assert.equal(classifyMode("IC"), "train");
assert.equal(classifyMode("RE"), "train");
assert.equal(classifyMode("BUS"), "bus");
assert.equal(classifyMode("T"), "bus"); // tram grouped with bus

// parseApiDate should normalize the +0100 offset format
const parsed = parseApiDate("2025-11-25T21:35:00+0100");
assert.ok(parsed instanceof Date);
assert.equal(parsed.toISOString(), "2025-11-25T20:35:00.000Z");

// shared delta helper should return signed minutes
assert.equal(
  computeDeltaMinutes("2026-02-19T12:00:00+0100", "2026-02-19T12:03:00+0100"),
  3,
);
assert.equal(
  computeDeltaMinutes("2026-02-19T12:00:00+0100", "2026-02-19T11:58:00+0100"),
  -2,
);
assert.equal(computeDeltaMinutes("2026-02-19T12:00:00+0100", null), null);

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

// realtime delta regression harness:
// Lausanne / Geneva / Zurich must follow one render rule for delay/early/cancelled.
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

  const samples = [
    { id: "Parent8501120", station: "Lausanne, Motte", category: "B", operator: "TL" },
    { id: "Parent8587057", station: "Genève, Rive", category: "T", operator: "TPG" },
    { id: "Parent8503000", station: "Zürich, Bellevue", category: "T", operator: "VBZ" },
  ];

  const nowBase = Date.now() + 8 * 60 * 1000;
  const deltas = [0, 1, 2, -1, -2, 3, null, 5, -3, 0];

  const mkIso = (ms) => new Date(ms).toISOString();

  function buildEntry({ idx, category, operator, delta, cancelled = false }) {
    const scheduledMs = nowBase + idx * 3 * 60 * 1000;
    const realtimeMs =
      delta == null ? null : scheduledMs + Number(delta) * 60 * 1000;
    return {
      category,
      number: String((idx % 4) + 1),
      name: String((idx % 4) + 1),
      operator,
      to: `Destination ${idx + 1}`,
      source: "scheduled",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: `${(idx % 3) + 1}`,
        delay: delta,
        prognosis: {
          departure: realtimeMs == null ? null : mkIso(realtimeMs),
          delay: delta,
          status: cancelled ? "CANCELLED" : "OK",
          cancelled,
        },
        cancelled,
      },
      cancelled,
    };
  }

  try {
    for (const sample of samples) {
      appState.STATION = sample.station;
      appState.stationId = sample.id;
      appState.trainServiceFilter = "train_all";
      appState.platformFilter = null;
      appState.lineFilter = null;
      appState.favoritesOnly = false;
      appState.lastPlatforms = {};

      const stationboard = deltas.map((delta, idx) =>
        buildEntry({
          idx,
          category: sample.category,
          operator: sample.operator,
          delta,
          cancelled: idx === 8,
        }),
      );

      const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_TIME)
        .filter((row) => row.mode === "bus")
        .slice(0, 10);

      console.log(
        "[rt-delta-harness]",
        JSON.stringify(
          {
            stationId: sample.id,
            station: sample.station,
            sample: rows.map((r) => ({
              line: r.line,
              delayMin: r.delayMin ?? null,
              earlyMin: r.earlyMin ?? null,
              status: r.status ?? null,
              remark: r.remark ?? "",
              remarkWide: r.remarkWide ?? "",
              remarkNarrow: r.remarkNarrow ?? "",
            })),
          },
          null,
          2,
        ),
      );

      for (const row of rows) {
        // All rows tested here are buses (filtered above); bus rules apply.
        if (row.status === "cancelled") {
          assert.equal(String(row.remark || "").length > 0, true);
          continue;
        }
        // Bus: delay shown when delayMin > 1; plain "Retard" (no minutes for buses)
        if (typeof row.delayMin === "number" && row.delayMin > 1) {
          assert.equal(row.status, "delay");
          assert.equal(String(row.remark || "").toLowerCase().includes("retard"), true);
          continue;
        }
        // Bus: early shown when earlyMin > 1 (delayMin < -1)
        if (typeof row.delayMin === "number" && row.delayMin < -1) {
          assert.equal(row.status, "early");
          assert.equal(String(row.remark || "").toLowerCase().includes("avance"), true);
          continue;
        }
        // Tiny drift (|delayMin| <= 1) — suppressed for buses too
        if (typeof row.delayMin === "number" && Math.abs(row.delayMin) <= 1) {
          assert.equal(row.status, null);
          assert.equal(String(row.remark || ""), "");
          continue;
        }
        assert.equal(row.status, null);
      }

      // Buses can show early; if there are negative-delta bus rows, at least one must be "early"
      const hasNegative = rows.some((row) => typeof row.delayMin === "number" && row.delayMin < 0);
      if (hasNegative) {
        assert.equal(rows.some((row) => row.status === "early"), true);
      }
    }
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

// When backend clamps delayMin to 0 but timestamps show early departure,
// keep early signal from timestamps for bus cosmetics.
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

  const nowBase = Date.now() + 8 * 60 * 1000;
  const mkIso = (ms) => new Date(ms).toISOString();
  const makeBusEntry = ({ line, earlyMin }) => {
    const scheduledMs = nowBase + Number(line) * 60 * 1000;
    const realtimeMs = scheduledMs - earlyMin * 60 * 1000;
    return {
      category: "B",
      number: String(line),
      name: String(line),
      operator: "TL",
      to: `Destination ${line}`,
      source: "tripupdate",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: "A",
        delay: 0, // backend-clamped API field
        prognosis: {
          departure: mkIso(realtimeMs),
          delay: 0,
          status: "ON_TIME",
          cancelled: false,
        },
        cancelled: false,
      },
      cancelled: false,
    };
  };

  try {
    appState.STATION = "Lausanne, Bel-Air";
    appState.stationId = "Parent8591988";
    appState.trainServiceFilter = "train_all";
    appState.platformFilter = null;
    appState.lineFilter = null;
    appState.favoritesOnly = false;
    appState.lastPlatforms = {};

    const stationboard = [
      makeBusEntry({ line: 8, earlyMin: 2 }),
      makeBusEntry({ line: 9, earlyMin: 1 }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_TIME);
    const line8 = rows.find((row) => String(row.simpleLineId || "") === "8");
    const line9 = rows.find((row) => String(row.simpleLineId || "") === "9");

    assert.ok(line8);
    assert.equal(line8.status, "early");
    assert.ok(String(line8.remark || "").toLowerCase().includes("avance"));
    assert.equal(line8.delayMin, -2);

    assert.ok(line9);
    assert.equal(line9.status, null);
    assert.equal(line9.delayMin, -1);
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

// line view should keep at least one delayed departure visible for a line
// even when the per-line quota would otherwise pick only on-time rows.
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

  const nowBase = Date.now() + 8 * 60 * 1000;
  const mkIso = (ms) => new Date(ms).toISOString();
  const makeBusEntry = ({ line, offsetMin, delayMin = 0, to }) => {
    const scheduledMs = nowBase + offsetMin * 60 * 1000;
    const realtimeMs = scheduledMs + delayMin * 60 * 1000;
    return {
      category: "B",
      number: String(line),
      name: String(line),
      operator: "TL",
      to: to || `Destination ${line}`,
      source: "scheduled",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: "A",
        delay: delayMin,
        prognosis: {
          departure: mkIso(realtimeMs),
          delay: delayMin,
          status: "ON_TIME",
          cancelled: false,
        },
        cancelled: false,
      },
      cancelled: false,
    };
  };

  try {
    appState.STATION = "Lausanne, Bel-Air";
    appState.stationId = "Parent8591988";
    appState.trainServiceFilter = "train_all";
    appState.platformFilter = null;
    appState.lineFilter = null;
    appState.favoritesOnly = false;
    appState.lastPlatforms = {};

    const stationboard = [
      // Line 8 has three departures; delayed one is third chronologically.
      makeBusEntry({ line: 8, offsetMin: 2, delayMin: 0, to: "Pully, gare" }),
      makeBusEntry({ line: 8, offsetMin: 4, delayMin: 0, to: "Pully, gare" }),
      makeBusEntry({ line: 8, offsetMin: 6, delayMin: 4, to: "Pully, gare" }),
      // Additional lines keep per-line quota at 2.
      makeBusEntry({ line: 1, offsetMin: 3, delayMin: 0 }),
      makeBusEntry({ line: 2, offsetMin: 3, delayMin: 0 }),
      makeBusEntry({ line: 3, offsetMin: 3, delayMin: 0 }),
      makeBusEntry({ line: 6, offsetMin: 3, delayMin: 0 }),
      makeBusEntry({ line: 7, offsetMin: 3, delayMin: 0 }),
      makeBusEntry({ line: 9, offsetMin: 3, delayMin: 0 }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_LINE);
    const line8Rows = rows.filter((row) => String(row.simpleLineId || "") === "8");

    assert.ok(line8Rows.length > 0);
    assert.ok(
      line8Rows.some((row) => row.status === "delay" && typeof row.delayMin === "number" && row.delayMin >= 2)
    );
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

// fetchStationboardRaw should forward selected UI language to backend (?lang=..)
{
  const originalFetch = globalThis.fetch;
  const previous = {
    station: appState.STATION,
    stationId: appState.stationId,
    language: appState.language,
  };

  appState.STATION = "Brig";
  appState.stationId = "Parent8501609";
  appState.language = "it";

  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url || "");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        station: { id: "Parent8501609", name: "Brig" },
        departures: [],
        banners: [],
      }),
    };
  };

  try {
    await fetchStationboardRaw({ allowRetry: false, bustCache: false });
    assert.ok(requestedUrl.includes("/api/stationboard?"));
    const parsed = new URL(requestedUrl, "http://localhost");
    assert.equal(parsed.searchParams.get("stop_id"), "Parent8501609");
    assert.equal(parsed.searchParams.get("lang"), "it");
  } finally {
    appState.STATION = previous.station;
    appState.stationId = previous.stationId;
    appState.language = previous.language;
    globalThis.fetch = originalFetch;
  }
}

// fetchStationSuggestions should use /api/stops/search and keep backend rows (no client filtering by diacritics/punctuation)
{
  const originalFetch = globalThis.fetch;

  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url || "");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        stops: [
          { stop_id: "Parent8503000", stop_name: "Zürich HB" },
          { stop_id: "Parent8587057", stop_name: "Genève, gare Cornavin" },
          { stop_id: "Parent8587387", stop_name: "Genève, Bel-Air" },
        ],
      }),
    };
  };

  try {
    const rows = await fetchStationSuggestions("Zurich");
    assert.ok(requestedUrl.includes("/api/stops/search?"));
    const parsed = new URL(requestedUrl, "http://localhost");
    assert.equal(parsed.searchParams.get("q"), "Zurich");
    assert.equal(parsed.searchParams.get("limit"), "7");
    assert.deepEqual(rows, [
      { id: "Parent8503000", name: "Zürich HB" },
      { id: "Parent8587057", name: "Genève, gare Cornavin" },
      { id: "Parent8587387", name: "Genève, Bel-Air" },
    ]);
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
    assert.equal(rows.some((row) => row.mode === "train" && row.simpleLineId === "15"), true);
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

// cancellation detection should not treat generic "cancellation" wording as a cancelled trip
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

  const normalDep = new Date(Date.now() + 10 * 60 * 1000);
  const cancelledDep = new Date(normalDep.getTime() + 3 * 60 * 1000);

  appState.STATION = "Zürich HB";
  appState.stationId = "Parent8503000";
  appState.trainServiceFilter = "train_all";
  appState.platformFilter = null;
  appState.lineFilter = null;
  appState.favoritesOnly = false;
  appState.lastPlatforms = {};

  const rows = buildDeparturesGrouped(
    {
      stationboard: [
        {
          category: "IC",
          number: "5",
          name: "IC5",
          to: "Lausanne",
          source: "scheduled",
          tags: [],
          stop: {
            departure: normalDep.toISOString(),
            platform: "5",
            prognosis: {
              departure: normalDep.toISOString(),
              delay: 0,
              status: "No cancellation expected",
            },
          },
        },
        {
          category: "IC",
          number: "1",
          name: "IC1",
          to: "Genève-Aéroport",
          source: "scheduled",
          tags: [],
          stop: {
            departure: cancelledDep.toISOString(),
            platform: "6",
            prognosis: {
              departure: cancelledDep.toISOString(),
              delay: 0,
              status: "CANCELLED",
            },
          },
        },
      ],
    },
    VIEW_MODE_LINE,
  );

  try {
    assert.equal(rows.length, 2);
    const ic5 = rows.find((row) => row.number === "5");
    const ic1 = rows.find((row) => row.number === "1");
    assert.ok(ic5);
    assert.ok(ic1);
    assert.notEqual(ic5.status, "cancelled");
    assert.equal(ic1.status, "cancelled");
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

// buildDeparturesGrouped should dedupe duplicated synthetic replacement rows
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

  const base = new Date(Date.now() + 20 * 60 * 1000);
  const depIso = base.toISOString();

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
          category: "B",
          number: "EV",
          name: "EV",
          to: "Bus de remplacement",
          source: "synthetic_alert",
          tags: ["replacement"],
          stop: {
            departure: depIso,
            departureTimestamp: Math.floor(base.getTime() / 1000),
            platform: "",
            prognosis: { departure: depIso, delay: 0, status: "OK" },
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
            departure: depIso,
            departureTimestamp: Math.floor(base.getTime() / 1000),
            platform: "",
            prognosis: { departure: depIso, delay: 0, status: "OK" },
          },
        },
      ],
    },
    VIEW_MODE_LINE,
  );

  try {
    assert.equal(rows.filter((row) => row.mode === "bus" && row.simpleLineId === "EV").length, 1);
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
