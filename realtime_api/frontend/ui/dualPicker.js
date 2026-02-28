import { t } from "../v20260227.i18n.js";
import { fetchStationSuggestions, fetchStationsNearby } from "../v20260227.logic.js";
import { loadFavorites, addFavorite, removeFavorite } from "../v20260227.favourites.js";
import {
  VIEW_MODE_LINE,
  VIEW_MODE_TIME,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
} from "../v20260227.state.js";

function createPickerTemplate(side) {
  const suffix = side === "right" ? "right" : "left";
  const sideLabel = side === "right" ? t("dualSideRight") : t("dualSideLeft");

  return `
    <div class="dual-picker-input-card">
      <div class="dual-picker-side-label" id="side-label-${suffix}">${sideLabel}</div>

      <label for="station-input-${suffix}" class="sr-only">${t("searchStop")}</label>
      <div class="dual-picker-search">
        <input
          id="station-input-${suffix}"
          type="text"
          class="dual-picker-input"
          placeholder="${t("searchAction")}..."
          autocomplete="off"
        />
        <div class="dual-picker-icons">
          <button
            id="favorites-only-toggle-${suffix}"
            class="dual-picker-icon-btn hc2__pillControl"
            type="button"
            aria-label="${t("filterFavoritesTitle")}"
            aria-pressed="false"
            aria-expanded="false"
            aria-controls="favorites-popover-${suffix}"
            title="${t("filterFavoritesTitle")}"
          >
            <span aria-hidden="true">★</span>
          </button>
          <button
            id="station-search-${suffix}"
            class="dual-picker-icon-btn hc2__pillControl"
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
        </div>
      </div>
      <ul id="station-suggestions-${suffix}" class="dual-picker-suggestions"></ul>
    </div>

    <div class="dual-picker-filters">
      <div class="hc2__row hc2__displayRow">
        <div class="hc2__rowLabel hc2__displayLabel">${t("filterDisplay")}</div>
        <div id="view-segment-${suffix}" class="hc2__segment"></div>
      </div>

      <div class="hc2__row">
        <button
          id="filters-open-${suffix}"
          class="hc2__pill hc2__topControl hc2__topControl--normal"
          type="button"
          aria-expanded="false"
          aria-controls="filters-popover-${suffix}"
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
          <span>${t("filterButton")}</span>
        </button>
      </div>
    </div>
  `;
}

function createPickerSheetsTemplate(side) {
  const suffix = side === "right" ? "right" : "left";

  return `
    <div id="favorites-backdrop-${suffix}" class="hc2__backdrop" hidden></div>

    <section
      id="favorites-popover-${suffix}"
      class="hc2__sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="favorites-popover-title-${suffix}"
      tabindex="-1"
      hidden
    >
      <header class="hc2__sheetHeader">
        <h2 id="favorites-popover-title-${suffix}" class="hc2__sheetTitle">${t("filterFavoritesTitle")}</h2>
        <button
          class="hc2__iconBtn hc2__sheetClose"
          type="button"
          data-fav-close="${suffix}"
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <div id="favorites-chip-list-${suffix}" class="hc2__favList"></div>
      <div id="favorites-empty-${suffix}" class="hc2__empty is-hidden">${t("filterNoFavorites")}</div>
    </section>

    <div id="filters-backdrop-${suffix}" class="hc2__backdrop" hidden></div>

    <section
      id="filters-popover-${suffix}"
      class="hc2__sheet hc2__sheet--filters"
      role="dialog"
      aria-modal="true"
      aria-labelledby="filters-sheet-title-${suffix}"
      tabindex="-1"
      hidden
    >
      <header class="hc2__sheetHeader">
        <h2 id="filters-sheet-title-${suffix}" class="hc2__sheetTitle">${t("filterButton")}</h2>
        <button
          class="hc2__iconBtn hc2__sheetClose"
          type="button"
          data-filter-close="${suffix}"
          aria-label="Close"
        >
          ×
        </button>
      </header>

      <div class="hc2__sheetBody">
        <section class="hc2__filterSection" id="filters-section-lines-${suffix}">
          <div class="hc2__sectionTitle" id="filters-lines-title-${suffix}">${t("filterLines")}</div>
          <div id="line-chip-list-${suffix}" class="hc2__chipRow"></div>
          <div id="lines-empty-${suffix}" class="hc2__empty is-hidden">${t("filterNoLines")}</div>
        </section>

        <section class="hc2__filterSection">
          <div class="hc2__sectionTitle">${t("filterDisplay")}</div>
          <label class="hc2__switch hc2__switch--clickable" for="filters-hide-departure-${suffix}">
            <span class="hc2__switchLabel">${t("filterHideDepartureShort")}</span>
            <input type="checkbox" id="filters-hide-departure-${suffix}" class="hc2__switchInput" />
          </label>
        </section>
      </div>

      <footer class="hc2__sheetFooter">
        <button class="hc2__secondary" type="button" data-filter-reset="${suffix}">
          ${t("filterReset")}
        </button>
        <button class="hc2__primary" type="button" data-filter-apply="${suffix}">
          ${t("filterApply")}
        </button>
      </footer>
    </section>
  `;
}

export class DualPicker {
  constructor(side, defaults, initialState, onChange) {
    this.side = side;
    this.defaults = defaults;
    this.state = initialState;
    this.isTrainBoard =
      initialState.view &&
      [TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE].includes(
        initialState.view
      );
    this.busView = initialState.busView || VIEW_MODE_TIME;
    this.trainView = initialState.trainView || TRAIN_FILTER_ALL;
    this.pendingHideDeparture = initialState.hideDeparture || false;
    this.pendingLineFilter = initialState.lineFilter ? new Set(initialState.lineFilter) : new Set();
    this.onChange = onChange;
    this.suggestToken = 0;

    this.els = {};
  }

  mount(mountEl) {
    this.mountEl = mountEl;
    mountEl.innerHTML = createPickerTemplate(this.side);
    document.body.insertAdjacentHTML("beforeend", createPickerSheetsTemplate(this.side));
    this.debouncedSuggest = this.debounce((q) => this.fetchSuggestions(q), 180);
    this.cacheRefs();
    this.syncAll();
    this.bindEvents();
  }

  cacheRefs() {
    const suffix = this.side === "right" ? "right" : "left";
    this.els = {
      input: document.getElementById(`station-input-${suffix}`),
      suggestions: document.getElementById(`station-suggestions-${suffix}`),
      geoBtn: document.getElementById(`station-search-${suffix}`),
      favoritesBtn: document.getElementById(`favorites-only-toggle-${suffix}`),
      favoritesPopover: document.getElementById(`favorites-popover-${suffix}`),
      favoritesList: document.getElementById(`favorites-chip-list-${suffix}`),
      favoritesEmpty: document.getElementById(`favorites-empty-${suffix}`),
      viewSegment: document.getElementById(`view-segment-${suffix}`),
      filtersOpen: document.getElementById(`filters-open-${suffix}`),
      filtersPopover: document.getElementById(`filters-popover-${suffix}`),
      filtersHide: document.getElementById(`filters-hide-departure-${suffix}`),
      lineChipList: document.getElementById(`line-chip-list-${suffix}`),
      linesEmpty: document.getElementById(`lines-empty-${suffix}`),
      linesSection: document.getElementById(`filters-section-lines-${suffix}`),
      filtersReset: document.querySelector(`[data-filter-reset='${suffix}']`),
      filtersApply: document.querySelector(`[data-filter-apply='${suffix}']`),
      filtersClose: document.querySelector(`[data-filter-close='${suffix}']`),
      favClose: document.querySelector(`[data-fav-close='${suffix}']`),
      filtersBackdrop: document.getElementById(`filters-backdrop-${suffix}`),
      favBackdrop: document.getElementById(`favorites-backdrop-${suffix}`),
      sideLabel: document.getElementById(`side-label-${suffix}`),
    };
  }

  syncAll() {
    this.syncInputValue();
    this.renderViewControls();
    this.renderLineChips();
    this.syncHideToggle();
    this.renderFavoritesList();
  }

  syncInputValue() {
    if (this.els.input) {
      this.els.input.value = this.state.stationName || this.state.customUrl || "";
    }
  }

  renderViewControls() {
    if (!this.els.viewSegment) return;
    const segment = this.els.viewSegment;
    segment.innerHTML = "";

    const isTrain = this.isTrainBoard;
    const options = isTrain
      ? [
          { v: TRAIN_FILTER_ALL, label: () => t("trainFilterAll") },
          { v: TRAIN_FILTER_REGIONAL, label: () => t("trainFilterRegional") },
          { v: TRAIN_FILTER_LONG_DISTANCE, label: () => t("trainFilterLongDistance") },
        ]
      : [
          { v: VIEW_MODE_LINE, label: () => t("viewOptionLine") },
          { v: VIEW_MODE_TIME, label: () => t("viewOptionTime") },
        ];

    const active = this.state.view || (isTrain ? TRAIN_FILTER_ALL : VIEW_MODE_TIME);

    options.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hc2__segmentBtn";
      b.dataset.view = opt.v;
      const isActive = opt.v === active;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-pressed", isActive ? "true" : "false");
      b.textContent = opt.label();
      b.addEventListener("click", () => {
        this.setView(opt.v);
      });
      segment.appendChild(b);
    });
  }

  renderLineChips() {
    if (!this.els.lineChipList || !this.els.linesEmpty || !this.els.linesSection) return;

    const lines = this.sortedLineOptions();
    const isTrain = this.isTrainBoard;
    const shouldHide = lines.length === 0 || isTrain;

    this.els.linesSection.hidden = shouldHide;
    if (shouldHide) {
      this.els.linesSection.style.display = "none";
    } else {
      this.els.linesSection.style.display = "";
    }

    this.els.lineChipList.innerHTML = "";
    if (shouldHide) {
      this.els.linesEmpty.classList.add("is-hidden");
      return;
    }

    if (lines.length === 0) {
      this.els.linesEmpty.classList.remove("is-hidden");
      return;
    }

    this.els.linesEmpty.classList.add("is-hidden");

    lines.forEach((lineId) => {
      const isActive = this.pendingLineFilter.has(lineId);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hc2__chip";
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.textContent = lineId;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.pendingLineFilter.has(lineId)) {
          this.pendingLineFilter.delete(lineId);
        } else {
          this.pendingLineFilter.add(lineId);
        }
        this.renderLineChips();
      });
      this.els.lineChipList.appendChild(btn);
    });
  }

  sortedLineOptions() {
    const lines = (window.appState?.lineOptions || [])
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    return lines.sort((a, b) => {
      const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
      const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
      if (na !== nb) return na - nb;
      return String(a).localeCompare(String(b), "fr-CH");
    });
  }

  syncHideToggle() {
    if (this.els.filtersHide) {
      const disabled = !!this.isTrainBoard;
      this.els.filtersHide.checked = disabled ? false : !!this.pendingHideDeparture;
      this.els.filtersHide.disabled = disabled;
    }
  }


  bindEvents() {
    if (this.els.input) {
      this.els.input.addEventListener("input", (e) => {
        const q = e.target.value.trim();
        if (!q || q.length < 2 || /^https?:\/\//i.test(q)) {
          this.clearSuggestions();
          return;
        }
        this.debouncedSuggest(q);
      });
      this.els.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.applyInputValue();
        } else if (e.key === "Escape") {
          this.clearSuggestions();
        }
      });
      this.els.input.addEventListener("focus", () => {
        if (this.els.input.value.trim().length >= 2) {
          this.debouncedSuggest(this.els.input.value.trim());
        }
      });
      this.els.input.addEventListener("blur", () => {
        setTimeout(() => this.clearSuggestions(), 150);
      });
    }

    if (this.els.suggestions) {
      this.els.suggestions.addEventListener("click", (e) => {
        const li = e.target.closest(".station-suggestion-item");
        if (!li || !li.dataset.id) return;
        this.setStation(li.dataset.name, li.dataset.id);
        this.clearSuggestions();
      });
    }

    if (this.els.geoBtn) {
      this.els.geoBtn.addEventListener("click", () => this.handleGeo());
    }

    if (this.els.favoritesBtn) {
      this.els.favoritesBtn.addEventListener("click", () => this.toggleFavoritesPopover());
    }

    if (this.els.filtersOpen) {
      this.els.filtersOpen.addEventListener("click", () => this.openFilters());
    }
    if (this.els.filtersClose) {
      this.els.filtersClose.addEventListener("click", () => this.closeFilters());
    }
    if (this.els.filtersApply) {
      this.els.filtersApply.addEventListener("click", () => this.applyFilters());
    }
    if (this.els.filtersReset) {
      this.els.filtersReset.addEventListener("click", () => this.resetFilters());
    }
    if (this.els.filtersHide) {
      this.els.filtersHide.addEventListener("change", () => {
        this.pendingHideDeparture = !!this.els.filtersHide.checked;
      });
    }

    if (this.els.favClose) {
      this.els.favClose.addEventListener("click", () => this.closeFavoritesPopover());
    }

    if (this.els.filtersBackdrop) {
      this.els.filtersBackdrop.addEventListener("click", () => this.closeFilters());
    }
    if (this.els.favBackdrop) {
      this.els.favBackdrop.addEventListener("click", () => this.closeFavoritesPopover());
    }
  }

  setView(view) {
    const VALID_BUS_VIEWS = new Set([VIEW_MODE_LINE, VIEW_MODE_TIME]);
    const VALID_TRAIN_VIEWS = new Set([TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE]);

    if (VALID_TRAIN_VIEWS.has(view)) {
      this.isTrainBoard = true;
      this.trainView = view;
      this.state.view = view;
    } else if (VALID_BUS_VIEWS.has(view)) {
      this.isTrainBoard = false;
      this.busView = view;
      this.state.view = view;
    } else {
      return;
    }

    this.renderViewControls();
    this.syncHideToggle();
    this.triggerChange();
  }

  openFilters() {
    if (!this.els.filtersPopover || !this.els.filtersOpen) return;
    this.pendingHideDeparture = !!this.state.hideDeparture;
    this.pendingLineFilter = new Set(this.state.lineFilter || []);
    this.syncHideToggle();
    this.renderLineChips();
    this.els.filtersPopover.hidden = false;
    if (this.els.filtersBackdrop) this.els.filtersBackdrop.hidden = false;
    this.els.filtersOpen.setAttribute("aria-expanded", "true");
  }

  closeFilters() {
    if (!this.els.filtersPopover || !this.els.filtersOpen) return;
    const active = document.activeElement;
    if (active && this.els.filtersPopover.contains(active)) {
      if (typeof this.els.filtersOpen.focus === "function") {
        this.els.filtersOpen.focus();
      } else if (typeof active.blur === "function") {
        active.blur();
      }
    }
    this.els.filtersPopover.hidden = true;
    if (this.els.filtersBackdrop) this.els.filtersBackdrop.hidden = true;
    this.els.filtersOpen.setAttribute("aria-expanded", "false");
  }

  applyFilters() {
    this.state.hideDeparture = !!this.pendingHideDeparture;
    this.state.lineFilter = this.pendingLineFilter.size > 0 ? Array.from(this.pendingLineFilter) : null;
    this.syncHideToggle();
    this.renderLineChips();
    this.closeFilters();
    this.triggerChange();
  }

  resetFilters() {
    this.pendingHideDeparture = false;
    this.pendingLineFilter.clear();
    this.state.hideDeparture = false;
    this.state.lineFilter = null;
    this.syncHideToggle();
    this.renderLineChips();
    this.closeFilters();
    this.triggerChange();
  }

  clearSuggestions() {
    if (this.els.suggestions) {
      this.els.suggestions.innerHTML = "";
      this.els.suggestions.style.display = "none";
      this.els.suggestions.classList.remove("is-visible");
    }
  }

  renderSuggestions(list) {
    if (!this.els.suggestions) return;
    this.els.suggestions.innerHTML = "";
    if (!list || !list.length) {
      this.els.suggestions.style.display = "none";
      this.els.suggestions.classList.remove("is-visible");
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach((item) => {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.dataset.id = item.id;
      li.dataset.name = item.name;

      // Show station name + distance if available
      if (item.distance !== undefined && item.distance !== null) {
        const distanceText = item.distance < 1000
          ? `${Math.round(item.distance)}m`
          : `${(item.distance / 1000).toFixed(1)}km`;
        li.innerHTML = `<span class="station-name">${item.name}</span><span class="station-distance">${distanceText}</span>`;
      } else {
        li.textContent = item.name;
      }

      frag.appendChild(li);
    });
    this.els.suggestions.appendChild(frag);
    this.els.suggestions.style.display = "block";
    this.els.suggestions.classList.add("is-visible");
  }

  debounce(fn, wait = 200) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  async fetchSuggestions(query) {
    if (!query || query.length < 2) {
      this.clearSuggestions();
      return;
    }
    const token = ++this.suggestToken;
    try {
      const list = await fetchStationSuggestions(query);
      if (token !== this.suggestToken) return;
      this.renderSuggestions(list);
    } catch {
      this.clearSuggestions();
    }
  }

  async applyInputValue() {
    if (!this.els.input) return;
    const value = this.els.input.value.trim();
    if (!value) return;

    if (/^https?:\/\//i.test(value)) {
      this.state = { ...this.state, customUrl: value };
      this.syncAll();
      this.clearSuggestions();
      this.triggerChange();
      return;
    }

    try {
      const list = await fetchStationSuggestions(value);
      const first = list?.[0];
      if (first) {
        this.setStation(first.name, first.id);
      } else {
        this.state.stationName = value;
        this.syncAll();
        this.triggerChange();
      }
    } catch {
      this.state.stationName = value;
      this.syncAll();
      this.triggerChange();
    }
  }

  setStation(name, id) {
    this.state.stationName = name;
    this.state.stationId = id;
    this.state.customUrl = null;
    this.pendingHideDeparture = this.state.hideDeparture;
    this.syncAll();
    this.clearSuggestions();
    this.triggerChange();
  }

  async handleGeo() {
    if (!this.els.geoBtn) return;
    this.els.geoBtn.disabled = true;
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        });
      });
      const stations = await fetchStationsNearby(
        pos.coords.latitude,
        pos.coords.longitude,
        8
      );
      if (stations && stations.length > 0) {
        // Clear input and show nearby stations in suggestions for user to choose (closest to least close)
        if (this.els.input) {
          this.els.input.value = "";
        }
        this.renderSuggestions(stations);
        // Focus the input so user sees the suggestions and can interact
        if (this.els.input) {
          this.els.input.focus();
        }
      }
    } catch {
      // ignore
    } finally {
      this.els.geoBtn.disabled = false;
    }
  }

  addCurrentStationToFavorites() {
    if (!this.state.stationId) {
      return;
    }
    const stationName = this.state.stationName || "";
    addFavorite({ id: this.state.stationId, name: stationName });
    this.showToast(t("favoriteAdded"));
    this.renderFavoritesList();
  }

  showToast(message) {
    const toast = document.createElement("div");
    toast.className = "hc2__toast";
    toast.textContent = message;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add("hc2__toast--visible");
    });

    setTimeout(() => {
      toast.classList.remove("hc2__toast--visible");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  toggleFavoritesPopover() {
    if (!this.els.favoritesPopover || !this.els.favoritesBtn) return;
    const isOpen = !this.els.favoritesPopover.hidden;
    if (isOpen) {
      this.closeFavoritesPopover();
    } else {
      this.renderFavoritesList();
      this.els.favoritesPopover.hidden = false;
      if (this.els.favBackdrop) this.els.favBackdrop.hidden = false;
      this.els.favoritesBtn.setAttribute("aria-expanded", "true");
    }
  }

  closeFavoritesPopover() {
    if (!this.els.favoritesPopover || !this.els.favoritesBtn) return;
    this.els.favoritesPopover.hidden = true;
    if (this.els.favBackdrop) this.els.favBackdrop.hidden = true;
    this.els.favoritesBtn.setAttribute("aria-expanded", "false");
  }

  renderFavoritesList() {
    if (!this.els.favoritesList || !this.els.favoritesPopover) return;

    const favs = loadFavorites();
    this.els.favoritesList.innerHTML = "";

    // Render header with "Add current station" button
    const header = document.createElement("div");
    header.className = "hc2__favoritesHeader";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "hc2__primary";
    addBtn.textContent = `+ ${t("filterFavoritesTitle")}`;
    addBtn.addEventListener("click", () => this.addCurrentStationToFavorites());

    header.appendChild(addBtn);
    this.els.favoritesList.appendChild(header);

    if (favs.length === 0) {
      if (this.els.favoritesEmpty) {
        this.els.favoritesEmpty.classList.remove("is-hidden");
      }
      return;
    }

    if (this.els.favoritesEmpty) {
      this.els.favoritesEmpty.classList.add("is-hidden");
    }

    // Render favorite items with delete buttons
    const frag = document.createDocumentFragment();
    favs.forEach((fav) => {
      const item = document.createElement("div");
      item.className = "hc2__favoriteItem";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hc2__favItemBtn";
      btn.textContent = fav.name;
      btn.addEventListener("click", () => {
        this.setStation(fav.name, fav.id);
        this.closeFavoritesPopover();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "hc2__favItemDelete";
      deleteBtn.setAttribute("aria-label", `${t("favoritesDelete")} ${fav.name}`);
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M18 6L6 18M6 6l12 12"/></svg>';
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`${t("favoritesDelete")} "${fav.name}"?`)) {
          removeFavorite(fav.id);
          this.showToast(t("favoriteRemoved"));
          this.renderFavoritesList();
        }
      });

      item.appendChild(btn);
      item.appendChild(deleteBtn);
      frag.appendChild(item);
    });

    this.els.favoritesList.appendChild(frag);
  }

  handleGlobalResize() {
    // No special resize handling needed for bottom sheets
  }

  handleGlobalClick(event) {
    if (this.els.favoritesPopover && !this.els.favoritesPopover.hidden) {
      const inPopover =
        this.els.favoritesPopover.contains(event.target) ||
        (this.els.favoritesBtn && this.els.favoritesBtn.contains(event.target));
      if (!inPopover) {
        this.closeFavoritesPopover();
      }
    }
    if (this.els.filtersPopover && !this.els.filtersPopover.hidden) {
      const inFilters =
        this.els.filtersPopover.contains(event.target) ||
        (this.els.filtersOpen && this.els.filtersOpen.contains(event.target));
      if (!inFilters) {
        this.closeFilters();
      }
    }
  }

  setBoardType(isTrain, view, hideDeparture, { silent = false } = {}) {
    const VALID_TRAIN_VIEWS = new Set([TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE]);
    const VALID_BUS_VIEWS = new Set([VIEW_MODE_LINE, VIEW_MODE_TIME]);

    this.isTrainBoard = !!isTrain;
    if (view) {
      if (this.isTrainBoard && VALID_TRAIN_VIEWS.has(view)) {
        this.trainView = view;
      } else if (!this.isTrainBoard && VALID_BUS_VIEWS.has(view)) {
        this.busView = view;
      }
    }

    this.state.view = this.isTrainBoard ? this.trainView : this.busView;

    if (typeof hideDeparture === "boolean") {
      this.state.hideDeparture = this.isTrainBoard ? false : !!hideDeparture;
      this.pendingHideDeparture = this.state.hideDeparture;
    }

    this.renderViewControls();
    this.syncHideToggle();
    if (!silent) this.triggerChange();
  }

  getUrl() {
    const viewForUrl = this.isTrainBoard ? this.trainView : this.busView;
    const BASE_BOARD_URL = new URL("./", window.location.href);
    const url = new URL(BASE_BOARD_URL);
    url.search = "";

    if (this.state.stationName) url.searchParams.set("stationName", this.state.stationName);
    if (this.state.stationId) url.searchParams.set("stationId", this.state.stationId);
    if (viewForUrl) url.searchParams.set("view", viewForUrl);
    if (this.state.hideDeparture) url.searchParams.set("hideDeparture", "1");
    if (this.state.lineFilter && this.state.lineFilter.length > 0) {
      url.searchParams.set("lines", this.state.lineFilter.join(","));
    }
    if (this.state.language) url.searchParams.set("lang", this.state.language);
    url.searchParams.set("dual", "1");

    return url.toString();
  }

  getSerializableState() {
    return {
      stationName: this.state.stationName,
      stationId: this.state.stationId,
      view: this.state.view,
      busView: this.busView,
      trainView: this.trainView,
      hideDeparture: this.state.hideDeparture,
      lineFilter: this.state.lineFilter || null,
      language: this.state.language,
      customUrl: this.state.customUrl || null,
    };
  }

  getDisplayName() {
    return this.state.stationName || t("dualBoardLabel");
  }

  applyState(next, { silent = false } = {}) {
    const VALID_TRAIN_VIEWS = new Set([TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE]);
    const VALID_BUS_VIEWS = new Set([VIEW_MODE_LINE, VIEW_MODE_TIME]);

    this.state = next;
    if (next.busView && VALID_BUS_VIEWS.has(next.busView)) {
      this.busView = next.busView;
    }
    if (next.trainView && VALID_TRAIN_VIEWS.has(next.trainView)) {
      this.trainView = next.trainView;
    }

    if (VALID_TRAIN_VIEWS.has(this.state.view)) {
      this.isTrainBoard = true;
    } else if (VALID_BUS_VIEWS.has(this.state.view)) {
      this.isTrainBoard = false;
    }

    this.state.view = this.isTrainBoard ? this.trainView : this.busView;
    this.pendingHideDeparture = !!this.state.hideDeparture;
    this.pendingLineFilter = new Set(next.lineFilter || []);
    this.syncAll();
    if (!silent) this.triggerChange();
  }

  triggerChange() {
    if (typeof this.onChange === "function") this.onChange();
  }

  setLanguage(lang, { silent = false } = {}) {
    this.state.language = lang;
    this.renderViewControls();
    this.syncHideToggle();
    if (!silent) this.triggerChange();
  }

  refreshLanguageUi() {
    this.setLanguage(this.state.language, { silent: true });
  }
}
