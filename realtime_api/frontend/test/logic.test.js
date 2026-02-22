import assert from "node:assert/strict";

import {
  buildDeparturesGrouped,
  classifyMode,
  computeDelayMin,
  computeDelaySeconds,
  computeDeltaMinutes,
  fetchStationSuggestions,
  fetchStationboardRaw,
  getDisplayedDelayBadge,
  detectNetworkFromStation,
  fetchJourneyDetails,
  parseApiDate,
  RT_HARD_CAP_MS,
  shouldApplyIncomingBoard,
  shouldHoldRtDowngrade,
} from "../v20260222-1.logic.js";
import { appState, VIEW_MODE_LINE, VIEW_MODE_TIME } from "../v20260222-1.state.js";

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

// canonical raw delay helpers
assert.equal(
  computeDelaySeconds("2026-02-19T12:00:00+0100", "2026-02-19T12:01:00+0100"),
  60,
);
assert.equal(computeDelayMin(60), 1);
assert.equal(computeDelayMin(60, { rounding: "ceil" }), 1);

// display-only suppression is train-only
{
  const busBadge = getDisplayedDelayBadge({
    mode: "bus",
    vehicleCategory: "bus_tram_metro",
    delaySeconds: 60,
    cancelled: false,
    busDelayThresholdMin: 1,
  });
  assert.equal(busBadge.displayedDelayMin, 1);
  assert.equal(busBadge.status, "delay");

  const trainBadge = getDisplayedDelayBadge({
    mode: "train",
    vehicleCategory: "train",
    delaySeconds: 60,
    cancelled: false,
  });
  assert.equal(trainBadge.displayedDelayMin, 1);
  assert.equal(trainBadge.status, null);
  assert.equal(trainBadge.suppressDelayRemark, true);
  assert.equal(trainBadge.remark, "");

  const trainDelay2 = getDisplayedDelayBadge({
    mode: "train",
    vehicleCategory: "train",
    delaySeconds: 120,
    cancelled: false,
  });
  assert.equal(trainDelay2.displayedDelayMin, 2);
  assert.equal(trainDelay2.status, "delay");
  assert.equal(String(trainDelay2.remark || "").length > 0, true);

  const trainEarly1 = getDisplayedDelayBadge({
    mode: "train",
    vehicleCategory: "train",
    delaySeconds: -60,
    cancelled: false,
  });
  assert.equal(trainEarly1.status, "early");
  assert.equal(String(trainEarly1.remark || "").toLowerCase().includes("avance"), true);

  const trainNoRealtime = getDisplayedDelayBadge({
    mode: "train",
    vehicleCategory: "train",
    delaySeconds: null,
    cancelled: false,
  });
  assert.equal(trainNoRealtime.status, null);

  const cancelled = getDisplayedDelayBadge({
    mode: "train",
    vehicleCategory: "train",
    delaySeconds: 60,
    cancelled: true,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(String(cancelled.remark || "").length > 0, true);
}

// bus delayed chip visibility: use backend delayMin threshold (>=2 only)
{
  const bus0 = getDisplayedDelayBadge({
    mode: "bus",
    vehicleCategory: "bus_tram_metro",
    delaySeconds: 0,
    authoritativeDelayMin: 0,
    cancelled: false,
    busDelayThresholdMin: 2,
  });
  assert.equal(bus0.status, null);

  // Regression: timestamp delta can be ~61s (ceil=2), but backend delayMin=1.
  // Chip must remain hidden because bus threshold uses backend delayMin as-is.
  const bus1 = getDisplayedDelayBadge({
    mode: "bus",
    vehicleCategory: "bus_tram_metro",
    delaySeconds: 61,
    authoritativeDelayMin: 1,
    cancelled: false,
    busDelayThresholdMin: 2,
  });
  assert.equal(bus1.status, null);
  assert.equal(bus1.displayedDelayMin, 1);

  const bus2 = getDisplayedDelayBadge({
    mode: "bus",
    vehicleCategory: "bus_tram_metro",
    delaySeconds: 61,
    authoritativeDelayMin: 2,
    cancelled: false,
    busDelayThresholdMin: 2,
  });
  assert.equal(bus2.status, "delay");
  assert.equal(bus2.displayedDelayMin, 2);
}

// detectNetworkFromStation should pick up city-specific networks
assert.equal(detectNetworkFromStation("Lausanne, gare"), "tl");
assert.equal(detectNetworkFromStation("Genève, Cornavin"), "tpg");
assert.equal(detectNetworkFromStation("Zurich HB"), "vbz");

// Anti-flicker guard: keep previous RT view briefly on transient non-applied responses.
assert.equal(
  shouldHoldRtDowngrade({
    lastRtAppliedAtMs: 1_000,
    nowMs: 20_000,
    holdWindowMs: 30_000,
    staleGraceMs: 30_000,
    nextRt: {
      applied: false,
      reason: "missing_cache",
      freshnessThresholdMs: 45_000,
      cacheAgeMs: 10_000,
    },
  }),
  true
);
assert.equal(
  shouldHoldRtDowngrade({
    lastRtAppliedAtMs: 1_000,
    nowMs: 70_000,
    holdWindowMs: 30_000,
    nextRt: { applied: false, reason: "missing_cache" },
  }),
  false
);

// Strict no-downgrade decision matrix:
// keep RT snapshot on scheduled-only responses unless forced or hard-cap exceeded.
{
  const nowMs = 1_000_000;
  const currentRtState = {
    currentBoardHasRtSnapshot: true,
    lastRtSnapshotAtMs: nowMs - 10_000,
  };
  const scheduledOnlyPayload = {
    rt: {
      applied: false,
      reason: "stale",
    },
  };
  const rtPayload = {
    rt: {
      applied: true,
      reason: "fresh",
    },
  };

  // 1) keeps_rt_on_scheduled_only_when_not_forced
  const holdDecision = shouldApplyIncomingBoard(
    currentRtState,
    scheduledOnlyPayload,
    200,
    {
      contextChanged: false,
      stopChanged: false,
      languageChanged: false,
      manualHardRefresh: false,
      hardCapMs: RT_HARD_CAP_MS,
    },
    nowMs
  );
  assert.equal(holdDecision.apply, false);
  assert.equal(holdDecision.mode, "ignore");

  // 2) allows_downgrade_after_hard_cap
  const hardCapDecision = shouldApplyIncomingBoard(
    {
      currentBoardHasRtSnapshot: true,
      lastRtSnapshotAtMs: nowMs - (6 * 60 * 1000),
    },
    scheduledOnlyPayload,
    200,
    { hardCapMs: RT_HARD_CAP_MS },
    nowMs
  );
  assert.equal(hardCapDecision.apply, true);
  assert.equal(hardCapDecision.reason, "hard_cap_exceeded");

  // 3) applies_scheduled_only_when_no_rt_yet
  const firstLoadDecision = shouldApplyIncomingBoard(
    {
      currentBoardHasRtSnapshot: false,
      lastRtSnapshotAtMs: null,
    },
    scheduledOnlyPayload,
    200,
    { hardCapMs: RT_HARD_CAP_MS },
    nowMs
  );
  assert.equal(firstLoadDecision.apply, true);
  assert.equal(firstLoadDecision.mode, "apply");

  // 4) always_applies_rt_snapshot
  const incomingRtDecision = shouldApplyIncomingBoard(
    {
      currentBoardHasRtSnapshot: true,
      lastRtSnapshotAtMs: nowMs - 30_000,
    },
    rtPayload,
    200,
    { hardCapMs: RT_HARD_CAP_MS },
    nowMs
  );
  assert.equal(incomingRtDecision.apply, true);
  assert.equal(incomingRtDecision.reason, "incoming_rt_snapshot");

  // 5) 204_does_nothing
  const noContentDecision = shouldApplyIncomingBoard(
    currentRtState,
    null,
    204,
    { hardCapMs: RT_HARD_CAP_MS },
    nowMs
  );
  assert.equal(noContentDecision.apply, false);
  assert.equal(noContentDecision.reason, "http_204_no_change");

  // 6) forced_stop_change_allows_downgrade
  const stopChangeDecision = shouldApplyIncomingBoard(
    currentRtState,
    scheduledOnlyPayload,
    200,
    {
      stopChanged: true,
      hardCapMs: RT_HARD_CAP_MS,
    },
    nowMs
  );
  assert.equal(stopChangeDecision.apply, true);
  assert.equal(stopChangeDecision.reason, "forced_stop_changed");
}
assert.equal(
  shouldHoldRtDowngrade({
    lastRtAppliedAtMs: 1_000,
    nowMs: 20_000,
    holdWindowMs: 30_000,
    staleGraceMs: 5_000,
    nextRt: {
      applied: false,
      reason: "stale_cache",
      freshnessThresholdMs: 45_000,
      cacheAgeMs: 60_500,
    },
  }),
  false
);
assert.equal(
  shouldHoldRtDowngrade({
    lastRtAppliedAtMs: 1_000,
    nowMs: 20_000,
    holdWindowMs: 30_000,
    nextRt: { applied: false, reason: "disabled" },
  }),
  false
);

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

// fetchStationboardRaw should send since_rt and handle 204 no-content responses.
{
  const originalFetch = globalThis.fetch;
  const previous = {
    stationId: appState.stationId,
    station: appState.STATION,
    language: appState.language,
    lastRtFetchedAt: appState.lastRtFetchedAt,
    lastStationboardHttpStatus: appState.lastStationboardHttpStatus,
  };
  appState.stationId = "Parent8501120";
  appState.STATION = "Lausanne";
  appState.language = "fr";
  appState.lastRtFetchedAt = "2026-02-21T15:00:00.000Z";

  try {
    let requestUrl = "";
    globalThis.fetch = async (url) => {
      requestUrl = String(url || "");
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get(name) {
            if (String(name || "").toLowerCase() === "x-md-rt-fetched-at") {
              return "2026-02-21T15:00:00.000Z";
            }
            return null;
          },
        },
      };
    };
    const notModified = await fetchStationboardRaw({ allowRetry: false });
    assert.equal(notModified?.__notModified, true);
    assert.equal(notModified?.__status, 204);
    assert.equal(requestUrl.includes("since_rt=2026-02-21T15%3A00%3A00.000Z"), true);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get() {
          return null;
        },
      },
      json: async () => ({
        station: { id: "Parent8501120", name: "Lausanne" },
        departures: [],
        banners: [],
        rt: {
          available: true,
          applied: true,
          reason: "fresh",
          feedKey: "la_tripupdates",
          fetchedAt: "2026-02-21T15:01:00.000Z",
          cacheFetchedAt: "2026-02-21T15:01:00.000Z",
          cacheAgeMs: 1000,
          freshnessThresholdMs: 45000,
          status: 200,
        },
        alerts: {
          available: false,
          applied: false,
          reason: "disabled",
          fetchedAt: null,
          ageSeconds: null,
        },
      }),
    });
    const full = await fetchStationboardRaw({ allowRetry: false });
    assert.equal(full?.__status, 200);
    assert.equal(appState.lastRtFetchedAt, "2026-02-21T15:01:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    appState.stationId = previous.stationId;
    appState.STATION = previous.station;
    appState.language = previous.language;
    appState.lastRtFetchedAt = previous.lastRtFetchedAt;
    appState.lastStationboardHttpStatus = previous.lastStationboardHttpStatus;
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
        // Bus: early shown for any negative signed delay
        if (typeof row.delayMin === "number" && row.delayMin < 0) {
          assert.equal(row.status, "early");
          assert.equal(String(row.remark || "").toLowerCase().includes("avance"), true);
          continue;
        }
        // Tiny late drift (+1) is still suppressed for buses.
        if (typeof row.delayMin === "number" && row.delayMin >= 0 && row.delayMin <= 1) {
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

// raw-vs-display invariants:
// - raw delay uses timestamps
// - train +1 can be display-suppressed
// - bus/tram/metro must not be train-suppressed
// - countdown/sorting must use realtime timestamps (not display suppression)
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

  const nowBase = Date.now() + 10 * 60 * 1000;
  const mkIso = (ms) => new Date(ms).toISOString();
  const makeEntry = ({ category, number, offsetMin, deltaSec }) => {
    const scheduledMs = nowBase + offsetMin * 60 * 1000;
    const realtimeMs = scheduledMs + deltaSec * 1000;
    return {
      category,
      number: String(number),
      name: String(number),
      operator: category === "S" ? "SBB" : "TL",
      to: `Dest ${number}`,
      source: "scheduled",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: "A",
        delay: Math.round(deltaSec / 60),
        prognosis: {
          departure: mkIso(realtimeMs),
          delay: Math.round(deltaSec / 60),
          status: "ON_TIME",
          cancelled: false,
        },
        cancelled: false,
      },
      cancelled: false,
    };
  };

  try {
    appState.STATION = "Test, Stop";
    appState.stationId = "Parent0000000";
    appState.trainServiceFilter = "train_all";
    appState.platformFilter = null;
    appState.lineFilter = null;
    appState.favoritesOnly = false;
    appState.lastPlatforms = {};

    const busOnlyRows = buildDeparturesGrouped(
      {
        stationboard: [
          makeEntry({ category: "B", number: "7", offsetMin: 2, deltaSec: 60 }),
          makeEntry({ category: "B", number: "8", offsetMin: 1, deltaSec: 0 }),
        ],
      },
      VIEW_MODE_TIME,
    );
    const bus7 = busOnlyRows.find((row) => row.mode === "bus" && String(row.simpleLineId || "") === "7");
    assert.ok(bus7);
    // 1) BUS: raw +60s stays +60s and display remains bus-domain (no train suppression)
    assert.equal(bus7.rawDelaySec, 60);
    assert.equal(bus7.delayMin, 1);
    assert.equal(bus7.displayedDelayMin, 1);

    const trainRows = buildDeparturesGrouped(
      {
        stationboard: [
          // Train +1 minute (display suppression allowed, raw must remain +60s)
          makeEntry({ category: "S", number: "5", offsetMin: 4, deltaSec: 60 }),
          makeEntry({ category: "S", number: "6", offsetMin: 3, deltaSec: 120 }),
        ],
      },
      VIEW_MODE_TIME,
    );
    const train5 = trainRows.find((row) => row.mode === "train" && String(row.simpleLineId || "") === "5");
    assert.ok(train5);
    // 2) TRAIN: raw +60s is preserved, +1 badge can stay visible while delay remark is suppressed
    assert.equal(train5.rawDelaySec, 60);
    assert.equal(train5.delayMin, 1);
    assert.equal(train5.displayedDelayMin, 1);
    assert.equal(train5.status, null);
    assert.equal(train5.suppressDelayRemark, true);
    assert.equal(String(train5.remark || ""), "");

    // 3) Countdown/min uses realtime timestamp directly (no 1-min global shift)
    assert.ok(
      Number.isFinite(train5.realtimeTime) &&
        Number.isFinite(train5.scheduledTime) &&
        train5.realtimeTime - train5.scheduledTime === 60_000,
    );
    const expectedTrainInMin = Math.max(0, Math.ceil((train5.realtimeTime - Date.now()) / 60_000));
    assert.equal(train5.inMin, expectedTrainInMin);

    // 4+5) Mixed regression + sorting by realtime/base time (not display fields)
    // 4) Mixed regression at helper level: train suppression must not change bus display mapping
    const mixedBusDisplay = getDisplayedDelayBadge({
      mode: "bus",
      vehicleCategory: "bus_tram_metro",
      delaySeconds: 60,
      cancelled: false,
      busDelayThresholdMin: 1,
    });
    const mixedTrainDisplay = getDisplayedDelayBadge({
      mode: "train",
      vehicleCategory: "train",
      delaySeconds: 60,
      cancelled: false,
    });
    assert.equal(mixedBusDisplay.displayedDelayMin, 1);
    assert.equal(mixedTrainDisplay.displayedDelayMin, 1);

    // 5) Sorting stays based on realtime/base time (not display fields)
    const sortedByBaseTime = [...trainRows].sort((a, b) => (a.baseTime || 0) - (b.baseTime || 0));
    assert.deepEqual(
      trainRows.map((row) => row.baseTime),
      sortedByBaseTime.map((row) => row.baseTime),
    );
    assert.ok(trainRows.every((row) => row.baseTime === row.realtimeTime));
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
  const makeBusEntry = ({ line, earlyMin, earlySeconds }) => {
    const scheduledMs = nowBase + Number(line) * 60 * 1000;
    const earlyOffsetSec =
      typeof earlySeconds === "number" ? earlySeconds : earlyMin * 60;
    const realtimeMs = scheduledMs - earlyOffsetSec * 1000;
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
      // Rounded minutes can be -2 around ~1m35s early.
      makeBusEntry({ line: 10, earlySeconds: 96 }),
      // -54s rounds to -1 min (deltaMin) but is below 60 s threshold → no early badge.
      makeBusEntry({ line: 11, earlySeconds: 54 }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_TIME);
    const line8 = rows.find((row) => String(row.simpleLineId || "") === "8");
    const line9 = rows.find((row) => String(row.simpleLineId || "") === "9");
    const line10 = rows.find((row) => String(row.simpleLineId || "") === "10");
    const line11 = rows.find((row) => String(row.simpleLineId || "") === "11");

    assert.ok(line8);
    assert.equal(line8.status, "early");
    assert.ok(String(line8.remark || "").toLowerCase().includes("avance"));
    assert.equal(line8.delayMin, -2);
    assert.equal(line8.delaySource, "timestamps");

    assert.ok(line9);
    assert.equal(line9.status, "early");
    assert.equal(line9.delayMin, -1);
    assert.ok(String(line9.remark || "").toLowerCase().includes("avance"));
    assert.equal(line9.delaySource, "timestamps");

    assert.ok(line10);
    assert.equal(line10.status, "early");
    assert.equal(line10.delayMin, -2);
    assert.ok(String(line10.remark || "").toLowerCase().includes("avance"));
    assert.equal(line10.delaySource, "timestamps");

    assert.ok(line11);
    // 54 s early is below the 60 s threshold → no early badge.
    assert.equal(line11.status, null);
    assert.equal(line11.delayMin, -1);
    assert.equal(line11.remark, "");
    assert.equal(line11.delaySource, "timestamps");
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

// small stops (<=4 lines) should show up to 2 departures per direction in line view
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
  const makeBusEntry = ({ line, to, offsetMin }) => {
    const scheduledMs = nowBase + offsetMin * 60 * 1000;
    return {
      category: "B",
      number: String(line),
      name: String(line),
      operator: "TL",
      to,
      source: "scheduled",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: "A",
        delay: 0,
        prognosis: {
          departure: mkIso(scheduledMs),
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
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 2 }),
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 4 }),
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 6 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 3 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 5 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 7 }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_LINE);
    const line8Rows = rows.filter((row) => String(row.simpleLineId || "") === "8");
    assert.equal(line8Rows.length, 4);

    const byDest = line8Rows.reduce((acc, row) => {
      const key = String(row.dest || "");
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());
    assert.equal(byDest.get("Pully, gare"), 2);
    assert.equal(byDest.get("Prilly, gare"), 2);
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

// large stops (>4 lines) should keep default per-line cap behavior
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
  const makeBusEntry = ({ line, to, offsetMin }) => {
    const scheduledMs = nowBase + offsetMin * 60 * 1000;
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
        delay: 0,
        prognosis: {
          departure: mkIso(scheduledMs),
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
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 2 }),
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 4 }),
      makeBusEntry({ line: 8, to: "Pully, gare", offsetMin: 6 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 3 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 5 }),
      makeBusEntry({ line: 8, to: "Prilly, gare", offsetMin: 7 }),
      makeBusEntry({ line: 1, offsetMin: 8 }),
      makeBusEntry({ line: 2, offsetMin: 9 }),
      makeBusEntry({ line: 3, offsetMin: 10 }),
      makeBusEntry({ line: 4, offsetMin: 11 }),
      makeBusEntry({ line: 5, offsetMin: 12 }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_LINE);
    const line8Rows = rows.filter((row) => String(row.simpleLineId || "") === "8");
    assert.equal(line8Rows.length, 2);
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

// small-stop mode should apply a fair global cap (16 rows) across lines
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
  const makeBusEntry = ({ line, to, offsetMin }) => {
    const scheduledMs = nowBase + offsetMin * 60 * 1000;
    return {
      category: "B",
      number: String(line),
      name: String(line),
      operator: "TL",
      to,
      source: "scheduled",
      tags: [],
      stop: {
        departure: mkIso(scheduledMs),
        platform: "A",
        delay: 0,
        prognosis: {
          departure: mkIso(scheduledMs),
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

    const lines = [1, 2, 3, 4];
    const dirs = ["Direction A", "Direction B", "Direction C"];
    const stationboard = [];
    for (const line of lines) {
      for (const [dirIdx, dir] of dirs.entries()) {
        stationboard.push(makeBusEntry({ line, to: dir, offsetMin: line * 20 + dirIdx * 4 + 1 }));
        stationboard.push(makeBusEntry({ line, to: dir, offsetMin: line * 20 + dirIdx * 4 + 2 }));
      }
    }

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_LINE);
    assert.equal(rows.length, 16);

    const byLine = rows.reduce((acc, row) => {
      const key = String(row.simpleLineId || "");
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());

    assert.equal(byLine.size, 4);
    assert.equal(byLine.get("1"), 4);
    assert.equal(byLine.get("2"), 4);
    assert.equal(byLine.get("3"), 4);
    assert.equal(byLine.get("4"), 4);
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

// small-stop mode should preserve delayed-row visibility without exceeding per-direction count
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
      makeBusEntry({ line: 8, offsetMin: 2, delayMin: 0, to: "Pully, gare" }),
      makeBusEntry({ line: 8, offsetMin: 4, delayMin: 0, to: "Pully, gare" }),
      makeBusEntry({ line: 8, offsetMin: 6, delayMin: 4, to: "Pully, gare" }),
    ];

    const rows = buildDeparturesGrouped({ stationboard }, VIEW_MODE_LINE);
    const line8Rows = rows.filter((row) => String(row.simpleLineId || "") === "8");

    assert.equal(line8Rows.length, 2);
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

// fetchStationboardRaw should keep banners empty when API banners are empty
{
  const originalFetch = globalThis.fetch;
  const previous = {
    station: appState.STATION,
    stationId: appState.stationId,
    language: appState.language,
  };

  appState.STATION = "Bern";
  appState.stationId = "Parent8507000";
  appState.language = "fr";

  const nowMs = Date.now() + 10 * 60 * 1000;
  const scheduledIso = new Date(nowMs).toISOString();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      station: { id: "Parent8507000", name: "Bern" },
      banners: [],
      departures: [
        {
          trip_id: "trip-1",
          category: "S",
          number: "5",
          line: "S5",
          destination: "Kerzers",
          scheduledDeparture: scheduledIso,
          realtimeDeparture: scheduledIso,
          delayMin: 0,
          alerts: [
            {
              id: "route-disruption",
              severity: "warning",
              header: "Limited train service between Kerzers and Payerne",
              description: "Construction work, replacement transport.",
            },
          ],
        },
        {
          trip_id: "trip-2",
          category: "S",
          number: "5",
          line: "S5",
          destination: "Kerzers",
          scheduledDeparture: scheduledIso,
          realtimeDeparture: scheduledIso,
          delayMin: 0,
          alerts: [
            {
              id: "route-disruption",
              severity: "warning",
              header: "Limited train service between Kerzers and Payerne",
              description: "Construction work, replacement transport.",
            },
          ],
        },
      ],
    }),
  });

  try {
    const data = await fetchStationboardRaw({ allowRetry: false, bustCache: false });
    assert.equal(Array.isArray(data?.banners), true);
    assert.equal(data.banners.length, 0);
  } finally {
    appState.STATION = previous.station;
    appState.stationId = previous.stationId;
    appState.language = previous.language;
    globalThis.fetch = originalFetch;
  }
}

// fetchStationboardRaw + buildDeparturesGrouped should preserve departure-level alerts
{
  const originalFetch = globalThis.fetch;
  const previous = {
    station: appState.STATION,
    stationId: appState.stationId,
    language: appState.language,
  };

  appState.STATION = "Bern, Bahnhof";
  appState.stationId = "Parent8576646";
  appState.language = "fr";

  const nowMs = Date.now() + 12 * 60 * 1000;
  const scheduledIso = new Date(nowMs).toISOString();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      station: { id: "Parent8576646", name: "Bern, Bahnhof" },
      banners: [],
      departures: [
        {
          trip_id: "trip-m10",
          category: "B",
          number: "M10",
          line: "M10",
          destination: "Biel/Bienne, Bahnhof/Gare",
          scheduledDeparture: scheduledIso,
          realtimeDeparture: scheduledIso,
          delayMin: 0,
          alerts: [
            {
              id: "a-1",
              severity: "warning",
              header: "Service restreint Biel/Bienne, Bahnhof/Gare [bus].",
              description: "Une manifestation en est la cause.",
            },
            {
              id: "empty-alert",
              severity: "info",
              header: "",
              description: "",
            },
          ],
        },
      ],
    }),
  });

  try {
    const data = await fetchStationboardRaw({ allowRetry: false, bustCache: false });
    assert.equal(Array.isArray(data?.stationboard), true);
    assert.equal(data.stationboard.length, 1);
    assert.equal(Array.isArray(data.stationboard[0]?.alerts), true);
    assert.equal(data.stationboard[0].alerts.length, 1);
    assert.equal(data.stationboard[0].alerts[0].id, "a-1");

    const rows = buildDeparturesGrouped(data, VIEW_MODE_LINE);
    assert.ok(rows.length >= 1);
    assert.equal(Array.isArray(rows[0]?.alerts), true);
    assert.equal(rows[0].alerts.length, 1);
    assert.equal(rows[0].alerts[0].id, "a-1");
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
    assert.equal(parsed.searchParams.get("limit"), "20");
    assert.equal(rows.length, 3);
    const ids = rows.map((row) => row.id).sort();
    assert.deepEqual(ids, [
      "Parent8503000",
      "Parent8587057",
      "Parent8587387",
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
