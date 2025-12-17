// ui.js
// --------------------------------------------------------
// UI: clock, table render, filters, station search, view toggle
// --------------------------------------------------------

import { appState, VIEW_MODE_TIME, VIEW_MODE_LINE } from "./state.js";
import { fetchStationSuggestions, fetchJourneyDetails, parseApiDate } from "./logic.js";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  clearFavorites,
} from "./favourites.js";
import { t } from "./i18n.js";



const pad2 = (n) => String(n).padStart(2, "0");

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

  btn.textContent = isOn ? "★" : "☆";
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
    const dd = pad2(now.getDate());
    const mm = pad2(now.getMonth() + 1);
    const yyyy = now.getFullYear();
    const hh = pad2(now.getHours());
    const mi = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    el.textContent = `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
  }

  tick();
  setInterval(tick, 1000);
}

// ---------------- STATION TITLE ----------------

export function updateStationTitle() {
  const title = document.getElementById("station-title");
  if (title) title.textContent = appState.STATION || "Station";

  const input = document.getElementById("station-input");
  if (input && !input.value) input.value = appState.STATION || "";
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

// ---------------- VIEW MODE BUTTON ----------------

function viewModeLabel(mode) {
  if (mode === VIEW_MODE_TIME) return t("viewOptionTime");
  if (mode === VIEW_MODE_LINE) return t("viewOptionLine");
  return t("viewLabelFallback");
}

export function setupViewToggle(onChange) {
  const segment = document.getElementById("view-segment");
  const segmentButtons = segment ? Array.from(segment.querySelectorAll("[data-view]")) : [];
  const sel = document.getElementById("view-select");
  const legacyBtn = document.getElementById("filter-toggle");

  function renderControls() {
    if (sel) sel.value = appState.viewMode || VIEW_MODE_LINE;
    if (segmentButtons.length) {
      segmentButtons.forEach((b) => {
        const mode = b.dataset.view === "time" ? VIEW_MODE_TIME : VIEW_MODE_LINE;
        const isActive = mode === appState.viewMode;
        b.classList.toggle("is-active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
        b.textContent = mode === VIEW_MODE_TIME ? t("viewOptionTime") : t("viewOptionLine");
      });
    }
    if (legacyBtn) {
      const labelEl = legacyBtn.querySelector(".filter-label");
      const txt = viewModeLabel(appState.viewMode);
      if (labelEl) labelEl.textContent = txt;
      else legacyBtn.textContent = txt;
      legacyBtn.classList.remove("is-hidden");
    }
  }

  function setView(mode) {
    if (mode !== VIEW_MODE_TIME && mode !== VIEW_MODE_LINE) return;
    appState.viewMode = mode;
    renderControls();
    updateFiltersVisibility();
    if (typeof onChange === "function") onChange();
  }

  if (!appState.viewMode) appState.viewMode = VIEW_MODE_LINE;

  if (segmentButtons.length) {
    segmentButtons.forEach((b) => {
      b.addEventListener("click", () => {
        const mode = b.dataset.view === "time" ? VIEW_MODE_TIME : VIEW_MODE_LINE;
        if (mode !== appState.viewMode) setView(mode);
      });
    });
  }

  if (sel) {
    appState.viewSelect = sel;

    function ensureOptions() {
      const options = [
        { v: VIEW_MODE_TIME, t: t("viewOptionTime") },
        { v: VIEW_MODE_LINE, t: t("viewOptionLine") },
      ];

      sel.innerHTML = "";
      for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.t;
        sel.appendChild(opt);
      }
      sel.value = appState.viewMode;
    }

    sel.addEventListener("change", () => setView(sel.value));
    ensureOptions();
    appState._ensureViewSelectOptions = () => {
      ensureOptions();
      renderControls();
    };
  }

  if (legacyBtn) {
    appState.viewButton = legacyBtn;
    legacyBtn.addEventListener("click", () => {
      const next = appState.viewMode === VIEW_MODE_TIME ? VIEW_MODE_LINE : VIEW_MODE_TIME;
      setView(next);
    });
  }

  renderControls();
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
};

const filterPending = {
  platforms: [],
  lines: [],
};

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

  const parts = [];
  if (activePlatforms.length) parts.push(`${t("filterPlatforms")}: ${activePlatforms.join(", ")}`);
  if (activeLines.length) parts.push(`${t("filterLines")}: ${activeLines.join(", ")}`);

  const activeCount =
    (activePlatforms.length ? 1 : 0) +
    (activeLines.length ? 1 : 0);

  if (filterUi.label) {
    filterUi.label.textContent = parts.length
      ? `${t("filterButton")} · ${parts.join(" • ")}`
      : t("filterButton");
  }

  if (filterUi.count) {
    if (activeCount > 0) {
      filterUi.count.textContent = String(activeCount);
      filterUi.count.classList.remove("is-hidden");
    } else {
      filterUi.count.classList.add("is-hidden");
    }
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
  const isSameSolo = current.length === 1 && current[0] === cleanId;
  const next = isSameSolo ? [] : [cleanId];

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
    filterPending.lines.length > 0;

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

  updateSheetResetState();
}

function openFiltersSheet() {
  if (!filterUi.sheet) return;
  filterSheetOpen = true;
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
  closeFiltersSheet(true);
}

function updateFiltersVisibility() {
  // Hide the view selector entirely on train-only boards
  const viewSelect = document.getElementById("view-select");
  const viewSegment = document.getElementById("view-segment");
  if (viewSelect) viewSelect.style.display = appState.lastBoardIsTrain ? "none" : "";
  if (viewSegment) viewSegment.style.display = appState.lastBoardIsTrain ? "none" : "";

  const platformSel = filterUi.platformSelect || document.getElementById("platform-filter");
  const platWrap = platformSel ? platformSel.closest(".platform-filter-container") : null;
  const lineSelect = filterUi.lineSelect || document.getElementById("line-filter");
  const lineWrap = lineSelect ? lineSelect.closest(".line-filter-container") : null;

  const hideBecauseView = false;
  const hideBecauseTrain = appState.lastBoardIsTrain;
  const hasPlatforms = (appState.platformOptions || []).length > 0;

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

  const filtersAvailable = showPlatform || showLine;
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
  filterUi.count = document.getElementById("filters-open-count");
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
    filterUi.platformSelect.addEventListener("change", () => {
      const v = filterUi.platformSelect.value;
      appState.platformFilter = v ? [v] : null;
      filterPending.platforms = normalizeFilterArray(appState.platformFilter, appState.platformOptions);
      updateFilterButtonState();
      if (typeof filtersOnChange === "function") filtersOnChange();
    });
  }

  if (filterUi.lineSelect) {
    filterUi.lineSelect.addEventListener("change", () => {
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
      li.textContent = s.name;
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

  if (btn) {
    btn.addEventListener("click", () => {
      clear();
      const q = input.value.trim();
      if (q) setStationSelection(q, null, onStationPicked);
    });
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

  if (!passList.length) {
    const empty = document.createElement("div");
    empty.className = "journey-stop";
    empty.textContent = "Aucun arrêt détaillé pour ce trajet.";
    stopsWrap.appendChild(empty);
    return stopsWrap;
  }

  passList.forEach((item, idx) => {
    const s = item.stop || item;
    const name = s.station?.name || s.name || s.stop?.name || "—";
    const arr = s.arrival || s.prognosis?.arrival || s.arrivalTime;
    const depTime = s.departure || s.prognosis?.departure || s.departureTime;
    const isFirst = idx === 0;
    const isLast = idx === passList.length - 1;
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
      timeEl.appendChild(rowArr);
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
      timeEl.appendChild(rowDep);
    }

    // Add platform once per stop (right side) for trains
    if (platformPill) {
      timeEl.appendChild(platformPill);
    }

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
  titleEl.textContent = "Détails du trajet";
  metaEl.textContent = "Chargement…";
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

    const platformLabel = dep.mode === "train" ? t("columnPlatformTrain") : t("columnPlatformBus");
    const hasPlatform = !!dep.platform;
    const platformText = hasPlatform ? `${platformLabel} ${dep.platform}` : "";
    metaEl.textContent = "";
    const metaLine = document.createElement("span");
    metaLine.textContent = `Départ prévu ${dep.timeStr || ""}`;
    const platPill = hasPlatform
      ? (() => {
          const pill = document.createElement("span");
          pill.className = "journey-meta-pill";
          pill.textContent = platformText;
          return pill;
        })()
      : null;
    metaEl.appendChild(metaLine);
    if (platPill) {
      metaEl.appendChild(document.createTextNode(" "));
      metaEl.appendChild(platPill);
    }

    stopsEl.innerHTML = "";
    stopsEl.appendChild(renderJourneyStops(dep, detail));
  } catch (err) {
    console.error("[MesDeparts][journey] error", err);
    metaEl.textContent = "Impossible de charger les arrêts pour ce trajet.";
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
    classes.push(`line-${net}-${id}`);
  } else {
    // Generic fallback only when we have no network
    classes.push(`line-generic-${id}`);
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

export function renderDepartures(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;

  setMinColumnVisibility(appState.lastBoardIsTrain);
  updatePlatformHeader(appState.lastBoardIsTrain);

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
    td.colSpan = 6;
    td.className = "col-empty";
    td.textContent = t("serviceEndedToday");
    tr.appendChild(td);
    tbody.appendChild(tr);
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
    tr.classList.toggle("clickable", !!dep.journeyId);
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
}
