import { t } from "../v20260227.i18n.js";
import { fetchStationSuggestions, fetchStationsNearby, isAbortError } from "../v20260227.logic.js";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function normalizeStop(stop) {
  if (!stop || typeof stop !== "object") return null;
  const name = typeof stop.name === "string" ? stop.name.trim() : "";
  const id = typeof stop.id === "string" ? stop.id.trim() : "";
  if (!name && !id) return null;
  return {
    id: id || null,
    name: name || "",
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function focusableIn(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.disabled &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getAttribute("hidden") == null,
  );
}

export function openHomeStopOnboardingModal({ initialStop } = {}) {
  const isDualEmbed =
    typeof document !== "undefined" &&
    (document.documentElement.classList.contains("dual-embed") ||
      document.body?.classList.contains("dual-embed"));
  if (isDualEmbed) {
    return Promise.resolve({ confirmed: false, stop: null, dontAskAgain: false });
  }

  const initial = normalizeStop(initialStop);
  const previouslyFocused =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const inertRoot = document.querySelector(".mobile-fullscreen-wrapper");

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "home-stop-onboarding";
    host.innerHTML = `
      <div class="hc2__backdrop home-stop-modal__backdrop"></div>
      <section
        class="hc2__sheet home-stop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-stop-modal-title"
        aria-describedby="home-stop-modal-desc"
        tabindex="-1"
      >
        <header class="hc2__sheetHeader home-stop-modal__header">
          <h2 id="home-stop-modal-title" class="hc2__sheetTitle">${escapeHtml(
            t("homeStopDialogTitle"),
          )}</h2>
        </header>
        <p id="home-stop-modal-desc" class="home-stop-modal__desc">${escapeHtml(
          t("homeStopDialogDescription"),
        )}</p>

        <div class="dual-picker-input-card home-stop-modal__picker">
          <label for="home-stop-modal-input" class="sr-only">${escapeHtml(t("homeStopDialogInputLabel"))}</label>
          <div class="dual-picker-search">
            <input
              id="home-stop-modal-input"
              type="text"
              class="dual-picker-input"
              placeholder="${escapeHtml(t("searchAction"))}..."
              autocomplete="off"
              aria-label="${escapeHtml(t("homeStopDialogInputLabel"))}"
            />
            <div class="dual-picker-icons">
              <button
                id="home-stop-modal-nearby"
                class="dual-picker-icon-btn"
                type="button"
                aria-label="${escapeHtml(t("nearbyButton"))}"
                title="${escapeHtml(t("nearbyButton"))}"
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
          <ul id="home-stop-modal-suggestions" class="home-stop-modal__suggestions" hidden></ul>
        </div>

        <p id="home-stop-modal-error" class="home-stop-modal__error is-hidden" role="status" aria-live="polite"></p>

        <label class="home-stop-modal__checkbox" for="home-stop-modal-dont-ask">
          <input id="home-stop-modal-dont-ask" type="checkbox" />
          <span>${escapeHtml(t("homeStopDialogDontAskAgain"))}</span>
        </label>

        <footer class="home-stop-modal__actions">
          <button id="home-stop-modal-cancel" class="hc2__secondary home-stop-modal__btn" type="button">
            ${escapeHtml(t("homeStopDialogCancel"))}
          </button>
          <button id="home-stop-modal-confirm" class="hc2__primary home-stop-modal__btn" type="button">
            ${escapeHtml(t("homeStopDialogConfirm"))}
          </button>
        </footer>
      </section>
    `;
    document.body.appendChild(host);

    if (inertRoot) inertRoot.setAttribute("inert", "");

    const modal = host.querySelector(".home-stop-modal");
    const backdrop = host.querySelector(".home-stop-modal__backdrop");
    const input = host.querySelector("#home-stop-modal-input");
    const nearbyBtn = host.querySelector("#home-stop-modal-nearby");
    const suggestions = host.querySelector("#home-stop-modal-suggestions");
    const error = host.querySelector("#home-stop-modal-error");
    const dontAskAgain = host.querySelector("#home-stop-modal-dont-ask");
    const cancelBtn = host.querySelector("#home-stop-modal-cancel");
    const confirmBtn = host.querySelector("#home-stop-modal-confirm");

    let selectedStop = initial;
    let queryToken = 0;
    let fetchAbortController = null;
    let debounceTimer = null;
    let isClosed = false;

    function setError(message) {
      const text = String(message || "").trim();
      if (!error) return;
      error.textContent = text;
      error.classList.toggle("is-hidden", !text);
    }

    function hideSuggestions() {
      if (!suggestions) return;
      suggestions.hidden = true;
      suggestions.innerHTML = "";
    }

    function renderSuggestionRows(rows) {
      if (!suggestions) return;
      const items = Array.isArray(rows) ? rows : [];
      suggestions.innerHTML = "";

      if (!items.length) {
        suggestions.hidden = true;
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const row of items) {
        const stop = normalizeStop(row);
        if (!stop) continue;
        const li = document.createElement("li");
        li.className = "home-stop-modal__suggestionItem";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "home-stop-modal__suggestionBtn";

        const nameSpan = document.createElement("span");
        nameSpan.className = "home-stop-modal__suggestionName";
        nameSpan.textContent = stop.name;
        button.appendChild(nameSpan);

        if (row && row.distance != null && Number.isFinite(Number(row.distance))) {
          const dist = Number(row.distance);
          const distanceSpan = document.createElement("span");
          distanceSpan.className = "home-stop-modal__suggestionDistance";
          distanceSpan.textContent =
            dist >= 1000 ? `${(dist / 1000).toFixed(dist >= 10_000 ? 0 : 1)} km` : `${Math.round(dist)} m`;
          button.appendChild(distanceSpan);
        }

        button.addEventListener("click", () => {
          selectedStop = stop;
          if (input) input.value = stop.name;
          setError("");
          hideSuggestions();
        });

        li.appendChild(button);
        fragment.appendChild(li);
      }

      if (!fragment.childNodes.length) {
        suggestions.hidden = true;
        return;
      }

      suggestions.appendChild(fragment);
      suggestions.hidden = false;
    }

    function renderSuggestionStatus(message) {
      if (!suggestions) return;
      suggestions.innerHTML = "";

      const li = document.createElement("li");
      li.className = "home-stop-modal__suggestionItem home-stop-modal__suggestionItem--status";
      li.textContent = String(message || "");
      suggestions.appendChild(li);
      suggestions.hidden = false;
    }

    async function searchStops(query) {
      const trimmed = String(query || "").trim();
      if (trimmed.length < 2) {
        hideSuggestions();
        return;
      }

      queryToken += 1;
      const token = queryToken;

      if (fetchAbortController) {
        fetchAbortController.abort();
      }
      fetchAbortController = new AbortController();

      renderSuggestionStatus(t("searchLoading"));

      try {
        const rows = await fetchStationSuggestions(trimmed, { signal: fetchAbortController.signal });
        if (token !== queryToken) return;
        if (!rows || !rows.length) {
          renderSuggestionStatus(t("searchEmpty"));
          return;
        }
        renderSuggestionRows(rows);
      } catch (err) {
        if (isAbortError(err)) return;
        hideSuggestions();
      }
    }

    function scheduleSearch(query) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        searchStops(query);
      }, 180);
    }

    async function chooseFromInput() {
      const raw = String(input?.value || "").trim();
      if (!raw) {
        setError(t("dualStatusEnterStation"));
        input?.focus({ preventScroll: true });
        return null;
      }

      if (selectedStop && selectedStop.name && selectedStop.name.toLowerCase() === raw.toLowerCase()) {
        return selectedStop;
      }

      try {
        const rows = await fetchStationSuggestions(raw);
        if (rows && rows.length) {
          return normalizeStop(rows[0]);
        }
      } catch {
        // ignore, fallback to free-text name below
      }

      return normalizeStop({ id: null, name: raw });
    }

    function restoreFocusAndResolve(payload) {
      if (isClosed) return;
      isClosed = true;

      if (debounceTimer) clearTimeout(debounceTimer);
      if (fetchAbortController) fetchAbortController.abort();
      document.removeEventListener("keydown", onDocumentKeydown, true);
      document.removeEventListener("mousedown", onDocumentMouseDown, true);

      if (inertRoot) inertRoot.removeAttribute("inert");
      host.remove();

      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {
          // ignore focus restore issues
        }
      }
      resolve(payload);
    }

    async function confirmSelection() {
      setError("");
      if (confirmBtn) confirmBtn.disabled = true;

      const chosen = await chooseFromInput();
      if (!chosen || !chosen.name) {
        if (confirmBtn) confirmBtn.disabled = false;
        setError(t("dualStatusEnterStation"));
        return;
      }

      restoreFocusAndResolve({
        confirmed: true,
        stop: chosen,
        dontAskAgain: !!dontAskAgain?.checked,
      });
    }

    function cancelSelection() {
      restoreFocusAndResolve({ confirmed: false });
    }

    async function runNearbySearch() {
      if (!nearbyBtn) return;
      nearbyBtn.disabled = true;
      setError("");
      renderSuggestionStatus(t("nearbySearching"));

      try {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          renderSuggestionStatus(t("nearbyNoGeo"));
          return;
        }
        const pos = await new Promise((resolvePos, rejectPos) => {
          navigator.geolocation.getCurrentPosition(resolvePos, rejectPos, {
            enableHighAccuracy: true,
            timeout: 12_000,
            maximumAge: 60_000,
          });
        });
        const rows = await fetchStationsNearby(pos.coords.latitude, pos.coords.longitude, 10);
        if (!rows || !rows.length) {
          renderSuggestionStatus(t("nearbyNone"));
          return;
        }
        renderSuggestionRows(rows);
      } catch (err) {
        if (err && Number(err.code) === 1) {
          renderSuggestionStatus(t("nearbyDenied"));
        } else {
          renderSuggestionStatus(t("nearbyError"));
        }
      } finally {
        nearbyBtn.disabled = false;
      }
    }

    function trapFocus(event) {
      if (!modal || event.key !== "Tab") return;
      const focusables = focusableIn(modal);
      if (!focusables.length) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = !!active && modal.contains(active);

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

    function onDocumentMouseDown(event) {
      if (!modal || modal.contains(event.target)) return;
      if (backdrop && backdrop.contains(event.target)) {
        cancelSelection();
      }
    }

    function onDocumentKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelSelection();
        return;
      }
      trapFocus(event);
    }

    input?.addEventListener("input", () => {
      const nextValue = String(input.value || "").trim();
      if (!nextValue) {
        selectedStop = null;
        hideSuggestions();
        setError("");
        return;
      }
      if (
        selectedStop &&
        selectedStop.name &&
        selectedStop.name.toLowerCase() !== nextValue.toLowerCase()
      ) {
        selectedStop = null;
      }
      setError("");
      scheduleSearch(nextValue);
    });

    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirmSelection();
      }
    });

    confirmBtn?.addEventListener("click", () => {
      confirmSelection();
    });
    cancelBtn?.addEventListener("click", cancelSelection);
    backdrop?.addEventListener("click", cancelSelection);
    nearbyBtn?.addEventListener("click", runNearbySearch);

    document.addEventListener("keydown", onDocumentKeydown, true);
    document.addEventListener("mousedown", onDocumentMouseDown, true);

    if (initial?.name && input) {
      input.value = initial.name;
    }
    requestAnimationFrame(() => {
      if (!input) return;
      input.focus({ preventScroll: true });
      input.select();
    });
  });
}
