// main.js
// --------------------------------------------------------
// App bootstrap + refresh loop
// --------------------------------------------------------

import {
  appState,
  DEFAULT_STATION,
  REFRESH_DEPARTURES,
  DEBUG_FORCE_NOW,
  VIEW_MODE_LINE,
  VIEW_MODE_TIME,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
  DEFAULT_STATION_ID,
  STATION_ID_STORAGE_KEY,
} from "./state.v2025-02-19.js";

import {
  detectNetworkFromStation,
  resolveStationId,
  fetchStationboardRaw,
  buildDeparturesGrouped,
  stationboardLooksStale,
} from "./logic.v2025-02-19.js";

import {
  setupClock,
  setupQuickControlsCollapse,
  setupViewToggle,
  setupFilters,
  renderFilterOptions,
  setupStationSearch,
  updateStationTitle,
  renderDepartures,
  setBoardLoadingState,
  ensureBoardFitsViewport,
  setupAutoFitWatcher,
  publishEmbedState,
  updateCountdownRows,
  renderServiceBanners,
} from "./ui.v2025-02-19.js";

import { setupInfoButton } from "./infoBTN.v2025-02-19.js";
import { initI18n, applyStaticTranslations, setLanguage, LANGUAGE_OPTIONS } from "./i18n.v2025-02-19.js";

// Persist station between reloads
const STORAGE_KEY = "mesdeparts.station";
// Legacy wrong default id (Genève Cornavin) that was used for “Lausanne, motte”
const LEGACY_DEFAULT_STATION_ID = "8587057";
const LEGACY_DEFAULT_STATION_NAME = "Lausanne, motte";
const COUNTDOWN_REFRESH_MS = 5_000;
const STALE_EMPTY_MAX_MS = 60_000; // force recovery if board stays empty this long while stationboard has entries
const STALE_BOARD_RETRY_COOLDOWN_MS = 60_000; // per-station cache-bypass retry spacing
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
let emptyBoardRetryStation = null;
let staleBoardRetryStation = null;
let staleBoardRetryAt = 0;
let staleBoardEmptySince = null;
let staleBoardDirectRescueAt = 0;
let lastNonEmptyStationboardAt = 0;
let refreshRequestSeq = 0;

function clearBoardForStationChange() {
  // Invalidate old in-flight refreshes and cached rows immediately.
  refreshRequestSeq += 1;
  lastStationboardData = null;
  staleBoardRetryStation = null;
  staleBoardRetryAt = 0;
  staleBoardEmptySince = null;
  staleBoardDirectRescueAt = 0;
  lastNonEmptyStationboardAt = 0;

  // Clear visible rows so we don't briefly show the previous station board.
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.innerHTML = "";
  }
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshDepartures({ showLoadingHint: false }), REFRESH_DEPARTURES);
}

function refreshCountdownTick() {
  if (!lastStationboardData) return;
  try {
    const rows = buildDeparturesGrouped(lastStationboardData, appState.viewMode);
    const updated = updateCountdownRows(rows);
    if (!updated) {
      renderServiceBanners(lastStationboardData?.banners || []);
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

function applyStation(name, id, { syncUrl = false } = {}) {
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
  appState.platformOptions = [];
  appState.lineOptions = [];
  appState.lineNetworks = {};
  appState.lastBoardIsTrain = false;
  appState.lastBoardHasBus = false;
  appState.lastBoardHasBusPlatform = false;
  appState.lastBoardNetwork = appState.currentNetwork || "generic";
  emptyBoardRetryStation = null;

  clearBoardForStationChange();
  renderFilterOptions();
  persistStationSelection(stationName, appState.stationId);
  if (syncUrl) {
    updateUrlWithStation(stationName, appState.stationId);
  }

  updateStationTitle();
}

async function refreshDepartures({ retried, showLoadingHint = true } = {}) {
  const requestSeq = ++refreshRequestSeq;
  const requestStation = appState.STATION || "";
  const requestStationId = appState.stationId || "";
  const isStaleRequest = () =>
    requestSeq !== refreshRequestSeq ||
    requestStation !== (appState.STATION || "") ||
    requestStationId !== (appState.stationId || "");

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
    if (isStaleRequest()) return;
    const tAfterFetch = DEBUG_PERF ? performance.now() : 0;
    const rows = buildDeparturesGrouped(data, appState.viewMode);
    const tAfterBuild = DEBUG_PERF ? performance.now() : 0;
    lastStationboardData = data;

    const rawCount = Array.isArray(data?.stationboard) ? data.stationboard.length : 0;
    if (rawCount > 0) {
      lastNonEmptyStationboardAt = Date.now();
    }
    const hasActiveFilters = !!(
      (Array.isArray(appState.platformFilter)
        ? appState.platformFilter.length
        : appState.platformFilter) ||
      (Array.isArray(appState.lineFilter)
        ? appState.lineFilter.length
        : appState.lineFilter)
    );
    const stationKey = appState.STATION || "";
    const boardEmpty = !rows || rows.length === 0;

    if (rawCount > 0 && boardEmpty) {
      staleBoardEmptySince = staleBoardEmptySince || Date.now();
    } else {
      staleBoardEmptySince = null;
    }

    // If nothing came back, try re-resolving the station once (per station),
    // but avoid doing it when filters hide results or the API returned entries.
    if (
      !retried &&
      boardEmpty &&
      rawCount === 0 &&
      !hasActiveFilters &&
      emptyBoardRetryStation !== stationKey
    ) {
      emptyBoardRetryStation = stationKey;
      try {
        await resolveStationId();
        const retryData = await fetchStationboardRaw();
        if (isStaleRequest()) return;
        const retryRows = buildDeparturesGrouped(retryData, appState.viewMode);
        if (retryRows && retryRows.length) {
          lastStationboardData = retryData;
          renderFilterOptions();
          renderServiceBanners(retryData?.banners || []);
          renderDepartures(retryRows);
          return;
        }
      } catch (e) {
        console.warn("[MesDeparts][retry] resolveStationId retry failed", e);
      }
    }

    if (
      !retried &&
      rawCount > 0 &&
      boardEmpty &&
      stationboardLooksStale(data)
    ) {
      const nowMs = Date.now();
      const recentlyRetried =
        staleBoardRetryStation === stationKey &&
        nowMs - staleBoardRetryAt < STALE_BOARD_RETRY_COOLDOWN_MS;

      if (!recentlyRetried) {
        staleBoardRetryStation = stationKey;
        staleBoardRetryAt = nowMs;
        try {
          const freshData = await fetchStationboardRaw({ allowRetry: false, bustCache: true });
          if (isStaleRequest()) return;
          const freshRows = buildDeparturesGrouped(freshData, appState.viewMode);
          lastStationboardData = freshData;
          renderFilterOptions();
          renderServiceBanners(freshData?.banners || []);
          renderDepartures(freshRows);
          updateDebugPanel(freshRows);
          publishEmbedState();
          return;
        } catch (e) {
          console.warn("[MesDeparts][stale-retry] failed", e);
        }
      }
    }

    if (
      !retried &&
      boardEmpty &&
      rawCount > 0 &&
      staleBoardEmptySince &&
      Date.now() - staleBoardEmptySince >= STALE_EMPTY_MAX_MS &&
      Date.now() - staleBoardDirectRescueAt >= STALE_EMPTY_MAX_MS
    ) {
      staleBoardDirectRescueAt = Date.now();
      try {
        const directData = await fetchStationboardRaw({ allowRetry: false, bustCache: true });
        if (isStaleRequest()) return;
        const directRows = buildDeparturesGrouped(directData, appState.viewMode);
        lastStationboardData = directData;
        staleBoardEmptySince = directRows && directRows.length ? null : staleBoardEmptySince;
        renderFilterOptions();
        renderServiceBanners(directData?.banners || []);
        renderDepartures(directRows);
        updateDebugPanel(directRows);
        publishEmbedState();
        return;
      } catch (e) {
        console.warn("[MesDeparts][stale-direct-rescue] failed", e);
      }
    }

    if (
      !retried &&
      rawCount === 0 &&
      lastNonEmptyStationboardAt &&
      Date.now() - lastNonEmptyStationboardAt >= STALE_EMPTY_MAX_MS &&
      Date.now() - staleBoardDirectRescueAt >= STALE_EMPTY_MAX_MS
    ) {
      staleBoardDirectRescueAt = Date.now();
      try {
        const directData = await fetchStationboardRaw({ allowRetry: false, bustCache: true });
        if (isStaleRequest()) return;
        const directRows = buildDeparturesGrouped(directData, appState.viewMode);
        lastStationboardData = directData;
        if (Array.isArray(directData?.stationboard) && directData.stationboard.length > 0) {
          lastNonEmptyStationboardAt = Date.now();
        }
        renderFilterOptions();
        renderServiceBanners(directData?.banners || []);
        renderDepartures(directRows);
        updateDebugPanel(directRows);
        publishEmbedState();
        return;
      } catch (e) {
        console.warn("[MesDeparts][stale-direct-rescue-empty] failed", e);
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

    renderServiceBanners(data?.banners || []);
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
    if (isStaleRequest()) return;
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
    renderServiceBanners([]);
  } finally {
    if (isStaleRequest()) return;
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
    renderServiceBanners(lastStationboardData?.banners || []);
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
  applyStaticTranslations();
  ensureBoardFitsViewport();

  const urlStation = getStationFromUrl();
  // Station from storage
  const storedRaw = localStorage.getItem(STORAGE_KEY);
  const stored = normalizeStationName(storedRaw);
  const storedIsLegacyDefault =
    !!stored && stored.toLowerCase() === LEGACY_DEFAULT_STATION_NAME.toLowerCase();
  const initialStored = storedIsLegacyDefault ? null : stored;
  if (urlStation) {
    applyStation(urlStation.name || initialStored || DEFAULT_STATION, urlStation.id || null);
  } else {
    applyStation(initialStored || DEFAULT_STATION);
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

  setupStationSearch((name, id) => {
    applyStation(name, id, { syncUrl: true });
    refreshDepartures();
  });

  loadClockIframe();

  // Initial load
  refreshDepartures();

  // Periodic refresh
  startRefreshLoop();
  startCountdownLoop();
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
