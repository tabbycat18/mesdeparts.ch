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
} from "./v20260227.state.js";

import {
  detectNetworkFromStation,
  initNetworkMapConfig,
  resolveStationId,
  fetchStationboardRaw,
  buildDeparturesGrouped,
  stationboardLooksStale,
  isTransientFetchError,
  RT_HARD_CAP_MS,
  buildBoardContextKey,
  isRtUnavailableFromStationboardPayload,
  parseBoardContextKey,
  shouldApplyIncomingBoard,
} from "./v20260227.logic.js";

import {
  setupClock,
  updateStationTitle,
  renderDepartures,
  ensureBoardFitsViewport,
  setupAutoFitWatcher,
  publishEmbedState,
  updateCountdownRows,
  renderServiceBanners,
} from "./v20260227.ui.js";

import { setupInfoButton } from "./v20260227.infoBTN.js";
import { initI18n, applyStaticTranslations, t } from "./v20260227.i18n.js";
import { loadFavorites } from "./v20260227.favourites.js";
import {
  getHomeStop,
  setHomeStop,
  clearHomeStop,
  shouldShowHomeStopModal,
} from "./v20260227.homeStop.js";
import { openHomeStopOnboardingModal } from "./ui/v20260227.homeStopOnboarding.js";
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
const FOREGROUND_REFRESH_DEBOUNCE_MS = 1_500;
const REFRESH_DRIFT_CATCHUP_MS = Math.max(2_000, Math.floor(REFRESH_DEPARTURES * 0.75));
const UNATTENDED_FETCH_STALE_MS = Math.max(45_000, REFRESH_DEPARTURES * 3);
const UNATTENDED_RESCUE_COOLDOWN_MS = 60_000;
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
let pendingRefreshRequest = null;
let lastRtAppliedSnapshot = null;
let nextRefreshAtMs = 0;
let rtDebugOverlayEl = null;
let consecutive204Count = 0;
let lastFullRefreshAt = 0;
let lastForegroundRefreshAt = 0;
let lastUnattendedRescueAt = 0;
const FULL_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // Force full refresh every 10 minutes
const MAX_CONSECUTIVE_204S = 5; // Force full refresh after 5 consecutive 204s

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
  const edgeCache = appState.lastStationboardCacheStatus || "-";
  const lastFetchAt = appState.lastStationboardFetchAt || "-";
  const serverFetchedAt = appState.lastRtFetchedAt || "-";
  el.textContent = [
    `lastFetchAt=${lastFetchAt}`,
    `edgeCache=${edgeCache}`,
    `serverFetchedAt=${serverFetchedAt}`,
    `lastStatus=${appState.lastStationboardHttpStatus ?? "-"}`,
    `nextPollSec=${nextSec}`,
  ].join(" | ");
}

function resetRtBoardState() {
  lastRtAppliedSnapshot = null;
  appState.lastRtSnapshotAtMs = null;
  appState.currentBoardHasRtSnapshot = false;
  appState.rtUiStatus = {
    applied: false,
    stale: false,
    staleSinceMs: null,
    reason: null,
  };
}

function enqueueRefreshRequest(options = {}) {
  pendingRefreshRequest = {
    retried: options.retried === true,
    showLoadingHint: options.showLoadingHint !== false,
    fromScheduler: options.fromScheduler === true,
    forceDowngrade: options.forceDowngrade === true,
    forceFetch: options.forceFetch === true,
  };
}

function currentBoardContextKeyFromState({ station, stationId, language } = {}) {
  const mode = isDualEmbed() ? "dual" : "single";
  const stopA = String(stationId || station || "").trim();
  return buildBoardContextKey({
    mode,
    language: String(language || "fr").trim().toLowerCase(),
    stopA,
    stopB: "",
  });
}

function getContextChangeFlags(previousKey, nextKey) {
  const previous = parseBoardContextKey(previousKey);
  const next = parseBoardContextKey(nextKey);
  const contextChanged =
    String(previousKey || "").trim() !== "" &&
    String(nextKey || "").trim() !== "" &&
    String(previousKey) !== String(nextKey);
  const stopChanged =
    contextChanged &&
    (previous.mode !== next.mode || previous.stopA !== next.stopA || previous.stopB !== next.stopB);
  const languageChanged = contextChanged && previous.language !== next.language;
  return { contextChanged, stopChanged, languageChanged };
}

function setEmbedAwareLoadingHint(isLoading) {
  const loading = !!isLoading;
  appState.boardLoadingHint = loading;
  setBoardLoadingHint(loading);
  publishEmbedState();
}

function setEmbedAwareNoticeHint(text, options) {
  const notice = String(text || "").trim();
  appState.boardNoticeHint = notice;
  setBoardNoticeHint(notice, options);
  publishEmbedState();
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
  appState.boardContextKey = null;
  resetRtBoardState();
  appState.lastRtFetchedAt = null;
  appState.lastStationboardFetchAt = null;
  appState.lastStationboardCacheStatus = null;
  appState.lastStationboardHttpStatus = null;
  lastForegroundRefreshAt = 0;
  lastUnattendedRescueAt = 0;
  setEmbedAwareNoticeHint("");
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
  const dueAtMs = Date.now() + delayMs;
  nextRefreshAtMs = dueAtMs;
  updateRtDebugOverlay();

  refreshTimer = setTimeout(() => {
    const driftMs = Math.max(0, Date.now() - dueAtMs);
    refreshTimer = null;
    nextRefreshAtMs = 0;
    updateRtDebugOverlay();
    if (DEBUG_RT_CLIENT && driftMs >= REFRESH_DRIFT_CATCHUP_MS) {
      // eslint-disable-next-line no-console
      console.log("[MesDeparts][rt-refresh] Timer drift detected", {
        driftMs: Math.round(driftMs),
        expectedDelayMs: Math.round(delayMs),
      });
    }
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

function getRefreshDriftMs(nowMs = Date.now()) {
  if (!Number.isFinite(nextRefreshAtMs) || nextRefreshAtMs <= 0) return 0;
  return Math.max(0, Number(nowMs) - nextRefreshAtMs);
}

function maybeCatchUpRefresh({ source = "unknown" } = {}) {
  if (!refreshLoopActive || refreshInFlight) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  const driftMs = getRefreshDriftMs();
  if (driftMs < REFRESH_DRIFT_CATCHUP_MS) return false;

  clearScheduledRefresh();
  if (DEBUG_RT_CLIENT) {
    // eslint-disable-next-line no-console
    console.log("[MesDeparts][rt-refresh] Catch-up refresh", {
      source,
      driftMs: Math.round(driftMs),
    });
  }
  refreshDepartures({ showLoadingHint: false, fromScheduler: true });
  return true;
}

function getLastStationboardFetchAgeMs(nowMs = Date.now()) {
  const raw = String(appState.lastStationboardFetchAt || "").trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - parsedMs);
}

function maybeRescueUnattendedStall({ source = "unknown" } = {}) {
  if (!refreshLoopActive || refreshInFlight) return false;
  if (typeof document !== "undefined" && document.hidden) return false;

  const nowMs = Date.now();
  if (nowMs - lastUnattendedRescueAt < UNATTENDED_RESCUE_COOLDOWN_MS) return false;

  const fetchAgeMs = getLastStationboardFetchAgeMs(nowMs);
  if (fetchAgeMs < UNATTENDED_FETCH_STALE_MS) return false;

  lastUnattendedRescueAt = nowMs;
  clearScheduledRefresh();
  if (DEBUG_RT_CLIENT) {
    // eslint-disable-next-line no-console
    console.log("[MesDeparts][rt-refresh] Unattended stall rescue", {
      source,
      fetchAgeMs: Math.round(fetchAgeMs),
      staleThresholdMs: UNATTENDED_FETCH_STALE_MS,
    });
  }
  refreshDepartures({
    showLoadingHint: false,
    fromScheduler: true,
    forceFetch: true,
  });
  return true;
}

function triggerForegroundRefresh({ source = "foreground" } = {}) {
  const nowMs = Date.now();
  const driftMs = getRefreshDriftMs(nowMs);
  const overdue = driftMs >= REFRESH_DRIFT_CATCHUP_MS;
  const dueToFocusResume =
    source === "visibilitychange" ||
    nowMs - lastForegroundRefreshAt >= FOREGROUND_REFRESH_DEBOUNCE_MS;
  if (!overdue && !dueToFocusResume) return;
  lastForegroundRefreshAt = nowMs;
  if (overdue) {
    clearScheduledRefresh();
  }
  if (DEBUG_RT_CLIENT && overdue) {
    // eslint-disable-next-line no-console
    console.log("[MesDeparts][rt-refresh] Foreground drift refresh", {
      source,
      driftMs: Math.round(driftMs),
    });
  }
  refreshDepartures({ showLoadingHint: false, fromScheduler: overdue });
}

function refreshCountdownTick() {
  if (maybeCatchUpRefresh({ source: "countdown" })) return;
  if (maybeRescueUnattendedStall({ source: "countdown" })) return;
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
  if (!refreshLoopActive) startRefreshLoop();
  if (!countdownTimer) startCountdownLoop();
  triggerForegroundRefresh({ source: "visibilitychange" });
}

function handleWindowFocus() {
  if (typeof document !== "undefined" && document.hidden) return;
  if (!refreshLoopActive) startRefreshLoop();
  if (!countdownTimer) startCountdownLoop();
  triggerForegroundRefresh({ source: "focus" });
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

  // Default view: chronological (by minute)
  appState.viewMode = VIEW_MODE_TIME;
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

async function refreshDepartures({
  retried,
  showLoadingHint = true,
  fromScheduler = false,
  forceDowngrade = false,
  forceFetch = false,
} = {}) {
  if (refreshInFlight) {
    enqueueRefreshRequest({
      retried,
      showLoadingHint,
      fromScheduler,
      forceDowngrade,
      forceFetch,
    });
    return;
  }

  const requestSeq = ++refreshRequestSeq;
  const requestStation = appState.STATION || "";
  const requestStationId = appState.stationId || "";
  const requestLanguage = String(appState.language || "fr").trim().toLowerCase();
  const requestContextKey = currentBoardContextKeyFromState({
    station: requestStation,
    stationId: requestStationId,
    language: requestLanguage,
  });
  const isStaleRequest = () =>
    requestSeq !== refreshRequestSeq ||
    requestStation !== (appState.STATION || "") ||
    requestStationId !== (appState.stationId || "") ||
    requestLanguage !== String(appState.language || "fr").trim().toLowerCase();
  let refreshSucceeded = false;
  let scheduleBackoff = false;

  // Force full refresh if too many consecutive 204s or if too much time has passed
  const nowMs = Date.now();
  const needsForcedRefresh = consecutive204Count >= MAX_CONSECUTIVE_204S ||
    (lastFullRefreshAt > 0 && nowMs - lastFullRefreshAt > FULL_REFRESH_INTERVAL_MS);

  if (needsForcedRefresh && !forceFetch) {
    if (DEBUG_RT_CLIENT) {
      // eslint-disable-next-line no-console
      console.log("[MesDeparts][rt-refresh] Force full refresh", {
        reason: consecutive204Count >= MAX_CONSECUTIVE_204S ? "too_many_204s" : "interval_elapsed",
        consecutive204Count,
        timeSinceLastFullRefreshMs: lastFullRefreshAt > 0 ? nowMs - lastFullRefreshAt : "never",
      });
    }
    forceFetch = true;
  }

  refreshInFlight = true;

  const tStart = DEBUG_PERF ? performance.now() : 0;
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.setAttribute("aria-busy", "true");
  }
  if (showLoadingHint) {
    setEmbedAwareLoadingHint(true);
  }

  try {
    const data = await fetchStationboardRaw({ bustCache: forceFetch });
    if (isStaleRequest()) return;
    if (Number.isFinite(Number(data?.__status))) {
      appState.lastStationboardHttpStatus = Number(data.__status);
      updateRtDebugOverlay();
    }
    if (data?.__notModified) {
      consecutive204Count++;
      if (DEBUG_RT_CLIENT) {
        // eslint-disable-next-line no-console
        console.log("[MesDeparts][rt-refresh] Received 204 No Content", {
          consecutive204Count,
          willForceRefreshNext: consecutive204Count >= MAX_CONSECUTIVE_204S,
        });
      }
      refreshSucceeded = true;
      publishEmbedState();
      return;
    }
    const tAfterFetch = DEBUG_PERF ? performance.now() : 0;
    const nowMs = Date.now();
    const previousContextKey = String(appState.boardContextKey || "").trim();
    const nextContextKey = requestContextKey;
    const { contextChanged, stopChanged, languageChanged } = getContextChangeFlags(
      previousContextKey,
      nextContextKey
    );
    const decision = shouldApplyIncomingBoard(
      {
        currentBoardHasRtSnapshot: appState.currentBoardHasRtSnapshot === true,
        lastRtSnapshotAtMs: appState.lastRtSnapshotAtMs,
      },
      data,
      data?.__status || 200,
      {
        contextChanged,
        stopChanged,
        languageChanged,
        manualHardRefresh: forceDowngrade === true,
        hardCapMs: RT_HARD_CAP_MS,
      },
      nowMs
    );
    const rtUnavailable = isRtUnavailableFromStationboardPayload(data);

    if (!decision.apply) {
      appState.boardContextKey = nextContextKey || appState.boardContextKey || null;
      appState.rtUiStatus = {
        applied: true,
        stale: true,
        staleSinceMs:
          Number.isFinite(Number(appState.rtUiStatus?.staleSinceMs))
            ? Number(appState.rtUiStatus.staleSinceMs)
            : nowMs,
        reason: String(data?.rt?.reason || "stale_or_unavailable"),
      };
      setEmbedAwareNoticeHint(rtUnavailable ? t("rtTemporarilyUnavailable") : "");
      refreshSucceeded = true;
      publishEmbedState();
      return;
    }

    appState.boardContextKey = nextContextKey || appState.boardContextKey || null;
    const incomingHasRtSnapshot = data?.rt?.applied === true;
    if (incomingHasRtSnapshot) {
      lastRtAppliedSnapshot = data;
      appState.lastRtSnapshotAtMs = nowMs;
      appState.currentBoardHasRtSnapshot = true;
      appState.rtUiStatus = {
        applied: true,
        stale: false,
        staleSinceMs: null,
        reason: String(data?.rt?.reason || "fresh"),
      };
    } else {
      if (appState.currentBoardHasRtSnapshot === true) {
        lastRtAppliedSnapshot = null;
      }
      appState.lastRtSnapshotAtMs = null;
      appState.currentBoardHasRtSnapshot = false;
      appState.rtUiStatus = {
        applied: false,
        stale: false,
        staleSinceMs: null,
        reason: String(data?.rt?.reason || "scheduled_only"),
      };
    }
    setEmbedAwareNoticeHint(rtUnavailable ? t("rtTemporarilyUnavailable") : "");
    // Reset consecutive 204 counter on successful response
    if (consecutive204Count > 0 && DEBUG_RT_CLIENT) {
      // eslint-disable-next-line no-console
      console.log("[MesDeparts][rt-refresh] Reset consecutive 204 counter on successful fetch");
    }
    consecutive204Count = 0;
    lastFullRefreshAt = Date.now();

    const renderData = data;
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
    // Always clear the visible hint before any early return so no terminal
    // path (queued follow-up, superseded/stale request) can leave it stuck.
    if (showLoadingHint) {
      setEmbedAwareLoadingHint(false);
    }
    if (pendingRefreshRequest) {
      const queued = pendingRefreshRequest;
      pendingRefreshRequest = null;
      setTimeout(() => {
        refreshDepartures(queued);
      }, 0);
      return;
    }
    if (staleRequest) {
      if (fromScheduler) {
        scheduleNextRefresh({ useBackoff: false });
      }
      return;
    }
    if (tbody) {
      tbody.removeAttribute("aria-busy");
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

function installDebugHardRefreshShortcut() {
  if (!DEBUG_RT_CLIENT || typeof window === "undefined") return;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!(event.altKey && event.shiftKey && event.code === "KeyR")) return;
      event.preventDefault();
      refreshDepartures({
        showLoadingHint: false,
        forceDowngrade: true,
        forceFetch: true,
      });
    },
    { passive: false }
  );
}

// --------------------------------------------------------
// Boot
// --------------------------------------------------------

(async function boot() {
  const bootStart = DEBUG_PERF ? performance.now() : 0;
  markEmbedIfNeeded();
  const lang = initI18n();
  appState.language = lang;
  const networkMapConfig = await initNetworkMapConfig();
  appState.networkPaletteRules =
    networkMapConfig && typeof networkMapConfig.paletteRules === "object"
      ? networkMapConfig.paletteRules
      : {};

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
  installDebugHardRefreshShortcut();

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
    window.addEventListener("focus", handleWindowFocus, { passive: true });
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

  // Auto-reload when the service worker installs a new version.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "SW_UPDATED") setTimeout(() => location.reload(), 100);
    });
  }

  // Auto-reload when iOS restores a frozen page from bfcache (bypasses the SW entirely).
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });
})().catch((err) => {
  console.error("[MesDeparts] boot failed", err);
});
