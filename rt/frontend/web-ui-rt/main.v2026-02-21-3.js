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
} from "./state.v2026-02-21-3.js";

import {
  detectNetworkFromStation,
  resolveStationId,
  fetchStationboardRaw,
  buildDeparturesGrouped,
  stationboardLooksStale,
  isTransientFetchError,
  shouldHoldRtDowngrade,
} from "./logic.v2026-02-21-3.js";

import {
  setupClock,
  updateStationTitle,
  renderDepartures,
  ensureBoardFitsViewport,
  setupAutoFitWatcher,
  publishEmbedState,
  updateCountdownRows,
  renderServiceBanners,
} from "./ui.v2026-02-21-3.js";

import { setupInfoButton } from "./infoBTN.v2026-02-21-3.js";
import { initI18n, applyStaticTranslations, t } from "./i18n.v2026-02-21-3.js";
import { loadFavorites } from "./favourites.v2026-02-21-3.js";
import {
  getHomeStop,
  setHomeStop,
  clearHomeStop,
  shouldShowHomeStopModal,
} from "./homeStop.v2026-02-21-3.js";
import { openHomeStopOnboardingModal } from "./ui/homeStopOnboarding.v2026-02-21-3.js";
import {
  initHeaderControls2,
  updateHeaderControls2,
  setBoardLoadingHint,
  setBoardNoticeHint,
  maybeShowThreeDotsTip,
} from "./ui/headerControls2.js";

// Persist station between reloads
const STORAGE_KEY = "mesdeparts.station";
// Legacy wrong default id (Genève Cornavin) that was used for “Lausanne, motte”
const LEGACY_DEFAULT_STATION_ID = "8587057";
const LEGACY_DEFAULT_STATION_NAME = "Lausanne, motte";
const COUNTDOWN_REFRESH_MS = 5_000;
const STALE_EMPTY_MAX_MS = 60_000; // force recovery if board stays empty this long while stationboard has entries
const STALE_BOARD_RETRY_COOLDOWN_MS = 60_000; // per-station cache-bypass retry spacing
const TRANSIENT_RETRY_DELAY_MS = 700;
const FOLLOWUP_REFRESH_BASE_MS = 3_000;
const REFRESH_JITTER_MIN_MS = 300;
const REFRESH_JITTER_MAX_MS = 600;
const REFRESH_BACKOFF_STEPS_MS = [2_000, 5_000, 10_000, 15_000];
const RT_DOWNGRADE_HOLD_WINDOW_MS = 30_000;
const RT_LONG_STALE_GRACE_MS = 30_000;
const DEBUG_RT_CLIENT =
  (() => {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return params.get("debug") === "1";
    } catch {
      return false;
    }
  })();
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
let followupRefreshTimer = null;
let countdownTimer = null;
let lastStationboardData = null;
let emptyBoardRetryStation = null;
let staleBoardRetryStation = null;
let staleBoardRetryAt = 0;
let staleBoardEmptySince = null;
let staleBoardDirectRescueAt = 0;
let lastNonEmptyStationboardAt = 0;
let refreshRequestSeq = 0;
let refreshBackoffIndex = 0;
let refreshLoopActive = false;
let refreshInFlight = false;
let lastRtAppliedSnapshot = null;
let lastRtAppliedAtMs = 0;
let nextRefreshAtMs = 0;
let rtDebugOverlayEl = null;

function ensureRtDebugOverlay() {
  if (!DEBUG_RT_CLIENT || typeof document === "undefined") return null;
  if (rtDebugOverlayEl && document.body?.contains(rtDebugOverlayEl)) return rtDebugOverlayEl;
  const el = document.createElement("div");
  el.id = "rt-debug-overlay";
  el.style.position = "fixed";
  el.style.right = "8px";
  el.style.bottom = "8px";
  el.style.zIndex = "9999";
  el.style.background = "rgba(255,255,255,0.95)";
  el.style.border = "1px solid rgba(0,0,0,0.2)";
  el.style.borderRadius = "8px";
  el.style.padding = "6px 8px";
  el.style.fontFamily = "monospace";
  el.style.fontSize = "11px";
  el.style.lineHeight = "1.3";
  el.style.color = "#111";
  document.body?.appendChild(el);
  rtDebugOverlayEl = el;
  return el;
}

function updateRtDebugOverlay() {
  if (!DEBUG_RT_CLIENT) return;
  const el = ensureRtDebugOverlay();
  if (!el) return;
  const remainingMs = Math.max(0, nextRefreshAtMs - Date.now());
  const nextSec = nextRefreshAtMs > 0 ? Math.ceil(remainingMs / 1000) : "-";
  el.textContent = [
    `lastRtFetchedAt=${appState.lastRtFetchedAt || "-"}`,
    `lastStatus=${appState.lastStationboardHttpStatus ?? "-"}`,
    `nextPollSec=${nextSec}`,
  ].join(" | ");
}

function clearBoardForStationChange() {
  // Invalidate old in-flight refreshes and cached rows immediately.
  refreshRequestSeq += 1;
  lastStationboardData = null;
  staleBoardRetryStation = null;
  staleBoardRetryAt = 0;
  staleBoardEmptySince = null;
  staleBoardDirectRescueAt = 0;
  lastNonEmptyStationboardAt = 0;
  lastRtAppliedSnapshot = null;
  lastRtAppliedAtMs = 0;
  appState.lastRtFetchedAt = null;
  appState.lastStationboardHttpStatus = null;
  setBoardNoticeHint("");
  updateRtDebugOverlay();

  // Clear visible rows so we don't briefly show the previous station board.
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.innerHTML = "";
  }
}

function randomRefreshJitterMs() {
  const spread = REFRESH_JITTER_MAX_MS - REFRESH_JITTER_MIN_MS;
  const magnitude = REFRESH_JITTER_MIN_MS + Math.random() * Math.max(0, spread);
  const sign = Math.random() < 0.5 ? -1 : 1;
  return Math.round(sign * magnitude);
}

function jitteredDelayMs(baseMs) {
  const base = Math.max(200, Number(baseMs) || 0);
  return Math.max(200, base + randomRefreshJitterMs());
}

function clearScheduledRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  nextRefreshAtMs = 0;
  updateRtDebugOverlay();
}

function clearFollowupRefresh() {
  if (followupRefreshTimer) {
    clearTimeout(followupRefreshTimer);
    followupRefreshTimer = null;
  }
}

function scheduleNextRefresh({ useBackoff = false } = {}) {
  if (!refreshLoopActive) return;
  if (typeof document !== "undefined" && document.hidden) return;

  clearScheduledRefresh();
  const backoffMs = REFRESH_BACKOFF_STEPS_MS[
    Math.max(0, Math.min(refreshBackoffIndex, REFRESH_BACKOFF_STEPS_MS.length - 1))
  ];
  const baseMs = useBackoff ? backoffMs : REFRESH_DEPARTURES;
  const delayMs = jitteredDelayMs(baseMs);
  nextRefreshAtMs = Date.now() + delayMs;
  updateRtDebugOverlay();

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    nextRefreshAtMs = 0;
    updateRtDebugOverlay();
    if (refreshInFlight) {
      scheduleNextRefresh({ useBackoff });
      return;
    }
    refreshDepartures({ showLoadingHint: false, fromScheduler: true });
  }, delayMs);
}

function scheduleInitialFollowupRefresh() {
  clearFollowupRefresh();
  const delayMs = jitteredDelayMs(FOLLOWUP_REFRESH_BASE_MS);
  followupRefreshTimer = setTimeout(() => {
    followupRefreshTimer = null;
    if (typeof document !== "undefined" && document.hidden) return;
    refreshDepartures({ showLoadingHint: false });
  }, delayMs);
}

function startRefreshLoop() {
  refreshLoopActive = true;
  refreshBackoffIndex = 0;
  scheduleNextRefresh({ useBackoff: false });
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
  refreshLoopActive = false;
  clearScheduledRefresh();
  clearFollowupRefresh();
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

function consumeResetHomeStopFlagFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const shouldReset =
      params.get("resetHomeStop") === "1" || params.get("resetDepartureStop") === "1";
    if (!shouldReset) return false;

    clearHomeStop();
    params.delete("resetHomeStop");
    params.delete("resetDepartureStop");
    const next = params.toString();
    const nextUrl = next ? `${window.location.pathname}?${next}` : window.location.pathname;
    window.history.replaceState({}, "", nextUrl);
    return true;
  } catch {
    return false;
  }
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

    if (params.has("lines")) {
      const linesParam = (params.get("lines") || "").trim();
      if (linesParam) {
        appState.lineFilter = linesParam.split(",").map(l => l.trim()).filter(Boolean);
      }
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
  updateHeaderControls2({
    currentStop: {
      id: appState.stationId || null,
      name: appState.STATION || "",
    },
    language: appState.language || "fr",
  });
  persistStationSelection(stationName, appState.stationId);
  if (syncUrl) {
    updateUrlWithStation(stationName, appState.stationId);
  }

  updateStationTitle();
}

async function refreshDepartures({ retried, showLoadingHint = true, fromScheduler = false } = {}) {
  const requestSeq = ++refreshRequestSeq;
  const requestStation = appState.STATION || "";
  const requestStationId = appState.stationId || "";
  const isStaleRequest = () =>
    requestSeq !== refreshRequestSeq ||
    requestStation !== (appState.STATION || "") ||
    requestStationId !== (appState.stationId || "");
  let refreshSucceeded = false;
  let scheduleBackoff = false;

  refreshInFlight = true;

  const tStart = DEBUG_PERF ? performance.now() : 0;
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.setAttribute("aria-busy", "true");
  }
  if (showLoadingHint) {
    setBoardLoadingHint(true);
  }

  try {
    const data = await fetchStationboardRaw();
    if (isStaleRequest()) return;
    if (Number.isFinite(Number(data?.__status))) {
      appState.lastStationboardHttpStatus = Number(data.__status);
      updateRtDebugOverlay();
    }
    if (data?.__notModified) {
      refreshSucceeded = true;
      publishEmbedState();
      return;
    }
    const tAfterFetch = DEBUG_PERF ? performance.now() : 0;
    const nowMs = Date.now();
    if (data?.rt?.applied === true) {
      lastRtAppliedSnapshot = data;
      lastRtAppliedAtMs = nowMs;
    }
    const holdPreviousRt = shouldHoldRtDowngrade({
      lastRtAppliedAtMs,
      nextRt: data?.rt,
      nowMs,
      holdWindowMs: RT_DOWNGRADE_HOLD_WINDOW_MS,
      staleGraceMs: RT_LONG_STALE_GRACE_MS,
    });
    const renderData = holdPreviousRt && lastRtAppliedSnapshot ? lastRtAppliedSnapshot : data;
    if (holdPreviousRt) {
      setBoardNoticeHint(t("rtTemporarilyUnavailable"), { ttlMs: REFRESH_DEPARTURES + 1_500 });
    } else {
      setBoardNoticeHint("");
      if (String(data?.rt?.reason || "").toLowerCase() === "disabled") {
        lastRtAppliedSnapshot = null;
        lastRtAppliedAtMs = 0;
      }
    }
    const rows = buildDeparturesGrouped(renderData, appState.viewMode);
    const tAfterBuild = DEBUG_PERF ? performance.now() : 0;
    lastStationboardData = renderData;

    const rawCount = Array.isArray(renderData?.stationboard) ? renderData.stationboard.length : 0;
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
          updateHeaderControls2();
          renderServiceBanners(retryData?.banners || []);
          renderDepartures(retryRows);
          markMainBoardReadyForHints();
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
          updateHeaderControls2();
          renderServiceBanners(freshData?.banners || []);
          renderDepartures(freshRows);
          markMainBoardReadyForHints();
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
        updateHeaderControls2();
        renderServiceBanners(directData?.banners || []);
        renderDepartures(directRows);
        markMainBoardReadyForHints();
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
        updateHeaderControls2();
        renderServiceBanners(directData?.banners || []);
        renderDepartures(directRows);
        markMainBoardReadyForHints();
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
    updateHeaderControls2();

    renderServiceBanners(renderData?.banners || []);
    renderDepartures(rows);
    markMainBoardReadyForHints();
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
    refreshSucceeded = true;
  } catch (err) {
    if (isStaleRequest()) return;
    const isTransient = isTransientFetchError(err);
    scheduleBackoff = true;
    if (isTransient && !retried) {
      setTimeout(() => {
        refreshDepartures({ retried: true, showLoadingHint: false });
      }, TRANSIENT_RETRY_DELAY_MS);
      return;
    }
    if (isTransient && lastStationboardData) {
      return;
    }
    if (isTransient) {
      return;
    } else {
      console.error("[MesDeparts] refresh error:", err);
    }

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
    const staleRequest = isStaleRequest();
    refreshInFlight = false;
    if (staleRequest) {
      if (fromScheduler) {
        scheduleNextRefresh({ useBackoff: false });
      }
      return;
    }
    if (tbody) {
      tbody.removeAttribute("aria-busy");
    }
    if (showLoadingHint) {
      setBoardLoadingHint(false);
    }
    publishEmbedState();
    updateRtDebugOverlay();

    if (fromScheduler) {
      if (refreshSucceeded) {
        refreshBackoffIndex = 0;
        scheduleNextRefresh({ useBackoff: false });
      } else {
        if (scheduleBackoff) {
          refreshBackoffIndex = Math.min(
            refreshBackoffIndex + 1,
            REFRESH_BACKOFF_STEPS_MS.length - 1
          );
        }
        scheduleNextRefresh({ useBackoff: true });
      }
    }
  }
}

function refreshDeparturesFromCache({ allowFetch = true, skipFilters = false, skipDebug = false } = {}) {
  if (!lastStationboardData) {
    if (allowFetch) refreshDepartures();
    return;
  }

  try {
    const rows = buildDeparturesGrouped(lastStationboardData, appState.viewMode);
    if (!skipFilters) updateHeaderControls2();
    renderServiceBanners(lastStationboardData?.banners || []);
    renderDepartures(rows);
    if (!skipDebug) updateDebugPanel(rows);
    publishEmbedState();
  } catch (err) {
    console.error("[MesDeparts] cached refresh error:", err);
    refreshDepartures();
  }
}

let homeStopOnboardingOpen = false;
let onboardingSettled = false;
let firstSuccessfulBoardRender = false;

function maybeShowThreeDotsTipWhenReady() {
  if (!onboardingSettled || !firstSuccessfulBoardRender) return;
  maybeShowThreeDotsTip();
}

function markMainBoardReadyForHints() {
  firstSuccessfulBoardRender = true;
  maybeShowThreeDotsTipWhenReady();
}

async function runHomeStopOnboardingIfNeeded() {
  if (homeStopOnboardingOpen) return;
  if (isDualEmbed()) {
    onboardingSettled = true;
    maybeShowThreeDotsTipWhenReady();
    return;
  }
  if (!shouldShowHomeStopModal()) {
    onboardingSettled = true;
    maybeShowThreeDotsTipWhenReady();
    return;
  }

  homeStopOnboardingOpen = true;
  try {
    const result = await openHomeStopOnboardingModal({
      initialStop: {
        id: appState.stationId || null,
        name: appState.STATION || "",
      },
    });

    if (!result || result.confirmed !== true || !result.stop?.name) return;

    setHomeStop({
      id: result.stop.id || null,
      name: result.stop.name,
      dontAskAgain: !!result.dontAskAgain,
    });
    applyStation(result.stop.name, result.stop.id || null, { syncUrl: true });
    refreshDepartures();
  } finally {
    homeStopOnboardingOpen = false;
    onboardingSettled = true;
    maybeShowThreeDotsTipWhenReady();
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

  initHeaderControls2({
    mountEl: document.getElementById("header-controls2-mount"),
    getCurrentStop: () => ({
      id: appState.stationId || null,
      name: appState.STATION || "",
    }),
    onSelectStop: (stopOrId, maybeName) => {
      if (typeof stopOrId === "string" && typeof maybeName === "string" && maybeName.trim()) {
        const id = stopOrId.trim() || null;
        const name = maybeName.trim();
        applyStation(name, id, { syncUrl: true });
        refreshDepartures();
        return;
      }

      if (typeof stopOrId === "string") {
        const id = stopOrId.trim();
        if (!id) return;
        const fav = loadFavorites().find((item) => item && item.id === id);
        if (!fav || !fav.name) return;
        applyStation(String(fav.name), id, { syncUrl: true });
        refreshDepartures();
        return;
      }

      const name = String(stopOrId?.name || "").trim();
      if (!name) return;
      const id = typeof stopOrId?.id === "string" && stopOrId.id.trim() ? stopOrId.id.trim() : null;
      applyStation(name, id, { syncUrl: true });
      refreshDepartures();
    },
    onControlsChange: () => {
      refreshDeparturesFromCache();
    },
    onLanguageChange: () => {
      ensureBoardFitsViewport();
      refreshDepartures();
    },
  });

  applyStaticTranslations();
  ensureBoardFitsViewport();

  consumeResetHomeStopFlagFromUrl();
  const savedHomeStop = getHomeStop();
  const urlStation = getStationFromUrl();
  // Station from storage
  const storedRaw = localStorage.getItem(STORAGE_KEY);
  const stored = normalizeStationName(storedRaw);
  const storedIsLegacyDefault =
    !!stored && stored.toLowerCase() === LEGACY_DEFAULT_STATION_NAME.toLowerCase();
  const initialStored = storedIsLegacyDefault ? null : stored;
  if (urlStation) {
    const fallbackName = savedHomeStop?.name || initialStored || DEFAULT_STATION;
    const fallbackId = savedHomeStop?.id || null;
    applyStation(urlStation.name || fallbackName, urlStation.id || fallbackId);
  } else if (savedHomeStop?.name) {
    applyStation(savedHomeStop.name, savedHomeStop.id || null);
  } else {
    applyStation(initialStored || DEFAULT_STATION);
  }
  applyUrlPreferences();

  setupClock();
  defer(setupInfoButton);
  defer(setupAutoFitWatcher);

  loadClockIframe();

  // Initial load
  refreshDepartures();
  scheduleInitialFollowupRefresh();
  defer(() => {
    runHomeStopOnboardingIfNeeded();
  });

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
  if (DEBUG_RT_CLIENT) {
    ensureRtDebugOverlay();
    updateRtDebugOverlay();
    setInterval(() => {
      updateRtDebugOverlay();
    }, 1000);
  }

  if (DEBUG_PERF) {
    const bootEnd = performance.now();
    logPerf("boot", { totalMs: bootEnd - bootStart });
  }
})();
