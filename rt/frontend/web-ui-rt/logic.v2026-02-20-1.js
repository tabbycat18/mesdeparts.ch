// logic.js
// --------------------------------------------------------
// Helpers: time / classification / filters / API
// --------------------------------------------------------

import {
  appState,
  DEPS_PER_LINE,
  SMALL_STOP_MAX_LINES,
  SMALL_STOP_DEPS_PER_DIRECTION,
  SMALL_STOP_MAX_ROWS,
  MIN_ROWS,
  MAX_TRAIN_ROWS,
  BOARD_HORIZON_MINUTES,
  ARRIVAL_LEAD_SECONDS,
  DEPARTED_GRACE_SECONDS,
  CHRONO_VIEW_MIN_MINUTES,
  DEBUG_EARLY,
  VIEW_MODE_TIME,
  VIEW_MODE_LINE,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
  STATION_ID_STORAGE_KEY,
} from "./state.v2026-02-20-1.js";
import { t } from "./i18n.v2026-02-20-1.js";

// API base can be overridden by setting window.__MD_API_BASE__ before scripts load.
// Frontend now targets rt/backend endpoints only.
function defaultApiBase() {
  if (typeof window === "undefined") return "";
  const host = String(window.location.hostname || "").toLowerCase();

  if (host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:3001";
  }

  // Production static frontend (mesdeparts.ch) proxies API via Cloudflare Worker.
  if (host === "mesdeparts.ch" || host === "www.mesdeparts.ch") {
    return "https://api.mesdeparts.ch";
  }

  // Fallback to same-origin on non-production hosts.
  return "";
}

const BACKEND_API_BASE =
  (typeof window !== "undefined" && window.__MD_API_BASE__) || defaultApiBase();

function getApiBase() {
  return String(BACKEND_API_BASE || "").replace(/\/$/, "");
}

const apiUrl = (pathAndQuery) => `${getApiBase()}${pathAndQuery}`;
const SUPPORTED_QUERY_LANGS = new Set(["fr", "de", "it", "en"]);

// Keep stationboard requests bounded to what the UI can display
const STATIONBOARD_LIMIT = Math.max(MAX_TRAIN_ROWS * 2, MIN_ROWS * 3, 60);

function isDeltaDiagnosticsEnabled() {
  if (DEBUG_EARLY) return true;
  if (typeof window === "undefined") return false;
  try {
    if (window.__MD_DEBUG_DELTA__ === true) return true;
    return window.localStorage?.getItem("mesdeparts.debug.delta") === "1";
  } catch {
    return false;
  }
}

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

function isRegionalTrainCategory(category) {
  const cat = (category || "").toUpperCase().trim();
  return cat === "S" || cat === "R";
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

  // Nyon / TPN
  const isNyon = /nyon|rolle|gland|st-cergue|prangins|tpn\b/.test(n);
  if (isNyon) return "tpn";

  // Morges / MBC
  const isMorges = /morges|cossonay|bi[eè]re|mbc\b/.test(n);
  if (isMorges) return "mbc";

  // Riviera / VMCV
  const isRiviera =
    /vevey|montreux|clarens|villeneuve|rennaz|blonay|vmcv\b/.test(n);
  if (isRiviera) return "vmcv";

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
  if (
    /\btpn\b|transports publics nyonnais|transports publics de la r[ée]gion nyonnaise|nyonnaise/.test(op)
  ) return "tpn";
  if (/\bmbc\b|morges-bière|morges-biere|cossonay/.test(op)) return "mbc";
  if (/\bvmcv\b|vevey-montreux/.test(op)) return "vmcv";

  return "";
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

function parseDateLike(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept both seconds and milliseconds timestamps.
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string" && value.trim()) {
    return parseApiDate(value);
  }
  return null;
}

function toFiniteMinutesOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Shared realtime delta computation: signed minutes (late positive, early negative).
export function computeDeltaMinutes(plannedTime, realtimeTime) {
  const planned = parseDateLike(plannedTime);
  const realtime = parseDateLike(realtimeTime);
  if (!planned || !realtime) return null;
  return Math.round((realtime.getTime() - planned.getTime()) / 60000);
}

function resolveRealtimeDelta({
  plannedTime,
  realtimeTime,
  authoritativeDelayMin,
}) {
  const planned = parseDateLike(plannedTime);
  const realtime = parseDateLike(realtimeTime);
  const computedDeltaSec =
    planned && realtime
      ? (realtime.getTime() - planned.getTime()) / 1000
      : null;
  const apiDelayMin = toFiniteMinutesOrNull(authoritativeDelayMin);
  const computedDeltaMin =
    computedDeltaSec != null
      ? Math.round(computedDeltaSec / 60)
      : null;

  // Prefer authoritative API delay, except when API reports 0 while timestamps show
  // an actual early departure; keep that early signal for bus cosmetics/countdown.
  const shouldTrustTimestampEarly =
    apiDelayMin === 0 &&
    computedDeltaMin != null &&
    computedDeltaMin < 0;
  const deltaMin =
    shouldTrustTimestampEarly
      ? computedDeltaMin
      : apiDelayMin != null
        ? apiDelayMin
        : computedDeltaMin;
  const effectiveDeltaSec =
    shouldTrustTimestampEarly
      ? computedDeltaSec
      : apiDelayMin != null
        ? apiDelayMin * 60
        : computedDeltaSec;
  const delayMin = deltaMin != null ? Math.max(0, deltaMin) : 0;
  const earlyMin = deltaMin != null ? Math.max(0, -deltaMin) : 0;

  return {
    deltaMin,
    effectiveDeltaSec,
    delayMin,
    earlyMin,
    apiDelayMin,
    computedDeltaSec,
    computedDeltaMin,
    source:
      shouldTrustTimestampEarly
        ? "timestamps"
        : apiDelayMin != null
          ? "api_delay"
          : computedDeltaMin != null
            ? "timestamps"
            : "none",
  };
}

function deriveRealtimeRemark({ cancelled, delayMin, earlyMin, effectiveDeltaSec, mode }) {
  if (cancelled) {
    const msg = t("remarkCancelled");
    return { status: "cancelled", remarkWide: msg, remarkNarrow: msg, remark: msg };
  }

  // Bus/tram/metro board rule:
  // keep delay format plain (no minute count for buses).
  if (mode === "bus") {
    if (delayMin > 1) {
      const msg = t("remarkDelayShort"); // plain "Retard" — no minutes for buses
      return { status: "delay", remarkWide: msg, remarkNarrow: msg, remark: msg };
    }
    if (earlyMin > 0 || (Number.isFinite(effectiveDeltaSec) && effectiveDeltaSec < 0)) {
      const msg = t("remarkEarly");
      return { status: "early", remarkWide: msg, remarkNarrow: msg, remark: msg };
    }
    return { status: null, remarkWide: "", remarkNarrow: "", remark: "" };
  }

  if (earlyMin > 0 || (Number.isFinite(effectiveDeltaSec) && effectiveDeltaSec < 0)) {
    const msg = t("remarkEarly");
    return { status: "early", remarkWide: msg, remarkNarrow: msg, remark: msg };
  }

  // Train/rail delay rule: suppress +1 min jitter; show from +2 min.
  if (delayMin >= 2) {
    // WIDE: "Retard env. X min" / NARROW: "+X min" (numeric-only, no word prefix)
    const wide = t("remarkDelayTrainApprox").replace("{min}", String(delayMin));
    const narrow = `+${delayMin} min`;
    return { status: "delay", remarkWide: wide, remarkNarrow: narrow, remark: wide };
  }
  // delayMin < 2 — suppress for trains
  return { status: null, remarkWide: "", remarkNarrow: "", remark: "" };
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchJson(url, { signal, timeoutMs = FETCH_TIMEOUT_MS, cache = "default" } = {}) {
  const controller = new AbortController();
  const timeout =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? setTimeout(() => controller.abort(new DOMException("Timeout", "AbortError")), timeoutMs)
      : null;

  const forwardAbort = () => controller.abort(signal?.reason || new DOMException("Aborted", "AbortError"));
  if (signal) {
    if (signal.aborted) {
      forwardAbort();
    } else {
      signal.addEventListener("abort", forwardAbort);
    }
  }

  try {
    const res = await fetch(url, { signal: controller.signal, cache });
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch (_) {}
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `\n${body.slice(0, 300)}` : ""}`);
      err.status = res.status;
      err.statusText = res.statusText;
      err.url = url;
      err.body = body ? body.slice(0, 300) : "";
      throw err;
    }
    return res.json();
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

export function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("abort");
}

function isTimeoutError(err) {
  return err instanceof DOMException && err.name === "AbortError" && err.message === "Timeout";
}

function isTransientFetchError(err) {
  return isAbortError(err) || isTimeoutError(err);
}

// --------------------------------------------------------
// Connections helpers (for route/passList details)
// --------------------------------------------------------

function toCHDateYYYYMMDD(ms) {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

function toCHTimeHHMM(ms) {
  return new Date(ms).toLocaleTimeString("fr-CH", {
    timeZone: "Europe/Zurich",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function normalizeCat(c) {
  const s = String(c || "").trim().toUpperCase();
  if (s === "B") return "BUS";
  return s;
}

function normalizeLineToken(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return String(parseInt(compact, 10));
  return compact;
}

function lineLooksLike(dep, journey) {
  const depNum = normalizeLineToken(dep?.number || dep?.simpleLineId || dep?.line);
  const jNum = normalizeLineToken(journey?.number);
  if (depNum) {
    // For bus/tram rows, unknown journey numbers are too ambiguous on mixed hubs.
    if (dep?.mode === "bus" && !jNum) return false;
    if (jNum && depNum !== jNum) return false;
  }

  const depCat = normalizeCat(dep?.category);
  const jCat = normalizeCat(journey?.category);
  if (dep?.mode === "bus" && classifyMode(jCat) === "train") return false;
  if (dep?.mode === "train" && depCat && jCat && depCat !== jCat) return false;
  return true;
}

function buildSectionFromPassList(passList, journey = null) {
  if (!Array.isArray(passList) || passList.length === 0) return null;
  const first = passList[0] || {};
  const last = passList[passList.length - 1] || {};
  return {
    journey: { ...(journey || {}), passList },
    departure: first.stop || first || null,
    arrival: last.stop || last || null,
  };
}

function passListContainsStation(passList, stationId, stationName) {
  if (!Array.isArray(passList) || passList.length === 0) return false;

  const targetId = stationId ? String(stationId).trim() : "";
  const targetName = (stationName || "").split(",")[0].trim().toLowerCase();

  return passList.some((item) => {
    const stop = item?.stop || item || {};
    const ids = [
      stop.station?.id,
      stop.location?.id,
      stop.id,
      stop.stop?.station?.id,
      stop.stop?.id,
    ]
      .map((v) => (v ? String(v).trim() : ""))
      .filter(Boolean);

    const names = [
      stop.station?.name,
      stop.name,
      stop.stop?.name,
    ]
      .map((v) => (v ? String(v).trim().toLowerCase() : ""))
      .filter(Boolean);

    const idMatch = targetId && ids.some((id) => id === targetId);
    const nameMatch = targetName && names.some((n) => n === targetName);
    return idMatch || nameMatch;
  });
}

// --------------------------------------------------------
// API : stations & stationboard
// --------------------------------------------------------

export async function resolveStationId() {
  const url = apiUrl(`/api/stops/search?q=${encodeURIComponent(appState.STATION)}&limit=7`);
  const data = await fetchJson(url);
  const list = Array.isArray(data?.stops) ? data.stops : [];
  if (!list.length) throw new Error("No station found");

  const normalizeName = (name) => String(name || "").trim().toLowerCase();
  const targetName = normalizeName(appState.STATION);

  // Prefer exact name matches when present; fallback to first API result
  const best =
    list.find((s) => normalizeName(s?.stop_name) === targetName) ||
    list[0];

  appState.stationId = String(best.stop_id || "").trim();
  try {
    const name = typeof appState.STATION === "string" ? appState.STATION : "";
    localStorage.setItem(
      STATION_ID_STORAGE_KEY,
      JSON.stringify({ name, id: appState.stationId }),
    );
  } catch {
    // ignore storage errors
  }
  return appState.stationId;
}

export async function fetchStationSuggestions(query, { signal } = {}) {
  const url = apiUrl(`/api/stops/search?q=${encodeURIComponent(query)}&limit=7`);
  const data = await fetchJson(url, { signal, timeoutMs: 6_000 });

  const list = Array.isArray(data?.stops) ? data.stops : [];
  return list
    .filter((s) => s && s.stop_name && s.stop_id)
    .map((s) => ({ id: s.stop_id, name: s.stop_name }));
}

export async function fetchStationsNearby(lat, lon, limit = 7) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    throw new Error("Invalid coordinates");
  }

  const url = apiUrl(
    `/api/stops/nearby?lat=${encodeURIComponent(latNum)}&lon=${encodeURIComponent(lonNum)}&limit=${encodeURIComponent(limit)}`,
  );
  const data = await fetchJson(url);

  const list = Array.isArray(data?.stops) ? data.stops : [];
  return list
    .filter((s) => s && s.stop_name && s.stop_id)
    .map((s) => ({
      id: s.stop_id,
      name: s.stop_name,
      distance:
        typeof s.distance_m === "number"
        ? s.distance_m
        : typeof s.distance_m === "string"
          ? Number(s.distance_m) || null
          : null,
    }));
}

function normalizeBackendStationboard(data) {
  const departures = Array.isArray(data?.departures) ? data.departures : [];
  const apiBanners = Array.isArray(data?.banners) ? data.banners : [];
  const fallbackBanners = [];
  const fallbackSeen = new Set();
  if (apiBanners.length === 0) {
    for (const dep of departures) {
      const depAlerts = Array.isArray(dep?.alerts) ? dep.alerts : [];
      for (const alert of depAlerts) {
        const severity = String(alert?.severity || "unknown").trim().toLowerCase() || "unknown";
        const header = String(alert?.header || alert?.headerText || "").trim();
        const description = String(alert?.description || alert?.descriptionText || "").trim();
        if (!header && !description) continue;
        const key = `${String(alert?.id || "")}|${severity}|${header}|${description}`;
        if (fallbackSeen.has(key)) continue;
        fallbackSeen.add(key);
        fallbackBanners.push({
          severity,
          header,
          description,
        });
      }
    }
  }
  const banners = apiBanners.length > 0 ? apiBanners : fallbackBanners;
  const stationId = String(data?.station?.id || appState.stationId || "").trim();
  const stationName = String(data?.station?.name || appState.STATION || "").trim();
  const station = { id: stationId, name: stationName };

  const stationboard = departures.map((dep) => {
    const scheduled = dep?.scheduledDeparture || dep?.realtimeDeparture || null;
    const realtime = dep?.realtimeDeparture || null;
    const delta = resolveRealtimeDelta({
      plannedTime: scheduled,
      realtimeTime: realtime,
      authoritativeDelayMin: dep?.delayMin,
    });
    const platformRaw = String(dep?.platform || "");
    const platform = dep?.platformChanged ? `!${platformRaw}` : platformRaw;
    const cancelled =
      dep?.cancelled === true ||
      dep?.canceled === true ||
      dep?.isCancelled === true ||
      dep?.cancellation === true;
    const scheduledMs = Date.parse(String(scheduled || ""));

    return {
      category: String(dep?.category || ""),
      number: String(dep?.number || ""),
      name: String(dep?.name || dep?.line || ""),
      operator: dep?.operator || "",
      to: String(dep?.destination || ""),
      source: String(dep?.source || ""),
      tags: Array.isArray(dep?.tags) ? dep.tags : [],
      cancelled,
      journey: dep?.trip_id ? { id: String(dep.trip_id) } : null,
      trip: dep?.trip_id ? { id: String(dep.trip_id) } : null,
      passList: [],
      stop: {
        station,
        departure: scheduled,
        departureTimestamp:
          Number.isFinite(scheduledMs) ? Math.floor(scheduledMs / 1000) : undefined,
        platform,
        delay: delta.deltaMin,
        cancelled,
        prognosis: {
          departure: realtime,
          delay: delta.deltaMin,
          status: String(dep?.status || (cancelled ? "CANCELED" : "")),
          cancelled,
          platform:
            dep?.prognosis?.platform ||
            dep?.stop?.prognosis?.platform ||
            dep?.prognosis?.departure?.platform ||
            null,
          capacity1st: dep?.prognosis?.capacity1st || null,
          capacity2nd: dep?.prognosis?.capacity2nd || null,
        },
      },
      prognosis: {
        status: String(dep?.status || (cancelled ? "CANCELED" : "")),
        cancelled,
      },
      _rtRaw: {
        "departure.scheduledDeparture": dep?.scheduledDeparture ?? null,
        "departure.realtimeDeparture": dep?.realtimeDeparture ?? null,
        "departure.delayMin": dep?.delayMin ?? null,
        "departure.status": dep?.status ?? null,
      },
    };
  });

  return { station, stationboard, banners };
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

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function hasCancelStatus(value) {
  const status = normalizeStatus(value);
  if (!status) return false;
  return (
    status === "cancel" ||
    status === "cancelled" ||
    status === "canceled" ||
    status.startsWith("cancelled_") ||
    status.startsWith("canceled_") ||
    status === "trip_cancelled" ||
    status === "trip_canceled" ||
    status === "cancelled_trip" ||
    status === "canceled_trip" ||
    status === "skipped_stop"
  );
}

function isCancelledEntry(entry, stop, prognosis) {
  if (stop?.cancelled === true || stop?.canceled === true) return true;
  if (prognosis?.cancelled === true || prognosis?.canceled === true) return true;
  if (entry?.cancelled === true || entry?.canceled === true) return true;
  if (entry?.prognosis?.cancelled === true || entry?.prognosis?.canceled === true) return true;

  if (hasCancelStatus(prognosis?.status)) return true;
  if (hasCancelStatus(stop?.status)) return true;
  if (hasCancelStatus(entry?.status)) return true;
  if (hasCancelStatus(entry?.prognosis?.status)) return true;

  return false;
}

function isInvalidStationboardError(err) {
  const status = typeof err?.status === "number" ? err.status : null;
  if (status === 400 || status === 404) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (!msg) return false;
  if (msg.includes("station") && msg.includes("not found")) return true;
  return msg.includes("404");
}

export async function fetchStationboardRaw(options = {}) {
  const { allowRetry = true, bustCache = false } = options;
  if (!appState.stationId) {
    await resolveStationId();
  }

  const stationKey = appState.stationId || "unknown";
  const requestLangRaw = String(appState.language || "").trim().toLowerCase();
  const requestLang = SUPPORTED_QUERY_LANGS.has(requestLangRaw) ? requestLangRaw : "fr";
  const inflightKey = `${getApiBase()}|${stationKey}|${requestLang}|${bustCache ? "bust" : "default"}`;

  if (!fetchStationboardRaw._inflight) {
    fetchStationboardRaw._inflight = new Map();
  }

  if (fetchStationboardRaw._inflight.has(inflightKey)) {
    return fetchStationboardRaw._inflight.get(inflightKey);
  }

  const params = new URLSearchParams({
    stop_id: stationKey,
    limit: String(STATIONBOARD_LIMIT),
    lang: requestLang,
  });
  if (bustCache) params.set("_ts", String(Date.now()));
  const url = apiUrl(`/api/stationboard?${params.toString()}`);
  const req = (async () => {
    try {
      const backendData = await fetchJson(url, { cache: bustCache ? "reload" : "default" });
      const data = normalizeBackendStationboard(backendData);

      const needsRetry =
        allowRetry &&
        appState.stationId &&
        (!data?.station || !data?.stationboard || data.stationboard.length === 0);

      if (needsRetry) {
        const badId = appState.stationId;
        try {
          appState.stationId = null;
          await resolveStationId();
          return await fetchStationboardRaw({ allowRetry: false });
        } catch (resolveErr) {
          console.warn("[MesDeparts] stationboard retry failed", {
            station: appState.STATION,
            badId,
            error: resolveErr?.message || String(resolveErr),
          });
        }
      }

      return data;
    } catch (err) {
      const canRetry =
        allowRetry &&
        appState.stationId &&
        isInvalidStationboardError(err);

      if (canRetry) {
        const badId = appState.stationId;
        try {
          appState.stationId = null;
          await resolveStationId();
          return await fetchStationboardRaw({ allowRetry: false });
        } catch (resolveErr) {
          console.warn("[MesDeparts] stationboard retry failed", {
            station: appState.STATION,
            badId,
            initialError: err?.message || String(err),
            retryError: resolveErr?.message || String(resolveErr),
          });
        }
      }
      throw err;
    } finally {
      fetchStationboardRaw._inflight.delete(inflightKey);
    }
  })();

  fetchStationboardRaw._inflight.set(inflightKey, req);
  return req;
}

export function stationboardLooksStale(data) {
  const list = Array.isArray(data?.stationboard) ? data.stationboard : [];
  if (!list.length) return false;

  const now = Date.now();
  const graceMs = DEPARTED_GRACE_SECONDS * 1000;

  return !list.some((entry) => {
    const stop = entry?.stop || {};
    const depStr =
      (stop.prognosis && stop.prognosis.departure) ||
      stop.departure ||
      (entry.prognosis && entry.prognosis.departure) ||
      null;

    let dep = parseApiDate(depStr);
    if (!dep && typeof stop.departureTimestamp === "number") {
      dep = new Date(stop.departureTimestamp * 1000);
    }

    if (!dep) return false;

    return dep.getTime() - now >= -graceMs;
  });
}

export function buildDeparturesGrouped(data, viewMode = VIEW_MODE_LINE) {
  const now = new Date();
  const night = isNightWindow(now);
  const stationboard = Array.isArray(data?.stationboard) ? data.stationboard : [];

  // Rule: no comma means “main station” -> show trains only
  const stationName = appState.STATION || "";
  const forceTrainStation = !stationName.includes(",");

  const applyMotteFilter = false; // Descendre mode removed
  const groupByLine = viewMode === VIEW_MODE_LINE;
  const chronoBuses = viewMode === VIEW_MODE_TIME;

  const byLine = new Map();
  const allDeps = [];
  const uniqueBusLinesBeforeUiFilters = new Set();
  const seenSyntheticReplacementRows = new Set();
  const busLines = new Set();
  const busPlatforms = new Set();
  const busNetworks = new Set();
  const lineNetworkMap = new Map();
  const lastPlatforms = appState.lastPlatforms || {};

  let trainCount = 0;
  let busCount = 0;
  let busHasPlatform = false;

  // Debug: limit how many rows we log per refresh
  let debugLogged = 0;
  const DEBUG_MAX = 25;

  const platformFilters = Array.isArray(appState.platformFilter)
    ? appState.platformFilter.filter(Boolean)
    : appState.platformFilter
      ? [appState.platformFilter]
      : [];

  const lineFilters = Array.isArray(appState.lineFilter)
    ? appState.lineFilter.filter(Boolean)
    : appState.lineFilter
      ? [appState.lineFilter]
      : [];

  const trainFilter = appState.trainServiceFilter || TRAIN_FILTER_ALL;

  for (const entry of stationboard) {
    const rawNumber = entry.number ? String(entry.number) : "";
    const rawCategory = entry.category ? String(entry.category) : "";
    const source = String(entry?.source || "").trim();
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];

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
    const replacementText = `${rawCategory} ${rawNumber} ${entry?.name || ""} ${
      entry?.to || ""
    } ${rawOperator}`.toLowerCase();
    const isReplacementBus =
      tags.includes("replacement") ||
      source === "synthetic_alert" ||
      /^EV/i.test(rawNumber) ||
      /\b(ev(?:\s*\d+)?|ersatz|replacement|remplacement|sostitutiv|substitute)\b/i.test(
        replacementText
      );

    // If this is a “station” board (no comma), ignore buses entirely
    if (forceTrainStation && mode === "bus" && !isReplacementBus) continue;

    if (mode === "train") trainCount += 1;
    else busCount += 1;

    if (mode === "train") {
      const isRegional = isRegionalTrainCategory(rawCategory);
      if (trainFilter === TRAIN_FILTER_REGIONAL && !isRegional) continue;
      if (trainFilter === TRAIN_FILTER_LONG_DISTANCE && isRegional) continue;
    }

    const dest = entry.to || "";
    const stop = entry.stop || {};
    const journeyId =
      (entry.journey && (entry.journey.id || entry.journey.name || entry.journey.journeyId)) ||
      (entry.trip && (entry.trip.id || entry.trip.name)) ||
      (stop.prognosis && (stop.prognosis.journeyId || stop.prognosis.tripId)) ||
      null;
    const depRaw = stop.departure;
    if (!depRaw) continue;

    const scheduledDt = parseApiDate(depRaw);
    if (!scheduledDt) continue;

    const plannedTimeStr = formatPlannedTime(scheduledDt);
    const prog = stop.prognosis || {};

    // --- realtime / delay computation (shared across operators/networks) ---
    let baseDt = scheduledDt;
    const realtimeDt = parseDateLike(prog.departure);
    const delta = resolveRealtimeDelta({
      plannedTime: scheduledDt,
      realtimeTime: realtimeDt || prog.departure || null,
      authoritativeDelayMin:
        stop?.delay ?? entry?.delayMin ?? prog?.delay ?? null,
    });
    const deltaMin = delta.deltaMin;
    const delayMin = delta.delayMin;
    const earlyMin = delta.earlyMin;
    const delaySource = delta.source;

    if (realtimeDt) {
      baseDt = realtimeDt;
    } else if (deltaMin != null) {
      baseDt = new Date(scheduledDt.getTime() + deltaMin * 60 * 1000);
    }

    // Debug: specifically log cases where realtime is earlier than scheduled
    if (DEBUG_EARLY && deltaMin != null && deltaMin < 0) {
      console.log("[MesDeparts][early-case]", {
        station: appState.STATION,
        mode,
        line: `${rawCategory}${rawNumber}`.trim(),
        to: dest,
        scheduledISO: scheduledDt.toISOString(),
        prognosisISO: baseDt.toISOString(),
        delayMin: deltaMin,
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

    const simpleLineId = normalizeSimpleLineId(rawNumber, rawCategory);
    const entryNetwork = detectNetworkFromEntry(entry);
    if (mode === "bus") {
      if (simpleLineId) uniqueBusLinesBeforeUiFilters.add(simpleLineId);
      busLines.add(simpleLineId);
      if (simpleLineId && !lineNetworkMap.has(simpleLineId)) {
        lineNetworkMap.set(simpleLineId, entryNetwork || appState.currentNetwork || "generic");
      }
    }

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
        apiDelay: toFiniteMinutesOrNull(stop.delay),
        computedDelayMin: delta.computedDeltaMin,
        effectiveDeltaMin: deltaMin,
        scheduledISO: scheduledDt.toISOString(),
        realtimeISO: baseDt.toISOString(),
        diffSec: Math.round(diffSec),
      });
    }

    const platformRaw = String(stop.platform || "");
    const isMarkedChanged = platformRaw.includes("!");
    const plannedPlatform = platformRaw.replace("!", "");
    const realtimePlatform = String(prog.platform || "").replace("!", "");
    const platform = realtimePlatform || plannedPlatform;
    const platformChanged = isMarkedChanged || !!(realtimePlatform && realtimePlatform !== plannedPlatform);
    const previousPlatform =
      journeyId && lastPlatforms[journeyId] && lastPlatforms[journeyId] !== platform
        ? lastPlatforms[journeyId]
        : null;
    const didChange = platformChanged || !!previousPlatform;

    if (mode === "bus" && platform) {
      busHasPlatform = true;
      busPlatforms.add(platform);
    }

    // platform filter applies only on bus boards, when not in Motte “down” view
    if (!applyMotteFilter && platformFilters.length && mode === "bus") {
      if (!platform || !platformFilters.includes(platform)) continue;
    }

    // Motte special filter (only in “down” view)
    if (applyMotteFilter && mode === "bus") {
      if (!passesMotteFilter(simpleLineId, dest, night)) continue;
    }

    // line filter applies only on bus boards, when not in Motte “down” view
    if (!applyMotteFilter && lineFilters.length && mode === "bus") {
      if (!lineFilters.includes(simpleLineId)) continue;
    }

    const isCancelled = isCancelledEntry(entry, stop, prog);
    const rtView = deriveRealtimeRemark({
      cancelled: isCancelled,
      delayMin,
      earlyMin,
      effectiveDeltaSec: delta.effectiveDeltaSec,
      mode,
    });
    const status = rtView.status;
    const remarkWide = rtView.remarkWide;
    const remarkNarrow = rtView.remarkNarrow;
    const remark = rtView.remark; // alias for remarkWide (backward compat)

    if (isDeltaDiagnosticsEnabled()) {
      // Per-row delay debug log — validate scheduled/rt dep, delayMin, mode, suppression
      const suppressed = !isCancelled && status !== "delay" && (delayMin > 0 || earlyMin > 0);
      console.log("[MesDeparts][delay-row]", {
        line: `${rawCategory}${rawNumber}`.trim(),
        mode,
        scheduledDep: scheduledDt.toISOString(),
        rtDep: realtimeDt ? realtimeDt.toISOString() : null,
        delayMin,
        earlyMin,
        suppressed,
        status,
        remarkWide,
        remarkNarrow,
      });

      console.log("[MesDeparts][rt-delta-row]", {
        stationId: appState.stationId || null,
        stationName: appState.STATION || null,
        operator: rawOperator || null,
        agency: entry?.agency || entry?.agency_name || null,
        mode,
        plannedDeparture: scheduledDt.toISOString(),
        realtimeDeparture: realtimeDt ? realtimeDt.toISOString() : null,
        cancelled: isCancelled,
        statusField: {
          entryStatus: entry?.status ?? null,
          stopStatus: stop?.status ?? null,
          prognosisStatus: prog?.status ?? null,
        },
        deltaMin,
        delayMin,
        earlyMin,
        renderStatus: status,
        renderRemarkWide: remarkWide,
        renderRemarkNarrow: remarkNarrow,
        delaySource,
        rawFieldsUsed: {
          "stop.departure": stop?.departure ?? null,
          "stop.prognosis.departure": prog?.departure ?? null,
          "stop.delay": stop?.delay ?? null,
          "entry.delayMin": entry?.delayMin ?? null,
          "entry.scheduledDeparture": entry?.scheduledDeparture ?? null,
          "entry.realtimeDeparture": entry?.realtimeDeparture ?? null,
          "entry.status": entry?.status ?? null,
          "stop.status": stop?.status ?? null,
          "stop.prognosis.status": prog?.status ?? null,
          "entry._rtRaw": entry?._rtRaw ?? null,
        },
      });
    }

    const depObj = {
      line: `${rawCategory}${rawNumber}`.trim(),
      name: entry.name || "",
      network: entryNetwork,

      category: rawCategory,
      number: rawNumber,
      mode,
      simpleLineId,
      dest,
      platform,
      platformChanged: didChange,
      previousPlatform,
      journeyId,
      passList: Array.isArray(entry.passList) ? entry.passList : null,

      // Column “Départ” always shows the planned time
      timeStr: plannedTimeStr,

      // countdown (bus boards only)
      inMin: Math.max(inMin, 0),

      // sorting / diagnostics
      baseTime: baseDt.getTime(),
      scheduledTime: scheduledDt.getTime(),
      realtimeTime: baseDt.getTime(),
      delaySource,
      delayMin: deltaMin,
      earlyMin,
      status,
      remark,       // alias for remarkWide (backward compat)
      remarkWide,
      remarkNarrow,

      // arrival icon window
      isArriving,

      // operator info (for PostAuto styling)
      operator: rawOperator || null,
      _debugNetwork: entryNetwork,
      isPostBus,
      source,
      tags,

      // details lookup helpers
      fromStationId: appState.stationId || null,
      fromStationName: appState.STATION || null,
      scheduledTimestamp:
        typeof stop.departureTimestamp === "number"
          ? stop.departureTimestamp
          : Math.floor(scheduledDt.getTime() / 1000),
    };

    if (source === "synthetic_alert" && isReplacementBus) {
      const dedupeKey = [
        depObj.line,
        depObj.dest,
        depObj.scheduledTimestamp,
        depObj.platform || "",
      ].join("|");
      if (seenSyntheticReplacementRows.has(dedupeKey)) continue;
      seenSyntheticReplacementRows.add(dedupeKey);
    }

    if (journeyId && platform) {
      lastPlatforms[journeyId] = platform;
    }

    allDeps.push(depObj);

    if (mode === "bus") {
      if (entryNetwork) busNetworks.add(entryNetwork.toLowerCase());

      const groupKey = simpleLineId || depObj.line;
      if (!byLine.has(groupKey)) byLine.set(groupKey, []);
      byLine.get(groupKey).push(depObj);
    }
  }

  // Board metadata for UI
  appState.lastBoardHasBus = busCount > 0;
  appState.lastBoardHasBusPlatform = busHasPlatform;
  appState.lastBoardNetwork =
    busNetworks.size > 0 ? Array.from(busNetworks)[0] : appState.currentNetwork || "generic";
  const isTrainBoard = trainCount > 0 && (busCount === 0 || forceTrainStation);
  appState.lastBoardIsTrain = isTrainBoard;

  appState.platformOptions = Array.from(busPlatforms);
  appState.lineOptions = Array.from(busLines);
  appState.lineNetworks = Object.fromEntries(lineNetworkMap);

  const lineDestComparator = (a, b) => {
    const num = (x) => {
      const m = String(x || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : Number.POSITIVE_INFINITY;
    };

    const keyA = a.simpleLineId || a.line || "";
    const keyB = b.simpleLineId || b.line || "";
    const numA = num(keyA);
    const numB = num(keyB);
    if (numA !== numB) return numA - numB;

    const lineCmp = keyA.localeCompare(keyB, "fr-CH");
    if (lineCmp !== 0) return lineCmp;

    const destCmp = (a.dest || "").localeCompare(b.dest || "", "fr-CH");
    if (destCmp !== 0) return destCmp;

    return (a.baseTime || 0) - (b.baseTime || 0);
  };


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
    const nowMs = Date.now();
    const chronoMinRows = Math.ceil(MIN_ROWS * 4 / 3);
    const sortedBuses = allDeps
      .filter((d) => d.mode === "bus")
      .slice()
      .sort((a, b) => a.baseTime - b.baseTime);

    const horizonMs = CHRONO_VIEW_MIN_MINUTES * 60 * 1000;
    const withinHorizon = sortedBuses.filter((d) => (d.baseTime || 0) - nowMs <= horizonMs);

    if (withinHorizon.length >= chronoMinRows) {
      return withinHorizon;
    }

    return sortedBuses.slice(0, Math.max(chronoMinRows, withinHorizon.length));
  }

  // Group-by-line view (default)
  let lineKeys;

  lineKeys = Array.from(byLine.keys()).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return a.localeCompare(b, "fr-CH");
  });

  const perLineCap = Math.max(1, DEPS_PER_LINE);
  const perDirectionCap = Math.max(1, SMALL_STOP_DEPS_PER_DIRECTION);
  const smallStopMaxRows = Math.max(1, SMALL_STOP_MAX_ROWS);
  const isSmallStopBoard =
    uniqueBusLinesBeforeUiFilters.size > 0 &&
    uniqueBusLinesBeforeUiFilters.size <= Math.max(1, SMALL_STOP_MAX_LINES);

  const balancedByDest = (deps, limit) => {
    const buckets = new Map();
    for (const d of deps) {
      const key = String(d?.dest || "").trim();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }

    for (const arr of buckets.values()) {
      arr.sort((a, b) => (a.baseTime || 0) - (b.baseTime || 0));
    }

    const queue = Array.from(buckets.entries())
      .map(([dest, list]) => ({
        dest,
        list,
        nextTime: list[0] ? list[0].baseTime || 0 : Infinity,
      }))
      .sort((a, b) => a.nextTime - b.nextTime || a.dest.localeCompare(b.dest, "fr-CH"));

    const out = [];
    while (out.length < limit && queue.length) {
      const cur = queue.shift();
      const item = cur.list.shift();
      if (item) out.push(item);
      if (cur.list.length) {
        cur.nextTime = cur.list[0].baseTime || 0;
        queue.push(cur);
        queue.sort((a, b) => a.nextTime - b.nextTime || a.dest.localeCompare(b.dest, "fr-CH"));
      }
    }

    return out;
  };

  const selectPerDirection = (deps, directionCap) => {
    const buckets = new Map();
    for (const d of deps) {
      const key = String(d?.dest || "").trim();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }

    const out = [];
    for (const arr of buckets.values()) {
      arr.sort((a, b) => (a.baseTime || 0) - (b.baseTime || 0));
      for (const dep of arr.slice(0, directionCap)) out.push(dep);
    }
    out.sort((a, b) => (a.baseTime || 0) - (b.baseTime || 0));
    return out;
  };

  const isDelayedDeparture = (dep) =>
    dep?.status === "delay" && typeof dep?.delayMin === "number" && dep.delayMin > 0;

  const preserveLineDelayVisibility = (selected, deps, limit) => {
    const out = Array.isArray(selected) ? selected.slice() : [];
    if (!deps?.length || out.some(isDelayedDeparture)) return out;

    const delayedCandidates = deps.filter(isDelayedDeparture);
    if (!delayedCandidates.length) return out;

    const keyOf = (dep) =>
      `${dep?.journeyId || ""}|${dep?.line || ""}|${dep?.dest || ""}|${dep?.scheduledTime || ""}`;
    const selectedKeys = new Set(out.map((dep) => keyOf(dep)));
    const candidate = delayedCandidates.find((dep) => !selectedKeys.has(keyOf(dep))) || delayedCandidates[0];
    if (!candidate) return out;

    if (out.length < limit) {
      out.push(candidate);
    } else {
      let replaceIdx = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (!isDelayedDeparture(out[i])) {
          replaceIdx = i;
          break;
        }
      }
      if (replaceIdx === -1) return out;
      out[replaceIdx] = candidate;
    }

    out.sort((a, b) => (a.baseTime || 0) - (b.baseTime || 0));
    return out;
  };

  const selectedByLine = new Map();
  for (const key of lineKeys) {
    const deps = (byLine.get(key) || []).slice().sort((a, b) => a.baseTime - b.baseTime);
    const initiallySelected = isSmallStopBoard
      ? selectPerDirection(deps, perDirectionCap)
      : balancedByDest(deps, perLineCap);
    const selectionCap = isSmallStopBoard ? initiallySelected.length : perLineCap;
    const selected = preserveLineDelayVisibility(initiallySelected, deps, selectionCap);
    selectedByLine.set(key, selected);
  }

  if (!isSmallStopBoard) {
    const flat = [];
    for (const key of lineKeys) {
      for (const dep of selectedByLine.get(key) || []) flat.push(dep);
    }
    return flat.sort(lineDestComparator);
  }

  // Small-stop mode: apply a fair global cap with round-robin picks across lines.
  const flat = [];
  const lineCursor = new Map(lineKeys.map((key) => [key, 0]));
  while (flat.length < smallStopMaxRows) {
    let pickedAny = false;
    for (const key of lineKeys) {
      const selected = selectedByLine.get(key) || [];
      const cursor = lineCursor.get(key) || 0;
      if (cursor >= selected.length) continue;
      flat.push(selected[cursor]);
      lineCursor.set(key, cursor + 1);
      pickedAny = true;
      if (flat.length >= smallStopMaxRows) break;
    }
    if (!pickedAny) break;
  }

  return flat.sort(lineDestComparator);
}

export async function fetchDeparturesGrouped(viewMode = VIEW_MODE_LINE) {
  const data = await fetchStationboardRaw();
  return buildDeparturesGrouped(data, viewMode);
}

async function fetchJourneyDetailsById(journeyId, { signal } = {}) {
  if (!journeyId) return null;
  const url = apiUrl(`/api/journey?id=${encodeURIComponent(journeyId)}&passlist=1`);
  try {
    const data = await fetchJson(url, { signal });
    const journey = data?.journey || data;
    const passList = journey?.passList || data?.passList;
    const section = buildSectionFromPassList(passList, journey);
    if (!section) return null;
    return { section, connection: null };
  } catch (_) {
    return null;
  }
}

// Journey details for a specific trip (bus or train) via /connections
export async function fetchJourneyDetails(dep, { signal } = {}) {
  if (!dep) throw new Error("fetchJourneyDetails: missing dep");

  const fromStationId = dep.fromStationId || appState.stationId || null;
  const fromStationName = dep.fromStationName || appState.STATION || "";
  const to = dep.dest;

  const passList = Array.isArray(dep?.passList) ? dep.passList : null;
  const directSection = buildSectionFromPassList(passList);
  const hasOriginInPassList = passListContainsStation(
    passList,
    fromStationId,
    fromStationName
  );
  const isTrain = dep.mode === "train";

  // Stationboard train passLists sometimes omit the queried station; in that case,
  // prefer fetching fresh details instead of trusting incomplete cached data.
  const directFallback =
    directSection && hasOriginInPassList ? { section: directSection, connection: null } : null;

  // For buses/trams, keep using the stationboard passList when it looks valid.
  // For trains, only use it as a fallback if live lookups fail (to avoid stale/partial data).
  if (!isTrain && directFallback) {
    return { section: directSection, connection: null };
  }

  const from = fromStationId || fromStationName;
  if (!from || !to) throw new Error("fetchJourneyDetails: missing from/to");

  const tMs = dep.scheduledTime || dep.baseTime || Date.now();
  const dt = new Date(tMs);
  if (Number.isNaN(dt.getTime())) throw new Error("fetchJourneyDetails: invalid scheduledTime");

  // Use CH timezone helpers to avoid UTC day-shift around midnight
  const date = toCHDateYYYYMMDD(dt.getTime());
  const time = toCHTimeHHMM(dt.getTime());

  async function fetchConnections(fromParam) {
    const url =
      apiUrl("/api/connections") +
      `?from=${encodeURIComponent(fromParam)}` +
      `&to=${encodeURIComponent(to)}` +
      `&date=${encodeURIComponent(date)}` +
      `&time=${encodeURIComponent(time)}` +
      `&limit=6`;
    return fetchJson(url, { signal });
  }

  let data = await fetchConnections(from);
  let conns = data?.connections || [];

  // Parent station IDs may return no matches on /connections; retry with station name.
  if (
    (!Array.isArray(conns) || conns.length === 0) &&
    fromStationName &&
    String(fromStationName).trim() &&
    String(from) !== String(fromStationName)
  ) {
    data = await fetchConnections(fromStationName);
    conns = data?.connections || [];
  }

  const targetTs =
    typeof dep.scheduledTimestamp === "number"
      ? dep.scheduledTimestamp
      : Math.floor(tMs / 1000);

  let bestSection = null;
  let bestConn = null;
  let bestScore = Infinity;
  let bestStrictSection = null;
  let bestStrictConn = null;
  let bestStrictScore = Infinity;

  for (const conn of conns) {
    for (const section of conn?.sections || []) {
      const j = section?.journey;
      const depTs = section?.departure?.departureTimestamp;
      if (typeof depTs !== "number") continue;

      const hasFromStation = passListContainsStation(
        section?.journey?.passList,
        fromStationId,
        fromStationName
      );

      const relaxedScore =
        Math.abs(depTs - targetTs) +
        (lineLooksLike(dep, j) ? 0 : 3600) +
        (hasFromStation ? 0 : 7200);
      if (relaxedScore < bestScore) {
        bestScore = relaxedScore;
        bestSection = section;
        bestConn = conn;
      }

      const strictMatch =
        lineLooksLike(dep, j) &&
        (dep.mode !== "bus" || classifyMode(j?.category || "") === "bus");
      if (!strictMatch) continue;
      const strictScore = Math.abs(depTs - targetTs) + (hasFromStation ? 0 : 7200);
      if (strictScore < bestStrictScore) {
        bestStrictScore = strictScore;
        bestStrictSection = section;
        bestStrictConn = conn;
      }
    }
  }

  if (bestStrictSection) {
    bestSection = bestStrictSection;
    bestConn = bestStrictConn;
  }

  if (!bestSection) throw new Error("No journey details available for this départ");

  const bestPassList = bestSection?.journey?.passList;
  if (
    (!Array.isArray(bestPassList) || bestPassList.length === 0) &&
    bestSection?.journey?.id
  ) {
    const viaId = await fetchJourneyDetailsById(bestSection.journey.id);
    if (viaId) return viaId;
  }

  if (bestSection) {
    return { section: bestSection, connection: bestConn };
  }

  if (directFallback) return directFallback;

  throw new Error("No journey details available for this départ");
}
