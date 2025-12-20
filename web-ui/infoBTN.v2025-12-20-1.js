// infoBTN.js
// --------------------------------------------------------
// Small help overlay that explains how the board works
// --------------------------------------------------------

import { appState } from "./state.v2025-12-20-1.js";
import { t } from "./i18n.v2025-12-20-1.js";

const INFO_TAB_STORAGE_KEY = "infoOverlayLastTab";
const TAB_KEYS = ["help", "realtime", "credits"];
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function createListItem(text) {
  const li = document.createElement("li");
  if (typeof text === "string" && text.includes("\n")) {
    const parts = text.split("\n");
    parts.forEach((part, idx) => {
      li.append(part);
      if (idx < parts.length - 1) li.appendChild(document.createElement("br"));
    });
  } else {
    li.textContent = text;
  }
  return li;
}

function createListItemWithBoldLabel(text) {
  if (typeof text !== "string") return createListItem(text);

  const li = document.createElement("li");
  const idx = text.indexOf(":");
  if (idx > 0 && idx < text.length - 1) {
    const label = text.slice(0, idx).trim();
    const rest = text.slice(idx + 1).trim();

    const strong = document.createElement("strong");
    strong.textContent = label;
    li.appendChild(strong);

    if (rest) {
      li.appendChild(document.createTextNode(" : "));
      const parts = rest.split("\n");
      parts.forEach((part, i) => {
        li.appendChild(document.createTextNode(part));
        if (i < parts.length - 1) li.appendChild(document.createElement("br"));
      });
    }
    return li;
  }

  return createListItem(text);
}

function buildHelpPanel() {
  const panel = createEl("div", "info-tab-panel info-tab-panel--help");

  const card = createEl("div", "info-card");
  const title = createEl("h4", "info-card-title", t("infoTabHelp"));
  card.appendChild(title);

  const list = createEl("ul", "info-list");

  [
    t("infoHelpItemSearch"),
    t("infoHelpItemViews"),
    t("infoHelpItemFilters"),
    t("infoHelpItemRead"),
    t("infoHelpItemData"),
  ].forEach((txt) => list.appendChild(createListItemWithBoldLabel(txt)));

  card.appendChild(list);
  panel.appendChild(card);

  return panel;
}

function buildRealtimePanel() {
  const panel = createEl("div", "info-tab-panel info-tab-panel--realtime");

  const sections = [
    {
      title: t("infoRealtimeMinVsDepartureTitle"),
      lines: [
        t("infoRealtimeDeparture"),
        t("infoRealtimeCountdown"),
        t("delaysRuleCountdown"),
      ],
    },
    {
      title: t("infoRealtimeThresholdsTitle"),
      lines: [
        t("infoRealtimeThresholdsBus"),
        t("infoRealtimeThresholdsTrain"),
        t("infoRealtimeThresholdsNote"),
      ],
    },
    {
      title: t("infoRealtimeColorsTitle"),
      lines: [t("infoRealtimeColorsInline")],
    },
    {
      title: t("infoRealtimeCancelTitle"),
      lines: [t("delaysRuleCancelled")],
    },
  ];

  sections.forEach((entry) => {
    const section = createEl("div", "info-card");
    const title = createEl("h4", "info-card-title", entry.title);
    section.appendChild(title);

    if (entry.lines && entry.lines.length) {
      const ul = createEl("ul", "info-lines");
      entry.lines.forEach((txt) => ul.appendChild(createListItem(txt)));
      section.appendChild(ul);
    }

    panel.appendChild(section);
  });

  return panel;
}

function buildCreditsPanel() {
  const panel = createEl("div", "info-tab-panel info-tab-panel--credits");

  const card = createEl("div", "info-card info-card--credits");
  const list = createEl("ul", "info-sublist");
  [
    t("creditsData"),
    t("creditsClock"),
    t("creditsClockNote"),
    t("infoCreditsAffiliation"),
    t("lineColorsNotice"),
    t("creditsAuthor"),
  ].forEach((txt) => list.appendChild(createListItemWithBoldLabel(txt)));

  card.appendChild(list);
  panel.appendChild(card);

  return panel;
}

function getStoredTab() {
  try {
    const stored = localStorage.getItem(INFO_TAB_STORAGE_KEY);
    if (stored && TAB_KEYS.includes(stored)) return stored;
  } catch (_) {
    // ignore
  }
  return "help";
}

function saveTab(tabId) {
  try {
    localStorage.setItem(INFO_TAB_STORAGE_KEY, tabId);
  } catch (_) {
    // ignore
  }
}

function buildInfoOverlay() {
  const overlay = createEl("div", "info-overlay");
  overlay.id = "info-overlay";

  const panel = createEl("div", "info-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "info-panel-title");

  const header = createEl("div", "info-panel-header");
  const titleRow = createEl("div", "info-panel-title-row");

  const title = createEl("div", "info-panel-title", t("infoTitle"));
  title.id = "info-panel-title";

  const close = createEl("button", "info-panel-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("infoClose"));

  titleRow.appendChild(title);
  titleRow.appendChild(close);

  const tabs = createEl("div", "info-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("infoTabsLabel"));

  const tabButtons = {};
  const tabPanels = {
    help: buildHelpPanel(),
    realtime: buildRealtimePanel(),
    credits: buildCreditsPanel(),
  };

  Object.entries(tabPanels).forEach(([key, panelEl]) => {
    panelEl.id = `info-panel-${key}`;
    panelEl.setAttribute("role", "tabpanel");
    panelEl.setAttribute("aria-labelledby", `info-tab-${key}`);
  });

  const tabLabels = {
    help: t("infoTabHelp"),
    realtime: t("infoTabRealtime"),
    credits: t("infoTabCredits"),
  };

  TAB_KEYS.forEach((key) => {
    const btn = createEl("button", "info-tab", tabLabels[key]);
    btn.type = "button";
    btn.dataset.tab = key;
    btn.id = `info-tab-${key}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", `info-panel-${key}`);
    btn.setAttribute("aria-selected", "false");
    btn.tabIndex = -1;
    btn.addEventListener("click", () => setActiveTab(key));
    tabButtons[key] = btn;
    tabs.appendChild(btn);
  });

  header.appendChild(titleRow);
  header.appendChild(tabs);

  const body = createEl("div", "info-panel-body");
  Object.values(tabPanels).forEach((panelEl) => body.appendChild(panelEl));

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);

  let activeTab = getStoredTab();
  let lastFocusedElement = null;

  function setActiveTab(tabId, { focusTab = false, skipSave = false } = {}) {
    const nextTab = TAB_KEYS.includes(tabId) ? tabId : "help";
    activeTab = nextTab;
    Object.entries(tabButtons).forEach(([key, btn]) => {
      const isActive = key === nextTab;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.tabIndex = isActive ? 0 : -1;

      const panelEl = tabPanels[key];
      panelEl.classList.toggle("is-active", isActive);
      panelEl.setAttribute("aria-hidden", isActive ? "false" : "true");
      panelEl.toggleAttribute("hidden", !isActive);
    });

    if (!skipSave) saveTab(nextTab);
    if (focusTab && tabButtons[nextTab]) {
      tabButtons[nextTab].focus({ preventScroll: true });
    }
  }

  function cycleTabs(direction) {
    const currentIndex = TAB_KEYS.indexOf(activeTab);
    const nextIndex =
      (currentIndex + direction + TAB_KEYS.length) % TAB_KEYS.length;
    setActiveTab(TAB_KEYS[nextIndex], { focusTab: true });
  }

  function getFocusableElements() {
    return Array.from(overlay.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (el) =>
        !el.disabled &&
        el.getAttribute("aria-hidden") !== "true" &&
        el.offsetParent !== null,
    );
  }

  function handleFocusTrap(e) {
    if (e.key !== "Tab") return;
    const focusable = getFocusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === overlay) {
        last.focus();
        e.preventDefault();
      }
    } else if (document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }

  function show(initialTab) {
    overlay.classList.add("is-visible");
    lastFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveTab(initialTab || getStoredTab(), { skipSave: true });
    requestAnimationFrame(() => {
      const focusTarget = tabButtons[activeTab] || close || panel;
      focusTarget.focus({ preventScroll: true });
    });
  }

  function hide() {
    overlay.classList.remove("is-visible");
    if (lastFocusedElement) {
      try {
        lastFocusedElement.focus({ preventScroll: true });
      } catch (_) {
        // ignore
      }
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });

  close.addEventListener("click", hide);

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hide();
    } else if (e.key === "Tab") {
      handleFocusTrap(e);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cycleTabs(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      cycleTabs(-1);
    }
  });

  tabs.addEventListener("keydown", (e) => {
    if (e.key === "Home") {
      e.preventDefault();
      setActiveTab(TAB_KEYS[0], { focusTab: true });
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveTab(TAB_KEYS[TAB_KEYS.length - 1], { focusTab: true });
    }
  });

  setActiveTab(activeTab, { skipSave: true });

  overlay.__infoControls = {
    show,
    hide,
    setActiveTab,
    updateTitle: (stationName) => {
      const name = stationName || "Station";
      title.textContent = `${t("infoTitle")} – ${name}`;
    },
  };

  return overlay;
}

export function setupInfoButton() {
  const btn = document.getElementById("info-btn");
  if (!btn) return;

  let overlay = document.getElementById("info-overlay");

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = buildInfoOverlay();
    document.body.appendChild(overlay);
    return overlay;
  }

  btn.addEventListener("click", () => {
    const overlayEl = ensureOverlay();
    const station = appState.STATION || "Station";
    overlayEl.__infoControls.updateTitle(station);
    overlayEl.__infoControls.show();
  });
}
