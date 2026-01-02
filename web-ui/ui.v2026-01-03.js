// ui.js
// --------------------------------------------------------
// UI: clock, table render, filters, station search, view toggle
// --------------------------------------------------------

import {
  appState,
  VIEW_MODE_TIME,
  VIEW_MODE_LINE,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
  API_MODE_BOARD,
  API_MODE_DIRECT,
  API_MODE_STORAGE_KEY,
  API_MODE_AUTO_OFF_KEY,
} from "./state.v2026-01-03.js";
import {
  fetchStationSuggestions,
  fetchStationsNearby,
  fetchJourneyDetails,
  parseApiDate,
} from "./logic.v2026-01-03.js";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  clearFavorites,
} from "./favourites.v2026-01-03.js";
import { t } from "./i18n.v2026-01-03.js";

const QUICK_CONTROLS_STORAGE_KEY = "mesdeparts.quickControlsCollapsed";
let quickControlsCollapsed = false;
let quickControlsInitialized = false;

const pad2 = (n) => String(n).padStart(2, "0");
const CH_TIMEZONE = "Europe/Zurich";
const CH_FORMATTER =
  typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: CH_TIMEZONE,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

function getSwissParts(date) {
  if (!CH_FORMATTER || typeof CH_FORMATTER.formatToParts !== "function") {
    return {
      year: String(date.getFullYear()),
      month: pad2(date.getMonth() + 1),
      day: pad2(date.getDate()),
      hour: pad2(date.getHours()),
      minute: pad2(date.getMinutes()),
      second: pad2(date.getSeconds()),
    };
  }

  const parts = CH_FORMATTER.formatToParts(date);
  const out = {
    year: "0000",
    month: "00",
    day: "00",
    hour: "00",
    minute: "00",
    second: "00",
  };

  for (const part of parts) {
    if (part.type in out) out[part.type] = part.value;
  }

  return out;
}

function normalizeLineId(dep) {
  if (!dep) return null;

  // Most common flat fields
  if (typeof dep.simpleLineId === "string" && dep.simpleLineId.trim()) return dep.simpleLineId;
  if (typeof dep.line === "string" && dep.line.trim()) return dep.line;
  if (typeof dep.route === "string" && dep.route.trim()) return dep.route;

  // transport.opendata.ch / misc variants
  if (typeof dep.route_short_name === "string" && dep.route_short_name.trim()) return dep.route_short_name;
  if (typeof dep.line_id === "string" && dep.line_id.trim()) return dep.line_id;
  if (typeof dep.service_line === "string" && dep.service_line.trim()) return dep.service_line;

  // Nested objects
  if (dep.line && typeof dep.line.id === "string" && dep.line.id.trim()) return dep.line.id;
  if (dep.route && typeof dep.route.short_name === "string" && dep.route.short_name.trim()) return dep.route.short_name;
  if (dep.route && typeof dep.route.id === "string" && dep.route.id.trim()) return dep.route.id;

  return null;
}

// ---------------- DEBUG (UI) ----------------
// Enable from console: window.DEBUG_UI = true
function uiDebugEnabled() {
  try {
    return !!window.DEBUG_UI;
  } catch {
    return false;
  }
}

function uiDebugLog(...args) {
  if (!uiDebugEnabled()) return;
  console.log(...args);
}

// ---------------- LAYOUT AUTO-FIT ----------------

const LAYOUT_TIGHT_CLASS = "layout-tight";
const OVERFLOW_TOLERANCE_PX = 2;
let ensureFitFrame = null;

function isOverflowing(element) {
  if (!element) return false;
  const viewportWidth =
    typeof window !== "undefined"
      ? Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0)
      : 0;
  const rect = element.getBoundingClientRect();
  const overflowInside = element.scrollWidth - element.clientWidth;
  const overflowViewport = viewportWidth ? rect.right - viewportWidth : 0;

  return overflowInside > OVERFLOW_TOLERANCE_PX || overflowViewport > OVERFLOW_TOLERANCE_PX;
}

export function ensureBoardFitsViewport() {
  if (ensureFitFrame) cancelAnimationFrame(ensureFitFrame);
  ensureFitFrame = requestAnimationFrame(() => {
    const body = document.body;
    const board = document.querySelector(".board");
    if (!body || !board) return;

    // Disable auto-zoom/scale; just ensure we are not in tight mode
    body.classList.remove(LAYOUT_TIGHT_CLASS);
  });
}

export function setupAutoFitWatcher() {
  window.addEventListener(
    "resize",
    () => {
      ensureBoardFitsViewport();
    },
    { passive: true }
  );
}

// ---------------- FAVORITES (UI) ----------------

const FAV_CLEAR_VALUE = "__clear__";

function getFavToggleEl() {
  return document.getElementById("station-fav-toggle");
}

function getFavSelectEl() {
  return document.getElementById("favorites-select");
}

function setFavToggleVisual(isOn) {
  const btn = getFavToggleEl();
  if (!btn) return;

  const icon = btn.querySelector(".fav-toggle__icon");
  if (icon) {
    icon.textContent = isOn ? "★" : "☆";
  } else {
    btn.textContent = isOn ? "★" : "☆";
  }
  btn.setAttribute("aria-pressed", isOn ? "true" : "false");
}

function refreshFavToggleFromState() {
  const id = appState.stationId;
  if (!id) {
    setFavToggleVisual(false);
    return;
  }
  setFavToggleVisual(isFavorite(id));
}

function renderFavoritesSelect(selectedId) {
  const sel = getFavSelectEl();
  if (!sel) return;

  const favs = loadFavorites();

  sel.innerHTML = "";

  // Placeholder
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = t("filterFavoritesTitle");
  sel.appendChild(opt0);

  // Items
  for (const f of favs) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }

  // Clear action
  if (favs.length) {
    const optClear = document.createElement("option");
    optClear.value = FAV_CLEAR_VALUE;
    optClear.textContent = "Effacer favoris…";
    sel.appendChild(optClear);
  }

  // Select current station if it exists in favourites
  if (selectedId && favs.some((f) => f.id === selectedId)) {
    sel.value = selectedId;
  } else {
    sel.value = "";
  }
}

function setStationSelection(name, id, onStationPicked) {
  // State
  if (typeof name === "string" && name.trim()) {
    appState.STATION = name.trim();
  }
  if (typeof id === "string" && id.trim()) {
    appState.stationId = id.trim();
  } else {
    appState.stationId = null;
  }

  // UI
  updateStationTitle();
  refreshFavToggleFromState();
  renderFavoritesSelect(appState.stationId);

  // Callback (backward-compatible): call with (name, id) if consumer supports it
  if (typeof onStationPicked === "function") {
    try {
      if (onStationPicked.length >= 2) onStationPicked(appState.STATION, appState.stationId);
      else onStationPicked(appState.STATION);
    } catch (e) {
      console.error("[MesDeparts][ui] onStationPicked error", e);
    }
  }

  // After a station change, the app (main.js) recalculates appState.stationIsMotte.
  // Ensure the view dropdown options are rebuilt so “Vue : Descendre” only appears for Motte.
  try {
    if (typeof appState._ensureViewSelectOptions === "function") {
      appState._ensureViewSelectOptions();
    }
  } catch (e) {
    console.warn("[MesDeparts][ui] _ensureViewSelectOptions failed", e);
  }

  // Keep filters visibility consistent with the current view/station.
  try {
    updateFiltersVisibility();
  } catch (_) {}
}

function buildTrainLabel(category, rawNumber) {
  const catRaw = (category || "").toUpperCase().trim();
  // Normalize category: keep only leading letters (e.g. "IR 95" -> "IR", "IC1" -> "IC")
  const cat = (catRaw.match(/^[A-Z]+/) || [""])[0];
  const raw = (rawNumber || "").trim();

  // Keep digits only (e.g. "001743" -> "1743", "17 05" -> "1705")
  const digitsOnly = raw.replace(/\D/g, "");
  const num = digitsOnly.replace(/^0+/, "");

  // "short" = 1..3 digits max (95, 170, 502)
  const hasShortNum = num.length > 0 && num.length <= 3;

  const isLongDistance = ["IC", "IR", "EC", "EN", "ICE", "RJ", "RJX"].includes(cat);
  const isRE = cat === "RE";
  const isRegio = cat === "R" || cat === "S" || cat === "SN";

  // Long distance: show only category if the number is unusable
  if (isLongDistance) {
    if (!hasShortNum) return { label: cat || "–", isSoloLongDistance: true };
    return { label: `${cat} ${num}`, isSoloLongDistance: false };
  }

  // RegioExpress (RE 33)
  if (isRE) {
    if (!hasShortNum) return { label: "RE", isSoloLongDistance: false };
    return { label: `RE ${num}`, isSoloLongDistance: false };
  }

  // Regio / S-Bahn (R 3, S 41)
  if (isRegio) {
    if (!num) return { label: cat || "–", isSoloLongDistance: false };
    return { label: `${cat} ${num}`, isSoloLongDistance: false };
  }

  // Fallback
  if (cat && hasShortNum) return { label: `${cat} ${num}`, isSoloLongDistance: false };
  if (cat) return { label: cat, isSoloLongDistance: false };
  if (hasShortNum) return { label: num, isSoloLongDistance: false };
  return { label: "–", isSoloLongDistance: false };
}

// ---------------- CLOCK ----------------

export function setupClock() {
  const el = document.getElementById("digital-clock");
  if (!el) return;

  function tick() {
    const now = new Date();
    const parts = getSwissParts(now);
    el.textContent = `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function scheduleTick() {
    tick();
    const delay = 1000 - (Date.now() % 1000);
    setTimeout(scheduleTick, delay);
  }

  scheduleTick();
}

// ---------------- STATION TITLE ----------------

export function updateStationTitle() {
  const title = document.getElementById("station-title");
  if (title) title.textContent = appState.STATION || "Station";

  const input = document.getElementById("station-input");
  if (input && !input.value) input.value = appState.STATION || "";

  ensureBoardFitsViewport();
}

export function setBoardLoadingState(isLoading) {
  const hint = document.getElementById("loading-hint");
  if (!hint) return;

  if (isLoading) {
    hint.textContent = t("loadingDepartures");
    hint.classList.add("is-visible");
  } else {
    hint.textContent = "";
    hint.classList.remove("is-visible");
  }
}

// ---------------- QUICK CONTROLS COLLAPSE ----------------

function getQuickControlsEls() {
  return {
    toggle: document.getElementById("quick-controls-toggle"),
    label: document.getElementById("quick-controls-toggle-label"),
    panel: document.getElementById("station-card-collapsible"),
  };
}

function applyStationCollapse(panel, collapsed, immediate = false) {
  if (!panel) return;
  const card = panel.closest(".station-card");
  const setCardState = () => {
    if (card) card.classList.toggle("station-card--collapsed", collapsed);
  };

  const finalize = () => {
    if (quickControlsCollapsed !== collapsed) {
      panel.removeEventListener("transitionend", finalize);
      return;
    }
    panel.style.height = "";
    panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
    panel.removeEventListener("transitionend", finalize);
    setCardState();
  };

  if (immediate) {
    panel.classList.toggle("is-collapsed", collapsed);
    panel.style.height = collapsed ? "0px" : "";
    panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
    setCardState();
    return;
  }

  setCardState();

  if (collapsed) {
    const start = panel.scrollHeight;
    panel.style.height = `${start}px`;
    panel.classList.add("is-collapsed");
    // force reflow before collapsing
    void panel.offsetHeight;
    panel.style.height = "0px";
  } else {
    panel.style.height = "0px";
    panel.classList.remove("is-collapsed");
    const target = panel.scrollHeight || 0;
    void panel.offsetHeight;
    panel.style.height = `${target}px`;
  }

  panel.addEventListener("transitionend", finalize);
}

function renderQuickControlsCollapsedState() {
  const { toggle, label, panel } = getQuickControlsEls();
  if (panel) {
    applyStationCollapse(panel, quickControlsCollapsed, !quickControlsInitialized);
    quickControlsInitialized = true;
  }
  if (label) {
    label.textContent = t(quickControlsCollapsed ? "quickControlsShow" : "quickControlsHide");
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", quickControlsCollapsed ? "false" : "true");
    toggle.classList.toggle("is-collapsed", quickControlsCollapsed);
    if (label) toggle.setAttribute("aria-label", label.textContent);
  }
}

function setQuickControlsCollapsed(nextState) {
  quickControlsCollapsed = !!nextState;
  renderQuickControlsCollapsedState();
  try {
    localStorage.setItem(QUICK_CONTROLS_STORAGE_KEY, quickControlsCollapsed ? "1" : "0");
  } catch {
    // ignore storage errors
  }
  ensureBoardFitsViewport();
}

export function setupQuickControlsCollapse() {
  const { toggle, panel } = getQuickControlsEls();
  if (!toggle || !panel) return;

  try {
    quickControlsCollapsed = localStorage.getItem(QUICK_CONTROLS_STORAGE_KEY) === "1";
  } catch {
    quickControlsCollapsed = false;
  }

  renderQuickControlsCollapsedState();

  toggle.addEventListener("click", () => {
    setQuickControlsCollapsed(!quickControlsCollapsed);
  });
}

// ---------------- VIEW MODE BUTTON ----------------

function viewModeLabel(mode) {
  if (mode === VIEW_MODE_TIME) return t("viewOptionTime");
  if (mode === VIEW_MODE_LINE) return t("viewOptionLine");
  return t("viewLabelFallback");
}

function trainFilterLabel(filter) {
  if (filter === TRAIN_FILTER_REGIONAL) return t("trainFilterRegional");
  if (filter === TRAIN_FILTER_LONG_DISTANCE) return t("trainFilterLongDistance");
  return t("trainFilterAll");
}

export function setupViewToggle(onChange) {
  const segment = document.getElementById("view-segment");
  const sel = document.getElementById("view-select");
  const legacyBtn = document.getElementById("filter-toggle");

  const trainOptions = [
    { v: TRAIN_FILTER_ALL, t: () => t("trainFilterAll") },
    { v: TRAIN_FILTER_REGIONAL, t: () => t("trainFilterRegional") },
    { v: TRAIN_FILTER_LONG_DISTANCE, t: () => t("trainFilterLongDistance") },
  ];

  const busOptions = [
    { v: VIEW_MODE_LINE, t: () => t("viewOptionLine") },
    { v: VIEW_MODE_TIME, t: () => t("viewOptionTime") },
  ];

  function setTrainFilter(next) {
    const allowed = [TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE];
    if (!allowed.includes(next)) return;
    if (appState.trainServiceFilter === next) return;
    appState.trainServiceFilter = next;
    renderControls();
    if (typeof onChange === "function") onChange();
  }

  function setView(mode) {
    if (mode !== VIEW_MODE_TIME && mode !== VIEW_MODE_LINE) return;
    if (appState.viewMode === mode) return;
    appState.viewMode = mode;
    renderControls();
    updateFiltersVisibility();
    if (typeof onChange === "function") onChange();
  }

  function renderSegment(options, activeValue, isTrainBoard) {
    if (!segment) return;
    segment.innerHTML = "";
    options.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "segmented-btn";
      b.dataset.option = o.v;
      const isActive = o.v === activeValue;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-pressed", isActive ? "true" : "false");
      b.textContent = o.t();
      b.addEventListener("click", () => {
        if (isTrainBoard) setTrainFilter(o.v);
        else setView(o.v);
      });
      segment.appendChild(b);
    });
  }

  function renderSelect(options, activeValue, isTrainBoard) {
    if (!sel) return;
    sel.innerHTML = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.t();
      sel.appendChild(opt);
    }
    sel.value = activeValue;
    sel.dataset.viewType = isTrainBoard ? "train" : "bus";
  }

  function renderLegacy(options, activeValue, isTrainBoard) {
    if (!legacyBtn) return;
    const labelEl = legacyBtn.querySelector(".filter-label");
    const activeLabel = isTrainBoard ? trainFilterLabel(activeValue) : viewModeLabel(activeValue);
    if (labelEl) labelEl.textContent = activeLabel;
    else legacyBtn.textContent = activeLabel;
    legacyBtn.classList.remove("is-hidden");
  }

  function renderControls() {
    const isTrainBoard = !!appState.lastBoardIsTrain;
    const options = isTrainBoard ? trainOptions : busOptions;
    const active = isTrainBoard
      ? appState.trainServiceFilter || TRAIN_FILTER_ALL
      : appState.viewMode || VIEW_MODE_LINE;

    renderSegment(options, active, isTrainBoard);
    renderSelect(options, active, isTrainBoard);
    renderLegacy(options, active, isTrainBoard);
  }

  if (!appState.viewMode) appState.viewMode = VIEW_MODE_LINE;
  if (!appState.trainServiceFilter) appState.trainServiceFilter = TRAIN_FILTER_ALL;

  if (sel) {
    appState.viewSelect = sel;
    sel.addEventListener("change", () => {
      const isTrainBoard = sel.dataset.viewType === "train" || appState.lastBoardIsTrain;
      const val = sel.value;
      if (isTrainBoard) setTrainFilter(val);
      else setView(val);
    });

    appState._ensureViewSelectOptions = () => {
      renderControls();
    };
  }

  if (legacyBtn) {
    appState.viewButton = legacyBtn;
    legacyBtn.addEventListener("click", () => {
      const isTrainBoard = !!appState.lastBoardIsTrain;
      if (isTrainBoard) {
        const order = [TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE];
        const idx = order.indexOf(appState.trainServiceFilter || TRAIN_FILTER_ALL);
        const next = order[(idx + 1) % order.length];
        setTrainFilter(next);
      } else {
        const next = appState.viewMode === VIEW_MODE_TIME ? VIEW_MODE_LINE : VIEW_MODE_TIME;
        setView(next);
      }
    });
  }

  renderControls();
  appState._renderViewControls = renderControls;
  updateFiltersVisibility();
}

// ---------------- FILTERS (platform + line) ----------------

const filterUi = {
  openBtn: null,
  label: null,
  count: null,
  quickReset: null,
  sheet: null,
  resetBtn: null,
  applyBtn: null,
  platformChips: null,
  lineChips: null,
  favoritesChips: null,
  favoritesEmpty: null,
  platformEmpty: null,
  lineEmpty: null,
  favoritesSwitch: null,
  manageFavorites: null,
  favPopover: null,
  favQuickToggle: null,
  platformSelect: null,
  lineSelect: null,
  hideDepartureToggle: null,
};

const filterPending = {
  platforms: [],
  lines: [],
  hideDeparture: false,
};

// ---------------- BOARD MODE (API) ----------------

const boardModeUi = {
  toggle: null,
  label: null,
  state: null,
  popover: null,
  okBtn: null,
};

function isBoardModeActive() {
  return appState.apiMode !== API_MODE_DIRECT;
}

function updateBoardModeToggleUi() {
  if (!boardModeUi.toggle) return;
  const active = isBoardModeActive();
  boardModeUi.toggle.classList.toggle("is-active", active);
  boardModeUi.toggle.setAttribute("aria-pressed", active ? "true" : "false");
  if (boardModeUi.label) boardModeUi.label.textContent = t("boardModeLabel");
  if (boardModeUi.state) {
    boardModeUi.state.textContent = t(active ? "boardModeStateOn" : "boardModeStateOff");
  }
}

function openBoardModePopover() {
  if (!boardModeUi.popover) return;
  boardModeUi.popover.classList.remove("is-hidden");
  boardModeUi.popover.setAttribute("aria-hidden", "false");
  if (boardModeUi.toggle) boardModeUi.toggle.setAttribute("aria-expanded", "true");
}

function closeBoardModePopover() {
  if (!boardModeUi.popover) return;
  boardModeUi.popover.classList.add("is-hidden");
  boardModeUi.popover.setAttribute("aria-hidden", "true");
  if (boardModeUi.toggle) boardModeUi.toggle.setAttribute("aria-expanded", "false");
}

function isBoardModePopoverOpen() {
  return boardModeUi.popover && !boardModeUi.popover.classList.contains("is-hidden");
}

export function refreshBoardModeToggleUi() {
  updateBoardModeToggleUi();
}

export function maybeShowBoardModePopover() {
  openBoardModePopover();
}

export function setupBoardModeToggle(onChange) {
  boardModeUi.toggle = document.getElementById("board-mode-toggle");
  boardModeUi.label = document.getElementById("board-mode-label");
  boardModeUi.state = document.getElementById("board-mode-state");
  boardModeUi.popover = document.getElementById("board-mode-popover");
  boardModeUi.okBtn = document.getElementById("board-mode-ok");

  if (!boardModeUi.toggle) return;

  if (boardModeUi.popover) {
    boardModeUi.popover.setAttribute("aria-hidden", "true");
    boardModeUi.popover.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.boardPopoverClose === "true") {
        closeBoardModePopover();
      }
    });
  }

  updateBoardModeToggleUi();
  boardModeUi.toggle.setAttribute("aria-expanded", "false");

  boardModeUi.toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFavoritesPopover();
    closeFiltersSheet(false);

    const next = isBoardModeActive() ? API_MODE_DIRECT : API_MODE_BOARD;
    appState.apiMode = next;
    try {
      localStorage.setItem(API_MODE_STORAGE_KEY, next);
      if (next === API_MODE_DIRECT) {
        localStorage.setItem(API_MODE_AUTO_OFF_KEY, "1");
      } else {
        localStorage.removeItem(API_MODE_AUTO_OFF_KEY);
      }
    } catch {
      // ignore
    }
    updateBoardModeToggleUi();

    if (typeof onChange === "function") onChange(next);

    maybeShowBoardModePopover();
  });

  if (boardModeUi.okBtn) {
    boardModeUi.okBtn.addEventListener("click", () => {
      closeBoardModePopover();
    });
  }

  document.addEventListener("click", (e) => {
    if (
      isBoardModePopoverOpen() &&
      boardModeUi.popover &&
      !boardModeUi.popover.contains(e.target) &&
      (!boardModeUi.toggle || !boardModeUi.toggle.contains(e.target))
    ) {
      closeBoardModePopover();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isBoardModePopoverOpen()) {
      closeBoardModePopover();
    }
  });
}

const selectedFavorites = new Set();
let favoritesManageMode = false;

let filterSheetOpen = false;
let favoritesPopoverOpen = false;
let filtersOnChange = null;

function updateFavoritesDeleteState() {
  if (!filterUi.favoritesDelete) return;
  const canDelete = favoritesManageMode && selectedFavorites.size > 0;
  filterUi.favoritesDelete.disabled = !canDelete;
}

function updateFavoritesManageUi() {
  if (filterUi.manageFavorites) {
    filterUi.manageFavorites.textContent = favoritesManageMode
      ? t("favoritesManageDone")
      : t("filterManageFavorites");
    filterUi.manageFavorites.classList.toggle("is-active", favoritesManageMode);
  }
  if (filterUi.favPopover) {
    filterUi.favPopover.classList.toggle("favorites-manage-mode", favoritesManageMode);
  }
  if (filterUi.favoritesChips) {
    filterUi.favoritesChips.classList.toggle("favorites-manage-mode", favoritesManageMode);
  }
  updateFavoritesDeleteState();
}

function setFavoritesManageMode(on) {
  favoritesManageMode = !!on;
  if (!favoritesManageMode) {
    selectedFavorites.clear();
  }
  updateFavoritesManageUi();
  if (typeof appState._renderFavoritesPopover === "function") {
    appState._renderFavoritesPopover();
  }
}

function openFavoritesPopover() {
  if (!filterUi.favPopover) return;
  favoritesPopoverOpen = true;
  filterUi.favPopover.classList.remove("is-hidden");
  filterUi.favPopover.setAttribute("aria-hidden", "false");
  setFavoritesManageMode(false);
  updateFavoritesToggleUi();
}

function closeFavoritesPopover() {
  if (!filterUi.favPopover) return;
  favoritesPopoverOpen = false;
  filterUi.favPopover.classList.add("is-hidden");
  filterUi.favPopover.setAttribute("aria-hidden", "true");
  setFavoritesManageMode(false);
  updateFavoritesToggleUi();
}

function applyPendingFilters() {
  appState.platformFilter = filterPending.platforms.length ? filterPending.platforms.slice() : null;
  appState.lineFilter = filterPending.lines.length ? filterPending.lines.slice() : null;
  appState.hideBusDeparture = !!filterPending.hideDeparture;
  applyFiltersToLegacySelects();
  updateFilterButtonState();
  if (typeof filtersOnChange === "function") filtersOnChange();
}

function normalizeFilterArray(val, allowed) {
  const arr = Array.isArray(val)
    ? val.filter(Boolean)
    : val
      ? [val]
      : [];

  const unique = Array.from(new Set(arr));
  if (!Array.isArray(allowed) || !allowed.length) return unique;

  const allowedSet = new Set(allowed);
  // Preserve the order of the allowed list
  return allowed.filter((v) => allowedSet.has(v) && unique.includes(v));
}

function setSelectOptions(selectEl, options, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = placeholder;
  selectEl.appendChild(opt0);

  for (const val of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    selectEl.appendChild(opt);
  }
}

function applyFiltersToLegacySelects() {
  if (filterUi.platformSelect) {
    const val = Array.isArray(appState.platformFilter)
      ? appState.platformFilter[0] || ""
      : appState.platformFilter || "";
    filterUi.platformSelect.value = val;
  }
  if (filterUi.lineSelect) {
    const val = Array.isArray(appState.lineFilter)
      ? appState.lineFilter[0] || ""
      : appState.lineFilter || "";
    filterUi.lineSelect.value = val;
  }
}

// ---------------- EMBED STATE BROADCAST ----------------

export function publishEmbedState() {
  if (typeof window === "undefined" || window.parent === window) return;
  const isDualEmbed =
    document.documentElement.classList.contains("dual-embed") ||
    (document.body && document.body.classList.contains("dual-embed"));
  if (!isDualEmbed) return;

  const payload = {
    type: "md-board-state",
    station: appState.STATION || "",
    stationId: appState.stationId || null,
    isTrain: !!appState.lastBoardIsTrain,
    view: appState.lastBoardIsTrain
      ? appState.trainServiceFilter || TRAIN_FILTER_ALL
      : appState.viewMode || VIEW_MODE_LINE,
    hideDeparture: !!appState.hideBusDeparture,
    apiMode: appState.apiMode,
    favoritesOnly: !!appState.favoritesOnly,
    timestamp: Date.now(),
  };

  try {
    window.parent.postMessage(payload, "*");
  } catch {
    // ignore
  }
}

function notifyFavoritesOnlyChange() {
  try {
    if (typeof appState._favoriteFilterChanged === "function") {
      appState._favoriteFilterChanged(!!appState.favoritesOnly);
    }
  } catch (e) {
    console.warn("[MesDeparts][ui] favoritesOnly hook failed", e);
  }
}

function updateFavoritesToggleUi() {
  const active = !!appState.favoritesOnly;
  if (filterUi.favQuickToggle) {
    filterUi.favQuickToggle.classList.toggle("is-active", active);
    filterUi.favQuickToggle.setAttribute("aria-pressed", active ? "true" : "false");
    filterUi.favQuickToggle.setAttribute("aria-expanded", favoritesPopoverOpen ? "true" : "false");
  }
  if (filterUi.favoritesSwitch) {
    filterUi.favoritesSwitch.checked = active;
  }
}

function updateFilterButtonState() {
  const activePlatforms = normalizeFilterArray(appState.platformFilter);
  const activeLines = normalizeFilterArray(appState.lineFilter);
  const activeHideDeparture = !appState.lastBoardIsTrain && appState.hideBusDeparture;

  const parts = [];
  if (activePlatforms.length) parts.push(`${t("filterPlatformsShort")} ${activePlatforms.join(", ")}`);
  if (activeLines.length) parts.push(`${t("filterLinesShort")} ${activeLines.join(", ")}`);
  if (activeHideDeparture) parts.push(t("filterHideDepartureShort"));

  const activeCount =
    (activePlatforms.length ? 1 : 0) +
    (activeLines.length ? 1 : 0) +
    (activeHideDeparture ? 1 : 0);

  if (filterUi.label) {
    filterUi.label.textContent = parts.length ? parts.join(" • ") : t("filterButton");
  }

  if (filterUi.openBtn) {
    filterUi.openBtn.classList.toggle("is-active", activeCount > 0);
  }

  if (filterUi.quickReset) {
    if (activeCount > 0) filterUi.quickReset.classList.remove("is-hidden");
    else filterUi.quickReset.classList.add("is-hidden");
  }
}

function applyLineBadgeFilter(lineId) {
  const cleanId = String(lineId || "").trim();
  if (!cleanId) return;

  const allowed = (appState.lineOptions || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });
  if (!allowed.includes(cleanId)) return;

  const current = normalizeFilterArray(appState.lineFilter, allowed);
  const nextSet = new Set(current);
  if (nextSet.has(cleanId)) nextSet.delete(cleanId);
  else nextSet.add(cleanId);
  const next = normalizeFilterArray(Array.from(nextSet), allowed);

  appState.lineFilter = next.length ? next : null;
  filterPending.lines = normalizeFilterArray(appState.lineFilter, allowed);

  applyFiltersToLegacySelects();
  updateFilterButtonState();

  if (filterSheetOpen) {
    syncPendingFromState({ preserveSelections: true });
    renderFilterSheet();
  }

  renderLineChips(allowed);

  if (typeof filtersOnChange === "function") filtersOnChange();
}

function syncPendingFromState({ preserveSelections = false } = {}) {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  const currentPlatforms = normalizeFilterArray(appState.platformFilter, platforms);
  const currentLines = normalizeFilterArray(appState.lineFilter, lines);
  appState.platformFilter = currentPlatforms.length ? currentPlatforms : null;
  appState.lineFilter = currentLines.length ? currentLines : null;
  filterPending.hideDeparture = !!appState.hideBusDeparture;

  filterPending.platforms = preserveSelections
    ? normalizeFilterArray(filterPending.platforms, platforms)
    : currentPlatforms.slice();

  filterPending.lines = preserveSelections
    ? normalizeFilterArray(filterPending.lines, lines)
    : currentLines.slice();
}

function toggleChip(type, value) {
  const target = type === "platforms" ? filterPending.platforms : filterPending.lines;
  if (value === "__all__") {
    target.splice(0, target.length);
  } else {
    const idx = target.indexOf(value);
    if (idx >= 0) target.splice(idx, 1);
    else target.push(value);
  }
  renderFilterSheet();
  applyPendingFilters();
}

function renderFilterChips(type, options, container) {
  if (!container) return;
  container.innerHTML = "";

  const selected = type === "platforms" ? filterPending.platforms : filterPending.lines;
  if (!options.length) return;

  const clearChip = document.createElement("button");
  clearChip.type = "button";
  clearChip.className = "filter-chip";
  if (selected.length === 0) clearChip.classList.add("is-active");
  clearChip.dataset.type = type;
  clearChip.dataset.value = "__all__";
  clearChip.textContent = t("filterAll");
  clearChip.addEventListener("click", () => toggleChip(type, "__all__"));
  container.appendChild(clearChip);

  for (const val of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    if (selected.includes(val)) chip.classList.add("is-active");
    chip.dataset.type = type;
    chip.dataset.value = val;
    chip.textContent = val;
    chip.addEventListener("click", () => toggleChip(type, val));
    container.appendChild(chip);
  }
}

function updateSheetResetState() {
  const hasPending =
    filterPending.platforms.length > 0 ||
    filterPending.lines.length > 0 ||
    !!filterPending.hideDeparture;

  if (filterUi.resetBtn) {
    filterUi.resetBtn.disabled = !hasPending;
  }
}

function renderFilterSheet() {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  if (filterUi.platformEmpty) {
    filterUi.platformEmpty.classList.toggle("is-hidden", platforms.length > 0);
  }
  if (filterUi.lineEmpty) {
    filterUi.lineEmpty.classList.toggle("is-hidden", lines.length > 0);
  }

  renderFilterChips("platforms", platforms, filterUi.platformChips);
  renderFilterChips("lines", lines, filterUi.lineChips);

  if (filterUi.hideDepartureToggle) {
    filterUi.hideDepartureToggle.checked = !!filterPending.hideDeparture;
  }

  updateSheetResetState();
}

function openFiltersSheet() {
  if (!filterUi.sheet) return;
  filterSheetOpen = true;
  if ("inert" in filterUi.sheet) {
    filterUi.sheet.inert = false;
  }
  filterUi.sheet.classList.remove("is-hidden");
  filterUi.sheet.setAttribute("aria-hidden", "false");
  if (filterUi.openBtn) filterUi.openBtn.setAttribute("aria-expanded", "true");
  syncPendingFromState();
  renderFilterSheet();
}

function closeFiltersSheet(applyChanges = false) {
  if (applyChanges) {
    applyPendingFilters();
  } else {
    syncPendingFromState();
  }

  if (filterUi.sheet) {
    const active = document.activeElement;
    if (active && filterUi.sheet.contains(active)) {
      if (filterUi.openBtn && typeof filterUi.openBtn.focus === "function") {
        filterUi.openBtn.focus();
      } else if (typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
    }
    if ("inert" in filterUi.sheet) {
      filterUi.sheet.inert = true;
    }
    filterUi.sheet.classList.add("is-hidden");
    filterUi.sheet.setAttribute("aria-hidden", "true");
  }
  if (filterUi.openBtn) filterUi.openBtn.setAttribute("aria-expanded", "false");

  filterSheetOpen = false;
  updateFavoritesToggleUi();
}

function resetAppliedFilters() {
  filterPending.platforms = [];
  filterPending.lines = [];
  filterPending.hideDeparture = false;
  closeFiltersSheet(true);
}

function updateFiltersVisibility() {
  const platformSel = filterUi.platformSelect || document.getElementById("platform-filter");
  const platWrap = platformSel ? platformSel.closest(".platform-filter-container") : null;
  const lineSelect = filterUi.lineSelect || document.getElementById("line-filter");
  const lineWrap = lineSelect ? lineSelect.closest(".line-filter-container") : null;

  const hideBecauseView = false;
  const hideBecauseTrain = appState.lastBoardIsTrain;
  const hasPlatforms = (appState.platformOptions || []).length > 0;
  const displaySection = document.getElementById("filters-section-display");
  const showDisplay = !hideBecauseTrain;

  const showPlatform =
    !hideBecauseView &&
    !hideBecauseTrain &&
    appState.lastBoardHasBus &&
    appState.lastBoardHasBusPlatform &&
    hasPlatforms;

  const showLine =
    !hideBecauseView && !hideBecauseTrain && appState.lastBoardHasBus;

  if (platWrap) platWrap.style.display = showPlatform ? "" : "none";
  if (!showPlatform && platformSel) {
    platformSel.value = "";
    appState.platformFilter = null;
    filterPending.platforms = [];
  }
  if (lineWrap) lineWrap.style.display = showLine ? "" : "none";
  if (!showLine) {
    appState.lineFilter = null;
    filterPending.lines = [];
  }

  if (!showDisplay) {
    appState.hideBusDeparture = false;
    filterPending.hideDeparture = false;
  }

  if (displaySection) displaySection.style.display = showDisplay ? "" : "none";

  const filtersAvailable = showPlatform || showLine || showDisplay;
  if (filterUi.openBtn) {
    filterUi.openBtn.disabled = !filtersAvailable;
    filterUi.openBtn.style.opacity = filtersAvailable ? "1" : "0.65";
  }
  if (!filtersAvailable && filterSheetOpen) {
    closeFiltersSheet(false);
  }

  const platformSection = document.getElementById("filters-section-platforms");
  const lineSection = document.getElementById("filters-section-lines");
  if (platformSection) platformSection.style.display = showPlatform ? "" : "none";
  if (lineSection) lineSection.style.display = showLine ? "" : "none";

  updateFilterButtonState();
}

export function setupFilters(onChange) {
  filtersOnChange = onChange;
  filterUi.openBtn = document.getElementById("filters-open");
  filterUi.label = document.getElementById("filters-open-label");
  filterUi.quickReset = document.getElementById("filters-reset-inline");
  filterUi.sheet = document.getElementById("filters-popover");
  filterUi.resetBtn = document.getElementById("filters-reset");
  filterUi.applyBtn = document.getElementById("filters-apply");
  filterUi.platformChips = document.getElementById("platform-chip-list");
  filterUi.lineChips = document.getElementById("line-chip-list");
  filterUi.favoritesChips = document.getElementById("favorites-chip-list");
  filterUi.favoritesEmpty = document.getElementById("favorites-empty");
  filterUi.platformEmpty = document.getElementById("platforms-empty");
  filterUi.lineEmpty = document.getElementById("lines-empty");
  filterUi.favoritesSwitch = null;
  filterUi.manageFavorites = document.getElementById("favorites-manage");
  filterUi.favoritesDelete = document.getElementById("favorites-delete");
  filterUi.favPopover = document.getElementById("favorites-popover");
  filterUi.favQuickToggle = document.getElementById("favorites-only-toggle");
  filterUi.platformSelect = document.getElementById("platform-filter");
  filterUi.lineSelect = document.getElementById("line-filter");
  filterUi.hideDepartureToggle = document.getElementById("filters-hide-departure");
  const selectInteraction = { platform: false, line: false };
  if (filterUi.favPopover) {
    filterUi.favPopover.setAttribute("aria-hidden", "true");
  }
  if (filterUi.openBtn) {
    filterUi.openBtn.setAttribute("aria-expanded", "false");
  }

  if (typeof appState._setFavoritesOnly !== "function") {
    appState._setFavoritesOnly = (val) => {
      appState.favoritesOnly = !!val;
      updateFavoritesToggleUi();
      notifyFavoritesOnlyChange();
    };
  }

  if (filterUi.openBtn) {
    filterUi.openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFavoritesPopover();
      if (filterSheetOpen) closeFiltersSheet(false);
      else openFiltersSheet();
    });
  }

  if (filterUi.quickReset) {
    filterUi.quickReset.addEventListener("click", () => resetAppliedFilters());
  }

  if (filterUi.sheet) {
    filterUi.sheet.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.filterPopoverClose === "true") {
        closeFiltersSheet(false);
      }
    });
  }

  if (filterUi.resetBtn) {
    filterUi.resetBtn.addEventListener("click", () => resetAppliedFilters());
  }

  if (filterUi.applyBtn) {
    filterUi.applyBtn.addEventListener("click", () => closeFiltersSheet(true));
  }

  if (filterUi.hideDepartureToggle) {
    filterUi.hideDepartureToggle.addEventListener("change", () => {
      filterPending.hideDeparture = !!filterUi.hideDepartureToggle.checked;
      renderFilterSheet();
    });
  }

  if (filterUi.favQuickToggle) {
    filterUi.favQuickToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (favoritesPopoverOpen) closeFavoritesPopover();
      else openFavoritesPopover();
    });
  }

  if (filterUi.manageFavorites) {
    filterUi.manageFavorites.addEventListener("click", () => {
      setFavoritesManageMode(!favoritesManageMode);
    });
  }

  if (filterUi.favoritesDelete) {
    filterUi.favoritesDelete.addEventListener("click", () => {
      if (selectedFavorites.size === 0) return;
      const ok = window.confirm(t("favoritesDeleteConfirm"));
      if (!ok) return;

      const favs = loadFavorites();
      for (const id of Array.from(selectedFavorites)) {
        const exists = favs.find((f) => f.id === id);
        if (exists) removeFavorite(id);
      }
      selectedFavorites.clear();
      renderFavoritesSelect(appState.stationId);
      refreshFavToggleFromState();
      renderFavoriteChipsList();
      updateFavoritesDeleteState();
      if (loadFavorites().length === 0) {
        applyFavoritesOnlyMode(false);
      }
    });
  }

  if (filterUi.favPopover) {
    filterUi.favPopover.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.favPopoverClose === "true") {
        closeFavoritesPopover();
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (
      favoritesPopoverOpen &&
      filterUi.favPopover &&
      !filterUi.favPopover.contains(e.target) &&
      (!filterUi.favQuickToggle || !filterUi.favQuickToggle.contains(e.target))
    ) {
      closeFavoritesPopover();
    }

    if (
      filterSheetOpen &&
      filterUi.sheet &&
      !filterUi.sheet.contains(e.target) &&
      (!filterUi.openBtn || !filterUi.openBtn.contains(e.target))
    ) {
      closeFiltersSheet(false);
    }
  });

  if (filterUi.platformSelect) {
    const mark = () => { selectInteraction.platform = true; };
    filterUi.platformSelect.addEventListener("pointerdown", mark);
    filterUi.platformSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) mark();
    });
    filterUi.platformSelect.addEventListener("change", () => {
      if (!selectInteraction.platform) {
        // Guard against iOS restoring a stale <select> value without user interaction.
        filterUi.platformSelect.value = "";
        appState.platformFilter = null;
        filterPending.platforms = [];
        updateFilterButtonState();
        if (typeof filtersOnChange === "function") filtersOnChange();
        return;
      }
      selectInteraction.platform = false;
      const v = filterUi.platformSelect.value;
      appState.platformFilter = v ? [v] : null;
      filterPending.platforms = normalizeFilterArray(appState.platformFilter, appState.platformOptions);
      updateFilterButtonState();
      if (typeof filtersOnChange === "function") filtersOnChange();
    });
  }

  if (filterUi.lineSelect) {
    const mark = () => { selectInteraction.line = true; };
    filterUi.lineSelect.addEventListener("pointerdown", mark);
    filterUi.lineSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) mark();
    });
    filterUi.lineSelect.addEventListener("change", () => {
      if (!selectInteraction.line) {
        // Guard against iOS restoring a stale <select> value without user interaction.
        filterUi.lineSelect.value = "";
        appState.lineFilter = null;
        filterPending.lines = [];
        updateFilterButtonState();
        if (typeof filtersOnChange === "function") filtersOnChange();
        return;
      }
      selectInteraction.line = false;
      const v = filterUi.lineSelect.value;
      appState.lineFilter = v ? [v] : null;
      filterPending.lines = normalizeFilterArray(appState.lineFilter, appState.lineOptions);
      updateFilterButtonState();
      if (typeof filtersOnChange === "function") filtersOnChange();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (filterSheetOpen) closeFiltersSheet(false);
      if (favoritesPopoverOpen) closeFavoritesPopover();
    }
  });

  syncPendingFromState();
  applyFiltersToLegacySelects();
  updateFavoritesManageUi();
  updateFavoritesToggleUi();
  updateFilterButtonState();
  updateFiltersVisibility();
}

export function renderFilterOptions() {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  if (filterUi.platformSelect) setSelectOptions(filterUi.platformSelect, platforms, t("filterPlatforms"));
  if (filterUi.lineSelect) setSelectOptions(filterUi.lineSelect, lines, t("filterLines"));

  // sanitize applied filters against available options
  appState.platformFilter = normalizeFilterArray(appState.platformFilter, platforms);
  if (appState.platformFilter.length === 0) appState.platformFilter = null;

  appState.lineFilter = normalizeFilterArray(appState.lineFilter, lines);
  if (appState.lineFilter.length === 0) appState.lineFilter = null;

  if (!filterSheetOpen) {
    filterPending.platforms = normalizeFilterArray(appState.platformFilter, platforms);
    filterPending.lines = normalizeFilterArray(appState.lineFilter, lines);
  } else {
    syncPendingFromState({ preserveSelections: true });
  }

  applyFiltersToLegacySelects();
  updateFiltersVisibility();
  updateFilterButtonState();

  if (filterSheetOpen) renderFilterSheet();

  renderLineChips(lines);
}

// ---------------- STATION SEARCH ----------------

export function setupStationSearch(onStationPicked) {
  const input = document.getElementById("station-input");
  const list = document.getElementById("station-suggestions");
  const btn = document.getElementById("station-search-btn");
  const geoBtn = btn; // single button handles geolocation
  const favBtn = getFavToggleEl();
  const favSel = getFavSelectEl();
  const favoritesChipList = filterUi.favoritesChips;
  const favoritesEmpty = filterUi.favoritesEmpty;

  if (!input || !list) return;

  let lastQuery = "";
  let active = [];
  let favoritesOnly = !!appState.favoritesOnly;

  function renderFavoriteChipsList() {
    if (!favoritesChipList) return;

    const favs = loadFavorites();
    favoritesChipList.innerHTML = "";
    favoritesChipList.classList.toggle("favorites-manage-mode", favoritesManageMode);

    if (favoritesEmpty) {
      favoritesEmpty.classList.toggle("is-hidden", favs.length > 0);
    }

    if (!favs.length) {
      updateFavoritesDeleteState();
      return;
    }

    for (const f of favs) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.id = f.id;

      const content = document.createElement("span");
      content.className = "favorite-chip__content";

      const nameSpan = document.createElement("span");
      nameSpan.className = "favorite-chip__name";
      nameSpan.textContent = f.name;
      nameSpan.addEventListener("click", (e) => {
        e.preventDefault();
        if (favoritesManageMode) return;
        setStationSelection(f.name, f.id, onStationPicked);
        closeFavoritesPopover();
      });

      chip.addEventListener("click", (e) => {
        if (favoritesManageMode) return;
        e.preventDefault();
        setStationSelection(f.name, f.id, onStationPicked);
        closeFavoritesPopover();
      });

      const select = document.createElement("span");
      select.className = "favorite-chip__select";
      select.style.display = favoritesManageMode ? "inline-flex" : "none";

      const isSel = favoritesManageMode && selectedFavorites.has(f.id);
      if (isSel) {
        chip.classList.add("is-active");
        select.textContent = "✕";
      } else {
        select.textContent = " ";
      }

      select.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!favoritesManageMode) return;
        if (selectedFavorites.has(f.id)) {
          selectedFavorites.delete(f.id);
          chip.classList.remove("is-active");
          select.textContent = " ";
        } else {
          selectedFavorites.add(f.id);
          chip.classList.add("is-active");
          select.textContent = "✕";
        }
        updateFavoritesDeleteState();
      });

      content.appendChild(nameSpan);
      content.appendChild(select);
      chip.appendChild(content);
      favoritesChipList.appendChild(chip);
    }

    updateFavoritesDeleteState();
  }

  function renderFavoriteSuggestions(query) {
    const favs = loadFavorites();
    const q = (query || "").toLowerCase();
    const filtered = favs.filter((f) => !q || (f.name || "").toLowerCase().includes(q));

    list.innerHTML = "";
    active = filtered;

    if (!filtered.length) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.textContent = t("filterNoFavorites");
      li.style.opacity = "0.75";
      list.appendChild(li);
      list.style.display = "";
      return;
    }

    list.style.display = "";

    for (const s of filtered) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.textContent = s.name;
      li.addEventListener("click", () => {
        input.value = s.name;
        clear();
        setStationSelection(s.name, s.id, onStationPicked);
      });
      list.appendChild(li);
    }
  }

  function applyFavoritesOnlyMode(next) {
    favoritesOnly = !!next;
    appState.favoritesOnly = favoritesOnly;
    updateFavoritesToggleUi();
    updateFilterButtonState();
    notifyFavoritesOnlyChange();
    if (favoritesOnly) renderFavoriteSuggestions(input.value.trim());
    else clear();
  }

  // Make it easy to overwrite the current station: select all text on focus,
  // and keep that selection even when the click started at the beginning.
  let justAutoSelected = false;
  input.addEventListener("focus", () => {
    if (input.value) {
      input.select();
      justAutoSelected = true;
    }
    if (favoritesOnly) {
      renderFavoriteSuggestions(input.value.trim());
    }
  });
  input.addEventListener("mouseup", (e) => {
    if (justAutoSelected) {
      e.preventDefault(); // keep the full selection instead of placing the caret
      justAutoSelected = false;
    }
  });

  function clear() {
    active = [];
    list.innerHTML = "";
    list.style.display = "none";
  }

  function renderStatus(text) {
    list.innerHTML = "";
    active = [];
    if (!text) {
      list.style.display = "none";
      return;
    }
    const li = document.createElement("li");
    li.className = "station-suggestion-item is-hint";
    li.textContent = text;
    list.appendChild(li);
    list.style.display = "";
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return null;
    if (meters >= 1000) {
      const km = meters / 1000;
      return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
    }
    return `${Math.round(meters)} m`;
  }

  function renderSuggestions(items) {
    list.innerHTML = "";
    active = items;

    if (!items.length) {
      list.style.display = "none";
      return;
    }

    list.style.display = "";

    for (const s of items) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = s.name;
      li.appendChild(nameSpan);

      const dist = formatDistance(typeof s.distance === "number" ? s.distance : null);
      if (dist) {
        const d = document.createElement("span");
        d.className = "station-suggestion-distance";
        d.textContent = dist;
        li.appendChild(d);
      }

      li.addEventListener("click", () => {
        input.value = s.name;
        clear();
        setStationSelection(s.name, s.id, onStationPicked);
      });
      list.appendChild(li);
    }
  }

  async function doSuggest(q) {
    if (favoritesOnly) {
      renderFavoriteSuggestions(q);
      return;
    }

    if (!q || q.length < 2) {
      clear();
      return;
    }
    lastQuery = q;
    try {
      const items = await fetchStationSuggestions(q);
      if (input.value !== lastQuery) return; // stale
      renderSuggestions(items);
    } catch (e) {
      clear();
    }
  }

  let debounceTimer = null;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSuggest(q), 180);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clear();
      const q = input.value.trim();
      if (q) setStationSelection(q, null, onStationPicked);
    } else if (e.key === "Escape") {
      clear();
    }
  });

function setGeoLoading(on) {
  if (!geoBtn) return;
  geoBtn.disabled = !!on;
  geoBtn.classList.toggle("is-loading", !!on);
  geoBtn.classList.toggle("is-active", !!on);
  geoBtn.setAttribute("aria-busy", on ? "true" : "false");
  geoBtn.setAttribute("aria-pressed", on ? "true" : "false");
  if (!on) geoBtn.removeAttribute("aria-busy");
}

  async function findNearbyStations() {
    if (!geoBtn) return;
    if (!navigator.geolocation) {
      renderStatus(t("nearbyNoGeo"));
      setGeoLoading(false);
      return;
    }

    applyFavoritesOnlyMode(false);
    setGeoLoading(true);
    renderStatus(t("nearbySearching"));

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        });
      });

      const items = await fetchStationsNearby(pos.coords.latitude, pos.coords.longitude, 10);
      lastQuery = "";
      input.value = "";
      if (!items.length) {
        renderStatus(t("nearbyNone"));
        return;
      }
      renderSuggestions(items);
    } catch (e) {
      if (e && typeof e.code === "number" && e.code === 1) {
        renderStatus(t("nearbyDenied"));
      } else {
        renderStatus(t("nearbyError"));
      }
    } finally {
      setGeoLoading(false);
    }
  }

  if (geoBtn) {
    geoBtn.addEventListener("click", () => {
      findNearbyStations();
    });
    geoBtn.setAttribute("aria-label", t("nearbyButton"));
    geoBtn.title = t("nearbyButton");
    geoBtn.setAttribute("aria-pressed", "false");
  }

  // Init favourites UI (dropdown + star)
  renderFavoritesSelect(appState.stationId);
  refreshFavToggleFromState();
  renderFavoriteChipsList();

  if (favSel) {
    favSel.addEventListener("change", () => {
      const v = favSel.value;

      if (!v) return;

      if (v === FAV_CLEAR_VALUE) {
        clearFavorites();
        renderFavoritesSelect(appState.stationId);
        refreshFavToggleFromState();
        renderFavoriteChipsList();
        applyFavoritesOnlyMode(false);
        return;
      }

      const favs = loadFavorites();
      const f = favs.find((x) => x.id === v);
      if (!f) {
        favSel.value = "";
        return;
      }

      // Selecting a favourite should immediately load it
      setStationSelection(f.name, f.id, onStationPicked);
    });
  }

  if (favBtn) {
    favBtn.addEventListener("click", () => {
      const id = appState.stationId;
      const name = appState.STATION;

      // We only allow starring when we have a reliable stop id
      if (!id) {
        console.warn("[MesDeparts][favorites] Cannot favorite without stationId. Pick a suggestion first.");
        refreshFavToggleFromState();
        return;
      }

      if (isFavorite(id)) {
        removeFavorite(id);
      } else {
        addFavorite({ id, name });
      }

      renderFavoritesSelect(appState.stationId);
      refreshFavToggleFromState();
      renderFavoriteChipsList();
      if (loadFavorites().length === 0) {
        applyFavoritesOnlyMode(false);
      }
    });
  }

  appState._favoriteFilterChanged = (val) => {
    favoritesOnly = !!val;
    updateFavoritesToggleUi();
    updateFilterButtonState();
    if (favoritesOnly) renderFavoriteSuggestions(input.value.trim());
    else clear();
  };

  appState._renderFavoritesPopover = renderFavoriteChipsList;
  appState._setFavoritesOnly = applyFavoritesOnlyMode;

  if (favoritesOnly) {
    renderFavoriteSuggestions(input.value.trim());
  }

  document.addEventListener("click", (e) => {
    if (!list.contains(e.target) && e.target !== input) clear();
  });
}

// ---------------- LINE CHIPS (header summary) ----------------

function renderLineChips(lines) {
  const wrap = document.getElementById("line-chips");
  const container = document.getElementById("line-chips-container");
  if (!wrap || !container) return;

  const normalizedLines = (lines || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const activeLines = new Set(normalizeFilterArray(appState.lineFilter, normalizedLines));

  wrap.style.display = normalizedLines.length ? "flex" : "none";

  container.innerHTML = "";
  for (const ln of normalizedLines) {
    const badge = document.createElement("span");
    const lineNetwork =
      (appState.lineNetworks && appState.lineNetworks[ln]) ||
      appState.lastBoardNetwork ||
      appState.currentNetwork;
    badge.className = busBadgeClass({ simpleLineId: ln, network: lineNetwork });
    badge.textContent = ln;
    badge.classList.add("is-clickable");
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("aria-pressed", activeLines.has(ln) ? "true" : "false");
    badge.classList.toggle("is-active-filter", activeLines.has(ln));

    const activate = (e) => {
      e.preventDefault();
      applyLineBadgeFilter(ln);
    };

    badge.addEventListener("click", activate);
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        activate(e);
      }
    });

    container.appendChild(badge);
  }
}

// ---------------- TABLE RENDER ----------------

function trainBadgeClass(category) {
  const catRaw = (category || "").toUpperCase().trim();
  const cat = (catRaw.match(/^[A-Z]+/) || [""])[0];

  // Old UI behavior:
  // - Long distance (IC/IR/EC/EN/ICE/RJ/RJX) => red badge with white text
  // - RE => RegioExpress style
  // - R/S/SN => Regio style
  if (["IC", "IR", "EC", "EN", "ICE", "RJ", "RJX"].includes(cat)) return "train-longdistance";
  if (cat === "RE") return "train-rexpress";
  if (cat === "PE") return "train-pe";
  if (["R", "S", "SN"].includes(cat)) return "train-regio";
  return "train-regio";
}

function formatTimeCell(val) {
  const d = parseApiDate(val);
  if (!d) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function stopMatchesStation(stop, stationId, stationName) {
  const targetId = stationId ? String(stationId).trim() : "";
  const targetName = (stationName || "").split(",")[0].trim().toLowerCase();
  if (!stop) return false;

  const candidates = [
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

  return (
    (targetId && candidates.some((id) => id === targetId)) ||
    (targetName && names.some((n) => n === targetName))
  );
}

function ensureJourneyOverlay() {
  let overlay = document.getElementById("journey-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "journey-overlay";
  overlay.className = "journey-overlay";
  overlay.innerHTML = `
    <div class="journey-panel">
      <div class="journey-header">
        <div class="journey-title"></div>
        <button class="journey-close" type="button" aria-label="Fermer">×</button>
      </div>
      <div class="journey-body">
        <div class="journey-meta"></div>
        <div class="journey-stops"></div>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("is-visible");
  });
  overlay.querySelector(".journey-close").addEventListener("click", () => {
    overlay.classList.remove("is-visible");
  });

  document.body.appendChild(overlay);
  return overlay;
}

function renderJourneyStops(dep, detail) {
  const section = detail?.section || detail;
  const connection = detail?.connection;
  const stopsWrap = document.createElement("div");
  stopsWrap.className = "journey-stops";

  const passList =
    section?.journey?.passList ||
    detail?.journey?.passList ||
    detail?.passList ||
    detail?.stops ||
    [];
  const isTrain = dep.mode === "train";

  const originId =
    dep.fromStationId ||
    section?.departure?.station?.id ||
    connection?.from?.station?.id ||
    appState.stationId ||
    null;
  const originName =
    dep.fromStationName ||
    section?.departure?.station?.name ||
    connection?.from?.station?.name ||
    appState.STATION ||
    "";

  const startIdx = passList.findIndex((item) =>
    stopMatchesStation(item?.stop || item, originId, originName)
  );
  const visiblePassList =
    startIdx >= 0 ? passList.slice(startIdx) : passList.slice();

  if (!visiblePassList.length) {
    const empty = document.createElement("div");
    empty.className = "journey-stop";
    empty.textContent = t("journeyNoStops");
    stopsWrap.appendChild(empty);
    return stopsWrap;
  }

  visiblePassList.forEach((item, idx) => {
    const s = item.stop || item;
    const fallbackOrigin =
      idx === 0
        ? dep.fromStationName ||
          section?.departure?.station?.name ||
          section?.departure?.name ||
          ""
        : "";
    const name = s.station?.name || s.name || s.stop?.name || fallbackOrigin || "—";
    const arr = s.arrival || s.prognosis?.arrival || s.arrivalTime;
    const depTime = s.departure || s.prognosis?.departure || s.departureTime;
    const isFirst = idx === 0;
    const isLast = idx === visiblePassList.length - 1;
    const cleanPlat = (p) => (p ? String(p).replace("!", "").trim() : "");

    const platCandidates = [
      s.platform,
      s.prognosis?.platform,
      s.stop?.platform,
      s.departure?.platform,
      s.arrival?.platform,
      s.prognosis?.departure?.platform,
      s.prognosis?.arrival?.platform,
      s.stop?.prognosis?.platform,
      s.stop?.departure?.platform,
      s.stop?.arrival?.platform,
      isFirst ? section?.departure?.platform : null,
      isFirst ? connection?.from?.platform : null,
      isLast ? section?.arrival?.platform : null,
      isLast ? connection?.to?.platform : null,
    ];

    const platform = cleanPlat(platCandidates.find((p) => cleanPlat(p)) || "");
    const li = document.createElement("div");
    li.className = "journey-stop";
    if (isLast) li.classList.add("is-last");
    if (isFirst) li.classList.add("is-origin");

    const dot = document.createElement("span");
    dot.className = "journey-stop-dot";
    li.appendChild(dot);

    const content = document.createElement("div");
    content.className = "journey-stop-content";

    const nameEl = document.createElement("div");
    nameEl.className = "journey-stop-name";
    nameEl.textContent = name;

    const timeEl = document.createElement("div");
    timeEl.className = "journey-stop-times";
    const timeStack = document.createElement("div");
    timeStack.className = "journey-stop-time-stack";

    const arrStr = arr ? formatTimeCell(arr) : null;
    const depStr = depTime ? formatTimeCell(depTime) : null;

    // For trains: always show both when available.
    // For buses: show arrival only when meaningful; departure by default.
    let showArrival;
    let showDeparture;
    if (isTrain) {
      showArrival = !!arrStr;
      showDeparture = !!depStr;
    } else {
      showArrival =
        (isLast && !!arrStr) ||
        (!!arrStr && !!depStr && arrStr !== depStr && !isFirst) ||
        (!!arrStr && !depStr && !isFirst);
      showDeparture = (!isLast && !!depStr) || (isFirst && !!depStr);
    }

    // For trains, never show an arrival time on the departure station row to avoid stale “now” values.
    if (isTrain && isFirst) {
      showArrival = false;
    }

    const platformPill =
      platform
        ? (() => {
            const plat = document.createElement("span");
            plat.className = "journey-stop-platform small";
            const label = isTrain ? t("columnPlatformTrain") : t("columnPlatformBus");
            plat.textContent = `${label} ${platform}`;
            return plat;
          })()
        : null;

    if (showArrival) {
      const rowArr = document.createElement("div");
      rowArr.className = "journey-stop-time-row";
      const lbl = document.createElement("span");
      lbl.className = "journey-stop-time-label";
      lbl.textContent = "Arr.";
      const val = document.createElement("span");
      val.className = "journey-stop-time-value";
      val.textContent = arrStr || "--:--";
      rowArr.appendChild(lbl);
      rowArr.appendChild(val);
      timeStack.appendChild(rowArr);
    }

    if (showDeparture) {
      const rowDep = document.createElement("div");
      rowDep.className = "journey-stop-time-row";
      const lbl = document.createElement("span");
      lbl.className = "journey-stop-time-label";
      lbl.textContent = isLast ? "Arr." : "Dép.";
      const val = document.createElement("span");
      val.className = "journey-stop-time-value";
      val.textContent = depStr || arrStr || "--:--";
      rowDep.appendChild(lbl);
      rowDep.appendChild(val);
      timeStack.appendChild(rowDep);
    }

    // Add platform once per stop (left side)
    if (platformPill) {
      timeEl.appendChild(platformPill);
    }
    timeEl.appendChild(timeStack);

    content.appendChild(nameEl);
    content.appendChild(timeEl);
    li.appendChild(content);
    stopsWrap.appendChild(li);
  });

  return stopsWrap;
}

async function openJourneyDetails(dep) {
  if (!dep) return;
  const overlay = ensureJourneyOverlay();
  overlay.classList.add("is-visible");

  const titleEl = overlay.querySelector(".journey-title");
  const metaEl = overlay.querySelector(".journey-meta");
  const stopsEl = overlay.querySelector(".journey-stops");

  // Loading state
  titleEl.textContent = t("journeyTitle");
  metaEl.textContent = t("journeyLoading");
  stopsEl.innerHTML = "";

  try {
    const detail = await fetchJourneyDetails(dep);
    const section = detail?.section || detail;
    const badge = document.createElement("span");
    if (dep.mode === "train") {
      badge.className = `line-badge line-train ${trainBadgeClass(dep.category || dep.line || "")}`;
      badge.textContent = dep.line || dep.number || dep.category || "";
    } else {
      badge.className = busBadgeClass(dep);
      badge.textContent = normalizeLineId(dep);
    }

    titleEl.innerHTML = "";
    titleEl.appendChild(badge);
    const dest = document.createElement("span");
    dest.className = "journey-dest";
    dest.textContent = `→ ${dep.dest || section?.arrival?.station?.name || section?.journey?.to?.name || ""}`;
    titleEl.appendChild(dest);

    const hasDelay = typeof dep.delayMin === "number" && dep.delayMin > 0;

    metaEl.textContent = "";
    const metaLine = document.createElement("span");
    metaLine.className = "journey-meta-time";
    metaLine.textContent = `${t("journeyPlannedDeparture")} ${dep.timeStr || ""}`;
    const delayPill =
      hasDelay && dep.delayMin > 0
        ? (() => {
            const pill = document.createElement("span");
            pill.className = "journey-meta-pill journey-meta-pill--delay";
            pill.textContent = `+${dep.delayMin} min`;
            return pill;
          })()
        : null;

    metaEl.appendChild(metaLine);
    if (delayPill) metaEl.appendChild(delayPill);

    stopsEl.innerHTML = "";
    stopsEl.appendChild(renderJourneyStops(dep, detail));
  } catch (err) {
    console.error("[MesDeparts][journey] error", err);
    metaEl.textContent = t("journeyStopsError");
    stopsEl.innerHTML = "";
  }
}

function busBadgeClass(dep) {
  if (!dep) return "line-badge";

  const simpleLineId =
    typeof dep.simpleLineId === "string" && dep.simpleLineId.trim()
      ? dep.simpleLineId
      : null;

  if (!simpleLineId) return "line-badge";

  const id = String(simpleLineId).trim().toUpperCase();
  const idForClass = id.replace(/\+/g, "PLUS");

  const net = (dep.network || appState.currentNetwork || "").toLowerCase();

  // PostAuto styling (full yellow pill)
  if (dep.isPostBus || net === "postauto") {
    return "line-badge line-postbus";
  }

  const classes = ["line-badge"];

  // Night buses (N1, N2, ...)
  if (id.startsWith("N")) {
    classes.push("line-night");
  }

  // Prefer per-departure network (from logic), fallback to station network
  if (net) {
    classes.push(`line-${net}-${idForClass}`);
  } else {
    // Generic fallback only when we have no network
    classes.push(`line-generic-${idForClass}`);
  }

  return classes.join(" ");
}

function setMinColumnVisibility(isTrain) {
  const thMin = document.querySelector("th.col-min");
  const thPlat = document.querySelector("th.col-platform");

  if (thMin) thMin.style.display = isTrain ? "none" : "";
  if (thPlat) thPlat.style.display = isTrain ? "" : "";
}

function updatePlatformHeader(isTrain) {
  const thPlat = document.querySelector("th.col-platform");
  if (thPlat) thPlat.textContent = isTrain ? t("columnPlatformTrain") : t("columnPlatformBus");
}

function setDepartureColumnVisibility(hide) {
  const thTime = document.querySelector("th.col-time");
  const departuresTable = document.querySelector("table.departures");
  if (thTime) thTime.style.display = hide ? "none" : "";
  if (departuresTable) departuresTable.classList.toggle("is-hide-departure", !!hide);
}

export function renderDepartures(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;

  setMinColumnVisibility(appState.lastBoardIsTrain);
  updatePlatformHeader(appState.lastBoardIsTrain);
  const hideDeparture = !!appState.hideBusDeparture && !appState.lastBoardIsTrain;
  setDepartureColumnVisibility(hideDeparture);
  if (typeof appState._renderViewControls === "function") {
    appState._renderViewControls();
  }

  tbody.innerHTML = "";

  // UI debug: board summary
  const total = Array.isArray(rows) ? rows.length : 0;
  const trainCount = (rows || []).filter((r) => r && r.mode === "train").length;
  const busCount = total - trainCount;
  uiDebugLog("[MesDeparts][ui] renderDepartures", {
    station: appState.STATION,
    viewMode: appState.viewMode,
    total,
    trainCount,
    busCount,
    lastBoardIsTrain: !!appState.lastBoardIsTrain,
    lastBoardHasBus: !!appState.lastBoardHasBus,
    lastBoardHasBusPlatform: !!appState.lastBoardHasBusPlatform,
    platformFilter: appState.platformFilter || null,
    lineFilter: appState.lineFilter || null,
  });
  if (uiDebugEnabled()) window.__MD_UI_LOGGED__ = 0;

  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = hideDeparture ? 5 : 6;
    td.className = "col-empty";
    td.textContent = t("serviceEndedToday");
    tr.appendChild(td);
    tbody.appendChild(tr);
    ensureBoardFitsViewport();
    return;
  }

  const lineOptions = (appState.lineOptions || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const activeLineFilters = new Set(
    normalizeFilterArray(appState.lineFilter, lineOptions)
  );

  let prevLineKey = null;

  for (const dep of rows || []) {
    const tr = document.createElement("tr");
    tr.dataset.journeyId = dep.journeyId || "";
    const hasDetails =
      !!dep.journeyId || (Array.isArray(dep.passList) && dep.passList.length > 0);
    tr.classList.toggle("clickable", hasDetails);
    tr.addEventListener("click", () => openJourneyDetails(dep));

    // UI debug: log first rows only (avoid spamming)
    if (uiDebugEnabled()) {
      window.__MD_UI_LOGGED__ = window.__MD_UI_LOGGED__ || 0;
      if (window.__MD_UI_LOGGED__ < 20) {
        window.__MD_UI_LOGGED__ += 1;
        uiDebugLog("[MesDeparts][ui-row]", {
          mode: dep?.mode,
          line: dep?.simpleLineId || dep?.line || dep?.number || "",
          category: dep?.category || "",
          number: dep?.number || "",
          dest: dep?.dest || "",
          timeStr: dep?.timeStr || "",
          inMin: typeof dep?.inMin === "number" ? dep.inMin : null,
          isArriving: !!dep?.isArriving,
          platform: dep?.platform || "",
          platformChanged: !!dep?.platformChanged,
          status: dep?.status || "",
          remark: dep?.remark || "",
        });
      }
    }

    const lineKey = dep?.simpleLineId || dep?.line || dep?.number || "";
    if (!appState.lastBoardIsTrain && prevLineKey && lineKey && lineKey !== prevLineKey) {
      tr.classList.add("line-separator");
    }
    if (lineKey) prevLineKey = lineKey;

    // Line
    const tdLine = document.createElement("td");
    tdLine.className = "col-line-cell";

    const badge = document.createElement("span");
    if (dep.mode === "train") {
      const cat = dep.category || "";
      const num = dep.number || "";

      // Apply SBB-ish visual type classes + train rectangle shape
      badge.className = `line-badge line-train ${trainBadgeClass(cat)}`;

      // Build a compact, human-readable label (IR 95, RE 33, R 3, PE 30, or just IR/PE)
      const { label, isSoloLongDistance } = buildTrainLabel(cat, num);
      badge.textContent = label;

      if (isSoloLongDistance) {
        badge.classList.add("train-longdistance-solo");
      }
    } else {
      const lineId = normalizeLineId(dep);

      // PostAuto special
      if (dep.isPostBus) {
        badge.className = "line-badge line-postbus";
        badge.textContent = lineId || "";
      } else {
        badge.className = busBadgeClass(dep);
        badge.textContent = lineId || "";
      }

      if (lineId) {
        badge.classList.add("is-clickable");
        badge.setAttribute("role", "button");
        badge.tabIndex = 0;
        badge.title = `${t("filterLines")}: ${lineId}`;
        badge.classList.toggle("is-active-filter", activeLineFilters.has(lineId));
        badge.setAttribute("aria-pressed", activeLineFilters.has(lineId) ? "true" : "false");
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          applyLineBadgeFilter(lineId);
        });
        badge.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            applyLineBadgeFilter(lineId);
          }
        });
      }
    }
    tdLine.appendChild(badge);

    // Destination
    const tdTo = document.createElement("td");
    tdTo.className = "col-to-cell";
    tdTo.textContent = dep.dest || "";

    // Time
    const tdTime = document.createElement("td");
    tdTime.className = "col-time-cell";
    tdTime.textContent = dep.timeStr || "";
    if (hideDeparture) tdTime.style.display = "none";

    // Platform
    const tdPlat = document.createElement("td");
    tdPlat.className = "col-platform-cell";
    const platformVal = dep.platform || "";
    const prevPlatform = dep.previousPlatform || null;

    if (dep.platformChanged && platformVal) {
      const wrap = document.createElement("div");
      wrap.className = "platform-change-wrap";

      if (prevPlatform) {
        const prevBadge = document.createElement("span");
        prevBadge.className = "platform-badge platform-badge--prev";
        prevBadge.textContent = prevPlatform;
        wrap.appendChild(prevBadge);
      }

      const curBadge = document.createElement("span");
      curBadge.className = "platform-badge platform-badge--current";
      curBadge.textContent = platformVal;

      const arrow = document.createElement("span");
      arrow.className = "platform-change-arrow";
      arrow.textContent = "⇄";
      curBadge.appendChild(arrow);

      wrap.appendChild(curBadge);

      tdPlat.appendChild(wrap);
      tdPlat.classList.add("platform-changed");
    } else if (platformVal) {
      const badge = document.createElement("span");
      badge.className = "platform-badge";
      badge.textContent = platformVal;
      tdPlat.appendChild(badge);
    } else {
      tdPlat.textContent = "";
    }

    // Min
    const tdMin = document.createElement("td");
    tdMin.className = "col-min-cell";

    if (!appState.lastBoardIsTrain) {
      if (dep.isArriving) {
        tdMin.innerHTML = `
          <svg class="bus-arrival-icon pulse-bus" viewBox="0 0 24 24" aria-label="Arrive">
            <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3-3.58-3-8-3S4 3 4 6v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14 9 14.67 9 15.5 8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5S15.67 14 16.5 14 18 14.67 18 15.5 17.33 17 16.5 17zM6 11V6h12v5H6z"/>
          </svg>`;
      } else if (typeof dep.inMin === "number") {
        tdMin.textContent = String(dep.inMin);
      } else {
        tdMin.textContent = "";
      }
    } else {
      tdMin.style.display = "none";
    }

    // Remark
    const tdRemark = document.createElement("td");
    tdRemark.className = "col-remark-cell";
    tdRemark.textContent = dep.remark || "";
    if (dep.status === "cancelled") tdRemark.classList.add("status-cancelled");
    if (dep.status === "delay") tdRemark.classList.add("status-delay");
    if (dep.status === "early") tdRemark.classList.add("status-early");

    // Assemble
    tr.appendChild(tdLine);
    tr.appendChild(tdTo);
    tr.appendChild(tdTime);
    tr.appendChild(tdPlat);
    tr.appendChild(tdMin);
    tr.appendChild(tdRemark);

    tbody.appendChild(tr);
  }

  ensureBoardFitsViewport();
}
