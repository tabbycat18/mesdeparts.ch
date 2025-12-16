// ui.js
// --------------------------------------------------------
// UI: clock, table, filter, station input
// --------------------------------------------------------

import { appState } from "./state.js";
import { fetchStationSuggestions } from "./logic.js";

function buildTrainLabel(category, rawNumber) {
  const cat = (category || "").toUpperCase().trim();
  const raw = (rawNumber || "").trim();

  // Garder uniquement les chiffres du numéro
  // ex: "001743" -> "1743", "17 05" -> "1705"
  const digitsOnly = raw.replace(/\D/g, "");
  const num = digitsOnly.replace(/^0+/, ""); // supprimer les zéros en tête

  // "court" = 1 à 3 chiffres max (95, 170, 502)
  const hasShortNum = num.length > 0 && num.length <= 3;

  const isLongDistance = ["IC", "IR", "EC", "EN", "ICE", "RJ", "RJX"].includes(
    cat
  );
  const isRE = cat === "RE";
  const isRegio = cat === "R" || cat === "S";

  // --- Long distance: IR / IC / EC / EN / ICE / RJ / RJX ---
  if (isLongDistance) {
    if (!hasShortNum) {
      // Numéro interne trop long ou inexploitable -> seulement IR / IC / etc.
      return { label: cat || "–", isSoloLongDistance: true };
    }
    return { label: `${cat} ${num}`, isSoloLongDistance: false };
  }

  // --- RegioExpress (RE 33) ---
  if (isRE) {
    if (!hasShortNum) {
      // RE sans numéro fiable
      return { label: "RE", isSoloLongDistance: false };
    }
    return { label: `RE ${num}`, isSoloLongDistance: false };
  }

  // --- Regio / S-Bahn (R 3, S 41) : toujours avec numéro si dispo ---
  if (isRegio) {
    if (!num) {
      return { label: cat || "–", isSoloLongDistance: false };
    }
    return { label: `${cat} ${num}`, isSoloLongDistance: false };
  }

  // --- Fallback générique ---
  if (cat && hasShortNum)
    return { label: `${cat} ${num}`, isSoloLongDistance: false };
  if (cat) return { label: cat, isSoloLongDistance: false };
  if (hasShortNum) return { label: num, isSoloLongDistance: false };
  return { label: "–", isSoloLongDistance: false };
}

// --- Simple UI helpers ---

export function updateStationTitle() {
  const titleEl = document.getElementById("station-title");
  if (titleEl) {
    titleEl.textContent = appState.STATION;
  }
}

export function updateFilterToggleUI() {
  const btn = appState.filterButton;
  if (!btn) return;

  // Always show the button (it’s now a view selector)
  btn.classList.remove("is-hidden");
  btn.setAttribute("aria-hidden", "false");

  const labelEl = btn.querySelector(".filter-label");
  const mode =
    appState.viewMode || (appState.stationIsMotte ? "down" : "grouped");

  let label = "Vue";
  if (mode === "grouped") label = "Vue: Par ligne";
  if (mode === "chrono") label = "Vue: Heure";
  if (mode === "down") label = "Vue: Centre-ville";

  if (labelEl) labelEl.textContent = label;

  // Optional: visually mark "down" as ON-style
  if (mode === "down") {
    btn.classList.add("is-on");
    btn.setAttribute("aria-pressed", "true");
  } else {
    btn.classList.remove("is-on");
    btn.setAttribute("aria-pressed", "false");
  }
}

// --- Clock ---

export function renderClock() {
  const el = document.getElementById("digital-clock");
  if (!el) return;

  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-CH", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
  const timeStr = now.toLocaleTimeString("fr-CH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  el.textContent = `${dateStr}  ${timeStr}`;
}

// --- Departures table ---

export function renderDepartures(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  // Train-only board detection (must stay explicit)
  const hideMin = !!appState.lastBoardIsTrain;

  // Show / hide "min" column header depending on board type
  const minHeader = document.querySelector(".col-min-header");
  if (minHeader) {
    minHeader.style.display = hideMin ? "none" : "";
  }

  const visibleRows = rows;

  if (!visibleRows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "Aucun départ disponible.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const dep of visibleRows) {
    const tr = document.createElement("tr");

    // Column: Line
    const tdLine = document.createElement("td");
    tdLine.className = "col-line-cell";

    const badge = document.createElement("span");
    badge.classList.add("line-badge");

    if (dep.mode === "train") {
      const cat = dep.category || "";
      const num = dep.number || "";

      // Déterminer le type visuel
      const upperCat = (cat || "").toUpperCase();
      let visualType;

      if (["IC", "IR", "EC", "EN", "ICE", "RJ", "RJX"].includes(upperCat)) {
        visualType = "train-longdistance";
      } else if (upperCat === "RE") {
        visualType = "train-rexpress";
      } else if (upperCat === "PE") {
        // GoldenPass / Panorama Express (PE / PE 30)
        visualType = "train-pe";
      } else if (upperCat === "R" || upperCat === "S") {
        visualType = "train-regio";
      } else {
        // fallback: considérer comme Regio
        visualType = "train-regio";
      }

      badge.classList.add("line-train", visualType);

      // Construire le libellé affiché (IR 95, RE 33, R 3, PE 30, ou juste IR / PE)
      const { label, isSoloLongDistance } = buildTrainLabel(cat, num);
      badge.textContent = label;

      if (isSoloLongDistance) {
        badge.classList.add("train-longdistance-solo");
      }
    } else {
      // --- BUS BADGE BRANCH -----------------------------
      const rawBus = dep.simpleLineId || dep.number || dep.line || "?";
      const busNum = String(rawBus).trim() || "?";

      badge.textContent = busNum;

      // 1) PostAuto prioritaire: jaune/noir partout en Suisse
      if (dep.isPostBus) {
        badge.classList.add("line-postbus");
      }
      // 2) Sinon palettes réseau spécifiques
      else if (appState.currentNetwork === "tpg") {
        let key = busNum;
        if (key === "E+") key = "Eplus";
        if (key === "G+") key = "Gplus";
        badge.classList.add(`line-tpg-${key}`);
      } else if (appState.currentNetwork === "vbz") {
        badge.classList.add(`line-zh-${busNum}`);
      } else {
        // TL / MBC / TPN / générique
        badge.classList.add(`line-${busNum}`);
      }
    }

    tdLine.appendChild(badge);

    // Time
    const tdTime = document.createElement("td");
    tdTime.className = "col-time-cell";
    tdTime.textContent = dep.timeStr;

    // Destination
    const tdDest = document.createElement("td");
    tdDest.textContent = dep.dest;

    // Platform
    const tdPlatform = document.createElement("td");
    tdPlatform.className = "col-platform-cell";
    tdPlatform.textContent = dep.platform || "";
    if (dep.platformChanged) {
      tdPlatform.classList.add("platform-changed");
    }

    // Minutes column (hidden for pure train boards, but kept in DOM to keep column alignment)
    const tdMin = document.createElement("td");
    tdMin.className = "col-min-cell";
    tdMin.style.display = hideMin ? "none" : "";

    if (!hideMin) {
      if (dep.showArrivalIcon) {
        const svgNS = "http://www.w3.org/2000/svg";
        const xlinkNS = "http://www.w3.org/1999/xlink";
        const icon = document.createElementNS(svgNS, "svg");

        // Your arrival icon is meant for bus mode
        icon.setAttribute("class", "bus-arrival-icon pulse-bus");
        const use = document.createElementNS(svgNS, "use");
        use.setAttributeNS(xlinkNS, "xlink:href", "#bus-arrival");
        icon.appendChild(use);

        tdMin.appendChild(icon);
      } else {
        tdMin.textContent = dep.inMin.toString();
      }
    }

    // Remark
    const tdRemark = document.createElement("td");
    tdRemark.className = "col-remark-cell";

    // Apply status-based styling hooks coming from logic.js
    if (dep.status === "delay") {
      tdRemark.classList.add("status-delay");
    } else if (dep.status === "early") {
      tdRemark.classList.add("status-early");
    }

    tdRemark.textContent = dep.remark || "";

    tr.appendChild(tdLine);
    tr.appendChild(tdTime);
    tr.appendChild(tdDest);
    tr.appendChild(tdPlatform);
    tr.appendChild(tdMin);
    tr.appendChild(tdRemark);

    tbody.appendChild(tr);
  }
}

// --- Platform pills visibility ---

// Helper to sort platforms/lines "naturally" (A, B, C, 1, 2, 3, etc.)
function sortPlatforms(list) {
  return list.slice().sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);

    if (aNum && bNum) return na - nb; // both numeric
    if (aNum && !bNum) return 1; // put letters before numbers
    if (!aNum && bNum) return -1;
    return a.localeCompare(b, "fr-CH"); // both non-numeric
  });
}

export function updatePlatformFilterVisibility() {
  const container = document.querySelector(".platform-filter-container");
  const select = document.getElementById("platform-filter");
  if (!container || !select) return;

  const motteDescendreOn = appState.stationIsMotte && appState.filterEnabled;
  if (motteDescendreOn) {
    container.style.display = "none";
    return;
  }

  const hasBus = appState.lastBoardHasBus;
  const trainOnly = appState.lastBoardIsTrain;
  const hasBusPlatforms = appState.lastBoardHasBusPlatform;
  const platforms = sortPlatforms(appState.platformOptions || []);

  // Hide filter when:
  //  - no buses at all, OR
  //  - board is pure train, OR
  //  - no bus platforms detected
  if (!hasBus || trainOnly || !hasBusPlatforms || platforms.length === 0) {
    container.style.display = "none";
    appState.platformFilter = null;
    select.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Tous les quais";
    select.appendChild(optAll);
    select.value = "";

    return;
  }

  // Otherwise, build the dropdown with actual platforms
  container.style.display = "";

  // Rebuild options
  select.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "Tous les quais";
  select.appendChild(optAll);

  for (const p of platforms) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }

  // Ensure select reflects current filter
  if (appState.platformFilter && platforms.includes(appState.platformFilter)) {
    select.value = appState.platformFilter;
  } else {
    appState.platformFilter = null;
    select.value = "";
  }
}

// --- Line filter visibility (bus) ---

export function updateLineFilterVisibility() {
  const select = document.getElementById("line-filter");
  if (!select) return; // pas encore dans le HTML

  const container =
    document.querySelector(".line-filter-container") || select.parentElement;

  const motteDescendreOn = appState.stationIsMotte && appState.filterEnabled;
  if (motteDescendreOn) {
    if (container) container.style.display = "none";
    return;
  }

  const hasBus = appState.lastBoardHasBus;
  const trainOnly = appState.lastBoardIsTrain;
  const lines = sortPlatforms(appState.lineOptions || []);

  // Cacher quand:
  //  - aucun bus,
  //  - board 100 % trains,
  //  - aucune ligne détectée
  if (!hasBus || trainOnly || lines.length === 0) {
    if (container) container.style.display = "none";
    appState.lineFilter = null;

    select.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Toutes les lignes";
    select.appendChild(optAll);
    select.value = "";

    return;
  }

  if (container) container.style.display = "";

  // Reconstruire les options
  select.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "Toutes les lignes";
  select.appendChild(optAll);

  for (const line of lines) {
    const opt = document.createElement("option");
    opt.value = line;
    opt.textContent = line;
    select.appendChild(opt);
  }

  // S'assurer que le select reflète bien la valeur courante
  if (appState.lineFilter && lines.includes(appState.lineFilter)) {
    select.value = appState.lineFilter;
  } else {
    appState.lineFilter = null;
    select.value = "";
  }
}

// --- Controls setup ---

export function setupFilterToggle(onToggle) {
  const btn = document.getElementById("filter-toggle");
  if (!btn) return;

  appState.filterButton = btn;

  btn.addEventListener("click", () => {
    const modes = appState.stationIsMotte
      ? ["down", "grouped", "chrono"]
      : ["grouped", "chrono"];

    const cur = appState.viewMode || modes[0];
    const idx = modes.indexOf(cur);
    const next = modes[(idx + 1) % modes.length];

    appState.viewMode = next;

    // If entering Centre-ville view, clear other filters (same as before)
    if (next === "down") {
      appState.platformFilter = null;
      appState.lineFilter = null;
    }

    updateFilterToggleUI();
    onToggle();
  });

  updateFilterToggleUI();
}

export function setupStationInput(onStationSelected) {
  const input = document.getElementById("station-input");
  const btn = document.getElementById("station-submit");
  const suggestionsEl = document.getElementById("station-suggestions");
  if (!input || !btn || !suggestionsEl) return;

  // Show current station as placeholder, but keep the field empty
  input.placeholder = appState.STATION;
  input.value = "";

  // On focus, select everything (if any)
  input.addEventListener("focus", () => {
    input.select();
  });

  let debounceId = null;

  function clearSuggestions() {
    suggestionsEl.innerHTML = "";
  }

  function renderSuggestions(list) {
    clearSuggestions();
    if (!list.length) return;

    for (const s of list) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.textContent = s.name;
      li.addEventListener("click", () => {
        input.value = ""; // clear after click
        clearSuggestions();
        onStationSelected(s.name, s.id);
      });
      suggestionsEl.appendChild(li);
    }
  }

  async function loadSuggestions(term) {
    try {
      const list = await fetchStationSuggestions(term);
      renderSuggestions(list);
    } catch (e) {
      console.error("Station suggestions error:", e);
    }
  }

  input.addEventListener("input", () => {
    const val = input.value.trim();
    if (debounceId) clearTimeout(debounceId);

    if (val.length < 2) {
      clearSuggestions();
      return;
    }

    debounceId = setTimeout(() => loadSuggestions(val), 250);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearSuggestions();
      const term = input.value;
      onStationSelected(term);
      input.value = ""; // field empty right after search
    }
  });

  btn.addEventListener("click", () => {
    clearSuggestions();
    const term = input.value;
    onStationSelected(term);
    input.value = ""; // same behaviour on button click
  });
}

export function setupPlatformFilter(onPlatformChange) {
  const select = document.getElementById("platform-filter");
  if (!select) return;

  select.addEventListener("change", () => {
    const value = select.value;
    appState.platformFilter = value || null;
    onPlatformChange();
  });
}

export function setupLineFilter(onLineChange) {
  const select = document.getElementById("line-filter");
  if (!select) return;

  select.addEventListener("change", () => {
    const value = select.value;
    appState.lineFilter = value || null;
    onLineChange();
  });
}