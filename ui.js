// ui.js
// --------------------------------------------------------
// UI: clock, table render, filters, station search, view toggle
// --------------------------------------------------------

import { appState, VIEW_MODE_TIME, VIEW_MODE_LINE, VIEW_MODE_DOWN } from "./state.js";
import { fetchStationSuggestions } from "./logic.js";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  clearFavorites,
} from "./favourites.js";



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
  opt0.textContent = "Favoris";
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

// ---------------- VIEW MODE BUTTON ----------------

function viewModeLabel(mode) {
  if (mode === VIEW_MODE_TIME) return "Vue: Heure";
  if (mode === VIEW_MODE_LINE) return "Vue: Lignes";
  if (mode === VIEW_MODE_DOWN) return "Vue: Descendre";
  return "Vue";
}

export function setupViewToggle(onChange) {
  // New UI: dropdown select (index.html uses #view-select)
  const sel = document.getElementById("view-select");

  // Backward compat: if the old toggle button still exists, keep it working.
  const btn = document.getElementById("filter-toggle");

  // ---- Preferred path: dropdown ----
  if (sel) {
    appState.viewSelect = sel;

    function ensureOptions() {
      // If we leave Motte, make sure we are not stuck in DOWN view.
      if (!appState.stationIsMotte && appState.viewMode === VIEW_MODE_DOWN) {
        appState.viewMode = VIEW_MODE_TIME;
      }

      // Build the option list depending on station
      const wantDown = !!appState.stationIsMotte;
      const options = wantDown
        ? [
            { v: VIEW_MODE_TIME, t: "Vue : Heure" },
            { v: VIEW_MODE_LINE, t: "Vue : Par ligne" },
            { v: VIEW_MODE_DOWN, t: "Vue : Descendre" },
          ]
        : [
            { v: VIEW_MODE_TIME, t: "Vue : Heure" },
            { v: VIEW_MODE_LINE, t: "Vue : Par ligne" },
          ];

      sel.innerHTML = "";
      for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.t;
        sel.appendChild(opt);
      }

      // Ensure select reflects current state
      sel.value = appState.viewMode || VIEW_MODE_TIME;
    }

    sel.addEventListener("change", () => {
      const next = sel.value;
      appState.viewMode = next;

      // Entering “down” view: clear filters to avoid accidental empty lists
      if (next === VIEW_MODE_DOWN) {
        appState.platformFilter = null;
        appState.lineFilter = null;

        const pSel = document.getElementById("platform-filter");
        const lSel = document.getElementById("line-filter");
        if (pSel) pSel.value = "";
        if (lSel) lSel.value = "";
      }

      updateFiltersVisibility();
      if (typeof onChange === "function") onChange();
    });

    // initial
    if (!appState.viewMode) appState.viewMode = VIEW_MODE_TIME;
    ensureOptions();
    updateFiltersVisibility();

    // Provide a small hook so other code can call this after station changes if needed.
    appState._ensureViewSelectOptions = ensureOptions;

    return;
  }

  // ---- Fallback path: old cycling button (if still present) ----
  if (!btn) return;

  appState.viewButton = btn;

  function render() {
    const labelEl = btn.querySelector(".filter-label");
    const txt = viewModeLabel(appState.viewMode);
    if (labelEl) labelEl.textContent = txt;
    else btn.textContent = txt;

    // Highlight only when “down” is active (reuses existing CSS)
    btn.classList.toggle("is-on", appState.viewMode === VIEW_MODE_DOWN);

    btn.classList.remove("is-hidden");
  }

  btn.addEventListener("click", () => {
    const modes = appState.stationIsMotte
      ? [VIEW_MODE_TIME, VIEW_MODE_LINE, VIEW_MODE_DOWN]
      : [VIEW_MODE_TIME, VIEW_MODE_LINE];

    const curIdx = Math.max(0, modes.indexOf(appState.viewMode));
    const next = modes[(curIdx + 1) % modes.length];

    appState.viewMode = next;

    // Entering “down” view: clear filters to avoid accidental empty lists
    if (next === VIEW_MODE_DOWN) {
      appState.platformFilter = null;
      appState.lineFilter = null;
      const pSel = document.getElementById("platform-filter");
      const lSel = document.getElementById("line-filter");
      if (pSel) pSel.value = "";
      if (lSel) lSel.value = "";
    }

    render();
    updateFiltersVisibility();

    if (typeof onChange === "function") onChange();
  });

  if (!appState.viewMode) appState.viewMode = VIEW_MODE_TIME;
  render();
  updateFiltersVisibility();
}

// ---------------- FILTERS (platform + line) ----------------

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

function updateFiltersVisibility() {
  const platWrap = document.querySelector(".platform-filter-container");
  const lineSelect = document.getElementById("line-filter");
  const lineWrap = lineSelect ? lineSelect.closest(".line-filter-container") : null;

  const hideBecauseView = appState.stationIsMotte && appState.viewMode === VIEW_MODE_DOWN;
  const hideBecauseTrain = appState.lastBoardIsTrain;

  const showPlatform =
    !hideBecauseView && !hideBecauseTrain && appState.lastBoardHasBus && appState.lastBoardHasBusPlatform;

  const showLine =
    !hideBecauseView && !hideBecauseTrain && appState.lastBoardHasBus;

  if (platWrap) platWrap.style.display = showPlatform ? "" : "none";
  if (lineWrap) lineWrap.style.display = showLine ? "" : "none";
}

export function setupFilters(onChange) {
  const platformSel = document.getElementById("platform-filter");
  const lineSel = document.getElementById("line-filter");

  if (platformSel) {
    platformSel.addEventListener("change", () => {
      appState.platformFilter = platformSel.value || null;
      if (typeof onChange === "function") onChange();
    });
  }

  if (lineSel) {
    lineSel.addEventListener("change", () => {
      appState.lineFilter = lineSel.value || null;
      if (typeof onChange === "function") onChange();
    });
  }

  updateFiltersVisibility();
}

export function renderFilterOptions() {
  const platformSel = document.getElementById("platform-filter");
  const lineSel = document.getElementById("line-filter");

  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  setSelectOptions(platformSel, platforms, "Quai");
  setSelectOptions(lineSel, lines, "Ligne");

  // restore selected value
  if (platformSel) platformSel.value = appState.platformFilter || "";
  if (lineSel) lineSel.value = appState.lineFilter || "";

  updateFiltersVisibility();
}

// ---------------- STATION SEARCH ----------------

export function setupStationSearch(onStationPicked) {
  const input = document.getElementById("station-input");
  const list = document.getElementById("station-suggestions");
  const btn = document.getElementById("station-search-btn");
  const favBtn = getFavToggleEl();
  const favSel = getFavSelectEl();

  if (!input || !list) return;

  let lastQuery = "";
  let active = [];

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

  let t = null;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (t) clearTimeout(t);
    t = setTimeout(() => doSuggest(q), 180);
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

  if (favSel) {
    favSel.addEventListener("change", () => {
      const v = favSel.value;

      if (!v) return;

      if (v === FAV_CLEAR_VALUE) {
        clearFavorites();
        renderFavoritesSelect(appState.stationId);
        refreshFavToggleFromState();
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
    });
  }

  document.addEventListener("click", (e) => {
    if (!list.contains(e.target) && e.target !== input) clear();
  });
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

function busBadgeClass(dep) {
  if (!dep) return "line-badge";

  const simpleLineId =
    typeof dep.simpleLineId === "string" && dep.simpleLineId.trim()
      ? dep.simpleLineId
      : null;

  if (!simpleLineId) return "line-badge";

  const id = String(simpleLineId).trim().toUpperCase();

  // Night buses (N1, N2, ...)
  if (id.startsWith("N")) {
    return `line-badge line-night line-${id}`;
  }

  // Prefer per-departure network (from logic), fallback to station network
  const network = (dep.network || appState.currentNetwork || "").toLowerCase();

  switch (network) {
    case "tl":
      return `line-badge line-tl-${id}`;
    case "tpg":
      return `line-badge line-tpg-${id}`;
    case "vbz":
    case "zvv":
      return `line-badge line-zvv-${id}`;
    default:
      return `line-badge line-generic-${id}`;
  }
}

function setMinColumnVisibility(isTrain) {
  const thMin = document.querySelector("th.col-min");
  const thPlat = document.querySelector("th.col-platform");

  if (thMin) thMin.style.display = isTrain ? "none" : "";
  if (thPlat) thPlat.style.display = isTrain ? "" : "";
}

export function renderDepartures(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;

  setMinColumnVisibility(appState.lastBoardIsTrain);

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

  for (const dep of rows || []) {
    const tr = document.createElement("tr");

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
    tdPlat.textContent = dep.platform || "";
    if (dep.platformChanged) tdPlat.style.fontWeight = "800";

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
