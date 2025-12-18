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
} from "./state.v2025-12-18-3.js";

import {
  detectNetworkFromStation,
  resolveStationId,
  fetchDeparturesGrouped,
} from "./logic.v2025-12-18-3.js";

import {
  setupClock,
  setupViewToggle,
  setupFilters,
  renderFilterOptions,
  setupStationSearch,
  updateStationTitle,
  renderDepartures,
  setBoardLoadingState,
} from "./ui.v2025-12-18-3.js";

import { setupInfoButton } from "./infoBTN.v2025-12-18-3.js";
import { initI18n, applyStaticTranslations, setLanguage, LANGUAGE_OPTIONS } from "./i18n.v2025-12-18-3.js";

// Persist station between reloads
const STORAGE_KEY = "mesdeparts.station";

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

function applyStation(name, id) {
  const stationName = normalizeStationName(name) || DEFAULT_STATION;

  appState.STATION = stationName;
  // If a station id is provided (from suggestion/favourite), keep it.
  // Otherwise leave as null; it will be resolved later from the name.
  appState.stationId = (typeof id === "string" && id.trim()) ? id.trim() : null;

  appState.stationIsMotte = stationName.toLowerCase().includes("motte");
  appState.currentNetwork = detectNetworkFromStation(stationName);

  // Default view: group by line
  appState.viewMode = VIEW_MODE_LINE;

  // Reset filters on station change
  appState.platformFilter = null;
  appState.lineFilter = null;
  appState.lastPlatforms = {};

  localStorage.setItem(STORAGE_KEY, stationName);
  updateUrlWithStation(stationName, appState.stationId);

  updateStationTitle();
}

async function refreshDepartures({ retried, showLoadingHint = true } = {}) {
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.setAttribute("aria-busy", "true");
  }
  if (showLoadingHint) {
    setBoardLoadingState(true);
  }

  try {
    if (!appState.stationId) {
      await resolveStationId();
    }

    const rows = await fetchDeparturesGrouped(appState.viewMode);

    // If nothing came back, try re-resolving the station once before declaring “Fin de service”.
    if (!retried && (!rows || rows.length === 0)) {
      try {
        await resolveStationId();
        const retryRows = await fetchDeparturesGrouped(appState.viewMode);
        if (retryRows && retryRows.length) {
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
    updateDebugPanel(rows);
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
  }
}

// --------------------------------------------------------
// Boot
// --------------------------------------------------------

(function boot() {
  const lang = initI18n();
  appState.language = lang;
  applyStaticTranslations();

  const urlStation = getStationFromUrl();
  // Station from storage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (urlStation) {
    applyStation(urlStation.name || stored || DEFAULT_STATION, urlStation.id || null);
  } else {
    applyStation(stored || DEFAULT_STATION);
  }

  setupClock();
  setupInfoButton();
  setupLanguageSwitcher(() => {
    refreshDepartures();
  });

  setupViewToggle(() => {
    refreshDepartures();
  });

  setupFilters(() => {
    refreshDepartures();
  });

  setupStationSearch((name, id) => {
    applyStation(name, id);
    refreshDepartures();
  });

  // Initial load
  refreshDepartures();

  // Periodic refresh
  setInterval(() => refreshDepartures({ showLoadingHint: false }), REFRESH_DEPARTURES);
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
