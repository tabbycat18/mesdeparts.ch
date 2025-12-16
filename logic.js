// logic.js
// --------------------------------------------------------
// Helpers: time / classification / filters / API
// --------------------------------------------------------

import {
  appState,
  DEPS_PER_LINE,
  MIN_ROWS,
  MAX_TRAIN_ROWS,
  BOARD_HORIZON_MINUTES,
  ARRIVAL_LEAD_SECONDS,
  DEPARTED_GRACE_SECONDS,
  BUS_DELAY_LABEL_THRESHOLD_MIN,
  TRAIN_DELAY_LABEL_THRESHOLD_MIN,
  DEBUG_EARLY,
  VIEW_MODE_TIME,
  VIEW_MODE_LINE,
  VIEW_MODE_DOWN,
} from "./state.js";

// Night window: Friday 22:00 -> Sunday 07:00
export function isNightWindow(now) {
  const wd = now.getDay(); // 0 Sunday ... 6 Saturday
  const h = now.getHours();
  if (wd === 5 && h >= 22) return true; // Friday evening
  if (wd === 6) return true; // Saturday
  if (wd === 0 && h < 7) return true; // Sunday morning
  return false;
}

// Classification train / bus according to SBB category
export function classifyMode(category) {
  const cat = (category || "").toUpperCase().trim();

  const TRAIN_CATS = ["IC","IR","EC","EN","R","RE","S","ICE","RJ","RJX","PE","GPX"];
  // City rail (tram/metro) that you want grouped with “bus” on the board
  const CITY_RAIL_CATS = ["T","TRAM","M"];

  if (TRAIN_CATS.includes(cat)) return "train";
  if (cat === "B" || cat === "BUS" || CITY_RAIL_CATS.includes(cat)) return "bus";

  // Fallback: treat unknown as urban so it still shows
  if (!cat) return "bus";
  return "bus";
}

// Motte special direction filter
export function isDownDirection(lineNo, dest) {
  const dl = (dest || "").toLowerCase();
  if (lineNo === "3") return dl.includes("lausanne") && dl.includes("gare");
  if (lineNo === "8") return dl.includes("pully") && dl.includes("gare");
  if (lineNo === "18") return dl.includes("crissier");
  return false;
}

export function passesMotteFilter(lineNo, dest, night) {
  // N1 only during the night window (both directions)
  if (lineNo === "N1") return night;

  // Motte: keep only 3 / 8 / 18 in "down" direction
  if (lineNo === "3" || lineNo === "8" || lineNo === "18") {
    return isDownDirection(lineNo, dest);
  }
  return false;
}

export function detectNetworkFromStation(name) {
  const n = (name || "").toLowerCase();

  // Lausanne / TL (approximate list around Lausanne)
  const isLausanne =
    /lausanne|renens|pully|epalinges|ecublens|crissier|prilly|tl\b/.test(n);
  if (isLausanne) return "tl";

  // Geneva / TPG – Versoix, Genève, Thônex, Aïre, etc.
  const isGeneva =
    /genève|geneve|versoix|thonex|thônex|lancy|carouge|meyrin|onex|bernex|aire|aïre|plan-les-ouates|pregny|chêne-bourg|chene-bourg|chêne-bougeries|chene-bougeries/.test(n);
  if (isGeneva) return "tpg";

  // Zürich / VBZ
  const isZurich =
    /zürich|zurich|oerlikon|altstetten|hardbrücke|hardbrucke|vbz/.test(n);
  if (isZurich) return "vbz";

  return "generic";
}

// Detect transport network from a stationboard entry (operator-based, not station-based)
function detectNetworkFromEntry(entry) {
  const op = String(
    entry?.operator?.name ||
    entry?.operator?.display ||
    entry?.operator ||
    ""
  ).toLowerCase();

  if (/transports publics genevois|\btpg\b/.test(op)) return "tpg";
  if (/\btl\b|transports publics de la région lausannoise|lausanne/.test(op)) return "tl";
  if (/vbz|zürcher verkehrsbetriebe|zuercher verkehrsbetriebe/.test(op)) return "zvv";
  if (/postauto|carpostal|autopostale/.test(op)) return "postauto";

  return "generic";
}

// Fix format "2025-11-25T21:35:00+0100" to ISO standard
export function parseApiDate(str) {
  if (!str) return null;
  let s = String(str);
  if (s.length === 24 && /[+-]\d{4}$/.test(s)) {
    s = s.slice(0, 22) + ":" + s.slice(22); // +0100 -> +01:00
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `\n${body.slice(0, 300)}` : ""}`);
  }
  return res.json();
}

// --------------------------------------------------------
// API : stations & stationboard
// --------------------------------------------------------

export async function resolveStationId() {
  const url = `https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(appState.STATION)}`;
  const data = await fetchJson(url);

  const list = data.stations || data.stops || data.locations || [];
  const first = list[0];
  if (!first) throw new Error("No station found");
  appState.stationId = first.id;
  return first.id;
}

export async function fetchStationSuggestions(query) {
  const url = `https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(query)}&limit=7`;
  const data = await fetchJson(url);

  const list = data.stations || data.stops || data.locations || [];
  return list
    .filter((s) => s && s.name)
    .map((s) => ({ id: s.id, name: s.name }));
}

// Normalize a “simple” line id used for CSS and grouping
function normalizeSimpleLineId(rawNumber, rawCategory) {
  const trimmedNumber = rawNumber ? String(rawNumber).trim() : "";

  if (trimmedNumber && /^[0-9]+$/.test(trimmedNumber)) {
    const n = parseInt(trimmedNumber, 10);
    return Number.isNaN(n) ? trimmedNumber : String(n); // strip leading zeros
  }

  // Letter+digits without special chars (e.g. "N01" → "N1")
  if (
    trimmedNumber &&
    /^[A-Za-z]+0*[0-9]+$/.test(trimmedNumber) &&
    !/[+]/.test(trimmedNumber)
  ) {
    const match = trimmedNumber.match(/^([A-Za-z]+)0*([0-9]+)$/);
    if (match) {
      const prefix = match[1].toUpperCase();
      const numInt = parseInt(match[2], 10);
      const numStr = Number.isNaN(numInt) ? match[2] : String(numInt);
      return `${prefix}${numStr}`;
    }
    return trimmedNumber;
  }

  if (trimmedNumber) return trimmedNumber;
  if (rawCategory) return String(rawCategory).trim();
  return "";
}

function formatPlannedTime(d) {
  return d.toLocaleTimeString("fr-CH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export async function fetchDeparturesGrouped(viewMode = VIEW_MODE_LINE) {
  if (!appState.stationId) {
    await resolveStationId();
  }

  const url = `https://transport.opendata.ch/v1/stationboard?station=${encodeURIComponent(appState.stationId)}&limit=300`;
  const data = await fetchJson(url);

  const now = new Date();
  const night = isNightWindow(now);

  // Rule: no comma means “main station” -> show trains only
  const stationName = appState.STATION || "";
  const forceTrainStation = !stationName.includes(",");

  const applyMotteFilter = appState.stationIsMotte && viewMode === VIEW_MODE_DOWN;
  const groupByLine = viewMode === VIEW_MODE_LINE || viewMode === VIEW_MODE_DOWN;
  const chronoBuses = viewMode === VIEW_MODE_TIME;

  const byLine = new Map();
  const allDeps = [];
  const busLines = new Set();
  const busPlatforms = new Set();

  let trainCount = 0;
  let busCount = 0;
  let busHasPlatform = false;

  // Debug: limit how many rows we log per refresh
  let debugLogged = 0;
  const DEBUG_MAX = 25;

  for (const entry of data.stationboard || []) {
    const rawNumber = entry.number ? String(entry.number) : "";
    const rawCategory = entry.category ? String(entry.category) : "";

    // Operator can be a string or an object
    const rawOperator =
      (entry.operator &&
        (entry.operator.name || entry.operator.display || entry.operator)) ||
      entry.operator ||
      "";

    const isPostBus = /PAG|postauto|carpostal|autopostale/i.test(String(rawOperator));

    // Debug: inspect operator string and PostAuto detection in console
    if (DEBUG_EARLY && rawOperator) {
      console.log("[MesDeparts] operator debug", {
        station: appState.STATION,
        line: `${rawCategory}${rawNumber}`.trim(),
        dest: entry.to || "",
        rawOperator,
        isPostBus,
      });
    }

    let mode = classifyMode(rawCategory);

    // If this is a “station” board (no comma), ignore buses entirely
    if (forceTrainStation && mode === "bus") continue;

    if (mode === "train") trainCount += 1;
    else busCount += 1;

    const dest = entry.to || "";

    const stop = entry.stop || {};
    const depRaw = stop.departure;
    if (!depRaw) continue;

    const scheduledDt = parseApiDate(depRaw);
    if (!scheduledDt) continue;

    const plannedTimeStr = formatPlannedTime(scheduledDt);

    // --- realtime / delay computation ---
    let baseDt = scheduledDt;
    let delayMin = 0;
    let delaySource = "none";

    const prog = stop.prognosis || {};
    if (prog.departure) {
      const progDt = parseApiDate(prog.departure);
      if (progDt) {
        baseDt = progDt;
        delaySource = "prognosis";
        delayMin = Math.round((baseDt.getTime() - scheduledDt.getTime()) / 60000);
      }
    } else if (typeof stop.delay === "number") {
      delayMin = stop.delay;
      delaySource = "delay";
      baseDt = new Date(scheduledDt.getTime() + delayMin * 60 * 1000);
    }

    // Debug: specifically log cases where prognosis is earlier than scheduled
    if (DEBUG_EARLY && delaySource === "prognosis" && delayMin < 0) {
      console.log("[MesDeparts][early-case]", {
        station: appState.STATION,
        mode,
        line: `${rawCategory}${rawNumber}`.trim(),
        to: dest,
        scheduledISO: scheduledDt.toISOString(),
        prognosisISO: baseDt.toISOString(),
        delayMin,
      });
    }

    // --- horizon & arrival window ---
    const diffMs = baseDt.getTime() - now.getTime();
    const diffSec = diffMs / 1000;

    // keep only within the future horizon
    if (diffSec > BOARD_HORIZON_MINUTES * 60) continue;

    // hide vehicles that already left (beyond the grace window)
    if (diffSec < -DEPARTED_GRACE_SECONDS) continue;

    // countdown minutes (for bus boards only)
    let inMin;
    if (diffSec > 60) {
      inMin = Math.ceil(diffSec / 60);
    } else if (diffSec > 0) {
      inMin = 1;
    } else {
      inMin = 0;
    }

    const isArriving =
      diffSec <= ARRIVAL_LEAD_SECONDS && diffSec >= -DEPARTED_GRACE_SECONDS;

    if (DEBUG_EARLY && debugLogged < DEBUG_MAX) {
      debugLogged += 1;
      console.log("[MesDeparts][early-debug]", {
        station: appState.STATION,
        mode,
        category: rawCategory,
        number: rawNumber,
        line: `${rawCategory}${rawNumber}`.trim(),
        to: dest,
        scheduled: depRaw,
        prognosisDeparture: prog.departure || null,
        apiDelay: typeof stop.delay === "number" ? stop.delay : null,
        computedDelayMin: delayMin,
        scheduledISO: scheduledDt.toISOString(),
        realtimeISO: baseDt.toISOString(),
        diffSec: Math.round(diffSec),
      });
    }

    const platformRaw = stop.platform || "";
    const platformChanged = String(platformRaw).includes("!");
    const platform = String(platformRaw).replace("!", "");

    if (mode === "bus" && platform) {
      busHasPlatform = true;
      busPlatforms.add(platform);
    }

    // platform filter applies only on bus boards, when not in Motte “down” view
    if (!applyMotteFilter && appState.platformFilter && mode === "bus") {
      if (!platform || platform !== appState.platformFilter) continue;
    }

    // Normalized line id (for bus grouping + CSS)
    const simpleLineId = normalizeSimpleLineId(rawNumber, rawCategory);

    // Motte special filter (only in “down” view)
    if (applyMotteFilter && mode === "bus") {
      if (!passesMotteFilter(simpleLineId, dest, night)) continue;
    }

    // line filter applies only on bus boards, when not in Motte “down” view
    if (!applyMotteFilter && appState.lineFilter && mode === "bus") {
      if (simpleLineId !== appState.lineFilter) continue;
    }

    // --- remark & status (delay/early rules) ---
    let remark = "";
    let status = null; // "delay" | "early" | null

    if (delayMin > 0) {
      const threshold =
        mode === "bus"
          ? BUS_DELAY_LABEL_THRESHOLD_MIN
          : TRAIN_DELAY_LABEL_THRESHOLD_MIN;

      if (delayMin >= threshold) {
        if (mode === "bus") {
          remark = "Retard";
        } else {
          remark = `Retard env. ${delayMin} min`;
        }
        status = "delay";
      }
    } else if (delayMin < 0) {
      // You decided: early only for bus/tram/metro, not for trains
      if (mode === "bus") {
        remark = `-${Math.abs(delayMin)} min`;
        status = "early";
      }
    }

    const depObj = {
      line: `${rawCategory}${rawNumber}`.trim(),
      name: entry.name || "",
      network: detectNetworkFromEntry(entry),

      category: rawCategory,
      number: rawNumber,
      mode,
      simpleLineId,
      dest,
      platform,
      platformChanged,

      // Column “Départ” always shows the planned time
      timeStr: plannedTimeStr,

      // countdown (bus boards only)
      inMin: Math.max(inMin, 0),

      // sorting / diagnostics
      baseTime: baseDt.getTime(),
      scheduledTime: scheduledDt.getTime(),
      realtimeTime: baseDt.getTime(),
      delaySource,
      delayMin,
      status,
      remark,

      // arrival icon window
      isArriving,

      // operator info (for PostAuto styling)
      operator: rawOperator || null,
      _debugNetwork: detectNetworkFromEntry(entry),
      isPostBus,
    };

    allDeps.push(depObj);

    if (mode === "bus") {
      busLines.add(simpleLineId);

      const groupKey = simpleLineId || depObj.line;
      if (!byLine.has(groupKey)) byLine.set(groupKey, []);
      byLine.get(groupKey).push(depObj);
    }
  }

  // Board metadata for UI
  appState.lastBoardHasBus = busCount > 0;
  appState.lastBoardHasBusPlatform = busHasPlatform;
  const isTrainBoard = trainCount > 0 && busCount === 0;
  appState.lastBoardIsTrain = isTrainBoard;

  appState.platformOptions = Array.from(busPlatforms);
  appState.lineOptions = Array.from(busLines);

  // Train boards: always chronological
  if (isTrainBoard) {
    return allDeps
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime)
      .slice(0, MAX_TRAIN_ROWS);
  }

  // Bus boards:
  // - Heure view: simply sort by baseTime (realtime)
  if (chronoBuses) {
    return allDeps
      .filter((d) => d.mode === "bus")
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime)
      .slice(0, MIN_ROWS);
  }

  // Group-by-line view (default)
  const flat = [];
  let lineKeys;

  if (applyMotteFilter) {
    const preferredOrder = ["3", "8", "18", "N1"];
    const present = Array.from(byLine.keys());
    lineKeys = preferredOrder.filter((ln) => present.includes(ln));
  } else {
    lineKeys = Array.from(byLine.keys()).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
      if (na !== nb) return na - nb;
      return a.localeCompare(b, "fr-CH");
    });
  }

  for (const key of lineKeys) {
    const deps = (byLine.get(key) || []).slice().sort((a, b) => a.baseTime - b.baseTime);
    for (const d of deps.slice(0, DEPS_PER_LINE)) flat.push(d);
  }

  // Fallback: if too few rows, fill with soonest buses (only when no user filter and not Motte down)
  const hasUserFilter = !!appState.platformFilter || !!appState.lineFilter;
  if (flat.length < MIN_ROWS && !hasUserFilter && !applyMotteFilter) {
    const sortedAll = allDeps
      .filter((d) => d.mode === "bus")
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime);
    return sortedAll.slice(0, MIN_ROWS);
  }

  return flat;
}
