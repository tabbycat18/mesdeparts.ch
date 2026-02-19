import {
  appState,
  VIEW_MODE_LINE,
  VIEW_MODE_TIME,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
} from "../state.v2025-02-19.js";
import { fetchStationSuggestions, fetchStationsNearby } from "../logic.v2025-02-19.js";
import { loadFavorites, saveFavorites } from "../favourites.v2025-02-19.js";
import { t, setLanguage, LANGUAGE_OPTIONS, applyStaticTranslations } from "../i18n.v2025-02-19.js";

const STORAGE_COLLAPSED_KEY = "mesdeparts.headerControls2.collapsed";

const FAVORITE_MESSAGES = {
  missing: {
    fr: "Sélectionne un arrêt avant d'ajouter aux favoris.",
    de: "Bitte wähle zuerst eine Haltestelle.",
    it: "Seleziona prima una fermata.",
    en: "Select a stop before adding to favorites.",
  },
  exists: {
    fr: "Déjà dans vos favoris.",
    de: "Bereits in den Favoriten.",
    it: "Già nei preferiti.",
    en: "Already in favorites.",
  },
  saved: {
    fr: "Ajouté aux favoris.",
    de: "Zu Favoriten hinzugefügt.",
    it: "Aggiunto ai preferiti.",
    en: "Saved to favorites.",
  },
};

const SAVE_LABELS = {
  fr: { ready: "Sauver cet arrêt", saved: "Arrêt déjà sauvegardé" },
  de: { ready: "Diesen Halt speichern", saved: "Haltestelle bereits gespeichert" },
  it: { ready: "Salva questa fermata", saved: "Fermata già salvata" },
  en: { ready: "Save this stop", saved: "Stop already saved" },
};

const state = {
  initialized: false,
  mountEl: null,
  // Integration contract:
  // - getCurrentStop(): provided by main.v2025-02-19.js -> returns { id, name } from appState.
  // - onSelectStop(arg1, arg2): provided by main.v2025-02-19.js -> supports `(id, name)` and legacy payloads.
  // - favorites storage: loadFavorites()/saveFavorites() from favourites.v2025-02-19.js.
  callbacks: {
    getCurrentStop: () => ({ id: appState.stationId || null, name: appState.STATION || "" }),
    onSelectStop: null,
    onGeoLocate: null,
    onOpenInfo: null,
    onControlsChange: null,
    onLanguageChange: null,
  },
  controlsOpen: false,
  favoritesOpen: false,
  searchText: "",
  favorites: [], // [{ id, name, addedAt }]
  selectedFavId: null,
  isSaving: false,
  refs: {},
  filtersOpen: false,
  suggestions: [],
  suggestionsDebounce: null,
  currentStop: { id: null, name: "" },
  draftFilters: {
    platforms: [],
    lines: [],
    hideDeparture: false,
  },
  statusTimer: null,
  controlsAnimationTimer: null,
  favoritesOpener: null,
  inertRoot: null,
};

function langCode() {
  return String(appState.language || "fr").toLowerCase();
}

function pickLocalized(map) {
  const lang = langCode();
  return map[lang] || map.en;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v));
  if (!value) return [];
  return [String(value)];
}

function normalizeToAllowed(value, allowed) {
  const requested = new Set(normalizeArray(value));
  const list = Array.isArray(allowed) ? allowed : [];
  return list.filter((entry) => requested.has(entry));
}

function getStopFromCallback() {
  const src =
    typeof state.callbacks.getCurrentStop === "function"
      ? state.callbacks.getCurrentStop()
      : { id: appState.stationId || null, name: appState.STATION || "" };

  return {
    id: src && typeof src.id === "string" ? src.id.trim() : null,
    name: src && typeof src.name === "string" ? src.name.trim() : "",
  };
}

function createTemplate() {
  return `
    <header class="hc2" aria-label="Header Controls">
      <div class="hc2__meta">
        <div class="hc2__clockCol" aria-hidden="true">
          <div class="hc2__clock">
            <iframe
              data-clock-src="clock/index.html"
              class="cff-clock"
              title="Horloge CFF"
              loading="lazy"
            ></iframe>
          </div>
        </div>

        <div class="hc2__titleBlock">
          <h1 id="station-title" class="hc2__title">${state.currentStop.name || "Station"}</h1>
          <div class="hc2__subtitleRow">
            <div id="station-subtitle" class="hc2__subtitle">${t("nextDepartures")}</div>
            <div id="mode-icons" class="mode-icons" aria-label="Modes" title="Modes"></div>
          </div>
          <div class="hc2__timeRow">
            <div id="digital-clock" class="digital-clock">--:--:--</div>
            <div id="unofficial-tag" class="unofficial-tag">${t("headerUnofficialTag")}</div>
          </div>
        </div>

        <div class="hc2__metaActions">
          <button
            id="info-btn"
            class="hc2__iconBtn"
            data-action="info"
            type="button"
            aria-label="${t("dualInfoLabel")}"
            title="${t("dualInfoLabel")}"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"></circle>
              <line x1="12" y1="11" x2="12" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line>
              <circle cx="12" cy="8" r="1.2" fill="currentColor"></circle>
            </svg>
          </button>
          <button
            id="header-controls2-menu-toggle"
            class="hc2__iconBtn"
            data-action="menu"
            type="button"
            aria-expanded="false"
            aria-controls="header-controls2-panel"
            aria-label="${t("quickControlsShow")}"
          >
            <span id="header-controls2-menu-label" class="sr-only">${t("quickControlsShow")}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="6" cy="12" r="1.8" fill="currentColor"></circle>
              <circle cx="12" cy="12" r="1.8" fill="currentColor"></circle>
              <circle cx="18" cy="12" r="1.8" fill="currentColor"></circle>
            </svg>
          </button>
        </div>
      </div>

      <div id="header-controls2-panel" class="hc2__controls" hidden aria-label="Header Controls 2">
        <label for="station-input" class="sr-only">${t("searchStop")}</label>
        <div class="hc2__search">
          <span class="hc2__searchIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path
                fill="currentColor"
                d="m15.7 14.3-.3-.3A5.95 5.95 0 0 0 16.5 10a6 6 0 1 0-6 6 5.95 5.95 0 0 0 4-1.5l.3.3v.9L20 21l1-1-5.3-5.7Zm-5.2 0A4.3 4.3 0 1 1 14.8 10a4.3 4.3 0 0 1-4.3 4.3Z"
              />
            </svg>
          </span>
          <input
            id="station-input"
            type="text"
            class="hc2__searchInput"
            placeholder="${t("searchAction")}..."
            autocomplete="off"
          />
          <div class="hc2__searchActions">
            <button
              id="station-input-clear"
              class="hc2__actionBtn is-hidden"
              data-action="clear"
              type="button"
              aria-label="Clear"
            >
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  d="M6 6 18 18M18 6 6 18"
                />
              </svg>
            </button>
            <button
              id="station-search-btn"
              class="hc2__actionBtn"
              data-action="geo"
              type="button"
              aria-label="${t("nearbyButton")}"
              title="${t("nearbyButton")}"
            >
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 21s-6-5.94-6-11a6 6 0 1 1 12 0c0 5.06-6 11-6 11Z"
                />
                <circle cx="12" cy="10" r="2.4" fill="currentColor" />
              </svg>
            </button>
            <button
              id="favorites-only-toggle"
              class="hc2__actionBtn"
              data-action="favorites"
              type="button"
              aria-label="${t("filterFavoritesTitle")}"
              aria-expanded="false"
              aria-controls="favorites-popover"
            >
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                  d="M6 4h12a1 1 0 0 1 1 1v15l-7-3-7 3V5a1 1 0 0 1 1-1Z"
                />
              </svg>
              <span id="favorites-only-label" class="sr-only">${t("filterFavoritesLabel")}</span>
            </button>
          </div>
        </div>

        <ul id="station-suggestions" class="hc2__suggestions"></ul>

        <div class="hc2__row">
          <div id="view-section-label" class="hc2__rowLabel">${t("viewSectionLabel")}</div>
          <div id="view-segment" class="hc2__segment"></div>
        </div>

        <div class="hc2__row hc2__rowDual">
          <a
            id="dual-board-link"
            class="hc2__pill"
            href="dual-board.html"
            target="_blank"
            rel="noopener"
            aria-label="${t("dualBoardOpen")}"
          >
            <span aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <rect x="5" y="6" width="6" height="12" rx="2" fill="currentColor"></rect>
                <rect x="13" y="6" width="6" height="12" rx="2" fill="currentColor"></rect>
              </svg>
            </span>
            <span id="dual-board-label">${t("dualBoardLabel")}</span>
          </a>
          <button
            id="filters-open"
            class="hc2__pill"
            data-action="filters"
            type="button"
            aria-expanded="false"
            aria-controls="filters-popover"
          >
            <span id="filters-open-label">${t("filterButton")}</span>
          </button>
          <button id="filters-reset-inline" class="hc2__linkBtn is-hidden" type="button">${t("filterReset")}</button>
        </div>

        <div class="hc2__row hc2__rowLang">
          <label for="language-select" class="hc2__rowLabel">${t("languageLabel")}</label>
          <select id="language-select" class="hc2__select" aria-label="${t("languageLabel")}"></select>
        </div>

        <div id="loading-hint" class="loading-hint" role="status" aria-live="polite"></div>
      </div>
    </header>
  `;
}

function createGlobalSheetsTemplate() {
  return `
    <div id="favorites-backdrop" class="hc2__backdrop" hidden></div>

    <section
      id="favorites-popover"
      class="hc2__sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="favorites-popover-title"
      tabindex="-1"
      hidden
    >
      <header class="hc2__sheetHeader">
        <h2 id="favorites-popover-title" class="hc2__sheetTitle">${t("filterFavoritesTitle")}</h2>
        <button
          class="hc2__iconBtn hc2__sheetClose"
          data-action="closeFavs"
          data-fav-sheet-close="true"
          type="button"
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <div id="favorites-status" class="hc2__status is-hidden" role="status" aria-live="polite"></div>

      <button id="favorites-save-current" class="hc2__primary" data-action="saveStop" type="button">
        ${pickLocalized(SAVE_LABELS).ready}
      </button>

      <div id="favorites-chip-list" class="hc2__favList"></div>
      <div id="favorites-empty" class="hc2__empty is-hidden">${t("filterNoFavorites")}</div>

      <footer class="hc2__sheetFooter">
        <button id="favorites-manage" class="hc2__secondary" data-action="manage" type="button">
          ${t("filterManageFavorites")}
        </button>
        <button id="favorites-delete" class="hc2__danger" data-action="delete" type="button" disabled>
          ${t("favoritesDelete")}
        </button>
      </footer>
    </section>

    <section
      id="filters-popover"
      class="hc2__sheet hc2__sheet--filters"
      role="dialog"
      aria-modal="true"
      aria-labelledby="filters-sheet-title"
      tabindex="-1"
      hidden
    >
      <header class="hc2__sheetHeader">
        <h2 id="filters-sheet-title" class="hc2__sheetTitle">${t("filterButton")}</h2>
        <button
          class="hc2__iconBtn hc2__sheetClose"
          data-action="closeFilters"
          data-filter-popover-close="true"
          type="button"
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <div class="hc2__sheetBody">
        <section class="hc2__filterSection" id="filters-section-platforms">
          <div class="hc2__sectionTitle" id="filters-platforms-title">${t("filterPlatforms")}</div>
          <div id="platform-chip-list" class="hc2__chipRow"></div>
          <div id="platforms-empty" class="hc2__empty is-hidden">${t("filterNoPlatforms")}</div>
        </section>

        <section class="hc2__filterSection" id="filters-section-lines">
          <div class="hc2__sectionTitle" id="filters-lines-title">${t("filterLines")}</div>
          <div id="line-chip-list" class="hc2__chipRow"></div>
          <div id="lines-empty" class="hc2__empty is-hidden">${t("filterNoLines")}</div>
        </section>

        <section class="hc2__filterSection" id="filters-section-display">
          <div class="hc2__sectionTitle" id="filters-display-title">${t("filterDisplay")}</div>
          <label class="hc2__switch" for="filters-hide-departure">
            <span>${t("filterHideDeparture")}</span>
            <input type="checkbox" id="filters-hide-departure" />
          </label>
        </section>
      </div>

      <footer class="hc2__sheetFooter">
        <button id="filters-reset" class="hc2__secondary" type="button">${t("filterReset")}</button>
        <button id="filters-apply" class="hc2__primary" type="button">${t("filterApply")}</button>
      </footer>
    </section>
  `;
}

function ensureGlobalSheetsMounted() {
  let host = document.getElementById("header-controls2-global-layer");
  if (!host) {
    host = document.createElement("div");
    host.id = "header-controls2-global-layer";
    document.body.appendChild(host);
  }
  host.innerHTML = createGlobalSheetsTemplate();
}

function cacheRefs() {
  const q = (id) => state.mountEl.querySelector(`#${id}`);
  const d = document;
  const dq = (id) => d.getElementById(id);

  state.refs = {
    menuToggle: q("header-controls2-menu-toggle"),
    menuLabel: q("header-controls2-menu-label"),
    panel: q("header-controls2-panel"),
    infoBtn: q("info-btn"),

    stationInput: q("station-input"),
    stationClear: q("station-input-clear"),
    stationGeo: q("station-search-btn"),
    stationSuggestions: q("station-suggestions"),

    favoritesToggle: q("favorites-only-toggle"),
    favoritesSheet: dq("favorites-popover"),
    favoritesClose: d.querySelector("[data-fav-sheet-close='true']"),
    favoritesStatus: dq("favorites-status"),
    favoritesSave: dq("favorites-save-current"),
    favoritesManage: dq("favorites-manage"),
    favoritesDelete: dq("favorites-delete"),
    favoritesList: dq("favorites-chip-list"),
    favoritesEmpty: dq("favorites-empty"),

    filtersOpen: q("filters-open"),
    filtersLabel: q("filters-open-label"),
    filtersResetInline: q("filters-reset-inline"),
    filtersSheet: dq("filters-popover"),
    filtersClose: d.querySelector("[data-filter-popover-close='true']"),
    filtersReset: dq("filters-reset"),
    filtersApply: dq("filters-apply"),
    platformsList: dq("platform-chip-list"),
    linesList: dq("line-chip-list"),
    platformsEmpty: dq("platforms-empty"),
    linesEmpty: dq("lines-empty"),
    hideDeparture: dq("filters-hide-departure"),

    viewSegment: q("view-segment"),
    backdrop: dq("favorites-backdrop"),
    languageSelect: q("language-select"),
  };
}

function mountMarkup() {
  state.mountEl.innerHTML = createTemplate();
  ensureGlobalSheetsMounted();
  cacheRefs();
}

function resolveInertRoot() {
  if (state.inertRoot && document.contains(state.inertRoot)) {
    return state.inertRoot;
  }
  const root =
    state.mountEl?.closest(".mobile-fullscreen-wrapper") ||
    document.querySelector(".mobile-fullscreen-wrapper") ||
    document.querySelector(".board");
  state.inertRoot = root || null;
  return state.inertRoot;
}

function setBackgroundInert(enabled) {
  const root = resolveInertRoot();
  if (!root) return;

  if (enabled) {
    root.setAttribute("inert", "");
    return;
  }

  root.removeAttribute("inert");
}

function focusableIn(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      "button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
    ),
  ).filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
}

function trapFocusInFavoritesSheet(event) {
  if (!state.favoritesOpen || event.key !== "Tab") return;
  const sheet = state.refs.favoritesSheet;
  if (!sheet || sheet.hidden) return;

  const focusables = focusableIn(sheet);
  if (!focusables.length) {
    event.preventDefault();
    if (typeof sheet.focus === "function") sheet.focus({ preventScroll: true });
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const inside = !!active && sheet.contains(active);

  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    }
    return;
  }

  if (!inside || active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function setStatus(message) {
  const el = state.refs.favoritesStatus;
  if (!el) return;

  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }

  const text = String(message || "").trim();
  el.textContent = text;
  el.classList.toggle("is-hidden", !text);
  if (!text) return;

  state.statusTimer = setTimeout(() => {
    if (!state.refs.favoritesStatus) return;
    state.refs.favoritesStatus.classList.add("is-hidden");
    state.refs.favoritesStatus.textContent = "";
    state.statusTimer = null;
  }, 2400);
}

function syncCollapseUi() {
  const panel = state.refs.panel;
  const btn = state.refs.menuToggle;
  const label = state.refs.menuLabel;
  if (!panel || !btn) return;

  if (state.controlsAnimationTimer) {
    clearTimeout(state.controlsAnimationTimer);
    state.controlsAnimationTimer = null;
  }

  if (state.controlsOpen) {
    panel.hidden = false;
    panel.classList.remove("is-closing");
    requestAnimationFrame(() => {
      panel.classList.add("is-open");
    });
  } else {
    panel.classList.remove("is-open");
    panel.classList.add("is-closing");
    state.controlsAnimationTimer = setTimeout(() => {
      panel.hidden = true;
      panel.classList.remove("is-closing");
      state.controlsAnimationTimer = null;
    }, 220);
  }

  btn.setAttribute("aria-expanded", state.controlsOpen ? "true" : "false");
  const txt = t(state.controlsOpen ? "quickControlsHide" : "quickControlsShow");
  btn.setAttribute("aria-label", txt);
  if (label) label.textContent = txt;
}

function openControls() {
  state.controlsOpen = true;
  syncCollapseUi();
  try {
    localStorage.setItem(STORAGE_COLLAPSED_KEY, "0");
  } catch {
    // ignore storage failures
  }
}

function closeControls() {
  state.controlsOpen = false;
  syncCollapseUi();
  try {
    localStorage.setItem(STORAGE_COLLAPSED_KEY, "1");
  } catch {
    // ignore storage failures
  }
}

function toggleControls() {
  if (state.controlsOpen) closeControls();
  else openControls();
}

function restoreCollapsedState() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_COLLAPSED_KEY);
  } catch {
    stored = null;
  }

  if (stored === "0" || stored === "1") {
    state.controlsOpen = stored === "0";
  } else {
    state.controlsOpen = !window.matchMedia("(max-width: 900px)").matches;
  }
  syncCollapseUi();
}

function closeFilters({ restoreFocus = true } = {}) {
  if (!state.filtersOpen) return;

  const { favoritesSheet, filtersSheet, favoritesToggle, filtersOpen, backdrop } = state.refs;
  const opener = filtersOpen;

  const active = document.activeElement;
  if (
    restoreFocus &&
    filtersSheet &&
    active &&
    filtersSheet.contains(active) &&
    opener &&
    typeof opener.focus === "function"
  ) {
    opener.focus({ preventScroll: true });
  }

  if (filtersSheet) {
    filtersSheet.hidden = true;
  }
  filtersOpen?.setAttribute("aria-expanded", "false");
  state.filtersOpen = false;

  if (!state.favoritesOpen) {
    if (backdrop) backdrop.hidden = true;
  }
  favoritesToggle?.setAttribute("aria-expanded", state.favoritesOpen ? "true" : "false");

  if (restoreFocus && opener && typeof opener.focus === "function") {
    opener.focus({ preventScroll: true });
  }
}

function openFavorites() {
  const { favoritesSheet, favoritesToggle, backdrop } = state.refs;
  closeFilters({ restoreFocus: false });
  const active = document.activeElement;
  state.favoritesOpener =
    active && typeof active.focus === "function" ? active : favoritesToggle || null;
  syncFavoritesFromStorage();
  renderFavoritesSheet();
  updateSaveButton();
  if (favoritesSheet) {
    favoritesSheet.hidden = false;
  }
  favoritesToggle?.setAttribute("aria-expanded", "true");
  if (backdrop) backdrop.hidden = false;
  setBackgroundInert(true);
  state.favoritesOpen = true;

  const focusables = focusableIn(favoritesSheet);
  const target = focusables[0] || favoritesSheet;
  if (target && typeof target.focus === "function") {
    target.focus({ preventScroll: true });
  }
}

function closeFavorites({ restoreFocus = true } = {}) {
  if (!state.favoritesOpen) return;
  const { favoritesSheet, favoritesToggle, backdrop } = state.refs;
  const opener = state.favoritesOpener;
  const active = document.activeElement;
  if (
    restoreFocus &&
    favoritesSheet &&
    active &&
    favoritesSheet.contains(active) &&
    opener &&
    typeof opener.focus === "function"
  ) {
    opener.focus({ preventScroll: true });
  }
  state.favoritesOpen = false;
  if (favoritesSheet) {
    favoritesSheet.hidden = true;
  }
  favoritesToggle?.setAttribute("aria-expanded", "false");
  if (!state.filtersOpen) {
    if (backdrop) backdrop.hidden = true;
  }
  setBackgroundInert(false);
  state.favoritesOpener = null;
  if (restoreFocus && opener && typeof opener.focus === "function") {
    opener.focus({ preventScroll: true });
  }
}

function toggleFavorites() {
  if (state.favoritesOpen) closeFavorites();
  else openFavorites();
}

function openFilters() {
  const { filtersSheet, filtersOpen, backdrop } = state.refs;
  closeFavorites({ restoreFocus: false });
  syncDraftFiltersFromState();
  renderFiltersSheet();
  if (filtersSheet) {
    filtersSheet.hidden = false;
  }
  filtersOpen?.setAttribute("aria-expanded", "true");
  if (backdrop) backdrop.hidden = false;
  state.filtersOpen = true;
}

function closeFiltersAndApply() {
  applyDraftFilters();
  closeFilters();
}

function closeAllSheets({ restoreFocus = true } = {}) {
  closeFavorites({ restoreFocus });
  closeFilters({ restoreFocus });
}

function setSearchText(value) {
  const input = state.refs.stationInput;
  state.searchText = String(value || "");
  if (input && input.value !== state.searchText) {
    input.value = state.searchText;
  }
  syncClearButton();
}

function clearSearch() {
  setSearchText("");
  clearSuggestions();
  if (state.refs.stationInput && typeof state.refs.stationInput.focus === "function") {
    state.refs.stationInput.focus();
  }
}

function setSuggestionsVisible(visible) {
  const list = state.refs.stationSuggestions;
  if (!list) return;
  list.classList.toggle("is-visible", !!visible);
}

function clearSuggestions() {
  const list = state.refs.stationSuggestions;
  if (!list) return;
  list.innerHTML = "";
  state.suggestions = [];
  state.searchText = String(state.refs.stationInput?.value || "");
  setSuggestionsVisible(false);
}

function renderSuggestionStatus(message) {
  const list = state.refs.stationSuggestions;
  if (!list) return;

  list.innerHTML = "";
  const item = document.createElement("li");
  item.className = "hc2__suggestion hc2__suggestionStatus";
  item.textContent = message;
  list.appendChild(item);
  state.suggestions = [];
  setSuggestionsVisible(true);
}

function syncClearButton() {
  const input = state.refs.stationInput;
  const clearBtn = state.refs.stationClear;
  if (!input || !clearBtn) return;

  const hasText = !!String(input.value || "").trim();
  state.searchText = String(input.value || "");
  clearBtn.classList.toggle("is-hidden", !hasText);
}

function formatDistance(distance) {
  const meters = Number(distance);
  if (!Number.isFinite(meters) || meters <= 0) return "";
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

function emitSelectStop(stop) {
  if (!stop || !stop.name) return;

  if (typeof state.callbacks.onSelectStop === "function") {
    state.callbacks.onSelectStop({
      id: typeof stop.id === "string" && stop.id.trim() ? stop.id.trim() : null,
      name: String(stop.name || "").trim(),
    });
  }
}

function selectStop(stop) {
  emitSelectStop(stop);
  clearSuggestions();
  closeAllSheets({ restoreFocus: false });
}

function selectFavorite(id) {
  const favId = typeof id === "string" ? id.trim() : "";
  if (!favId) return;
  const fav = state.favorites.find((item) => item && item.id === favId);
  if (!fav) return;

  state.selectedFavId = favId;
  if (typeof state.callbacks.onSelectStop === "function") {
    // STEP 5 contract: select favorite using id + name.
    state.callbacks.onSelectStop(fav.id, fav.name);
  }
  closeFavorites({ restoreFocus: false });
}

function syncFavoritesFromStorage() {
  state.favorites = Array.isArray(loadFavorites()) ? loadFavorites() : [];
  if (state.selectedFavId && !state.favorites.some((f) => f.id === state.selectedFavId)) {
    state.selectedFavId = null;
  }
}

function persistFavorites() {
  state.favorites = saveFavorites(state.favorites || []);
}

function deleteFavorite(id) {
  const favId = typeof id === "string" ? id.trim() : "";
  if (!favId) return;
  state.favorites = (state.favorites || []).filter((fav) => fav.id !== favId);
  if (state.selectedFavId === favId) {
    state.selectedFavId = null;
  }
  persistFavorites();
  renderFavoritesSheet();
  updateSaveButton();
}

function deleteSelectedFavorite() {
  if (!state.selectedFavId) return;
  deleteFavorite(state.selectedFavId);
}

function renderSuggestions(items) {
  const list = state.refs.stationSuggestions;
  if (!list) return;

  state.suggestions = Array.isArray(items) ? items : [];
  list.innerHTML = "";

  if (!state.suggestions.length) {
    setSuggestionsVisible(false);
    return;
  }

  state.suggestions.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "hc2__suggestion";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "hc2__suggestionBtn";

    const title = document.createElement("span");
    title.className = "hc2__suggestionName";
    title.textContent = String(entry.name || "").trim();
    button.appendChild(title);

    const dist = formatDistance(entry.distance);
    if (dist) {
      const distance = document.createElement("span");
      distance.className = "hc2__suggestionDistance";
      distance.textContent = dist;
      button.appendChild(distance);
    }

    button.addEventListener("click", () => selectStop({ id: entry.id || null, name: entry.name || "" }));
    li.appendChild(button);
    list.appendChild(li);
  });

  setSuggestionsVisible(true);
}

async function fetchAndRenderSuggestions(query) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) {
    clearSuggestions();
    return;
  }

  const requested = trimmed;
  try {
    const items = await fetchStationSuggestions(trimmed);
    const current = String(state.refs.stationInput?.value || "").trim();
    if (current !== requested) return;
    renderSuggestions(items || []);
  } catch {
    clearSuggestions();
  }
}

async function runGeoLocate() {
  const geoBtn = state.refs.stationGeo;
  geoBtn?.setAttribute("disabled", "true");
  geoBtn?.classList.add("is-loading");
  renderSuggestionStatus(t("nearbySearching"));

  try {
    const geoCallback = state.callbacks.onGeoLocate;
    let items = null;

    // If integrator provides a zero-arg geolocate callback, let it fully resolve nearby stops.
    if (typeof geoCallback === "function" && geoCallback.length === 0) {
      const directItems = await geoCallback();
      if (Array.isArray(directItems)) {
        items = directItems;
      }
    }

    let pos = null;
    if (!Array.isArray(items)) {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        renderSuggestionStatus(t("nearbyNoGeo"));
        return;
      }

      pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        });
      });
    }

    if (!Array.isArray(items) && pos && typeof geoCallback === "function" && geoCallback.length > 0) {
      items = await geoCallback({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
    }

    if (!Array.isArray(items) && pos) {
      items = await fetchStationsNearby(pos.coords.latitude, pos.coords.longitude, 10);
    }

    if (!items || !items.length) {
      renderSuggestionStatus(t("nearbyNone"));
      return;
    }

    if (state.refs.stationInput) {
      state.refs.stationInput.value = "";
      syncClearButton();
    }

    renderSuggestions(items);
  } catch (err) {
    if (err && Number(err.code) === 1) {
      renderSuggestionStatus(t("nearbyDenied"));
    } else {
      renderSuggestionStatus(t("nearbyError"));
    }
  } finally {
    geoBtn?.removeAttribute("disabled");
    geoBtn?.classList.remove("is-loading");
  }
}

function callControlsChanged() {
  if (typeof state.callbacks.onControlsChange === "function") {
    state.callbacks.onControlsChange();
  }
}

function renderViewSegment() {
  const mount = state.refs.viewSegment;
  if (!mount) return;

  const trainMode = !!appState.lastBoardIsTrain;
  const options = trainMode
    ? [
        { key: TRAIN_FILTER_ALL, label: t("trainFilterAll") },
        { key: TRAIN_FILTER_REGIONAL, label: t("trainFilterRegional") },
        { key: TRAIN_FILTER_LONG_DISTANCE, label: t("trainFilterLongDistance") },
      ]
    : [
        { key: VIEW_MODE_LINE, label: t("viewOptionLine") },
        { key: VIEW_MODE_TIME, label: t("viewOptionTime") },
      ];

  const active = trainMode
    ? appState.trainServiceFilter || TRAIN_FILTER_ALL
    : appState.viewMode || VIEW_MODE_LINE;

  mount.innerHTML = "";

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hc2__segmentBtn";
    btn.dataset.option = opt.key;
    if (opt.key === VIEW_MODE_LINE || opt.key === VIEW_MODE_TIME) {
      btn.dataset.view = opt.key;
    }
    const isActive = opt.key === active;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    btn.textContent = opt.label;

    btn.addEventListener("click", () => {
      if (trainMode) {
        if (appState.trainServiceFilter !== opt.key) {
          appState.trainServiceFilter = opt.key;
          renderViewSegment();
          callControlsChanged();
        }
        return;
      }

      if (appState.viewMode !== opt.key) {
        appState.viewMode = opt.key;
        renderViewSegment();
        callControlsChanged();
      }
    });

    mount.appendChild(btn);
  });
}

function filterSummaryParts() {
  const platformFilters = normalizeArray(appState.platformFilter);
  const lineFilters = normalizeArray(appState.lineFilter);
  const hideDeparture = !appState.lastBoardIsTrain && !!appState.hideBusDeparture;

  const parts = [];
  if (platformFilters.length) parts.push(`${t("filterPlatformsShort")} ${platformFilters.join(", ")}`);
  if (lineFilters.length) parts.push(`${t("filterLinesShort")} ${lineFilters.join(", ")}`);
  if (hideDeparture) parts.push(t("filterHideDepartureShort"));

  return parts;
}

function renderFilterSummary() {
  const label = state.refs.filtersLabel;
  const resetInline = state.refs.filtersResetInline;
  if (!label) return;

  const parts = filterSummaryParts();
  if (!parts.length) {
    label.textContent = t("filterButton");
    resetInline?.classList.add("is-hidden");
    return;
  }

  label.textContent = parts.join(" • ");
  resetInline?.classList.remove("is-hidden");
}

function syncDraftFiltersFromState() {
  const platformAllowed = (appState.platformOptions || []).map(String);
  const lineAllowed = (appState.lineOptions || []).map(String);

  state.draftFilters.platforms = normalizeToAllowed(appState.platformFilter, platformAllowed);
  state.draftFilters.lines = normalizeToAllowed(appState.lineFilter, lineAllowed);
  state.draftFilters.hideDeparture = !!appState.hideBusDeparture;
}

function toggleDraft(type, value) {
  const list = state.draftFilters[type];
  const idx = list.indexOf(value);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(value);
}

function createChip({ text, active, onClick }) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "hc2__chip";
  chip.classList.toggle("is-active", !!active);
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  chip.textContent = text;
  chip.addEventListener("click", onClick);
  return chip;
}

function renderDraftList(container, values, selected, type) {
  if (!container) return;
  container.innerHTML = "";

  if (!values.length) return;

  container.appendChild(
    createChip({
      text: t("filterAll"),
      active: selected.length === 0,
      onClick: () => {
        state.draftFilters[type] = [];
        renderFiltersSheet();
      },
    }),
  );

  values.forEach((value) => {
    container.appendChild(
      createChip({
        text: value,
        active: selected.includes(value),
        onClick: () => {
          toggleDraft(type, value);
          renderFiltersSheet();
        },
      }),
    );
  });
}

function renderFiltersSheet() {
  const platforms = (appState.platformOptions || []).map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const lines = (appState.lineOptions || [])
    .map(String)
    .filter(Boolean)
    .sort((a, b) => {
      const numA = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
      if (numA !== numB) return numA - numB;
      return String(a).localeCompare(String(b));
    });

  state.draftFilters.platforms = normalizeToAllowed(state.draftFilters.platforms, platforms);
  state.draftFilters.lines = normalizeToAllowed(state.draftFilters.lines, lines);

  renderDraftList(state.refs.platformsList, platforms, state.draftFilters.platforms, "platforms");
  renderDraftList(state.refs.linesList, lines, state.draftFilters.lines, "lines");

  if (state.refs.platformsEmpty) {
    state.refs.platformsEmpty.classList.toggle("is-hidden", platforms.length > 0);
  }
  if (state.refs.linesEmpty) {
    state.refs.linesEmpty.classList.toggle("is-hidden", lines.length > 0);
  }

  if (state.refs.hideDeparture) {
    state.refs.hideDeparture.checked = !!state.draftFilters.hideDeparture;
    state.refs.hideDeparture.disabled = !!appState.lastBoardIsTrain;
  }
}

function applyDraftFilters() {
  appState.platformFilter = state.draftFilters.platforms.length ? state.draftFilters.platforms.slice() : null;
  appState.lineFilter = state.draftFilters.lines.length ? state.draftFilters.lines.slice() : null;
  appState.hideBusDeparture = !!state.draftFilters.hideDeparture;

  renderFilterSummary();
  callControlsChanged();
}

function resetAllFilters() {
  state.draftFilters.platforms = [];
  state.draftFilters.lines = [];
  state.draftFilters.hideDeparture = false;
  renderFiltersSheet();
}

function updateSaveButton() {
  const button = state.refs.favoritesSave;
  if (!button) return;

  const stop = state.currentStop;
  const hasStop = !!(stop && stop.id && stop.name);
  const alreadySaved = hasStop && (state.favorites || []).some((fav) => fav.id === stop.id);

  const labels = pickLocalized(SAVE_LABELS);
  button.disabled = !hasStop || alreadySaved || !!state.isSaving;
  button.textContent = alreadySaved ? labels.saved : labels.ready;
}

function renderFavoritesSheet() {
  const host = state.refs.favoritesList;
  const empty = state.refs.favoritesEmpty;
  const deleteBtn = state.refs.favoritesDelete;
  if (!host || !empty) return;

  syncFavoritesFromStorage();
  const favorites = state.favorites || [];
  host.innerHTML = "";

  if (!favorites.length) {
    empty.classList.remove("is-hidden");
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  empty.classList.add("is-hidden");

  favorites.forEach((fav) => {
    const row = document.createElement("div");
    row.className = "hc2__favoriteRow";
    row.classList.toggle("is-selected", state.selectedFavId === fav.id);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "hc2__favoriteItem";
    pickBtn.textContent = fav.name;
    pickBtn.addEventListener("click", () => {
      selectFavorite(fav.id);
    });

    const deleteBtnInline = document.createElement("button");
    deleteBtnInline.type = "button";
    deleteBtnInline.className = "hc2__favoriteDelete";
    deleteBtnInline.setAttribute("aria-label", `${t("favoritesDelete")}: ${fav.name}`);
    deleteBtnInline.textContent = "×";
    deleteBtnInline.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteFavorite(fav.id);
    });

    row.appendChild(pickBtn);
    row.appendChild(deleteBtnInline);
    host.appendChild(row);
  });

  if (deleteBtn) {
    deleteBtn.disabled = !state.selectedFavId;
  }
}

function saveCurrentStop() {
  if (state.isSaving) return;
  state.currentStop = getStopFromCallback();
  const stop = state.currentStop;
  if (!stop || !stop.id || !stop.name) {
    setStatus(pickLocalized(FAVORITE_MESSAGES.missing));
    updateSaveButton();
    return;
  }

  syncFavoritesFromStorage();
  if ((state.favorites || []).some((fav) => fav.id === stop.id)) {
    setStatus(pickLocalized(FAVORITE_MESSAGES.exists));
    updateSaveButton();
    return;
  }

  state.isSaving = true;
  updateSaveButton();
  state.favorites = [
    { id: stop.id, name: stop.name, addedAt: Date.now() },
    ...(state.favorites || []),
  ];
  persistFavorites();
  state.selectedFavId = stop.id;
  state.isSaving = false;
  renderFavoritesSheet();
  updateSaveButton();
  setStatus(pickLocalized(FAVORITE_MESSAGES.saved));
}

function renderLanguageSelect() {
  const select = state.refs.languageSelect;
  if (!select) return;

  select.innerHTML = "";
  LANGUAGE_OPTIONS.forEach((opt) => {
    const node = document.createElement("option");
    node.value = opt.code;
    node.textContent = opt.label;
    select.appendChild(node);
  });
  select.value = appState.language || "fr";
}

function bindEvents() {
  const r = state.refs;

  r.menuToggle?.addEventListener("click", () => {
    toggleControls();
  });

  r.infoBtn?.addEventListener("click", () => {
    if (typeof state.callbacks.onOpenInfo === "function") {
      state.callbacks.onOpenInfo();
    }
  });

  r.stationInput?.addEventListener("input", () => {
    setSearchText(r.stationInput.value || "");
    if (state.suggestionsDebounce) clearTimeout(state.suggestionsDebounce);
    const query = state.searchText.trim();
    state.suggestionsDebounce = setTimeout(() => fetchAndRenderSuggestions(query), 180);
  });

  r.stationInput?.addEventListener("focus", () => {
    syncClearButton();
    const query = r.stationInput.value.trim();
    if (query.length >= 2) fetchAndRenderSuggestions(query);
  });

  r.stationInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearSearch();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();

    const query = state.searchText.trim();
    if (!query) return;

    const first = state.suggestions[0];
    if (first && String(first.name || "").toLowerCase() === query.toLowerCase()) {
      selectStop({ id: first.id || null, name: first.name || "" });
      return;
    }

    selectStop({ id: null, name: query });
  });

  r.stationClear?.addEventListener("click", () => {
    clearSearch();
  });

  r.stationGeo?.addEventListener("click", () => {
    runGeoLocate();
  });

  r.favoritesToggle?.addEventListener("click", () => {
    if (!state.favoritesOpen) {
      openFavorites();
      return;
    }
    const focusables = focusableIn(state.refs.favoritesSheet);
    const target = focusables[0] || state.refs.favoritesSheet;
    if (target && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  });
  r.filtersOpen?.addEventListener("click", () => {
    if (state.filtersOpen) closeFilters();
    else openFilters();
  });

  r.favoritesClose?.addEventListener("click", () => closeFavorites());
  r.filtersClose?.addEventListener("click", () => closeFilters());
  r.backdrop?.addEventListener("click", () => closeAllSheets());

  r.favoritesSave?.addEventListener("click", saveCurrentStop);
  r.favoritesManage?.addEventListener("click", () => {
    setStatus(t("favoritesManageHint"));
  });
  r.favoritesDelete?.addEventListener("click", () => {
    deleteSelectedFavorite();
  });

  r.filtersReset?.addEventListener("click", () => {
    resetAllFilters();
  });

  r.filtersApply?.addEventListener("click", () => {
    closeFiltersAndApply();
  });

  r.filtersResetInline?.addEventListener("click", () => {
    appState.platformFilter = null;
    appState.lineFilter = null;
    appState.hideBusDeparture = false;
    syncDraftFiltersFromState();
    renderFilterSummary();
    updateHeaderControls2();
    callControlsChanged();
  });

  r.hideDeparture?.addEventListener("change", () => {
    state.draftFilters.hideDeparture = !!r.hideDeparture.checked;
  });

  r.languageSelect?.addEventListener("change", () => {
    const applied = setLanguage(r.languageSelect.value);
    appState.language = applied;
    applyStaticTranslations();
    updateHeaderControls2({ language: applied });
    if (typeof state.callbacks.onLanguageChange === "function") {
      state.callbacks.onLanguageChange(applied);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target) return;

    if (
      r.stationSuggestions &&
      !r.stationSuggestions.contains(target) &&
      r.stationInput &&
      target !== r.stationInput
    ) {
      clearSuggestions();
    }

    if (!state.favoritesOpen && !state.filtersOpen) return;

    if (
      ((state.favoritesOpen &&
        r.favoritesSheet &&
        !r.favoritesSheet.contains(target) &&
        r.favoritesToggle &&
        !r.favoritesToggle.contains(target)) ||
        (state.filtersOpen &&
          r.filtersSheet &&
          !r.filtersSheet.contains(target) &&
          r.filtersOpen &&
          !r.filtersOpen.contains(target))) &&
      (!r.backdrop || !r.backdrop.contains(target))
    ) {
      closeAllSheets();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      trapFocusInFavoritesSheet(event);
      return;
    }
    if (event.key !== "Escape") return;
    clearSuggestions();
    closeAllSheets();
  });
}

function resolveMountEl(mountEl) {
  if (mountEl && typeof mountEl === "object" && typeof mountEl.appendChild === "function") {
    return mountEl;
  }
  if (typeof mountEl === "string") {
    return document.querySelector(mountEl);
  }
  return null;
}

export function initHeaderControls2({
  mountEl,
  getCurrentStop,
  onSelectStop,
  onGeoLocate,
  onOpenInfo,
  onControlsChange,
  onLanguageChange,
} = {}) {
  const resolved = resolveMountEl(mountEl);
  if (!resolved) {
    throw new Error("initHeaderControls2 requires a valid mountEl");
  }

  state.mountEl = resolved;
  state.callbacks.getCurrentStop = typeof getCurrentStop === "function" ? getCurrentStop : state.callbacks.getCurrentStop;
  state.callbacks.onSelectStop = typeof onSelectStop === "function" ? onSelectStop : null;
  state.callbacks.onGeoLocate = typeof onGeoLocate === "function" ? onGeoLocate : null;
  state.callbacks.onOpenInfo = typeof onOpenInfo === "function" ? onOpenInfo : null;
  state.callbacks.onControlsChange = typeof onControlsChange === "function" ? onControlsChange : null;
  state.callbacks.onLanguageChange = typeof onLanguageChange === "function" ? onLanguageChange : null;

  state.currentStop = getStopFromCallback();
  mountMarkup();
  renderLanguageSelect();
  restoreCollapsedState();
  syncDraftFiltersFromState();
  bindEvents();

  state.initialized = true;

  appState._renderViewControls = () => {
    renderViewSegment();
    renderFilterSummary();
  };
  appState._ensureViewSelectOptions = () => {
    renderViewSegment();
  };

  updateHeaderControls2({
    currentStop: state.currentStop,
    language: appState.language,
  });

  applyStaticTranslations();
}

export function updateHeaderControls2({ currentStop, language } = {}) {
  if (!state.initialized) return;

  if (currentStop && typeof currentStop === "object") {
    state.currentStop = {
      id: typeof currentStop.id === "string" ? currentStop.id.trim() : null,
      name: typeof currentStop.name === "string" ? currentStop.name.trim() : "",
    };
  } else {
    state.currentStop = getStopFromCallback();
  }

  if (language && state.refs.languageSelect) {
    state.refs.languageSelect.value = String(language);
  }

  const stationTitle = state.mountEl.querySelector("#station-title");
  if (stationTitle) stationTitle.textContent = state.currentStop.name || "Station";

  if (state.refs.stationInput && document.activeElement !== state.refs.stationInput) {
    state.refs.stationInput.value = state.currentStop.name || "";
  }
  syncClearButton();

  renderLanguageSelect();
  renderViewSegment();
  renderFilterSummary();
  renderFiltersSheet();
  renderFavoritesSheet();
  updateSaveButton();

  const filtersAvailable =
    (Array.isArray(appState.platformOptions) && appState.platformOptions.length > 0) ||
    (Array.isArray(appState.lineOptions) && appState.lineOptions.length > 0) ||
    !appState.lastBoardIsTrain;

  if (state.refs.filtersOpen) {
    state.refs.filtersOpen.disabled = !filtersAvailable;
    state.refs.filtersOpen.classList.toggle("is-disabled", !filtersAvailable);
  }
}
