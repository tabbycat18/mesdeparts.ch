import {
  appState,
  VIEW_MODE_LINE,
  VIEW_MODE_TIME,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
} from "../v20260222.state.js";
import { fetchStationSuggestions, fetchStationsNearby, isAbortError } from "../v20260222.logic.js";
import { loadFavorites, saveFavorites } from "../v20260222.favourites.js";
import { getHasSeenThreeDotsTip, setHasSeenThreeDotsTip } from "../v20260222.threeDotsTip.js";
import { t, setLanguage, LANGUAGE_OPTIONS, applyStaticTranslations } from "../v20260222.i18n.js";

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

const SAVE_META_LABELS = {
  fr: {
    idle: "Choisissez un arrêt puis appuyez ici",
    readyPrefix: "Prêt à sauvegarder",
    savedPrefix: "Déjà dans vos favoris",
    saving: "Sauvegarde en cours…",
  },
  de: {
    idle: "Haltestelle wählen und hier tippen",
    readyPrefix: "Bereit zum Speichern",
    savedPrefix: "Bereits in Favoriten",
    saving: "Speichere…",
  },
  it: {
    idle: "Seleziona una fermata e tocca qui",
    readyPrefix: "Pronta da salvare",
    savedPrefix: "Già nei preferiti",
    saving: "Salvataggio…",
  },
  en: {
    idle: "Pick a stop, then tap here",
    readyPrefix: "Ready to save",
    savedPrefix: "Already in favorites",
    saving: "Saving…",
  },
};

const TRAIN_SEGMENT_VARIANTS = {
  all: {
    fr: { full: "Tous", mid: "Tous", short: "Tous", tiny: "Tous" },
    de: { full: "Alle", mid: "Alle", short: "Alle", tiny: "Alle" },
    it: { full: "Tutti", mid: "Tutti", short: "Tutti", tiny: "Tutti" },
    en: { full: "All", mid: "All", short: "All", tiny: "All" },
  },
  regional: {
    fr: { full: "Régio", mid: "Régio", short: "Régio", tiny: "Régio" },
    de: { full: "Regio", mid: "Regio", short: "Regio", tiny: "Regio" },
    it: { full: "Regio", mid: "Regio", short: "Regio", tiny: "Regio" },
    en: { full: "Regio", mid: "Regio", short: "Regio", tiny: "Regio" },
  },
  longDistance: {
    fr: { full: "Gde Ln", mid: "Gde Ln", short: "Gde Ln", tiny: "Gde Ln" },
    de: { full: "Fernv", mid: "Fernv", short: "Fernv", tiny: "Fernv" },
    it: { full: "Lunga", mid: "Lunga", short: "Lunga", tiny: "Lunga" },
    en: { full: "Long", mid: "Long", short: "Long", tiny: "Long" },
  },
};

const state = {
  initialized: false,
  mountEl: null,
  // Integration contract:
  // - getCurrentStop(): provided by v20260222.main.js -> returns { id, name } from appState.
  // - onSelectStop(arg1, arg2): provided by v20260222.main.js -> supports `(id, name)` and legacy payloads.
  // - favorites storage: loadFavorites()/saveFavorites() from v20260222.favourites.js.
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
  favoritesManageMode: false,
  pendingFavoriteDeleteId: null,
  searchText: "",
  favorites: [], // [{ id, name, addedAt }]
  selectedFavId: null,
  isSaving: false,
  refs: {},
  filtersOpen: false,
  suggestions: [],
  suggestionsDebounce: null,
  currentStop: { id: null, name: "" },
  // Single source of truth for filters in this subsystem.
  filterState: {
    selectedPlatforms: "ALL", // "ALL" | Set<string>
    selectedLines: "ALL", // "ALL" | Set<string>
    hideDepartureBus: false,
  },
  statusTimer: null,
  controlsAnimationTimer: null,
  segmentResizeRaf: null,
  windowResizeHandler: null,
  favoritesOpener: null,
  inertRoot: null,
  // Search resiliency: AbortController for in-flight suggestion fetch
  suggestionsAbortController: null,
  // Search cache: { [normalizedQuery]: { items, ts } }
  suggestionCache: {},
  // Debounce token for deduplication (ensures only latest debounce runs)
  _searchDebounceToken: 0,
  // Board loading state tracking
  isSuggestionFetching: false,
  isBoardLoading: false,
  boardNoticeText: "",
  boardNoticeTimer: null,
  threeDotsTipEl: null,
  threeDotsTipVisible: false,
  threeDotsTipShownInSession: false,
  threeDotsTipOutsideHandler: null,
  threeDotsTipKeydownHandler: null,
  threeDotsTipRepositionRaf: null,
};

// Search resiliency constants
const SUGGESTION_CACHE_TTL = 90_000; // 90 seconds
const SEARCH_TIMEOUT_MS = 6_000; // 6s client-side timeout

// Dev-only guard (same pattern as existing window.DEBUG_UI)
const dbg = (...a) => {
  if (typeof window !== "undefined" && window.DEBUG_UI) {
    console.log("[HC2][search]", ...a);
  }
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
              <circle cx="4" cy="12" r="1.8" fill="currentColor"></circle>
              <circle cx="12" cy="12" r="1.8" fill="currentColor"></circle>
              <circle cx="20" cy="12" r="1.8" fill="currentColor"></circle>
            </svg>
          </button>
        </div>
      </div>

      <div id="header-controls2-panel" class="hc2__controls is-collapsed" aria-label="Header Controls 2" aria-hidden="true">
        <div class="hc2__topControls">
          <div class="hc2__topRow hc2__topRow--search">
            <label for="station-input" class="sr-only">${t("searchStop")}</label>
            <div class="hc2__search hc2__topSurface">
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
                  class="hc2__actionBtn hc2__pillControl is-hidden"
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
                  class="hc2__actionBtn hc2__pillControl"
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
                  class="hc2__actionBtn hc2__pillControl"
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
          </div>

          <div class="hc2__topRow hc2__topRow--secondary">
            <div class="hc2__topCluster hc2__topCluster--display">
              <div id="view-section-label" class="hc2__rowLabel hc2__topDisplayLabel">${t("viewSectionLabel")}</div>
              <div id="view-segment" class="hc2__segment"></div>
            </div>

            <div class="hc2__topCluster hc2__topCluster--actions hc2__rowDual">
              <a
                id="dual-board-link"
                class="hc2__pill hc2__topControl hc2__topControl--normal"
                href="dual-board.html"
                target="_blank"
                rel="noopener"
                aria-label="${t("dualBoardOpen")}"
              >
                <span class="hc2__dualIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <rect
                      x="3.5"
                      y="5"
                      width="7.5"
                      height="14"
                      rx="2.4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                    ></rect>
                    <rect
                      x="13"
                      y="5"
                      width="7.5"
                      height="14"
                      rx="2.4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                    ></rect>
                    <path
                      d="M11.2 9.2h1.6M11.2 14.8h1.6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                    ></path>
                    <circle cx="7.25" cy="8.8" r="0.9" fill="currentColor"></circle>
                    <circle cx="16.75" cy="8.8" r="0.9" fill="currentColor"></circle>
                  </svg>
                </span>
                <span id="dual-board-label">${t("dualBoardLabel")}</span>
              </a>
              <button
                id="filters-open"
                class="hc2__pill hc2__topControl hc2__topControl--normal"
                data-action="filters"
                type="button"
                aria-expanded="false"
                aria-controls="filters-popover"
              >
                <span class="hc2__pillIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M4 6h16l-6.4 7.1v4.9l-3.2 1.8v-6.7z"
                    />
                  </svg>
                </span>
                <span id="filters-open-label">${t("filterButton")}</span>
              </button>
            </div>

            <div class="hc2__topCluster hc2__topCluster--language">
              <span id="language-select-title" class="hc2__rowLabel hc2__topLanguageLabel">${t("languageLabel")}</span>
              <label for="language-select" class="sr-only">${t("languageLabel")}</label>
              <select
                id="language-select"
                class="hc2__select hc2__topControl hc2__topControl--normal"
                aria-label="${t("languageLabel")}"
              ></select>
            </div>
          </div>
        </div>
      </div>

      <div id="loading-hint" class="loading-hint" role="status" aria-live="polite"></div>

      <div id="hc2-served-lines" class="hc2__served" hidden>
        <div class="hc2__servedLeft">
          <span id="hc2-served-lines-label" class="hc2__servedLabel">${t("servedByLines")}</span>
          <div id="hc2-served-lines-container" class="hc2__servedChips"></div>
        </div>
      </div>
    </header>
  `;
}

function createGlobalSheetsTemplate() {
  return `
    <div id="favorites-backdrop" class="hc2__backdrop ui-modal-overlay" hidden></div>

    <section
      id="favorites-popover"
      class="hc2__sheet ui-modal-shell hc2__sheet--favorites"
      role="dialog"
      aria-modal="true"
      aria-labelledby="favorites-popover-title"
      tabindex="-1"
      hidden
    >
      <header class="hc2__sheetHeader ui-modal-header">
        <div class="ui-modal-headerMain">
          <h2 id="favorites-popover-title" class="hc2__sheetTitle ui-modal-title">${t("filterFavoritesTitle")}</h2>
          <button
            class="hc2__sheetClose ui-modal-close"
            data-action="closeFavs"
            data-fav-sheet-close="true"
            type="button"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>

      <div class="hc2__sheetBody ui-modal-body hc2__sheetBody--favorites">
        <div id="favorites-status" class="hc2__status is-hidden" role="status" aria-live="polite"></div>

        <div class="hc2__saveCard">
          <button id="favorites-save-current" class="hc2__saveCta" data-action="saveStop" type="button">
            <span class="hc2__saveCtaIcon" aria-hidden="true">★</span>
            <span class="hc2__saveCtaText">
              <span id="favorites-save-current-label" class="hc2__saveCtaTitle">
                ${pickLocalized(SAVE_LABELS).ready}
              </span>
              <span id="favorites-save-current-meta" class="hc2__saveCtaMeta">
                ${pickLocalized(SAVE_META_LABELS).idle}
              </span>
            </span>
          </button>
        </div>

        <div id="favorites-chip-list" class="hc2__favList"></div>
        <div id="favorites-empty" class="hc2__empty is-hidden">${t("filterNoFavorites")}</div>
      </div>

      <footer class="hc2__sheetFooter ui-modal-footer">
        <button id="favorites-manage" class="hc2__secondary" data-action="manage" type="button">
          ${t("filterManageFavorites")}
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
          <label class="hc2__switch hc2__switch--clickable" for="filters-hide-departure">
            <span class="hc2__switchLabel">${t("filterHideDepartureShort")}</span>
            <input type="checkbox" id="filters-hide-departure" class="hc2__switchInput" />
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
    infoBadge: dq("info-badge"),

    stationInput: q("station-input"),
    stationClear: q("station-input-clear"),
    stationGeo: q("station-search-btn"),
    // Portal: suggestions is on document.body, not inside mountEl
    stationSuggestions: dq("station-suggestions"),

    favoritesToggle: q("favorites-only-toggle"),
    favoritesSheet: dq("favorites-popover"),
    favoritesClose: d.querySelector("[data-fav-sheet-close='true']"),
    favoritesStatus: dq("favorites-status"),
    favoritesSave: dq("favorites-save-current"),
    favoritesSaveLabel: dq("favorites-save-current-label"),
    favoritesSaveMeta: dq("favorites-save-current-meta"),
    favoritesManage: dq("favorites-manage"),
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
    displayLeft: q("view-segment"),
    servedLinesWrap: q("hc2-served-lines"),
    servedLinesLabel: q("hc2-served-lines-label"),
    servedLinesContainer: q("hc2-served-lines-container"),
    backdrop: dq("favorites-backdrop"),
    languageTitle: q("language-select-title"),
    languageSelect: q("language-select"),
  };
}

function mountMarkup() {
  state.mountEl.innerHTML = createTemplate();
  ensureGlobalSheetsMounted();

  // Portal: attach suggestions list directly to body so it escapes the
  // overflow:hidden + transform stacking context on .hc2__controls.
  let portal = document.getElementById("station-suggestions");
  if (!portal) {
    portal = document.createElement("ul");
    portal.id = "station-suggestions";
    portal.className = "hc2__suggestions";
    document.body.appendChild(portal);
  }

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

function isElementVisible(el) {
  if (!el || el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function scheduleThreeDotsTipReposition() {
  if (!state.threeDotsTipVisible || !state.threeDotsTipEl || !state.refs.menuToggle) return;
  if (state.threeDotsTipRepositionRaf) {
    cancelAnimationFrame(state.threeDotsTipRepositionRaf);
    state.threeDotsTipRepositionRaf = null;
  }
  state.threeDotsTipRepositionRaf = requestAnimationFrame(() => {
    state.threeDotsTipRepositionRaf = null;
    positionThreeDotsTip();
  });
}

function positionThreeDotsTip() {
  const tip = state.threeDotsTipEl;
  const anchor = state.refs.menuToggle;
  if (!tip || !anchor) return;
  if (!isElementVisible(anchor)) return;

  const anchorRect = anchor.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const gap = 10;
  const edgeGap = 12;

  tip.classList.remove("hc2__menuTip--top", "hc2__menuTip--bottom", "hc2__menuTip--toast");
  tip.style.left = "0px";
  tip.style.top = "0px";

  const tipRect = tip.getBoundingClientRect();
  const tipHeight = Math.ceil(tipRect.height || 0);
  const tipWidth = Math.ceil(tipRect.width || 0);

  const spaceAbove = anchorRect.top - gap;
  const spaceBelow = vh - anchorRect.bottom - gap;

  const canPlaceAbove = spaceAbove >= tipHeight;
  const canPlaceBelow = spaceBelow >= tipHeight;
  const useToast = !canPlaceAbove && !canPlaceBelow;

  if (useToast) {
    tip.classList.add("hc2__menuTip--toast");
    const toastLeft = Math.max(edgeGap, Math.round((vw - tipWidth) / 2));
    const toastTop = Math.max(edgeGap, vh - tipHeight - edgeGap);
    tip.style.left = `${toastLeft}px`;
    tip.style.top = `${toastTop}px`;
    return;
  }

  const placeBelow = canPlaceBelow || spaceBelow >= spaceAbove;
  tip.classList.add(placeBelow ? "hc2__menuTip--bottom" : "hc2__menuTip--top");

  const top = placeBelow
    ? Math.round(anchorRect.bottom + gap)
    : Math.round(anchorRect.top - tipHeight - gap);
  let left = Math.round(anchorRect.right - tipWidth);
  left = Math.max(edgeGap, Math.min(left, vw - tipWidth - edgeGap));
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const arrowX = Math.round(anchorCenterX - left);
  const clampedArrowX = Math.max(16, Math.min(arrowX, Math.max(16, tipWidth - 16)));
  tip.style.setProperty("--hc2-tip-arrow-x", `${clampedArrowX}px`);

  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(edgeGap, top)}px`;
}

function dismissThreeDotsTip({ markSeen = true } = {}) {
  if (markSeen) {
    setHasSeenThreeDotsTip(true);
  }

  if (state.threeDotsTipRepositionRaf) {
    cancelAnimationFrame(state.threeDotsTipRepositionRaf);
    state.threeDotsTipRepositionRaf = null;
  }

  if (state.threeDotsTipOutsideHandler) {
    document.removeEventListener("mousedown", state.threeDotsTipOutsideHandler, true);
    state.threeDotsTipOutsideHandler = null;
  }
  if (state.threeDotsTipKeydownHandler) {
    document.removeEventListener("keydown", state.threeDotsTipKeydownHandler, true);
    state.threeDotsTipKeydownHandler = null;
  }

  const tip = state.threeDotsTipEl;
  if (tip && tip.parentNode) {
    tip.parentNode.removeChild(tip);
  }
  state.threeDotsTipEl = null;
  state.threeDotsTipVisible = false;
  state.threeDotsTipShownInSession = markSeen || getHasSeenThreeDotsTip();

  const anchor = state.refs.menuToggle;
  if (anchor) {
    anchor.removeAttribute("aria-describedby");
  }
}

function showThreeDotsTip() {
  if (state.threeDotsTipVisible) return true;
  const anchor = state.refs.menuToggle;
  if (!isElementVisible(anchor)) return false;

  const tip = document.createElement("div");
  tip.id = "hc2-three-dots-tip";
  tip.className = "hc2__menuTip";
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-live", "polite");
  tip.innerHTML = `
    <p class="hc2__menuTipText">${t("threeDotsTipBody")}</p>
    <button
      type="button"
      class="hc2__menuTipClose"
      aria-label="${t("threeDotsTipClose")}"
      title="${t("threeDotsTipClose")}"
    >
      ×
    </button>
  `;

  document.body.appendChild(tip);
  state.threeDotsTipEl = tip;
  state.threeDotsTipVisible = true;
  anchor?.setAttribute("aria-describedby", tip.id);

  const closeBtn = tip.querySelector(".hc2__menuTipClose");
  closeBtn?.addEventListener("click", () => {
    dismissThreeDotsTip({ markSeen: true });
  });

  state.threeDotsTipOutsideHandler = (event) => {
    const target = event.target;
    if (!target) return;
    if (tip.contains(target)) return;
    if (anchor && anchor.contains(target)) return;
    dismissThreeDotsTip({ markSeen: true });
  };
  document.addEventListener("mousedown", state.threeDotsTipOutsideHandler, true);

  state.threeDotsTipKeydownHandler = (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      dismissThreeDotsTip({ markSeen: true });
    }
  };
  document.addEventListener("keydown", state.threeDotsTipKeydownHandler, true);

  scheduleThreeDotsTipReposition();
  requestAnimationFrame(() => {
    scheduleThreeDotsTipReposition();
  });
  return true;
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
    cancelAnimationFrame(state.controlsAnimationTimer);
    state.controlsAnimationTimer = null;
  }

  if (state.controlsOpen) {
    const target = Math.max(panel.scrollHeight || 0, 1);
    panel.setAttribute("aria-hidden", "false");
    panel.classList.remove("is-collapsed");
    panel.classList.add("is-open");
    panel.style.height = "0px";
    // Flush start frame before animating to measured end height.
    panel.getBoundingClientRect();
    state.controlsAnimationTimer = requestAnimationFrame(() => {
      panel.style.height = `${target}px`;
      state.controlsAnimationTimer = null;
    });
  } else {
    const current = Math.max(panel.getBoundingClientRect().height || panel.scrollHeight || 0, 1);
    panel.style.height = `${current}px`;
    panel.classList.remove("is-open");
    panel.classList.add("is-collapsed");
    panel.setAttribute("aria-hidden", "true");
    // Flush current frame before collapsing to 0.
    panel.getBoundingClientRect();
    state.controlsAnimationTimer = requestAnimationFrame(() => {
      panel.style.height = "0px";
      state.controlsAnimationTimer = null;
    });
  }

  btn.setAttribute("aria-expanded", state.controlsOpen ? "true" : "false");
  const txt = t(state.controlsOpen ? "quickControlsHide" : "quickControlsShow");
  btn.setAttribute("aria-label", txt);
  if (label) label.textContent = txt;
}

function syncOpenControlsHeight() {
  const panel = state.refs.panel;
  if (!panel || !state.controlsOpen) return;
  panel.style.height = `${Math.max(panel.scrollHeight || 0, 1)}px`;
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
  state.favoritesManageMode = false;
  state.pendingFavoriteDeleteId = null;
  updateFavoritesManageButton();
  renderFavoritesSheet();

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
  state.favoritesManageMode = false;
  state.pendingFavoriteDeleteId = null;
  updateFavoritesManageButton();
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
  syncFilterStateFromAppState();
  renderFiltersSheet();
  if (filtersSheet) {
    filtersSheet.hidden = false;
  }
  filtersOpen?.setAttribute("aria-expanded", "true");
  if (backdrop) backdrop.hidden = false;
  state.filtersOpen = true;
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
  // Abort any in-flight suggestion fetch (no longer needed)
  if (state.suggestionsAbortController) {
    state.suggestionsAbortController.abort();
    state.suggestionsAbortController = null;
  }
  state.isSuggestionFetching = false;
  syncHint();
  setSearchText("");
  clearSuggestions();
  if (state.refs.stationInput && typeof state.refs.stationInput.focus === "function") {
    state.refs.stationInput.focus();
  }
}

// Reposition the portal dropdown under the search input using fixed coordinates.
// Called on show and on window resize so it tracks the input even if the tray
// height or page layout changes.
function repositionSuggestionsPortal() {
  const input = state.refs.stationInput;
  const list = state.refs.stationSuggestions;
  if (!input || !list) return;

  const rect = input.getBoundingClientRect();
  list.style.left = `${rect.left}px`;
  list.style.top = `${rect.bottom + 6}px`;
  list.style.width = `${rect.width}px`;
}

function setSuggestionsVisible(visible) {
  const list = state.refs.stationSuggestions;
  if (!list) return;
  if (visible) repositionSuggestionsPortal();
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

function syncHint() {
  if (!state.mountEl) return;
  const hint = state.mountEl.querySelector("#loading-hint");
  if (!hint) return;
  if (state.isSuggestionFetching) {
    hint.textContent = t("searchLoading");
    hint.classList.add("is-visible");
  } else if (state.isBoardLoading) {
    hint.textContent = t("loadingDepartures");
    hint.classList.add("is-visible");
  } else if (state.boardNoticeText) {
    hint.textContent = state.boardNoticeText;
    hint.classList.add("is-visible");
  } else {
    hint.textContent = "";
    hint.classList.remove("is-visible");
  }
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
  if (state.pendingFavoriteDeleteId === favId) {
    state.pendingFavoriteDeleteId = null;
  }
  persistFavorites();
  renderFavoritesSheet();
  updateSaveButton();
}

function updateFavoritesManageButton() {
  const btn = state.refs.favoritesManage;
  if (!btn) return;
  const managing = !!state.favoritesManageMode;
  btn.textContent = managing ? t("favoritesManageDone") : t("filterManageFavorites");
  btn.setAttribute("aria-pressed", managing ? "true" : "false");
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

function getCachedSuggestions(query) {
  const key = String(query || "").toLowerCase().trim();
  const entry = state.suggestionCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > SUGGESTION_CACHE_TTL) {
    delete state.suggestionCache[key];
    return null;
  }
  return entry.items;
}

function setCachedSuggestions(query, items) {
  const key = String(query || "").toLowerCase().trim();
  if (!key) return;
  if (!Array.isArray(items) || items.length === 0) {
    delete state.suggestionCache[key];
    return;
  }
  state.suggestionCache[key] = { items, ts: Date.now() };
}

function renderSuggestionLoading() {
  const list = state.refs.stationSuggestions;
  if (!list) return;
  list.innerHTML = "";
  const item = document.createElement("li");
  item.className = "hc2__suggestion hc2__suggestionStatus";
  item.textContent = t("searchLoading");
  list.appendChild(item);
  state.suggestions = [];
  setSuggestionsVisible(true);
}

function renderSuggestionError(type, retryFn) {
  const list = state.refs.stationSuggestions;
  if (!list) return;
  list.innerHTML = "";
  const li = document.createElement("li");
  li.className = "hc2__suggestion hc2__suggestion--error";
  li.setAttribute("role", "status");

  const titleEl = document.createElement("div");
  titleEl.className = "hc2__suggestionErrorTitle";
  if (type === "server") {
    titleEl.textContent = t("searchUnavailable");
  } else if (type === "timeout") {
    titleEl.textContent = t("searchOffline");
  } else {
    titleEl.textContent = t("searchUnavailable");
  }
  li.appendChild(titleEl);

  const subEl = document.createElement("div");
  subEl.className = "hc2__suggestionErrorSub";
  subEl.textContent = t("searchUnavailableSub");
  li.appendChild(subEl);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "hc2__suggestionRetry";
  retryBtn.textContent = t("searchRetry");
  retryBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof retryFn === "function") retryFn();
  });
  li.appendChild(retryBtn);

  list.appendChild(li);
  state.suggestions = [];
  setSuggestionsVisible(true);
}

function renderSuggestionsWithHint(items, hint) {
  renderSuggestions(items);
  const list = state.refs.stationSuggestions;
  if (!list || !hint) return;
  const hintLi = document.createElement("li");
  hintLi.className = "hc2__suggestion hc2__suggestionHint";
  hintLi.textContent = hint;
  hintLi.setAttribute("aria-hidden", "true");
  list.prepend(hintLi);
}

async function fetchAndRenderSuggestions(query) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) {
    state.isSuggestionFetching = false;
    syncHint();
    clearSuggestions();
    return;
  }

  // Abort previous in-flight request
  if (state.suggestionsAbortController) {
    state.suggestionsAbortController.abort();
    dbg("aborted previous fetch");
  }
  const controller = new AbortController();
  state.suggestionsAbortController = controller;
  const { signal } = controller;

  // Serve from cache immediately if hit
  const cached = getCachedSuggestions(trimmed);
  if (cached) {
    dbg("cache hit:", trimmed);
    state.isSuggestionFetching = false;
    syncHint();
    renderSuggestions(cached);
    return;
  }

  // Show loading state
  state.isSuggestionFetching = true;
  syncHint();
  renderSuggestionLoading();

  try {
    // Fetch with 6s timeout (passed via fetchStationSuggestions)
    const items = await fetchStationSuggestions(trimmed, { signal });

    // Stale check: verify input still matches
    const current = String(state.refs.stationInput?.value || "").trim();
    if (current !== trimmed) return;

    // Store in cache
    setCachedSuggestions(trimmed, items || []);

    if (!items || !items.length) {
      renderSuggestionStatus(t("searchEmpty"));
    } else {
      renderSuggestions(items);
    }
  } catch (err) {
    // User aborted (new query typed) → silently ignore
    if (signal.aborted) {
      dbg("fetch silently ignored (aborted)");
      return;
    }

    // Client-side timeout
    if (err instanceof DOMException && err.name === "AbortError" && err.message === "Timeout") {
      dbg("timeout hit");
      const fallback = getCachedSuggestions(trimmed);
      if (fallback) {
        renderSuggestionsWithHint(fallback, t("searchHintOffline"));
      } else {
        renderSuggestionError("timeout", () => fetchAndRenderSuggestions(trimmed));
      }
      return;
    }

    // Server error (502/503/504)
    if (err && typeof err.status === "number" && err.status >= 500) {
      dbg("5xx received:", err.status);
      const fallback = getCachedSuggestions(trimmed);
      if (fallback) {
        renderSuggestionsWithHint(fallback, t("searchHintOffline"));
      } else {
        renderSuggestionError("server", () => fetchAndRenderSuggestions(trimmed));
      }
      return;
    }

    // Other errors: clear dropdown
    clearSuggestions();
  } finally {
    // Only the controller that started this fetch clears the flag (latest-wins)
    if (state.suggestionsAbortController === controller) {
      state.isSuggestionFetching = false;
      syncHint();
    }
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

function trainSegmentDensity() {
  const leftWidth = state.refs.displayLeft?.clientWidth || state.refs.viewSegment?.clientWidth || 0;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth || 9999 : 9999;

  if (viewportWidth >= 900) return "full";
  if (viewportWidth <= 360 || leftWidth <= 180) return "tiny";
  if (viewportWidth <= 420 || leftWidth <= 240) return "short";
  if (leftWidth <= 300) return "mid";
  return "full";
}

function trainVariant(variantKey, density) {
  const lang = langCode();
  const byVariant = TRAIN_SEGMENT_VARIANTS[variantKey] || TRAIN_SEGMENT_VARIANTS.all;
  const localized = byVariant[lang] || byVariant.en || byVariant.fr;
  return localized[density] || localized.full;
}

function plainRegionalLabel() {
  return String(t("trainFilterRegional") || "")
    .replace(/\s*\(S\/R\)\s*/gi, "")
    .trim();
}

function renderViewSegment() {
  const mount = state.refs.viewSegment;
  if (!mount) return;

  const trainMode = !!appState.lastBoardIsTrain;
  const density = trainMode ? trainSegmentDensity() : "full";
  mount.dataset.density = density;
  mount.classList.toggle("hc2__segment--train", trainMode);

  const regionalAria = t("trainFilterRegional");
  const regionalTitle = plainRegionalLabel() || regionalAria;
  const options = trainMode
    ? [
        {
          key: TRAIN_FILTER_ALL,
          label: trainVariant("all", density),
          fullLabel: trainVariant("all", "full"),
          ariaLabel: trainVariant("all", "full"),
        },
        {
          key: TRAIN_FILTER_REGIONAL,
          label: trainVariant("regional", density),
          fullLabel: trainVariant("regional", "full"),
          ariaLabel: regionalAria,
          title: regionalTitle,
        },
        {
          key: TRAIN_FILTER_LONG_DISTANCE,
          label: trainVariant("longDistance", density),
          fullLabel: trainVariant("longDistance", "full"),
          ariaLabel: trainVariant("longDistance", "full"),
        },
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
    if (trainMode) {
      btn.setAttribute("aria-label", opt.ariaLabel || opt.fullLabel || opt.label);
      btn.title = opt.title || opt.fullLabel || opt.ariaLabel || opt.label;
    } else {
      btn.removeAttribute("aria-label");
      btn.removeAttribute("title");
    }
    const label = document.createElement("span");
    label.className = "hc2__segmentBtnLabel";
    label.textContent = opt.label;
    btn.appendChild(label);

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
  const platformFilters =
    state.filterState.selectedPlatforms === "ALL"
      ? []
      : Array.from(state.filterState.selectedPlatforms);
  const lineFilters =
    state.filterState.selectedLines === "ALL"
      ? []
      : Array.from(state.filterState.selectedLines);
  const hideDeparture = !appState.lastBoardIsTrain && !!state.filterState.hideDepartureBus;

  const parts = [];
  if (platformFilters.length) parts.push(`${t("filterPlatformsShort")} ${platformFilters.join(", ")}`);
  if (lineFilters.length) parts.push(`${t("filterLinesShort")} ${lineFilters.join(", ")}`);
  if (hideDeparture) parts.push(t("filterHideDepartureShort"));

  return parts;
}

function renderFilterSummary() {
  const label = state.refs.filtersLabel;
  const resetInline = state.refs.filtersResetInline;
  const filtersBtn = state.refs.filtersOpen;
  if (!label) return;

  const parts = filterSummaryParts();
  if (!parts.length) {
    label.textContent = t("filterButton");
    if (filtersBtn) filtersBtn.title = t("filterButton");
    resetInline?.classList.add("is-hidden");
    return;
  }

  label.textContent = `${t("filterButton")} (${parts.length})`;
  if (filtersBtn) filtersBtn.title = parts.join(" • ");
  resetInline?.classList.remove("is-hidden");
}

function sortedLineOptions() {
  return (appState.lineOptions || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .sort((a, b) => {
      const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
      const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
      if (na !== nb) return na - nb;
      return String(a).localeCompare(String(b), "fr-CH");
    });
}

function servedLineBadgeClass(lineId) {
  const raw = String(lineId || "").trim();
  if (!raw) return "line-badge line-generic";

  const id = raw.toUpperCase();
  const idForClass = id.replace(/\+/g, "PLUS");
  const networkMap = appState.lineNetworks || {};
  const network =
    networkMap[raw] ||
    networkMap[id] ||
    networkMap[raw.toLowerCase()] ||
    appState.lastBoardNetwork ||
    appState.currentNetwork ||
    "";
  const net = String(network || "").toLowerCase();

  if (net === "postauto") {
    return "line-badge line-postbus";
  }

  const classes = ["line-badge"];
  if (id.startsWith("N")) classes.push("line-night");
  if (net) classes.push(`line-${net}-${idForClass}`);
  else classes.push(`line-generic-${idForClass}`);
  return classes.join(" ");
}

function selectionFromAppState(value, allowed) {
  const normalized = normalizeToAllowed(value, allowed);
  if (!normalized.length) return "ALL";
  return new Set(normalized);
}

function selectionToAppFilter(selection) {
  if (selection === "ALL") return null;
  const values = Array.from(selection || []).filter(Boolean);
  return values.length ? values : null;
}

function normalizeSelection(selection, allowed) {
  if (selection === "ALL") return "ALL";
  const next = new Set(Array.from(selection || []).filter((v) => allowed.includes(v)));
  return next.size ? next : "ALL";
}

function toggleSelection(type, value) {
  const current = state.filterState[type];
  const next = current === "ALL" ? new Set() : new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  state.filterState[type] = next.size ? next : "ALL";
}

function syncFilterStateFromAppState() {
  const platformAllowed = (appState.platformOptions || []).map(String);
  const lineAllowed = (appState.lineOptions || []).map(String);

  state.filterState.selectedPlatforms = selectionFromAppState(appState.platformFilter, platformAllowed);
  state.filterState.selectedLines = selectionFromAppState(appState.lineFilter, lineAllowed);
  state.filterState.hideDepartureBus = !!appState.hideBusDeparture;
}

function applyFilterState({ notify = true } = {}) {
  appState.platformFilter = selectionToAppFilter(state.filterState.selectedPlatforms);
  appState.lineFilter = selectionToAppFilter(state.filterState.selectedLines);
  appState.hideBusDeparture = !!state.filterState.hideDepartureBus;
  renderFilterSummary();
  renderServedLinesChips();
  if (notify) callControlsChanged();
}

function setServedLineSelection(lineId) {
  const clean = String(lineId || "").trim();
  const allowed = sortedLineOptions();
  if (!clean || !allowed.includes(clean)) return;

  // Toggle selection: add if not present, remove if present
  toggleSelection("selectedLines", clean);
  applyFilterState();
  renderFiltersSheet();
}

function renderServedLinesChips() {
  const wrap = state.refs.servedLinesWrap;
  const label = state.refs.servedLinesLabel;
  const container = state.refs.servedLinesContainer;
  if (!wrap || !label || !container) return;

  const lines = sortedLineOptions();
  const selection = state.filterState.selectedLines;
  const active = selection === "ALL" ? new Set() : new Set(selection);

  label.textContent = t("servedByLines");
  const isDualBoard = document.documentElement.classList.contains("dual-embed") || document.body.classList.contains("dual-embed");
  const shouldHide = lines.length === 0 || !!appState.lastBoardIsTrain || isDualBoard;
  wrap.hidden = shouldHide;

  // Hide for train stations and dual board: use inline style to ensure it overrides any CSS
  if (shouldHide) {
    wrap.style.display = "none";
  } else {
    wrap.style.display = "";
  }

  container.innerHTML = "";
  if (wrap.hidden) return;

  const makeChip = ({ text, activeState, onClick, title, className = "" }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `hc2__servedChip ${className}`.trim();
    btn.classList.toggle("is-active", !!activeState);
    btn.setAttribute("aria-pressed", activeState ? "true" : "false");
    if (title) btn.title = title;
    btn.textContent = text;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
    });
    return btn;
  };

  lines.forEach((lineId) => {
    const isActive = active.has(lineId);
    container.appendChild(
      makeChip({
        text: lineId,
        activeState: isActive,
        title: `${t("filterLines")}: ${lineId}`,
        className: `${servedLineBadgeClass(lineId)} is-clickable ${isActive ? "is-active-filter" : ""}`,
        onClick: () => setServedLineSelection(lineId),
      }),
    );
  });
}

function createChip({ text, active, onClick, className = "hc2__chip", activeClassName = "is-active", title = "" }) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = className;
  if (activeClassName) chip.classList.toggle(activeClassName, !!active);
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  if (title) chip.title = title;
  chip.textContent = text;
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return chip;
}

function renderSelectionList(container, values, selection, type) {
  if (!container) return;
  container.innerHTML = "";

  if (!values.length) return;

  const selectedValues = selection === "ALL" ? [] : Array.from(selection);
  const isAll = selection === "ALL" || selectedValues.length === 0;

  container.appendChild(
    createChip({
      text: t("filterAll"),
      active: isAll,
      className: "hc2__chip hc2__chip--all",
      activeClassName: "is-active",
      onClick: () => {
        state.filterState[type] = "ALL";
        applyFilterState();
        renderFiltersSheet();
      },
    }),
  );

  values.forEach((value) => {
    const isLineSection = type === "selectedLines";
    container.appendChild(
      createChip({
        text: value,
        active: selectedValues.includes(value),
        className: isLineSection
          ? `hc2__lineChip ${servedLineBadgeClass(value)} is-clickable`
          : "hc2__chip",
        activeClassName: isLineSection ? "is-active-filter" : "is-active",
        title: isLineSection ? `${t("filterLines")}: ${value}` : "",
        onClick: () => {
          toggleSelection(type, value);
          applyFilterState();
          renderFiltersSheet();
        },
      }),
    );
  });
}

function renderFiltersSheet() {
  const platforms = (appState.platformOptions || []).map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const lines = sortedLineOptions();

  state.filterState.selectedPlatforms = normalizeSelection(state.filterState.selectedPlatforms, platforms);
  state.filterState.selectedLines = normalizeSelection(state.filterState.selectedLines, lines);

  renderSelectionList(
    state.refs.platformsList,
    platforms,
    state.filterState.selectedPlatforms,
    "selectedPlatforms",
  );
  renderSelectionList(
    state.refs.linesList,
    lines,
    state.filterState.selectedLines,
    "selectedLines",
  );

  if (state.refs.platformsEmpty) {
    state.refs.platformsEmpty.classList.toggle("is-hidden", platforms.length > 0);
  }
  if (state.refs.linesEmpty) {
    state.refs.linesEmpty.classList.toggle("is-hidden", lines.length > 0);
  }

  if (state.refs.hideDeparture) {
    state.refs.hideDeparture.checked = !!state.filterState.hideDepartureBus;
    state.refs.hideDeparture.disabled = !!appState.lastBoardIsTrain;
  }
}

function resetAllFilters() {
  state.filterState.selectedPlatforms = "ALL";
  state.filterState.selectedLines = "ALL";
  state.filterState.hideDepartureBus = false;
  applyFilterState();
  renderFiltersSheet();
}

function updateSaveButton() {
  const button = state.refs.favoritesSave;
  if (!button) return;
  const labelEl = state.refs.favoritesSaveLabel;
  const metaEl = state.refs.favoritesSaveMeta;

  const stop = state.currentStop;
  const hasStop = !!(stop && stop.id && stop.name);
  const alreadySaved = hasStop && (state.favorites || []).some((fav) => fav.id === stop.id);

  const labels = pickLocalized(SAVE_LABELS);
  const metaLabels = pickLocalized(SAVE_META_LABELS);
  button.disabled = !hasStop || alreadySaved || !!state.isSaving;
  button.classList.toggle("is-saved", !!alreadySaved);
  button.classList.toggle("is-ready", hasStop && !alreadySaved && !state.isSaving);
  button.classList.toggle("is-busy", !!state.isSaving);

  let labelText = labels.ready;
  let metaText = metaLabels.idle;
  if (state.isSaving) {
    labelText = labels.ready;
    metaText = metaLabels.saving;
  } else if (hasStop && alreadySaved) {
    labelText = labels.saved;
    metaText = metaLabels.savedPrefix;
  } else if (hasStop) {
    labelText = labels.ready;
    metaText = metaLabels.readyPrefix;
  }

  if (labelEl) labelEl.textContent = labelText;
  if (metaEl) metaEl.textContent = metaText;
  if (!labelEl && !metaEl) button.textContent = labelText;
}

function renderFavoritesSheet() {
  const host = state.refs.favoritesList;
  const empty = state.refs.favoritesEmpty;
  if (!host || !empty) return;

  syncFavoritesFromStorage();
  const favorites = state.favorites || [];
  host.innerHTML = "";

  if (!favorites.length) {
    empty.classList.remove("is-hidden");
    return;
  }

  empty.classList.add("is-hidden");

  favorites.forEach((fav) => {
    const row = document.createElement("div");
    row.className = "hc2__favoriteRow";
    row.classList.toggle("is-manage", !!state.favoritesManageMode);
    row.classList.toggle("is-selected", state.selectedFavId === fav.id);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "hc2__favoriteItem";
    pickBtn.textContent = fav.name;
    pickBtn.addEventListener("click", () => {
      selectFavorite(fav.id);
    });

    const deleteGroup = document.createElement("div");
    deleteGroup.className = "hc2__favoriteDeleteGroup";
    deleteGroup.hidden = !state.favoritesManageMode;

    const deleteBtnInline = document.createElement("button");
    deleteBtnInline.type = "button";
    deleteBtnInline.className = "hc2__favoriteDelete";
    deleteBtnInline.setAttribute("aria-label", `${t("favoritesDelete")}: ${fav.name}`);
    deleteBtnInline.textContent = "✕";
    deleteBtnInline.hidden =
      !state.favoritesManageMode || state.pendingFavoriteDeleteId === fav.id;
    deleteBtnInline.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.pendingFavoriteDeleteId = fav.id;
      renderFavoritesSheet();
    });

    const confirmDeleteBtn = document.createElement("button");
    confirmDeleteBtn.type = "button";
    confirmDeleteBtn.className = "hc2__favoriteDeleteConfirm";
    confirmDeleteBtn.textContent = t("favoritesDeleteConfirmAction");
    confirmDeleteBtn.hidden =
      !state.favoritesManageMode || state.pendingFavoriteDeleteId !== fav.id;
    confirmDeleteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteFavorite(fav.id);
    });

    const cancelDeleteBtn = document.createElement("button");
    cancelDeleteBtn.type = "button";
    cancelDeleteBtn.className = "hc2__favoriteDeleteCancel";
    cancelDeleteBtn.textContent = t("homeStopDialogCancel");
    cancelDeleteBtn.hidden =
      !state.favoritesManageMode || state.pendingFavoriteDeleteId !== fav.id;
    cancelDeleteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.pendingFavoriteDeleteId = null;
      renderFavoritesSheet();
    });

    row.appendChild(pickBtn);
    deleteGroup.appendChild(deleteBtnInline);
    deleteGroup.appendChild(confirmDeleteBtn);
    deleteGroup.appendChild(cancelDeleteBtn);
    row.appendChild(deleteGroup);
    host.appendChild(row);
  });

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
  const title = state.refs.languageTitle;
  if (!select) return;

  select.innerHTML = "";
  LANGUAGE_OPTIONS.forEach((opt) => {
    const node = document.createElement("option");
    node.value = opt.code;
    node.textContent = opt.label;
    select.appendChild(node);
  });
  select.value = appState.language || "fr";
  if (title) title.textContent = t("languageLabel");
}

function bindEvents() {
  const r = state.refs;

  r.menuToggle?.addEventListener("click", () => {
    setHasSeenThreeDotsTip(true);
    dismissThreeDotsTip({ markSeen: false });
    toggleControls();
  });

  r.infoBadge?.addEventListener("click", () => {
    if (typeof state.callbacks.onOpenInfo === "function") {
      state.callbacks.onOpenInfo();
    }
  });

  r.stationInput?.addEventListener("input", () => {
    setSearchText(r.stationInput.value || "");
    if (state.suggestionsDebounce) clearTimeout(state.suggestionsDebounce);
    const query = state.searchText.trim();
    const token = ++state._searchDebounceToken;
    state.suggestionsDebounce = setTimeout(() => {
      if (token !== state._searchDebounceToken) return; // stale debounce
      fetchAndRenderSuggestions(query);
    }, 180);
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
    state.favoritesManageMode = !state.favoritesManageMode;
    if (!state.favoritesManageMode) state.pendingFavoriteDeleteId = null;
    updateFavoritesManageButton();
    renderFavoritesSheet();
  });

  r.filtersReset?.addEventListener("click", () => {
    resetAllFilters();
  });

  r.filtersApply?.addEventListener("click", () => {
    closeFilters();
  });

  r.filtersResetInline?.addEventListener("click", () => {
    resetAllFilters();
  });

  r.hideDeparture?.addEventListener("change", () => {
    state.filterState.hideDepartureBus = !!r.hideDeparture.checked;
    applyFilterState();
    renderFiltersSheet();
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

  const onWindowResize = () => {
    if (state.segmentResizeRaf) {
      cancelAnimationFrame(state.segmentResizeRaf);
      state.segmentResizeRaf = null;
    }
    state.segmentResizeRaf = requestAnimationFrame(() => {
      state.segmentResizeRaf = null;
      renderViewSegment();
      syncOpenControlsHeight();
      // Keep portal dropdown aligned with input if currently visible
      if (state.refs.stationSuggestions?.classList.contains("is-visible")) {
        repositionSuggestionsPortal();
      }
      if (state.threeDotsTipVisible) {
        scheduleThreeDotsTipReposition();
      }
    });
  };
  if (state.windowResizeHandler) {
    window.removeEventListener("resize", state.windowResizeHandler);
  }
  state.windowResizeHandler = onWindowResize;
  window.addEventListener("resize", onWindowResize, { passive: true });
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
  state.threeDotsTipShownInSession = getHasSeenThreeDotsTip();
  dismissThreeDotsTip({ markSeen: false });

  state.currentStop = getStopFromCallback();
  mountMarkup();

  // Dev-only: verify computed font-size after styles settle.
  // Must print >= 16px on iPhone Safari to confirm zoom prevention.
  // Enable with: window.DEBUG_UI = true  (in browser console)
  if (typeof window !== "undefined" && window.DEBUG_UI) {
    const input = state.refs?.stationInput;
    if (input) {
      requestAnimationFrame(() => {
        const fs = getComputedStyle(input).fontSize;
        console.log("[HC2][searchInput] computed font-size:", fs, "— must be ≥ 16px on iPhone Safari to prevent zoom");
      });
    }
  }

  renderLanguageSelect();
  restoreCollapsedState();
  syncFilterStateFromAppState();
  bindEvents();

  state.initialized = true;

  appState._renderViewControls = () => {
    renderViewSegment();
    renderFilterSummary();
    renderServedLinesChips();
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
  syncFilterStateFromAppState();

  renderLanguageSelect();
  renderViewSegment();
  renderFiltersSheet();
  renderFilterSummary();
  renderServedLinesChips();
  renderFavoritesSheet();
  updateSaveButton();
  syncOpenControlsHeight();

  const filtersAvailable =
    (Array.isArray(appState.platformOptions) && appState.platformOptions.length > 0) ||
    (Array.isArray(appState.lineOptions) && appState.lineOptions.length > 0) ||
    !appState.lastBoardIsTrain;

  if (state.refs.filtersOpen) {
    state.refs.filtersOpen.disabled = !filtersAvailable;
    state.refs.filtersOpen.classList.toggle("is-disabled", !filtersAvailable);
  }
}

export function maybeShowThreeDotsTip() {
  if (!state.initialized) return false;
  if (state.threeDotsTipVisible) return true;
  if (state.threeDotsTipShownInSession) return false;
  if (getHasSeenThreeDotsTip()) {
    state.threeDotsTipShownInSession = true;
    return false;
  }
  return showThreeDotsTip();
}

export function setBoardLoadingHint(isLoading) {
  if (!state.initialized) return;
  state.isBoardLoading = !!isLoading;
  syncHint();
}

export function setBoardNoticeHint(text, { ttlMs = 0 } = {}) {
  if (!state.initialized) return;
  if (state.boardNoticeTimer) {
    clearTimeout(state.boardNoticeTimer);
    state.boardNoticeTimer = null;
  }
  state.boardNoticeText = String(text || "").trim();
  syncHint();
  const ttl = Number(ttlMs);
  if (state.boardNoticeText && Number.isFinite(ttl) && ttl > 0) {
    state.boardNoticeTimer = setTimeout(() => {
      state.boardNoticeText = "";
      state.boardNoticeTimer = null;
      syncHint();
    }, ttl);
  }
}
