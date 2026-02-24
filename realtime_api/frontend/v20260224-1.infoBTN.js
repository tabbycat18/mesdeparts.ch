// infoBTN.js
// --------------------------------------------------------
// Small help overlay that explains how the board works
// --------------------------------------------------------

import { appState } from "./v20260224-1.state.js";
import { t } from "./v20260224-1.i18n.js";

const INFO_TAB_STORAGE_KEY = "infoOverlayLastTab";
const TAB_KEYS = ["help", "realtime", "credits"];
const INFO_BODY_LOCK_CLASS = "info-modal-open";
const INFO_PREV_PADDING_DATA_KEY = "infoPrevPaddingRight";
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

function lockPageScroll() {
  const body = document.body;
  if (!body || body.classList.contains(INFO_BODY_LOCK_CLASS)) return;

  const prevPadding = body.style.paddingRight || "";
  body.dataset[INFO_PREV_PADDING_DATA_KEY] = prevPadding;

  let scrollbarCompensation = 0;
  try {
    const viewportWidth = window?.innerWidth || 0;
    const layoutWidth = document?.documentElement?.clientWidth || viewportWidth;
    scrollbarCompensation = Math.max(0, viewportWidth - layoutWidth);
  } catch (_) {
    scrollbarCompensation = 0;
  }

  body.classList.add(INFO_BODY_LOCK_CLASS);
  if (scrollbarCompensation > 0) {
    body.style.paddingRight = `${scrollbarCompensation}px`;
  }
}

function unlockPageScroll() {
  const body = document.body;
  if (!body) return;
  body.classList.remove(INFO_BODY_LOCK_CLASS);
  body.style.paddingRight = body.dataset[INFO_PREV_PADDING_DATA_KEY] || "";
  delete body.dataset[INFO_PREV_PADDING_DATA_KEY];
}

function buildInfoCard(section) {
  const card = createEl("section", "info-card");
  const title = createEl("h4", "info-card-title", t(section.titleKey));
  card.appendChild(title);

  const list = createEl("ul", "info-lines");
  section.itemKeys.forEach((key) => list.appendChild(createListItem(t(key))));
  card.appendChild(list);
  return card;
}

function getTabSections() {
  return {
    help: [
      {
        titleKey: "infoHelpSectionQuickStartTitle",
        itemKeys: ["infoHelpQuickStartItem1", "infoHelpQuickStartItem2"],
      },
      {
        titleKey: "infoHelpSectionReadingTitle",
        itemKeys: ["infoHelpReadingItem1", "infoHelpReadingItem2"],
      },
      {
        titleKey: "infoHelpSectionFiltersTitle",
        itemKeys: ["infoHelpFiltersItem1", "infoHelpFiltersItem2"],
      },
      {
        titleKey: "infoHelpSectionPersonalizationTitle",
        itemKeys: ["infoHelpPersonalizationItem1", "infoHelpPersonalizationItem2"],
      },
    ],
    realtime: [
      {
        titleKey: "infoRealtimeSectionMinDepartureTitle",
        itemKeys: ["infoRealtimeMinDepartureItem1", "infoRealtimeMinDepartureItem2"],
      },
      {
        titleKey: "infoRealtimeSectionOfficialTitle",
        itemKeys: ["infoRealtimeOfficialItem1", "infoRealtimeOfficialItem2"],
      },
      {
        titleKey: "infoRealtimeSectionThresholdsTitle",
        itemKeys: [
          "infoRealtimeThresholdItem1",
          "infoRealtimeThresholdItem2",
          "infoRealtimeThresholdItem3",
        ],
      },
      {
        titleKey: "infoRealtimeSectionDisruptionsTitle",
        itemKeys: ["infoRealtimeDisruptionsItem1", "infoRealtimeDisruptionsItem2"],
      },
      {
        titleKey: "infoRealtimeSectionCheckTitle",
        itemKeys: ["infoRealtimeCheckItem1", "infoRealtimeCheckItem2"],
      },
    ],
    credits: [
      {
        titleKey: "infoCreditsSectionSourcesTitle",
        itemKeys: ["infoCreditsSourcesItem1", "infoCreditsSourcesItem2"],
      },
      {
        titleKey: "infoCreditsSectionClockTitle",
        itemKeys: ["infoCreditsClockItem1", "infoCreditsClockItem2"],
      },
      {
        titleKey: "infoCreditsSectionLicenseTitle",
        itemKeys: ["infoCreditsLicenseItem1", "infoCreditsLicenseItem2"],
      },
      {
        titleKey: "infoCreditsSectionIndependenceTitle",
        itemKeys: ["infoCreditsIndependenceItem1"],
      },
    ],
  };
}

function buildTabPanel(tabId, sections) {
  const panel = createEl("section", `info-tab-panel info-tab-panel--${tabId}`);
  sections.forEach((section) => panel.appendChild(buildInfoCard(section)));

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
  const overlay = createEl("div", "info-overlay ui-modal-overlay");
  overlay.id = "info-overlay";

  const panel = createEl("div", "info-panel ui-modal-shell");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "info-panel-title");
  panel.setAttribute("aria-describedby", "info-panel-desc");

  const header = createEl("div", "info-panel-header ui-modal-header");
  const titleRow = createEl("div", "info-panel-title-row ui-modal-headerMain");
  const desc = createEl("p", "sr-only", t("infoModalDescription"));
  desc.id = "info-panel-desc";

  const title = createEl("h2", "info-panel-title ui-modal-title", t("infoTitle"));
  title.id = "info-panel-title";

  const close = createEl("button", "info-panel-close ui-modal-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("infoClose"));

  titleRow.appendChild(title);
  titleRow.appendChild(close);

  const tabs = createEl("div", "info-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("infoTabsLabel"));

  const tabSections = getTabSections();
  const tabButtons = {};
  const tabPanels = {
    help: buildTabPanel("help", tabSections.help),
    realtime: buildTabPanel("realtime", tabSections.realtime),
    credits: buildTabPanel("credits", tabSections.credits),
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
  header.appendChild(desc);
  header.appendChild(tabs);

  const body = createEl("div", "info-panel-body ui-modal-body");
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
    body.scrollTop = 0;

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
    lockPageScroll();
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
    unlockPageScroll();
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
    isVisible: () => overlay.classList.contains("is-visible"),
    updateTitle: (stationName) => {
      const name = stationName || "Station";
      title.textContent = `${t("infoTitle")} – ${name}`;
    },
  };

  return overlay;
}

export function setupInfoButton() {
  // Find all info badges (normal board, dual board inline, dual board floating)
  const infoBadges = [
    document.getElementById("info-badge"),
    document.getElementById("info-badge-dual"),
    document.getElementById("info-badge-float"),
  ].filter(Boolean); // Remove nulls

  if (!infoBadges.length) return;

  let overlay = document.getElementById("info-overlay");

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = buildInfoOverlay();
    document.body.appendChild(overlay);
    return overlay;
  }

  function showInfoPanel() {
    const overlayEl = ensureOverlay();
    const station = appState.STATION || "Station";
    overlayEl.__infoControls.updateTitle(station);
    overlayEl.__infoControls.show();
  }

  // Attach click listener to all badges
  infoBadges.forEach((badge) => {
    badge.addEventListener("click", showInfoPanel);
  });
}
