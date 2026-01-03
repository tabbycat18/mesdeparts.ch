// main.js
// --------------------------------------------------------
// App bootstrap + refresh loop
// --------------------------------------------------------

import {
  appState,
  DEFAULT_STATION,
  REFRESH_DEPARTURES,
  REFRESH_DIRECT,
  DEBUG_FORCE_NOW,
  VIEW_MODE_LINE,
  VIEW_MODE_TIME,
  API_MODE_BOARD,
  API_MODE_DIRECT,
  API_MODE_STORAGE_KEY,
  API_MODE_AUTO_OFF_KEY,
  API_MODE_AUTO_SWITCH_MS,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
  DEFAULT_STATION_ID,
  STATION_ID_STORAGE_KEY,
} from "./rt-state.js";

import {
  detectNetworkFromStation,
  resolveStationId,
  fetchStationboardRaw,
  buildDeparturesGrouped,
} from "./rt-logic.js";

import {
  setupClock,
  setupQuickControlsCollapse,
  setupViewToggle,
  setupFilters,
  setupBoardModeToggle,
  refreshBoardModeToggleUi,
  maybeShowBoardModePopover,
  renderFilterOptions,
  setupStationSearch,
  updateStationTitle,
  renderDepartures,
  setBoardLoadingState,
  ensureBoardFitsViewport,
  setupAutoFitWatcher,
  publishEmbedState,
  updateCountdownRows,
} from "./ui.v2026-01-04.js";

import { setupInfoButton } from "./infoBTN.v2026-01-04.js";
import { initI18n, applyStaticTranslations, setLanguage, LANGUAGE_OPTIONS } from "./i18n.v2026-01-04.js";

// Persist station between reloads
const STORAGE_KEY = "mesdeparts.station";
// Legacy wrong default id (Genève Cornavin) that was used for “Lausanne, motte”
const LEGACY_DEFAULT_STATION_ID = "8587057";
const DEFAULT_API_MODE = API_MODE_BOARD;
const COUNTDOWN_REFRESH_MS = 5_000;
const DEBUG_PERF =
  (() => {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return params.get("debugPerf") === "1" || window.DEBUG_PERF === true;
    } catch {
      return false;
    }
  })() && typeof performance !== "undefined";

const defer = (fn) => {
  if (typeof fn !== "function") return;
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(
      () => {
        try {
          fn();
        } catch (err) {
          console.error("[MesDeparts][defer] error", err);
        }
      },
      { timeout: 500 },
    );
    return;
  }
  setTimeout(() => {
    try {
      fn();
    } catch (err) {
      console.error("[MesDeparts][defer] error", err);
    }
  }, 0);
};

function logPerf(label, data) {
  if (!DEBUG_PERF) return;
  const pretty = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v]),
  );
  // eslint-disable-next-line no-console
  console.log(`[MesDeparts][perf] ${label}`, pretty);
}

const isDualEmbed = () =>
  document.documentElement.classList.contains("dual-embed") ||
  document.body?.classList.contains("dual-embed");

function loadClockIframe() {
  const clock = document.querySelector(".cff-clock[data-clock-src]");
  if (!clock) return;
  if (clock.getAttribute("src")) return;
  const src = clock.getAttribute("data-clock-src");
  if (!src) return;
  clock.setAttribute("src", src);
}

function readStoredStationMeta() {
  try {
    const raw = localStorage.getItem(STATION_ID_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    if (!name || !id) return null;
    return { name, id };
  } catch {
    return null;
  }
}

function persistStationSelection(name, id) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
    if (id) {
      localStorage.setItem(STATION_ID_STORAGE_KEY, JSON.stringify({ name, id }));
    } else {
      localStorage.removeItem(STATION_ID_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function markEmbedIfNeeded() {
  if (typeof window === "undefined") return;
  if (window.parent === window) return;
  try {
    document.documentElement.classList.add("dual-embed");
    if (document.body) document.body.classList.add("dual-embed");
  } catch {
    // ignore
  }
}

function parseApiModeParam(params) {
  if (!params) return null;
  const raw = (params.get("mode") || params.get("apiMode") || "").toLowerCase();
  if (raw === "direct" || raw === "off") return API_MODE_DIRECT;
  if (raw === "board" || raw === "on") return API_MODE_BOARD;
  return null;
}

function getInitialApiMode() {
  let params = null;
  try {
    params = new URLSearchParams(window.location.search || "");
  } catch {
    params = null;
  }

  const urlMode = parseApiModeParam(params);
  if (urlMode) {
    try {
      localStorage.setItem(API_MODE_STORAGE_KEY, urlMode);
      if (urlMode === API_MODE_DIRECT) {
        localStorage.setItem(API_MODE_AUTO_OFF_KEY, "1");
      } else {
        localStorage.removeItem(API_MODE_AUTO_OFF_KEY);
      }
    } catch {
      // ignore
    }
    return urlMode;
  }

  try {
    const stored = localStorage.getItem(API_MODE_STORAGE_KEY);
    if (stored === API_MODE_DIRECT || stored === API_MODE_BOARD) {
      if (stored === API_MODE_DIRECT) {
        localStorage.setItem(API_MODE_AUTO_OFF_KEY, "1");
      }
      return stored;
    }
  } catch {
    // ignore
  }

  try {
    localStorage.setItem(API_MODE_STORAGE_KEY, API_MODE_BOARD);
  } catch {
    // ignore
  }
  return API_MODE_BOARD;
}

function updateDebugPanel(rows) {
  const sample = (rows || []).slice(0, 4).map((d) => ({
    line: d?.simpleLineId || d?.line || "",
    dest: d?.dest || "",
    platform: d?.platform || "",
    time: d?.timeStr || "",
  }));

  const payload = {
    station: appState.STATION,
    stationId: appState.stationId,
    view: appState.viewMode,
    lastBoardIsTrain: appState.lastBoardIsTrain,
    platforms: appState.platformOptions,
    lines: appState.lineOptions,
    rows: (rows || []).length,
    sample,
  };

  console.debug("[MesDeparts][debug]", payload);
}

let refreshTimer = null;
let countdownTimer = null;
let lastStationboardData = null;
let autoBoardTimer = null;
let emptyBoardRetryStation = null;

function shouldAutoSwitchToBoard() {
  if (appState.apiMode !== API_MODE_DIRECT) return false;
  try {
    return localStorage.getItem(API_MODE_AUTO_OFF_KEY) !== "1";
  } catch {
    return false;
  }
}

function scheduleAutoBoardModeSwitch() {
  if (autoBoardTimer) clearTimeout(autoBoardTimer);
  if (!shouldAutoSwitchToBoard()) return;

  autoBoardTimer = setTimeout(() => {
    if (!shouldAutoSwitchToBoard()) return;
    appState.apiMode = API_MODE_BOARD;
    try {
      localStorage.setItem(API_MODE_STORAGE_KEY, API_MODE_BOARD);
    } catch {
      // ignore
    }
    refreshBoardModeToggleUi();
    startRefreshLoop();
    refreshDepartures();
    maybeShowBoardModePopover();
  }, API_MODE_AUTO_SWITCH_MS);
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  const interval = appState.apiMode === API_MODE_DIRECT ? REFRESH_DIRECT : REFRESH_DEPARTURES;
  refreshTimer = setInterval(() => refreshDepartures({ showLoadingHint: false }), interval);
}

function refreshCountdownTick() {
  if (!lastStationboardData) return;
  try {
    const rows = buildDeparturesGrouped(lastStationboardData, appState.viewMode);
    const updated = updateCountdownRows(rows);
    if (!updated) {
      renderDepartures(rows);
    }
    publishEmbedState();
  } catch (err) {
    console.error("[MesDeparts] countdown refresh error:", err);
    refreshDepartures();
  }
}

function startCountdownLoop() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    refreshCountdownTick();
  }, COUNTDOWN_REFRESH_MS);
}

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function stopCountdownLoop() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function handleVisibilityChange() {
  if (typeof document === "undefined") return;
  if (document.hidden) {
    stopRefreshLoop();
    stopCountdownLoop();
    return;
  }
  startRefreshLoop();
  startCountdownLoop();
  refreshDepartures({ showLoadingHint: false });
}

function normalizeStationName(name) {
  return (name || "").trim();
}

function updateUrlWithStation(name, id) {
  const params = new URLSearchParams(window.location.search || "");
  if (name) {
    params.set("stationName", name);
  } else {
    params.delete("stationName");
  }
  if (id) {
    params.set("stationId", id);
  } else {
    params.delete("stationId");
  }
  const query = params.toString();
  const newUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState({}, "", newUrl);
}

function getStationFromUrl() {
  const params = new URLSearchParams(window.location.search || "");
  const name = normalizeStationName(params.get("stationName"));
  const id = normalizeStationName(params.get("stationId"));

  if (name || id) {
    return {
      name: name || null,
      id: id || null,
    };
  }
  return null;
}

function applyUrlPreferences() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const viewParam = (params.get("view") || "").toLowerCase();
    const viewLine = typeof VIEW_MODE_LINE === "string" ? VIEW_MODE_LINE : "line";
    const viewTime = typeof VIEW_MODE_TIME === "string" ? VIEW_MODE_TIME : "time";
    const trainAll = typeof TRAIN_FILTER_ALL === "string" ? TRAIN_FILTER_ALL : "train_all";
    const trainRegional = typeof TRAIN_FILTER_REGIONAL === "string" ? TRAIN_FILTER_REGIONAL : "train_regional";
    const trainLong = typeof TRAIN_FILTER_LONG_DISTANCE === "string" ? TRAIN_FILTER_LONG_DISTANCE : "train_long";

    if (viewParam === viewLine || viewParam === viewTime) {
      appState.viewMode = viewParam;
    } else if (
      viewParam === trainAll ||
      viewParam === trainRegional ||
      viewParam === trainLong
    ) {
      appState.trainServiceFilter = viewParam;
    }

    if (params.has("hideDeparture")) {
      const raw = (params.get("hideDeparture") || "").toLowerCase();
      appState.hideBusDeparture = raw === "1" || raw === "true" || raw === "on" || raw === "yes";
    }
  } catch (err) {
    console.warn("[MesDeparts] failed to read URL prefs", err);
  }
}

function applyStation(name, id) {
  const stationName = normalizeStationName(name) || DEFAULT_STATION;
  const storedMeta = readStoredStationMeta();
  const explicitId = typeof id === "string" ? id.trim() : null;
  const cachedIdRaw =
    storedMeta && storedMeta.name && storedMeta.name.toLowerCase() === stationName.toLowerCase()
      ? storedMeta.id
      : null;
  const isDefaultStation = stationName.toLowerCase() === DEFAULT_STATION.toLowerCase();
  const cachedId =
    isDefaultStation && cachedIdRaw === LEGACY_DEFAULT_STATION_ID
      ? null
      : cachedIdRaw;
  const inferredId = isDefaultStation ? DEFAULT_STATION_ID : null;

  appState.STATION = stationName;
  // If a station id is provided (from suggestion/favourite), keep it.
  // Otherwise leave as null; it will be resolved later from the name.
  appState.stationId = explicitId || cachedId || inferredId || null;

  appState.stationIsMotte = stationName.toLowerCase().includes("motte");
  appState.currentNetwork = detectNetworkFromStation(stationName);

  // Default view: group by line
  appState.viewMode = VIEW_MODE_LINE;
  appState.trainServiceFilter = TRAIN_FILTER_ALL;

  // Reset filters on station change
  appState.platformFilter = null;
  appState.lineFilter = null;
  appState.lastPlatforms = {};
  emptyBoardRetryStation = null;

  persistStationSelection(stationName, appState.stationId);
  updateUrlWithStation(stationName, appState.stationId);

  updateStationTitle();
}

async function refreshDepartures({ retried, showLoadingHint = true } = {}) {
  const tStart = DEBUG_PERF ? performance.now() : 0;
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.setAttribute("aria-busy", "true");
  }
  if (showLoadingHint) {
    setBoardLoadingState(true);
  }

  try {
    const data = await fetchStationboardRaw();
    const tAfterFetch = DEBUG_PERF ? performance.now() : 0;
    const rows = buildDeparturesGrouped(data, appState.viewMode);
    const tAfterBuild = DEBUG_PERF ? performance.now() : 0;
    lastStationboardData = data;

    const rawCount = Array.isArray(data?.stationboard) ? data.stationboard.length : 0;
    const hasActiveFilters = !!(
      (Array.isArray(appState.platformFilter)
        ? appState.platformFilter.length
        : appState.platformFilter) ||
      (Array.isArray(appState.lineFilter)
        ? appState.lineFilter.length
        : appState.lineFilter)
    );
    const stationKey = appState.STATION || "";

    // If nothing came back, try re-resolving the station once (per station),
    // but avoid doing it when filters hide results or the API returned entries.
    if (
      !retried &&
      (!rows || rows.length === 0) &&
      rawCount === 0 &&
      !hasActiveFilters &&
      emptyBoardRetryStation !== stationKey
    ) {
      emptyBoardRetryStation = stationKey;
      try {
        await resolveStationId();
        const retryData = await fetchStationboardRaw();
        const retryRows = buildDeparturesGrouped(retryData, appState.viewMode);
        if (retryRows && retryRows.length) {
          lastStationboardData = retryData;
          renderFilterOptions();
          renderDepartures(retryRows);
          return;
        }
      } catch (e) {
        console.warn("[MesDeparts][retry] resolveStationId retry failed", e);
      }
    }

    if (DEBUG_FORCE_NOW && rows.length > 0) {
      // Do NOT mutate “Départ” (planned time).
      // Only force the arriving indicator for UI testing.
      rows[0].isArriving = true;
      rows[0].inMin = 0;
    }

    // Update filter dropdown options from the latest board
    renderFilterOptions();

    renderDepartures(rows);
    const tAfterRender = DEBUG_PERF ? performance.now() : 0;
    if (DEBUG_PERF) {
      logPerf("refresh", {
        fetchMs: tAfterFetch - tStart,
        buildMs: tAfterBuild - tAfterFetch,
        renderMs: tAfterRender - tAfterBuild,
        totalMs: tAfterRender - tStart,
        rows: rows?.length || 0,
      });
    }
    updateDebugPanel(rows);
    publishEmbedState();
  } catch (err) {
    console.error("[MesDeparts] refresh error:", err);

    // Show a minimal error row
    const tbody2 = document.getElementById("departures-body");
    if (tbody2) {
      tbody2.innerHTML = "";
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.style.padding = "10px 8px";
      td.textContent = "Erreur de chargement. Réessaie dans quelques secondes.";
      tr.appendChild(td);
      tbody2.appendChild(tr);
    }
  } finally {
    if (tbody) {
      tbody.removeAttribute("aria-busy");
    }
    if (showLoadingHint) {
      setBoardLoadingState(false);
    }
    publishEmbedState();
  }
}

function refreshDeparturesFromCache({ allowFetch = true, skipFilters = false, skipDebug = false } = {}) {
  if (!lastStationboardData) {
    if (allowFetch) refreshDepartures();
    return;
  }

  try {
    const rows = buildDeparturesGrouped(lastStationboardData, appState.viewMode);
    if (!skipFilters) renderFilterOptions();
    renderDepartures(rows);
    if (!skipDebug) updateDebugPanel(rows);
    publishEmbedState();
  } catch (err) {
    console.error("[MesDeparts] cached refresh error:", err);
    refreshDepartures();
  }
}

// --------------------------------------------------------
// Boot
// --------------------------------------------------------

(function boot() {
  const bootStart = DEBUG_PERF ? performance.now() : 0;
  markEmbedIfNeeded();
  const lang = initI18n();
  appState.language = lang;
  appState.apiMode = getInitialApiMode();
  applyStaticTranslations();
  ensureBoardFitsViewport();

  const urlStation = getStationFromUrl();
  // Station from storage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (urlStation) {
    applyStation(urlStation.name || stored || DEFAULT_STATION, urlStation.id || null);
  } else {
    applyStation(stored || DEFAULT_STATION);
  }
  applyUrlPreferences();

  setupClock();
  defer(setupInfoButton);
  setupLanguageSwitcher(() => {
    refreshDepartures();
  });
  setupQuickControlsCollapse();
  defer(setupAutoFitWatcher);

  setupViewToggle(() => {
    refreshDeparturesFromCache();
  });

  setupFilters(() => {
    refreshDeparturesFromCache();
  });

  setupBoardModeToggle(() => {
    refreshDepartures();
    startRefreshLoop();
    scheduleAutoBoardModeSwitch();
  });

  setupStationSearch((name, id) => {
    applyStation(name, id);
    refreshDepartures();
  });

  loadClockIframe();

  // Initial load
  refreshDepartures();

  // Periodic refresh
  startRefreshLoop();
  startCountdownLoop();
  scheduleAutoBoardModeSwitch();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange, { passive: true });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", handleVisibilityChange, { passive: true });
  }
  if (typeof document !== "undefined" && document.hidden) {
    handleVisibilityChange();
  }

  if (DEBUG_PERF) {
    const bootEnd = performance.now();
    logPerf("boot", { totalMs: bootEnd - bootStart });
  }
})();
function setupLanguageSwitcher(onChange) {
  const sel = document.getElementById("language-select");
  const label = document.querySelector("label[for='language-select']");
  if (!sel) return;

  sel.innerHTML = "";
  for (const opt of LANGUAGE_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.code;
    o.textContent = opt.label;
    sel.appendChild(o);
  }

  sel.value = appState.language || "fr";

  sel.addEventListener("change", () => {
    const lang = sel.value;
    const applied = setLanguage(lang);
    appState.language = applied;
    applyStaticTranslations();
    refreshBoardModeToggleUi();
    renderFilterOptions();
    ensureBoardFitsViewport();
    if (typeof appState._ensureViewSelectOptions === "function") {
      appState._ensureViewSelectOptions();
    }
    if (typeof onChange === "function") onChange();
  });

  if (label) {
    // Keep label in sync with current language
    applyStaticTranslations();
  }
}
