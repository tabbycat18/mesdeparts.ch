// main.js
// --------------------------------------------------------
// App bootstrap + refresh loop
// --------------------------------------------------------

import {
  appState,
  DEFAULT_STATION,
  REFRESH_DEPARTURES,
  DEBUG_FORCE_NOW,
  VIEW_MODE_DOWN,
  VIEW_MODE_LINE,
} from "./state.js";

import {
  detectNetworkFromStation,
  resolveStationId,
  fetchDeparturesGrouped,
} from "./logic.js";

import {
  setupClock,
  setupViewToggle,
  setupFilters,
  renderFilterOptions,
  setupStationSearch,
  updateStationTitle,
  renderDepartures,
} from "./ui.js";

import { setupInfoButton } from "./infoBTN.js";

// Persist station between reloads
const STORAGE_KEY = "mesdeparts.station";

function normalizeStationName(name) {
  return (name || "").trim();
}

function applyStation(name, id) {
  const stationName = normalizeStationName(name) || DEFAULT_STATION;

  appState.STATION = stationName;
  // If a station id is provided (from suggestion/favourite), keep it.
  // Otherwise leave as null; it will be resolved later from the name.
  appState.stationId = (typeof id === "string" && id.trim()) ? id.trim() : null;

  appState.stationIsMotte = stationName.toLowerCase().includes("motte");
  appState.currentNetwork = detectNetworkFromStation(stationName);

  // Default view: Motte -> Down, otherwise group by line
  appState.viewMode = appState.stationIsMotte ? VIEW_MODE_DOWN : VIEW_MODE_LINE;

  // Reset filters on station change
  appState.platformFilter = null;
  appState.lineFilter = null;

  localStorage.setItem(STORAGE_KEY, stationName);

  updateStationTitle();
}

async function refreshDepartures() {
  const tbody = document.getElementById("departures-body");
  if (tbody) {
    tbody.setAttribute("aria-busy", "true");
  }

  try {
    if (!appState.stationId) {
      await resolveStationId();
    }

    const rows = await fetchDeparturesGrouped(appState.viewMode);

    if (DEBUG_FORCE_NOW && rows.length > 0) {
      // Do NOT mutate “Départ” (planned time).
      // Only force the arriving indicator for UI testing.
      rows[0].isArriving = true;
      rows[0].inMin = 0;
    }

    // Update filter dropdown options from the latest board
    renderFilterOptions();

    renderDepartures(rows);
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
  }
}

// --------------------------------------------------------
// Boot
// --------------------------------------------------------

(function boot() {
  // Station from storage
  const stored = localStorage.getItem(STORAGE_KEY);
  applyStation(stored || DEFAULT_STATION);

  setupClock();
  setupInfoButton();

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
  setInterval(refreshDepartures, REFRESH_DEPARTURES);
})();
