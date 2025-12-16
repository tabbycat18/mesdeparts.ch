// logic.js
// --------------------------------------------------------
// Helpers: time / classification / filters / API
// --------------------------------------------------------

import {
  appState,
  MAX_LINES_BUS,
  DEPS_PER_LINE,
  MIN_ROWS,
  MAX_TRAIN_ROWS,
  DEBUG_EARLY,
  BUS_DELAY_MIN_THRESHOLD,
  TRAIN_DELAY_MIN_THRESHOLD,
  ARRIVAL_PULSE_BEFORE_SEC,
  ARRIVAL_PULSE_AFTER_SEC,
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

  const TRAIN_CATS = [
    "IC",
    "IR",
    "EC",
    "EN",
    "R",
    "RE",
    "S",
    "ICE",
    "RJ",
    "RJX",
    "PE",
    "GPX",
  ];

  // Catégories "city rail" (trams, métro, etc.) qu’on veut mettre avec les bus
  const CITY_RAIL_CATS = ["T", "TRAM", "M"]; // T = trams, M = métro (Lausanne)

  // 1) Vrai train grandes / régionales lignes
  if (TRAIN_CATS.includes(cat)) return "train";

  // 2) Transport urbain : bus, tram, métro, etc.
  if (cat === "B" || cat === "BUS" || CITY_RAIL_CATS.includes(cat)) {
    return "bus";
  }

  // 3) Fallback : tout ce qui n’est pas identifié comme train longue distance
  //    on le considère comme urbain (bus/tram) pour qu’il apparaisse dans le board.
  if (!cat) return "bus";
  return "bus";
}

export function isDownDirection(lineNo, dest) {
  const dl = dest.toLowerCase();

  if (lineNo === "3") {
    return dl.includes("lausanne") && dl.includes("gare");
  }
  if (lineNo === "8") {
    return dl.includes("pully") && dl.includes("gare");
  }
  if (lineNo === "18") {
    return dl.includes("crissier");
  }
  return false;
}

export function passesMotteFilter(lineNo, dest, night) {
  // N1 only during the night window (both directions)
  if (lineNo === "N1") {
    return night;
  }
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
    /genève|geneve|versoix|thonex|thônex|lancy|carouge|meyrin|onex|bernex|aire|aïre|plan-les-ouates|pregny|chêne-bourg|chene-bourg|chêne-bougeries|chene-bougeries/.test(
      n
    );
  if (isGeneva) return "tpg";

  // Zürich / VBZ
  const isZurich =
    /zürich|zurich|oerlikon|altstetten|hardbrücke|hardbrucke|vbz/.test(n);
  if (isZurich) return "vbz";

  return "generic";
}

// Fix format "2025-11-25T21:35:00+0100" to ISO standard
export function parseApiDate(str) {
  if (!str) return null;
  if (str.length === 24 && /[+-]\d{4}$/.test(str)) {
    str = str.slice(0, 22) + ":" + str.slice(22); // +0100 -> +01:00
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}


// --------------------------------------------------------
// API : stations & stationboard
// --------------------------------------------------------

// --- Fetch helper (hardening) --------------------------------------

async function fetchJson(url, label = "fetch") {
  // Retry once on rate-limit / transient errors
  const MAX_TRIES = 2;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`[${label}] Network error: ${err?.message || String(err)}`);
    }

    // Simple retry policy for transient statuses
    if (!res.ok && (res.status === 429 || res.status === 503) && attempt < MAX_TRIES) {
      // small backoff (browser-safe)
      await new Promise((r) => setTimeout(r, 600 * attempt));
      continue;
    }

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch (_) {
        body = "";
      }

      // Keep message short; avoid dumping huge HTML
      const tail = body ? ` — ${body.slice(0, 200)}` : "";
      throw new Error(`[${label}] HTTP ${res.status} ${res.statusText}${tail}`);
    }

    try {
      return await res.json();
    } catch (err) {
      throw new Error(`[${label}] Invalid JSON: ${err?.message || String(err)}`);
    }
  }

  // Should never happen due to returns/throws above
  throw new Error(`[${label}] Unknown fetch error`);
}

export async function resolveStationId() {
  const url = `https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(
    appState.STATION
  )}`;
  const data = await fetchJson(url, "locations:resolveStationId");

  const list = data.stations || data.stops || data.locations || [];
  const first = list[0];
  if (!first) throw new Error("No station found");
  appState.stationId = first.id;
  return first.id;
}

export async function fetchStationSuggestions(query) {
  const url = `https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(
    query
  )}&limit=7`;
  let data;
  try {
    data = await fetchJson(url, "locations:suggestions");
  } catch (e) {
    console.error(e);
    return [];
  }
  const list = data.stations || data.stops || data.locations || [];
  return list
    .filter((s) => s.name)
    .map((s) => ({
      id: s.id,
      name: s.name,
    }));
}

export async function fetchDeparturesGrouped() {
  if (!appState.stationId) {
    await resolveStationId();
  }

  // Limit response payload (Transport API supports fields[] across resources)
  const stationboardFields = [
    "stationboard/name",
    "stationboard/category",
    "stationboard/number",
    "stationboard/to",
    "stationboard/operator",
    "stationboard/stop/departure",
    "stationboard/stop/departureTimestamp",
    "stationboard/stop/platform",
    "stationboard/stop/delay",
    "stationboard/stop/prognosis/departure",
    "stationboard/stop/prognosis/arrival",
    "stationboard/stop/prognosis/platform",
  ];

  const fieldsQuery = stationboardFields
    .map((f) => `fields[]=${encodeURIComponent(f)}`)
    .join("&");

  const url = `https://transport.opendata.ch/v1/stationboard?station=${encodeURIComponent(
    appState.stationId
  )}&limit=300&${fieldsQuery}`;

  const data = await fetchJson(url, "stationboard");

  const now = new Date();
  const night = isNightWindow(now);

  const stationName = appState.STATION || "";
  const forceTrainStation = !stationName.includes(","); // règle: pas de virgule = gare -> trains uniquement

  const viewMode =
    appState.viewMode || (appState.stationIsMotte ? "down" : "grouped");

  const applyMotteFilter = appState.stationIsMotte && viewMode === "down";
  const chronoBus = viewMode === "chrono";

  const byLine = new Map();
  const allDeps = [];

  const busLines = new Set();

  let trainCount = 0;
  let busCount = 0;
  let busHasPlatform = false;

  // NEW: track which bus platforms exist on this board
  const busPlatforms = new Set();

  // Debug (early/late): limit how many rows we log per refresh
  let debugEarlyLogged = 0;
  const DEBUG_EARLY_MAX = 25;

  for (const entry of data.stationboard || []) {
    const rawNumber = entry.number ? String(entry.number) : "";
    const rawCategory = entry.category ? String(entry.category) : "";

    // Récupérer l'opérateur brut de l'API (peut être un objet ou une string)
    const rawOperator =
      (entry.operator &&
        (entry.operator.name || entry.operator.display || entry.operator)) ||
      entry.operator ||
      "";

    // Flag PostAuto (DE / FR / IT)
    const isPostBus = /PAG|postauto|carpostal|autopostale/i.test(rawOperator);

    let mode = classifyMode(rawCategory);

    // Si c'est une "gare" (nom sans virgule), on force tout en train en ignorant les bus
    if (forceTrainStation && mode === "bus") {
      continue; // on jette purement les bus de ce board
    }

    if (mode === "train") trainCount += 1;
    else busCount += 1;

    const dest = entry.to || "";

    // Debug: inspect operator string and PostAuto detection in console
    if (DEBUG_EARLY && rawOperator) {
      console.log("[MesDeparts] operator debug", {
        station: appState.STATION,
        line: `${rawCategory}${rawNumber}`.trim(),
        dest,
        rawOperator,
        isPostBus,
      });
    }

    const stop = entry.stop || {};
    const depRaw = stop.departure;
    if (!depRaw) continue;

    const scheduledDt = parseApiDate(depRaw);
    if (!scheduledDt) continue;

    // Heure de départ planifiée (horaire officiel) pour la colonne "Départ"
    const plannedTimeStr = scheduledDt.toLocaleTimeString("fr-CH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    let baseDt = scheduledDt;
    let delayMin = 0;
    let delaySource = "none";

    const prog = stop.prognosis || {};
    if (prog.departure) {
      const progDt = parseApiDate(prog.departure);
      if (progDt) {
        baseDt = progDt;
        delaySource = "prognosis";
        delayMin = Math.round(
          (baseDt.getTime() - scheduledDt.getTime()) / 60000
        );
      }
    } else if (typeof stop.delay === "number") {
      delayMin = stop.delay;
      delaySource = "delay";
      baseDt = new Date(scheduledDt.getTime() + delayMin * 60 * 1000);
    }

    if (DEBUG_EARLY && debugEarlyLogged < DEBUG_EARLY_MAX) {
      debugEarlyLogged += 1;
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
      });
    }

    // --- Calcul du décalage en minutes par rapport à l'heure temps réel ---
    const diffMs = baseDt.getTime() - now.getTime();
    const diffMinFloat = diffMs / 60000;

    const diffSecFloat = diffMs / 1000;

    // Pulse only for buses/trams/etc (your "bus" mode), in a tight window:
    //  - starts 15s BEFORE departure
    //  - continues 45s AFTER departure
    const showArrivalIcon =
      mode === "bus" &&
      diffSecFloat <= ARRIVAL_PULSE_BEFORE_SEC &&
      diffSecFloat >= -ARRIVAL_PULSE_AFTER_SEC;

    // Ne garder que les BUS/TRAM/METRO dans les 3 prochaines heures
    // (ne pas limiter les trains ici)
    if (mode === "bus" && diffMs > 3 * 60 * 60 * 1000) continue;

    // Règle d'affichage des minutes :
    //  - si > 1 minute: arrondi vers le haut (ceil)
    //  - entre 0 et 1 minute: on affiche encore "1"
    //  - à partir de baseDt (ou après): on affiche "0"
    let diffMin;
    if (diffMinFloat > 1) {
      diffMin = Math.ceil(diffMinFloat);
    } else if (diffMinFloat > 0) {
      diffMin = 1;
    } else {
      diffMin = 0;
    }

    // On ignore les véhicules déjà passés de plus d'une minute
    if (diffMinFloat < -1) continue;

    const platformRaw = stop.platform || "";
    const platformChanged = platformRaw.includes("!");
    const platform = platformRaw.replace("!", "");

    if (mode === "bus" && platform) {
      busHasPlatform = true;
      busPlatforms.add(platform);
    }

    // Si un filtre de quai est actif (et que "Descendre" est OFF), ne garder que les bus de ce quai
    if (!applyMotteFilter && appState.platformFilter && mode === "bus") {
      if (!platform || platform !== appState.platformFilter) {
        continue;
      }
    }

    let remark = "";
    let status = null; // "delay" | "early" | null

    // Statut temps réel: retard / en avance
    if (delayMin > 0) {
      const threshold =
        mode === "bus" ? BUS_DELAY_MIN_THRESHOLD : TRAIN_DELAY_MIN_THRESHOLD;

      // Only show "Retard" once we reach the threshold
      if (delayMin >= threshold) {
        if (mode === "bus") {
          // Bus / trams : texte court, sans minutes
          remark = "Retard";
        } else {
          // Trains : garder la forme détaillée avec minutes
          remark = `Retard env. ${delayMin} min`;
        }
        status = "delay";
      } else {
        // Under threshold: no delay wording/styling
        remark = "";
        status = null;
      }
    } else if (delayMin < 0) {
      // En avance
      if (mode === "bus") {
        // Bus / trams : explicite et cohérent
        remark = `-${Math.abs(delayMin)} min`;
        status = "early";
      } else {
        // Trains : ne pas afficher l'avance (pas de statut, pas de texte)
        remark = "";
        status = null;
      }
    }

    // Normalise a "simple" line id used for:
    //  - CSS classes (.line-3, .line-N1, etc.)
    //  - Motte filter (3 / 8 / 18 / N1)
    //  - line dropdown
    let simpleLineId = "";

    const trimmedNumber = rawNumber ? rawNumber.trim() : "";

    if (trimmedNumber && /^[0-9]+$/.test(trimmedNumber)) {
      // Purely numeric → strip leading zeros ("003" → "3")
      const n = parseInt(trimmedNumber, 10);
      simpleLineId = Number.isNaN(n) ? trimmedNumber : String(n);
    } else if (
      trimmedNumber &&
      /^[A-Za-z]+0*[0-9]+$/.test(trimmedNumber) &&
      !/[+]/.test(trimmedNumber)
    ) {
      // Letter+digits without special chars (e.g. "N01" → "N1")
      const match = trimmedNumber.match(/^([A-Za-z]+)0*([0-9]+)$/);
      if (match) {
        const prefix = match[1].toUpperCase();
        const numInt = parseInt(match[2], 10);
        const numStr = Number.isNaN(numInt) ? match[2] : String(numInt);
        simpleLineId = `${prefix}${numStr}`;
      } else {
        simpleLineId = trimmedNumber;
      }
    } else if (trimmedNumber) {
      // Contains letters / symbols (N1, E+, G+, etc.): keep as-is
      simpleLineId = trimmedNumber;
    } else if (rawCategory) {
      // Fallback: at least something, e.g. "M" for metro
      simpleLineId = rawCategory.trim();
    } else {
      simpleLineId = "";
    }

    if (applyMotteFilter && appState.stationIsMotte && mode === "bus") {
      if (!passesMotteFilter(simpleLineId, dest, night)) {
        continue;
      }
    }

    const depObj = {
      // Train / line label (for trains we’ll prefer `name` in the UI)
      line: `${rawCategory}${rawNumber}`.trim(),
      name: entry.name || "",

      category: rawCategory,
      number: rawNumber,
      mode,
      simpleLineId,
      dest,
      platform,
      platformChanged,
      inMin: Math.max(diffMin, 0),
      showArrivalIcon,
      // Affiche toujours l'heure planifiée dans la colonne "Départ"
      timeStr: plannedTimeStr,
      // Mais tri et minutes restent basés sur l'heure temps réel (baseDt)
      baseTime: baseDt.getTime(),
      scheduledTime: scheduledDt.getTime(),
      realtimeTime: baseDt.getTime(),
      delaySource, // "prognosis" | "delay" | "none"
      delayMin, // retard (positif) ou avance (négatif) vs horaire planifié
      status, // "delay" (retard), "early" (en avance) ou null
      remark,

      // Infos opérateur (pour styliser les bus postaux en jaune)
      operator: rawOperator || null,
      isPostBus,
    };

    allDeps.push(depObj);

    if (mode === "bus") {
      // Garder la liste des lignes de bus réellement affichées
      busLines.add(simpleLineId);

      // Groupement standard: par numéro de ligne simple
      const groupKey = simpleLineId || depObj.line;
      if (!byLine.has(groupKey)) byLine.set(groupKey, []);
      byLine.get(groupKey).push(depObj);
    }
  }

  appState.lastBoardHasBus = busCount > 0;
  appState.lastBoardHasBusPlatform = busHasPlatform;
  const isTrainBoard = trainCount > 0 && busCount === 0;
  appState.lastBoardIsTrain = isTrainBoard;

  // Stocker les options de quais et de lignes (remplies côté UI)
  appState.platformOptions = Array.from(busPlatforms);
  appState.lineOptions = Array.from(busLines);

  if (isTrainBoard) {
    const sorted = allDeps
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime)
      .slice(0, MAX_TRAIN_ROWS);
    return sorted;
  }

  // Heurelogical view for bus/tram/metro boards
  if (chronoBus) {
    const sortedBus = allDeps
      .filter((d) => d.mode === "bus")
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime);

    // Show the next departures chronologically (use MIN_ROWS as your visible size)
    return sortedBus.slice(0, MIN_ROWS);
  }

  // Si un filtre de ligne est actif (et que "Descendre" est OFF), renvoyer directement les MIN_ROWS prochains départs de cette ligne
  if (!applyMotteFilter && appState.lineFilter) {
    const selected = allDeps
      .filter((d) => d.mode === "bus" && d.simpleLineId === appState.lineFilter)
      .sort((a, b) => a.baseTime - b.baseTime)
      .slice(0, MIN_ROWS);

    return selected;
  }

  const flat = [];
  let lineKeys;

  if (applyMotteFilter && appState.stationIsMotte) {
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

  // Nouveau: on ne limite plus le nombre de lignes de bus affichées ici
  for (const key of lineKeys) {
    const deps = byLine.get(key) || [];
    for (const d of deps.slice(0, DEPS_PER_LINE)) {
      flat.push(d);
    }
  }

  // only use the MIN_ROWS fallback when there is NO user filter
  const hasUserFilter = !!appState.platformFilter || !!appState.lineFilter;

  if (
    flat.length < MIN_ROWS &&
    !hasUserFilter && // NEW: don’t override when filtered
    !(applyMotteFilter && appState.stationIsMotte)
  ) {
    const sortedAll = allDeps.slice().sort((a, b) => a.baseTime - b.baseTime);
    return sortedAll.slice(0, MIN_ROWS);
  }

  return flat;
}