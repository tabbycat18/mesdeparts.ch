// ui.js
// --------------------------------------------------------
// UI: clock, table render, filters, station search, view toggle
// --------------------------------------------------------

import {
  appState,
  VIEW_MODE_TIME,
  VIEW_MODE_LINE,
  TRAIN_FILTER_ALL,
  TRAIN_FILTER_REGIONAL,
  TRAIN_FILTER_LONG_DISTANCE,
  REMARK_NARROW_BREAKPOINT_PX,
} from "./v20260301.state.js";
import {
  fetchStationSuggestions,
  fetchStationsNearby,
  fetchJourneyDetails,
  isAbortError as isAbortErrorFromLogic,
  parseApiDate,
} from "./v20260301.logic.js";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  clearFavorites,
} from "./v20260301.favourites.js";
import { t } from "./v20260301.i18n.js";

const QUICK_CONTROLS_STORAGE_KEY = "mesdeparts.quickControlsCollapsed";
let quickControlsCollapsed = false;
let quickControlsInitialized = false;
const SERVICE_BANNER_PAGE_ROTATE_MS = 12000;
const SERVICE_BANNER_MAX_PAGES = 3;
let serviceBannerTimers = [];
const serviceBannerCycleAnchors = new Map();
let lastRenderedServiceBanners = [];
let departureAlertsLayer = null;
let departureAlertsPanel = null;
let departureAlertsTitle = null;
let departureAlertsList = null;
let departureAlertsCloseBtn = null;
let activeDepartureAlertsTrigger = null;
let activeDepartureAlertsDep = null;

const pad2 = (n) => String(n).padStart(2, "0");
const CH_TIMEZONE = "Europe/Zurich";
const CH_FORMATTER =
  typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: CH_TIMEZONE,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

function getSwissParts(date) {
  if (!CH_FORMATTER || typeof CH_FORMATTER.formatToParts !== "function") {
    return {
      year: String(date.getFullYear()),
      month: pad2(date.getMonth() + 1),
      day: pad2(date.getDate()),
      hour: pad2(date.getHours()),
      minute: pad2(date.getMinutes()),
      second: pad2(date.getSeconds()),
    };
  }

  const parts = CH_FORMATTER.formatToParts(date);
  const out = {
    year: "0000",
    month: "00",
    day: "00",
    hour: "00",
    minute: "00",
    second: "00",
  };

  for (const part of parts) {
    if (part.type in out) out[part.type] = part.value;
  }

  return out;
}

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

// ---------------- LAYOUT AUTO-FIT ----------------

const LAYOUT_TIGHT_CLASS = "layout-tight";
const OVERFLOW_TOLERANCE_PX = 2;
let ensureFitFrame = null;

function isOverflowing(element) {
  if (!element) return false;
  const viewportWidth =
    typeof window !== "undefined"
      ? Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0)
      : 0;
  const rect = element.getBoundingClientRect();
  const overflowInside = element.scrollWidth - element.clientWidth;
  const overflowViewport = viewportWidth ? rect.right - viewportWidth : 0;

  return overflowInside > OVERFLOW_TOLERANCE_PX || overflowViewport > OVERFLOW_TOLERANCE_PX;
}

export function ensureBoardFitsViewport() {
  if (ensureFitFrame) cancelAnimationFrame(ensureFitFrame);
  ensureFitFrame = requestAnimationFrame(() => {
    const body = document.body;
    const board = document.querySelector(".board");
    if (!body || !board) return;

    // Disable auto-zoom/scale; just ensure we are not in tight mode
    body.classList.remove(LAYOUT_TIGHT_CLASS);
    syncDestinationColumnWidth();
  });
}

export function setupAutoFitWatcher() {
  window.addEventListener(
    "resize",
    () => {
      ensureBoardFitsViewport();
    },
    { passive: true }
  );
}

// Determine whether to use the narrow (numeric-only "+X min") remark format.
// Matches the CSS phone breakpoint at REMARK_NARROW_BREAKPOINT_PX.
// Avoids flicker: uses viewport width as a stable, synchronous signal.
function isNarrowRemarkLayout() {
  if (typeof window === "undefined") return false;
  return window.innerWidth <= REMARK_NARROW_BREAKPOINT_PX;
}

// ---------------- FAVORITES (UI) ----------------

const FAV_CLEAR_VALUE = "__clear__";

function getFavSelectEl() {
  return document.getElementById("favorites-select");
}

function refreshFavToggleFromState() {}

function renderFavoritesSelect(selectedId) {
  const sel = getFavSelectEl();
  if (!sel) return;

  const favs = loadFavorites();

  sel.innerHTML = "";

  // Placeholder
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = t("filterFavoritesTitle");
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
  updateSaveCurrentBtn();
  setFavoritesStatus("");

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
    const parts = getSwissParts(now);
    el.textContent = `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function scheduleTick() {
    tick();
    const delay = 1000 - (Date.now() % 1000);
    setTimeout(scheduleTick, delay);
  }

  scheduleTick();
}

// ---------------- STATION TITLE ----------------

export function updateStationTitle() {
  const title = document.getElementById("station-title");
  if (title) title.textContent = appState.STATION || "Station";

  const input = document.getElementById("station-input");
  if (input && !input.value) input.value = appState.STATION || "";

  ensureBoardFitsViewport();
}

export function setBoardLoadingState(isLoading) {
  const hint = document.getElementById("loading-hint");
  if (!hint) return;

  if (isLoading) {
    hint.textContent = t("loadingDepartures");
    hint.classList.add("is-visible");
  } else {
    hint.textContent = "";
    hint.classList.remove("is-visible");
  }
}

function getServiceBannersHost() {
  let host = document.getElementById("service-banners");
  const scroller = document.querySelector(".departures-scroller");
  if (!scroller || !scroller.parentNode) return host || null;

  if (!host) {
    host = document.createElement("section");
    host.id = "service-banners";
    host.className = "service-banners";
    host.setAttribute("aria-live", "polite");
  }

  const hc2ServedLines = document.getElementById("hc2-served-lines");
  if (hc2ServedLines && hc2ServedLines.parentNode) {
    if (host.parentNode !== hc2ServedLines.parentNode || host.nextSibling !== hc2ServedLines) {
      hc2ServedLines.parentNode.insertBefore(host, hc2ServedLines);
    }
    return host;
  }

  const lineChips = document.getElementById("line-chips");
  if (lineChips && lineChips.parentNode) {
    if (host.parentNode !== lineChips.parentNode || host.nextSibling !== lineChips) {
      lineChips.parentNode.insertBefore(host, lineChips);
    }
    return host;
  }

  if (host.parentNode !== scroller.parentNode || host.nextSibling !== scroller) {
    scroller.parentNode.insertBefore(host, scroller);
  }
  return host;
}

function clearServiceBannerTimers() {
  for (const timer of serviceBannerTimers) {
    clearInterval(timer);
  }
  serviceBannerTimers = [];
}

function serviceBannerPageCharLimit() {
  const width = typeof window !== "undefined" ? Number(window.innerWidth || 0) : 0;
  if (width > 0 && width <= 520) return 120;
  if (width > 0 && width <= 920) return 165;
  if (width > 0 && width <= 1280) return 220;
  return 280;
}

function chunkBannerText(text, maxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const words = normalized.split(" ");
  const out = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    out.push(current);
    current = word;
  }
  if (current) out.push(current);
  return out;
}

function splitSentences(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [normalized];
}

function splitLongSegment(text, maxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];
  return chunkBannerText(normalized, maxChars);
}

function buildBannerPages(text, baseMaxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= baseMaxChars) return [normalized];

  const pageCount = Math.min(
    SERVICE_BANNER_MAX_PAGES,
    Math.max(1, Math.ceil(normalized.length / baseMaxChars))
  );
  const targetChars = Math.max(baseMaxChars, Math.ceil(normalized.length / pageCount));

  const sentenceChunks = [];
  for (const sentence of splitSentences(normalized)) {
    sentenceChunks.push(...splitLongSegment(sentence, targetChars));
  }

  const pages = [];
  let current = "";
  for (const segment of sentenceChunks) {
    if (pages.length === pageCount - 1) {
      current = current ? `${current} ${segment}` : segment;
      continue;
    }

    const candidate = current ? `${current} ${segment}` : segment;
    if (current && candidate.length > targetChars) {
      pages.push(current);
      current = segment;
    } else {
      current = candidate;
    }
  }
  if (current) pages.push(current);
  return pages.filter(Boolean);
}

function normalizeBannerPages(pages, targetChars = 0) {
  const out = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const text = String(page || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }

  if (out.length >= 3) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    const tinyTailThreshold = Math.max(34, Math.floor(targetChars * 0.26));
    const combinedThreshold = Math.max(160, Math.floor(targetChars * 1.3));
    const shouldMergeTail =
      last.length <= tinyTailThreshold ||
      prev.length + 1 + last.length <= combinedThreshold;
    if (shouldMergeTail) {
      out.splice(out.length - 2, 2, `${prev} ${last}`.replace(/\s+/g, " ").trim());
    }
  }

  if (out.length >= 3) {
    const normalizedText = out.join(" ").replace(/\s+/g, " ").trim();
    const twoPageTarget = Math.max(80, Math.ceil(normalizedText.length / 2));
    const twoPages = chunkBannerText(normalizedText, twoPageTarget)
      .map((p) => p.trim())
      .filter(Boolean);
    if (twoPages.length === 2) {
      return twoPages;
    }
  }

  return out;
}

function setBannerPage(textEl, pagerDots, pages, index) {
  const safeIndex = Math.max(0, Math.min(index, pages.length - 1));
  const pageText = String(pages[safeIndex] || "");
  if (/https?:\/\//i.test(pageText)) {
    textEl.innerHTML = "";
    appendAlertTextWithLinks(textEl, pageText, "service-banner__link");
  } else {
    textEl.textContent = pageText;
  }
  pagerDots.forEach((dot, i) => {
    dot.classList.toggle("is-active", i === safeIndex);
  });
}

function normalizeAlertSeverity(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "severe" || raw === "critical" || raw === "danger") return "severe";
  if (raw === "warning" || raw === "warn") return "warning";
  if (raw === "info" || raw === "information") return "info";
  return "unknown";
}

function normalizedText(value) {
  return String(value || "").trim();
}

function normalizedTextKey(value) {
  return normalizedText(value).toLowerCase();
}

function normalizedBannerTextKey(item) {
  const header = normalizedTextKey(item?.header || item?.headerText);
  const description = normalizedTextKey(item?.description || item?.descriptionText);
  if (!header && !description) return "";
  return `${header}|${description}`;
}

function normalizedAlertKey(alert) {
  const id = normalizedTextKey(alert?.id);
  const severity = normalizeAlertSeverity(alert?.severity);
  const header = normalizedTextKey(alert?.header || alert?.headerText);
  const description = normalizedTextKey(alert?.description || alert?.descriptionText);
  return `${id}|${severity}|${header}|${description}`;
}

export function normalizeDepartureAlerts(
  dep,
  banners = [],
  { suppressBannerDuplicates = false } = {}
) {
  const source = Array.isArray(dep?.alerts) ? dep.alerts : [];
  if (!source.length) return [];

  const bannerKeys = new Set(
    (Array.isArray(banners) ? banners : [])
      .map((banner) => normalizedBannerTextKey(banner))
      .filter(Boolean)
  );
  const seen = new Set();
  const out = [];

  for (const raw of source) {
    const normalized = {
      id: normalizedText(raw?.id),
      severity: normalizeAlertSeverity(raw?.severity),
      header: normalizedText(raw?.header || raw?.headerText),
      description: normalizedText(raw?.description || raw?.descriptionText),
    };
    if (!normalized.header && !normalized.description) continue;
    if (suppressBannerDuplicates) {
      const textKey = normalizedBannerTextKey(normalized);
      if (textKey && bannerKeys.has(textKey)) continue;
    }
    const key = normalizedAlertKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

export function resolveDepartureAlertsForLineBadge(dep, banners = []) {
  const uniqueOnly = normalizeDepartureAlerts(dep, banners, {
    suppressBannerDuplicates: true,
  });
  if (uniqueOnly.length > 0) return uniqueOnly;
  return normalizeDepartureAlerts(dep, banners, {
    suppressBannerDuplicates: false,
  });
}

function hasRenderableInlineAlert(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return false;
  return alerts.some((alert) => {
    const header = normalizedText(alert?.header || alert?.headerText);
    const description = normalizedText(alert?.description || alert?.descriptionText);
    return !!(header || description);
  });
}

export function resolveRenderableInlineAlertsForLineAlertButton(dep, banners = []) {
  const inlineOnly = resolveDepartureAlertsForLineBadge(dep, banners);
  return inlineOnly.filter((alert) => {
    const header = normalizedText(alert?.header || alert?.headerText);
    const description = normalizedText(alert?.description || alert?.descriptionText);
    return !!(header || description);
  });
}

export function hasPositiveDelayForAlertColumn(dep) {
  const status = String(dep?.status || "").toLowerCase();
  if (status === "delay") return true;
  const displayedDelay = Number(dep?.displayedDelayMin);
  if (Number.isFinite(displayedDelay) && displayedDelay > 0) return true;
  const delayMin = Number(dep?.delayMin);
  return Number.isFinite(delayMin) && delayMin > 0;
}

export function shouldShowBusLineAlertColumn(rows, banners = []) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let hasAnyDelayedBusDeparture = false;
  let hasRenderableAlertButton = false;
  for (const dep of rows) {
    if (!dep || dep.mode !== "bus") continue;
    if (!hasAnyDelayedBusDeparture && hasPositiveDelayForAlertColumn(dep)) {
      hasAnyDelayedBusDeparture = true;
    }
    if (!hasRenderableAlertButton) {
      const inlineAlerts = resolveRenderableInlineAlertsForLineAlertButton(dep, banners);
      if (hasRenderableInlineAlert(inlineAlerts)) {
        hasRenderableAlertButton = true;
      }
    }
    if (hasAnyDelayedBusDeparture && hasRenderableAlertButton) return true;
  }
  return false;
}

function closeDepartureAlertsPopover({ restoreFocus = false } = {}) {
  if (!departureAlertsLayer || !departureAlertsPanel) return;
  departureAlertsLayer.classList.remove("is-visible");
  departureAlertsPanel.style.removeProperty("top");
  departureAlertsPanel.style.removeProperty("left");
  departureAlertsPanel.style.removeProperty("right");
  departureAlertsPanel.style.removeProperty("max-width");
  departureAlertsPanel.style.removeProperty("max-height");
  if (restoreFocus && activeDepartureAlertsTrigger) {
    try {
      activeDepartureAlertsTrigger.focus();
    } catch {
      // ignore focus errors
    }
  }
  activeDepartureAlertsTrigger = null;
  activeDepartureAlertsDep = null;
}

function onDepartureAlertsViewportChange() {
  if (!departureAlertsLayer?.classList.contains("is-visible")) return;
  if (!activeDepartureAlertsDep || !activeDepartureAlertsTrigger) return;
  openDepartureAlertsPopover(activeDepartureAlertsDep, activeDepartureAlertsTrigger);
}

function ensureDepartureAlertsLayer() {
  if (departureAlertsLayer) return departureAlertsLayer;
  departureAlertsLayer = document.createElement("div");
  departureAlertsLayer.id = "departure-alerts-layer";
  departureAlertsLayer.className = "departure-alerts-layer";
  departureAlertsPanel = document.createElement("div");
  departureAlertsPanel.className = "departure-alerts-panel";
  departureAlertsPanel.setAttribute("role", "dialog");
  departureAlertsPanel.setAttribute("aria-modal", "false");

  const header = document.createElement("div");
  header.className = "departure-alerts-header";
  departureAlertsTitle = document.createElement("div");
  departureAlertsTitle.className = "departure-alerts-title";
  departureAlertsCloseBtn = document.createElement("button");
  departureAlertsCloseBtn.type = "button";
  departureAlertsCloseBtn.className = "departure-alerts-close";
  header.appendChild(departureAlertsTitle);
  header.appendChild(departureAlertsCloseBtn);

  departureAlertsList = document.createElement("div");
  departureAlertsList.className = "departure-alerts-list";
  departureAlertsPanel.appendChild(header);
  departureAlertsPanel.appendChild(departureAlertsList);
  departureAlertsLayer.appendChild(departureAlertsPanel);
  departureAlertsCloseBtn.textContent = "×";
  departureAlertsCloseBtn.setAttribute("aria-label", t("alertsClose"));
  departureAlertsCloseBtn.addEventListener("click", () => {
    closeDepartureAlertsPopover({ restoreFocus: true });
  });
  departureAlertsLayer.addEventListener("click", (event) => {
    if (event.target === departureAlertsLayer) {
      closeDepartureAlertsPopover({ restoreFocus: true });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && departureAlertsLayer.classList.contains("is-visible")) {
      event.preventDefault();
      closeDepartureAlertsPopover({ restoreFocus: true });
    }
  });
  window.addEventListener("resize", onDepartureAlertsViewportChange, { passive: true });
  window.addEventListener("scroll", onDepartureAlertsViewportChange, { passive: true });
  document.body.appendChild(departureAlertsLayer);
  return departureAlertsLayer;
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeAlertDescriptionText(value) {
  let text = String(value || "");
  if (!text) return "";
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href, label) => {
      const safeHref = String(href || "").trim();
      const safeLabel = stripHtmlTags(label);
      if (!safeHref) return safeLabel;
      if (!safeLabel) return safeHref;
      return `${safeLabel} (${safeHref})`;
    }
  );
  text = text.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi, " $1 ");
  text = text.replace(/<\/a>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  return text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function appendTextWithLineBreaks(container, value) {
  const text = String(value || "");
  if (!text) return;
  const lines = text.split(/\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (idx > 0) container.appendChild(document.createElement("br"));
    if (!lines[idx]) continue;
    if (typeof document.createTextNode === "function") {
      container.appendChild(document.createTextNode(lines[idx]));
    } else {
      const span = document.createElement("span");
      span.textContent = lines[idx];
      container.appendChild(span);
    }
  }
}

function appendAlertTextWithLinks(container, rawText, linkClassName = "departure-alerts-link") {
  if (!container) return;
  const text = normalizeAlertDescriptionText(rawText);
  if (!text) return;

  const urlRe = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0;
  let match = urlRe.exec(text);

  while (match) {
    const start = match.index;
    const rawUrl = match[0];
    if (start > cursor) {
      appendTextWithLineBreaks(container, text.slice(cursor, start));
    }

    let url = rawUrl;
    let trailing = "";
    while (/[),.;!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }

    if (url) {
      const link = document.createElement("a");
      link.className = linkClassName;
      link.href = url;
      link.textContent = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      container.appendChild(link);
    }
    if (trailing) appendTextWithLineBreaks(container, trailing);
    cursor = start + rawUrl.length;
    match = urlRe.exec(text);
  }

  if (cursor < text.length) {
    appendTextWithLineBreaks(container, text.slice(cursor));
  }
}

function renderDepartureAlertsList(alerts, container, { singleTitleInBanner = false } = {}) {
  if (!container) return;
  container.innerHTML = "";
  if (!Array.isArray(alerts) || alerts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "departure-alerts-empty";
    empty.textContent = t("alertsNone");
    container.appendChild(empty);
    return;
  }

  for (const alert of alerts) {
    const item = document.createElement("article");
    item.className = `departure-alerts-item departure-alerts-item--${alert.severity || "unknown"}`;
    const hideItemTitle = singleTitleInBanner && alerts.length === 1;
    if (alert.header && !hideItemTitle) {
      const title = document.createElement("h4");
      title.className = "departure-alerts-item-title";
      title.textContent = alert.header;
      item.appendChild(title);
    }
    const bodyText = hideItemTitle
      ? normalizedText(alert?.description || alert?.descriptionText || alert?.header || alert?.headerText)
      : normalizedText(alert?.description || alert?.descriptionText);
    if (bodyText) {
      const body = document.createElement("p");
      body.className = "departure-alerts-item-text";
      appendAlertTextWithLinks(body, bodyText);
      item.appendChild(body);
    }
    container.appendChild(item);
  }
}

export function openDepartureAlertsPopover(dep, anchorEl) {
  const alerts = resolveDepartureAlertsForLineBadge(dep, lastRenderedServiceBanners);
  if (!alerts.length || !anchorEl) {
    closeDepartureAlertsPopover({ restoreFocus: false });
    return;
  }

  const layer = ensureDepartureAlertsLayer();
  const panel = departureAlertsPanel;
  const lineLabel = normalizeLineId(dep) || dep?.line || dep?.number || "";
  const linePrefix = lineLabel
    ? `${t("columnLine")} ${lineLabel}`
    : t("columnLine");
  const singleAlertHeader =
    alerts.length === 1
      ? normalizedText(alerts[0]?.header || alerts[0]?.headerText)
      : "";
  const useSingleHeaderInBanner = alerts.length === 1 && !!singleAlertHeader;
  departureAlertsTitle.textContent = useSingleHeaderInBanner
    ? `${linePrefix} – ${singleAlertHeader}`
    : linePrefix;
  departureAlertsCloseBtn.setAttribute("aria-label", t("alertsClose"));
  renderDepartureAlertsList(alerts, departureAlertsList, {
    singleTitleInBanner: useSingleHeaderInBanner,
  });

  layer.classList.add("is-visible");
  activeDepartureAlertsTrigger = anchorEl;
  activeDepartureAlertsDep = dep;

  const rect = anchorEl.getBoundingClientRect();
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0);
  const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
  const panelWidth = Math.min(420, Math.max(260, viewportWidth - 20));
  panel.style.maxWidth = `${panelWidth}px`;
  panel.style.left = "10px";
  panel.style.top = `${Math.max(10, rect.bottom + 10)}px`;
  panel.style.right = "auto";
  panel.style.maxHeight = `${Math.max(180, viewportHeight - 24)}px`;

  const panelRect = panel.getBoundingClientRect();
  const anchorCenterX = rect.left + rect.width / 2;
  const desiredLeft = Math.min(
    Math.max(10, anchorCenterX - panelRect.width / 2),
    Math.max(10, viewportWidth - panelRect.width - 10)
  );
  let desiredTop = rect.bottom + 10;
  if (desiredTop + panelRect.height > viewportHeight - 10) {
    desiredTop = Math.max(10, rect.top - panelRect.height - 10);
  }
  panel.style.left = `${Math.max(10, desiredLeft)}px`;
  panel.style.top = `${Math.max(10, desiredTop)}px`;
}

export function renderServiceBanners(banners) {
  clearServiceBannerTimers();
  const host = getServiceBannersHost();
  if (!host) return;
  host.innerHTML = "";
  const activeBannerKeys = new Set();

  const list = Array.isArray(banners) ? banners : [];
  lastRenderedServiceBanners = list
    .map((item) => ({
      severity: normalizeAlertSeverity(item?.severity),
      header: normalizedText(item?.header),
      description: normalizedText(item?.description),
    }))
    .filter((item) => item.header || item.description);
  if (list.length === 0) {
    host.classList.remove("is-visible");
    return;
  }

  const seen = new Set();
  for (const banner of list) {
    const header = String(banner?.header || "").trim();
    const description = String(banner?.description || "").trim();
    const severity = String(banner?.severity || "unknown").trim().toLowerCase();
    const key = `${severity}|${header}|${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    activeBannerKeys.add(key);

    const item = document.createElement("article");
    item.className = `service-banner service-banner--${severity}`;

    const icon = document.createElement("span");
    icon.className = "service-banner__icon";
    icon.innerHTML = `
      <svg class="service-banner__iconSvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M13.9 2.8L5.8 13h4.6l-1.5 8.2L18.2 10h-4.4l.1-7.2z" fill="currentColor"></path>
      </svg>
    `;
    icon.setAttribute("aria-hidden", "true");
    item.appendChild(icon);

    const body = document.createElement("div");
    body.className = "service-banner__body";

    let titleEl = null;
    if (header) {
      titleEl = document.createElement("h3");
      titleEl.className = "service-banner__title";
      titleEl.textContent = header;
      body.appendChild(titleEl);
    } else {
      item.classList.add("service-banner--text-only");
    }

    const textEl = document.createElement("p");
    textEl.className = "service-banner__text";
    body.appendChild(textEl);

    const pager = document.createElement("div");
    pager.className = "service-banner__pager";
    pager.setAttribute("aria-hidden", "true");
    body.appendChild(pager);

    if (!header && !description) continue;
    const pageLimit = titleEl
      ? Math.max(100, Math.floor(serviceBannerPageCharLimit() * 0.95))
      : serviceBannerPageCharLimit();
    const normalizedDescription = normalizeAlertDescriptionText(description);
    const pages = normalizeBannerPages(
      buildBannerPages(normalizedDescription, pageLimit),
      pageLimit
    );
    if (pages.length === 0 && normalizedDescription) pages.push(normalizedDescription.trim());
    if (pages.length === 0) pages.push("");
    const hasTextPages = pages.some((p) => String(p || "").trim() !== "");

    const dots = [];
    if (pages.length > 1 && hasTextPages) {
      for (let i = 0; i < pages.length; i += 1) {
        const dot = document.createElement("span");
        dot.className = "service-banner__dot";
        pager.appendChild(dot);
        dots.push(dot);
      }
    } else {
      pager.style.display = "none";
    }

    let pageIndex = 0;
    if (hasTextPages) {
      let anchorMs = serviceBannerCycleAnchors.get(key);
      if (!Number.isFinite(anchorMs)) {
        anchorMs = Date.now();
        serviceBannerCycleAnchors.set(key, anchorMs);
      }
      if (pages.length > 1) {
        pageIndex =
          Math.floor((Date.now() - anchorMs) / SERVICE_BANNER_PAGE_ROTATE_MS) %
          pages.length;
      }
      setBannerPage(textEl, dots, pages, pageIndex);
    } else {
      textEl.style.display = "none";
    }
    if (pages.length > 1 && hasTextPages) {
      const anchorMs = serviceBannerCycleAnchors.get(key) || Date.now();
      let lastIndex = pageIndex;
      const timer = setInterval(() => {
        const nextIndex =
          Math.floor((Date.now() - anchorMs) / SERVICE_BANNER_PAGE_ROTATE_MS) %
          pages.length;
        if (nextIndex === lastIndex) return;
        lastIndex = nextIndex;
        setBannerPage(textEl, dots, pages, nextIndex);
      }, 500);
      serviceBannerTimers.push(timer);
    }

    item.appendChild(body);
    host.appendChild(item);
  }

  host.classList.toggle("is-visible", host.childElementCount > 0);

  // Prevent unbounded growth when station/language changes alter banner keys.
  for (const key of serviceBannerCycleAnchors.keys()) {
    if (!activeBannerKeys.has(key)) {
      serviceBannerCycleAnchors.delete(key);
    }
  }
}

// ---------------- QUICK CONTROLS COLLAPSE ----------------

function getQuickControlsEls() {
  return {
    toggle: document.getElementById("quick-controls-toggle"),
    label: document.getElementById("quick-controls-toggle-label"),
    panel: document.getElementById("station-card-collapsible"),
  };
}

function applyStationCollapse(panel, collapsed, immediate = false) {
  if (!panel) return;
  const card = panel.closest(".station-card");
  const setCardState = () => {
    if (card) card.classList.toggle("station-card--collapsed", collapsed);
  };

  const finalize = () => {
    if (quickControlsCollapsed !== collapsed) {
      panel.removeEventListener("transitionend", finalize);
      return;
    }
    panel.style.height = "";
    panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
    panel.removeEventListener("transitionend", finalize);
    setCardState();
  };

  if (immediate) {
    panel.classList.toggle("is-collapsed", collapsed);
    panel.style.height = collapsed ? "0px" : "";
    panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
    setCardState();
    return;
  }

  setCardState();

  if (collapsed) {
    const start = panel.scrollHeight;
    panel.style.height = `${start}px`;
    panel.classList.add("is-collapsed");
    // force reflow before collapsing
    void panel.offsetHeight;
    panel.style.height = "0px";
  } else {
    panel.style.height = "0px";
    panel.classList.remove("is-collapsed");
    const target = panel.scrollHeight || 0;
    void panel.offsetHeight;
    panel.style.height = `${target}px`;
  }

  panel.addEventListener("transitionend", finalize);
}

function renderQuickControlsCollapsedState() {
  const { toggle, label, panel } = getQuickControlsEls();
  if (panel) {
    applyStationCollapse(panel, quickControlsCollapsed, !quickControlsInitialized);
    quickControlsInitialized = true;
  }
  if (label) {
    label.textContent = t(quickControlsCollapsed ? "quickControlsShow" : "quickControlsHide");
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", quickControlsCollapsed ? "false" : "true");
    toggle.classList.toggle("is-collapsed", quickControlsCollapsed);
    if (label) toggle.setAttribute("aria-label", label.textContent);
  }

  const card = panel ? panel.closest(".station-card") : null;
  if (card) card.classList.toggle("station-card--collapsed", quickControlsCollapsed);
}

function setQuickControlsCollapsed(nextState) {
  quickControlsCollapsed = !!nextState;
  renderQuickControlsCollapsedState();
  try {
    localStorage.setItem(QUICK_CONTROLS_STORAGE_KEY, quickControlsCollapsed ? "1" : "0");
  } catch {
    // ignore storage errors
  }
  ensureBoardFitsViewport();
}

export function setupQuickControlsCollapse() {
  // Legacy header controls path disabled: replaced by ui/headerControls2.js
  return;

  const { toggle, panel } = getQuickControlsEls();
  if (!toggle || !panel) return;

  let storedCollapsed = null;
  try {
    storedCollapsed = localStorage.getItem(QUICK_CONTROLS_STORAGE_KEY);
  } catch {
    storedCollapsed = null;
  }

  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0);
  if (viewportWidth <= 520) {
    // Force compact startup on mobile to keep controls from taking vertical space.
    quickControlsCollapsed = true;
  } else if (storedCollapsed === "1" || storedCollapsed === "0") {
    quickControlsCollapsed = storedCollapsed === "1";
  } else {
    quickControlsCollapsed = false;
  }

  renderQuickControlsCollapsedState();

  toggle.addEventListener("click", () => {
    setQuickControlsCollapsed(!quickControlsCollapsed);
  });
}

// ---------------- VIEW MODE BUTTON ----------------

function viewModeLabel(mode) {
  if (mode === VIEW_MODE_TIME) return t("viewOptionTime");
  if (mode === VIEW_MODE_LINE) return t("viewOptionLine");
  return t("viewLabelFallback");
}

function trainFilterLabel(filter) {
  if (filter === TRAIN_FILTER_REGIONAL) return t("trainFilterRegional");
  if (filter === TRAIN_FILTER_LONG_DISTANCE) return t("trainFilterLongDistance");
  return t("trainFilterAll");
}

export function setupViewToggle(onChange) {
  // Legacy header controls path disabled: replaced by ui/headerControls2.js
  return;

  const segment = document.getElementById("view-segment");
  const sel = document.getElementById("view-select");
  const legacyBtn = document.getElementById("filter-toggle");

  const trainOptions = [
    { v: TRAIN_FILTER_ALL, t: () => t("trainFilterAll") },
    { v: TRAIN_FILTER_REGIONAL, t: () => t("trainFilterRegional") },
    { v: TRAIN_FILTER_LONG_DISTANCE, t: () => t("trainFilterLongDistance") },
  ];

  const busOptions = [
    { v: VIEW_MODE_LINE, t: () => t("viewOptionLine") },
    { v: VIEW_MODE_TIME, t: () => t("viewOptionTime") },
  ];

  function setTrainFilter(next) {
    const allowed = [TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE];
    if (!allowed.includes(next)) return;
    if (appState.trainServiceFilter === next) return;
    appState.trainServiceFilter = next;
    renderControls();
    if (typeof onChange === "function") onChange();
  }

  function setView(mode) {
    if (mode !== VIEW_MODE_TIME && mode !== VIEW_MODE_LINE) return;
    if (appState.viewMode === mode) return;
    appState.viewMode = mode;
    renderControls();
    updateFiltersVisibility();
    if (typeof onChange === "function") onChange();
  }

  function renderSegment(options, activeValue, isTrainBoard) {
    if (!segment) return;
    segment.innerHTML = "";
    options.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "segmented-btn";
      b.dataset.option = o.v;
      const isActive = o.v === activeValue;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-pressed", isActive ? "true" : "false");
      b.textContent = o.t();
      b.addEventListener("click", () => {
        if (isTrainBoard) setTrainFilter(o.v);
        else setView(o.v);
      });
      segment.appendChild(b);
    });
  }

  function renderSelect(options, activeValue, isTrainBoard) {
    if (!sel) return;
    sel.innerHTML = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.t();
      sel.appendChild(opt);
    }
    sel.value = activeValue;
    sel.dataset.viewType = isTrainBoard ? "train" : "bus";
  }

  function renderLegacy(options, activeValue, isTrainBoard) {
    if (!legacyBtn) return;
    const labelEl = legacyBtn.querySelector(".filter-label");
    const activeLabel = isTrainBoard ? trainFilterLabel(activeValue) : viewModeLabel(activeValue);
    if (labelEl) labelEl.textContent = activeLabel;
    else legacyBtn.textContent = activeLabel;
    legacyBtn.classList.remove("is-hidden");
  }

  function renderControls() {
    const isTrainBoard = !!appState.lastBoardIsTrain;
    const options = isTrainBoard ? trainOptions : busOptions;
    const active = isTrainBoard
      ? appState.trainServiceFilter || TRAIN_FILTER_ALL
      : appState.viewMode || VIEW_MODE_TIME;

    renderSegment(options, active, isTrainBoard);
    renderSelect(options, active, isTrainBoard);
    renderLegacy(options, active, isTrainBoard);
  }

  if (!appState.viewMode) appState.viewMode = VIEW_MODE_TIME;
  if (!appState.trainServiceFilter) appState.trainServiceFilter = TRAIN_FILTER_ALL;

  if (sel) {
    appState.viewSelect = sel;
    sel.addEventListener("change", () => {
      const isTrainBoard = sel.dataset.viewType === "train" || appState.lastBoardIsTrain;
      const val = sel.value;
      if (isTrainBoard) setTrainFilter(val);
      else setView(val);
    });

    appState._ensureViewSelectOptions = () => {
      renderControls();
    };
  }

  if (legacyBtn) {
    appState.viewButton = legacyBtn;
    legacyBtn.addEventListener("click", () => {
      const isTrainBoard = !!appState.lastBoardIsTrain;
      if (isTrainBoard) {
        const order = [TRAIN_FILTER_ALL, TRAIN_FILTER_REGIONAL, TRAIN_FILTER_LONG_DISTANCE];
        const idx = order.indexOf(appState.trainServiceFilter || TRAIN_FILTER_ALL);
        const next = order[(idx + 1) % order.length];
        setTrainFilter(next);
      } else {
        const next = appState.viewMode === VIEW_MODE_TIME ? VIEW_MODE_LINE : VIEW_MODE_TIME;
        setView(next);
      }
    });
  }

  renderControls();
  appState._renderViewControls = renderControls;
  updateFiltersVisibility();
}

// ---------------- FILTERS (platform + line) ----------------

const filterUi = {
  openBtn: null,
  label: null,
  count: null,
  quickReset: null,
  sheet: null,
  resetBtn: null,
  applyBtn: null,
  platformChips: null,
  lineChips: null,
  favoritesChips: null,
  favoritesEmpty: null,
  favoritesStatus: null,
  platformEmpty: null,
  lineEmpty: null,
  favoritesSwitch: null,
  manageFavorites: null,
  favPopover: null,
  favBackdrop: null,
  favQuickToggle: null,
  platformSelect: null,
  lineSelect: null,
  hideDepartureToggle: null,
};

const filterPending = {
  platforms: [],
  lines: [],
  hideDeparture: false,
};

const selectedFavorites = new Set();
let favoritesManageMode = false;

let filterSheetOpen = false;
let filtersOnChange = null;
const favoritesState = { isOpen: false, opener: null, currentStop: null };
const APP_ROOT_SELECTOR = ".board";

function updateFavoritesDeleteState() {
  if (!filterUi.favoritesDelete) return;
  const canDelete = favoritesManageMode && selectedFavorites.size > 0;
  filterUi.favoritesDelete.disabled = !canDelete;
}

function getCurrentStop() {
  return {
    id: appState.stationId,
    name: appState.STATION,
  };
}

function setFavoritesStatus(message) {
  if (!filterUi.favoritesStatus) {
    filterUi.favoritesStatus = document.getElementById("favorites-status");
  }
  const el = filterUi.favoritesStatus;
  if (!el) return;
  const text = message || "";
  el.textContent = text;
  el.classList.toggle("is-hidden", !text);
}

function updateSaveCurrentBtn() {
  const btn = filterUi.favoritesSaveCurrent;
  if (!btn) return;
  const lang = (appState.lang || "fr").toLowerCase();
  const labels = {
    fr: "Sauver cet arrêt",
    en: "Save this stop",
    de: "Diesen Halt speichern",
    it: "Salva questa fermata",
  };
  const label = labels[lang] || labels.en;
  const { id, name } = getCurrentStop();
  const already = id && isFavorite(id);
  btn.textContent = already ? `${label} ✓` : label;
  btn.disabled = !id || !name || already;
}

function saveCurrentStopToFavorites() {
  favoritesState.currentStop = getCurrentStop();
  const { id, name } = favoritesState.currentStop;
  const lang = (appState.lang || "fr").toLowerCase();
  const messages = {
    missing: {
      fr: "Sélectionne un arrêt avant d'ajouter aux favoris.",
      de: "Bitte wähle eine Haltestelle, bevor du sie zu den Favoriten hinzufügst.",
      it: "Seleziona una fermata prima di aggiungerla ai preferiti.",
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
  const pick = (key) => messages[key]?.[lang] || messages[key]?.en || "";

  if (!id || !name) {
    setFavoritesStatus(pick("missing"));
    updateSaveCurrentBtn();
    return;
  }

  if (isFavorite(id)) {
    setFavoritesStatus(pick("exists"));
    updateSaveCurrentBtn();
    return;
  }

  addFavorite({ id, name });
  renderFavoritesSelect(appState.stationId);
  refreshFavToggleFromState();
  if (typeof appState._renderFavoritesPopover === "function") {
    appState._renderFavoritesPopover();
  }
  updateSaveCurrentBtn();
  setFavoritesStatus(pick("saved"));
}

function updateFavoritesManageUi() {
  if (filterUi.manageFavorites) {
    filterUi.manageFavorites.textContent = favoritesManageMode
      ? t("favoritesManageDone")
      : t("filterManageFavorites");
    filterUi.manageFavorites.classList.toggle("is-active", favoritesManageMode);
  }
  if (filterUi.favPopover) {
    filterUi.favPopover.classList.toggle("favorites-manage-mode", favoritesManageMode);
  }
  if (filterUi.favoritesChips) {
    filterUi.favoritesChips.classList.toggle("favorites-manage-mode", favoritesManageMode);
  }
  updateFavoritesDeleteState();
}

function setFavoritesManageMode(on) {
  favoritesManageMode = !!on;
  if (!favoritesManageMode) {
    selectedFavorites.clear();
  }
  updateFavoritesManageUi();
  if (typeof appState._renderFavoritesPopover === "function") {
    appState._renderFavoritesPopover();
  }
}

function setAppInert(on) {
  const root = document.querySelector(APP_ROOT_SELECTOR);
  if (!root) return;
  if (on) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

function openFavorites(openerEl) {
  if (!filterUi.favPopover || favoritesState.isOpen) return;

  favoritesState.currentStop = getCurrentStop();
  favoritesState.opener =
    openerEl ||
    (document.activeElement && typeof document.activeElement.focus === "function"
      ? document.activeElement
      : filterUi.favQuickToggle);

  favoritesState.isOpen = true;
  setFavoritesManageMode(false);
  setFavoritesStatus("");

  filterUi.favPopover.classList.remove("is-hidden");
  filterUi.favPopover.hidden = false;
  filterUi.favPopover.style.left = "";
  filterUi.favPopover.style.right = "";
  filterUi.favPopover.style.bottom = "";
  filterUi.favPopover.style.top = "";
  filterUi.favPopover.style.position = "fixed";
  filterUi.favPopover.style.transform = "";
  updateFavoritesToggleUi();

  if (filterUi.favBackdrop) {
    filterUi.favBackdrop.classList.remove("is-hidden");
    filterUi.favBackdrop.classList.add("is-visible");
    filterUi.favBackdrop.hidden = false;
  }
  setAppInert(true);

  const focusTarget =
    filterUi.favPopover.querySelector("[data-fav-popover-close='true']") ||
    filterUi.favPopover.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (focusTarget && typeof focusTarget.focus === "function") {
    focusTarget.focus({ preventScroll: true });
  }
}

function closeFavorites() {
  if (!filterUi.favPopover || !favoritesState.isOpen) return;

  const restoreTarget =
    (favoritesState.opener && typeof favoritesState.opener.focus === "function" && favoritesState.opener) ||
    (filterUi.favQuickToggle && typeof filterUi.favQuickToggle.focus === "function" && filterUi.favQuickToggle) ||
    null;
  if (restoreTarget) {
    restoreTarget.focus({ preventScroll: true });
  }

  // Re-enable background before hiding the dialog to avoid aria-hidden on a focused node
  setAppInert(false);

  favoritesState.isOpen = false;
  filterUi.favPopover.classList.add("is-hidden");
  filterUi.favPopover.hidden = true;
  filterUi.favPopover.style.left = "";
  filterUi.favPopover.style.top = "";
  filterUi.favPopover.style.right = "";
  filterUi.favPopover.style.bottom = "";
  filterUi.favPopover.style.position = "";
  filterUi.favPopover.style.transform = "";

  if (filterUi.favBackdrop) {
    filterUi.favBackdrop.classList.remove("is-visible");
    filterUi.favBackdrop.classList.add("is-hidden");
    filterUi.favBackdrop.hidden = true;
  }
  setFavoritesManageMode(false);
  updateFavoritesToggleUi();
  favoritesState.opener = null;
  favoritesState.currentStop = null;
  setFavoritesStatus("");
}

function toggleFavorites(openerEl) {
  if (favoritesState.isOpen) closeFavorites();
  else openFavorites(openerEl);
}

function trapFocusInFavoritesPopover(e) {
  if (!filterUi.favPopover || !favoritesState.isOpen) return;
  const popover = filterUi.favPopover;
  if (popover.classList.contains("is-hidden")) return;

  const focusable = Array.from(
    popover.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");

  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (e.shiftKey) {
    if (active === first || !popover.contains(active)) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    }
    return;
  }

  if (active === last || !popover.contains(active)) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function applyPendingFilters() {
  appState.platformFilter = filterPending.platforms.length ? filterPending.platforms.slice() : null;
  appState.lineFilter = filterPending.lines.length ? filterPending.lines.slice() : null;
  appState.hideBusDeparture = !!filterPending.hideDeparture;
  applyFiltersToLegacySelects();
  updateFilterButtonState();
  if (typeof filtersOnChange === "function") filtersOnChange();
}

function normalizeFilterArray(val, allowed) {
  const arr = Array.isArray(val)
    ? val.filter(Boolean)
    : val
      ? [val]
      : [];

  const unique = Array.from(new Set(arr));
  if (!Array.isArray(allowed) || !allowed.length) return unique;

  const allowedSet = new Set(allowed);
  // Preserve the order of the allowed list
  return allowed.filter((v) => allowedSet.has(v) && unique.includes(v));
}

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

function applyFiltersToLegacySelects() {
  if (filterUi.platformSelect) {
    const val = Array.isArray(appState.platformFilter)
      ? appState.platformFilter[0] || ""
      : appState.platformFilter || "";
    filterUi.platformSelect.value = val;
  }
  if (filterUi.lineSelect) {
    const val = Array.isArray(appState.lineFilter)
      ? appState.lineFilter[0] || ""
      : appState.lineFilter || "";
    filterUi.lineSelect.value = val;
  }
}

// ---------------- EMBED STATE BROADCAST ----------------

export function publishEmbedState() {
  if (typeof window === "undefined" || window.parent === window) return;
  const isDualEmbed =
    document.documentElement.classList.contains("dual-embed") ||
    (document.body && document.body.classList.contains("dual-embed"));
  if (!isDualEmbed) return;

  const payload = {
    type: "md-board-state",
    station: appState.STATION || "",
    stationId: appState.stationId || null,
    isTrain: !!appState.lastBoardIsTrain,
    view: appState.lastBoardIsTrain
      ? appState.trainServiceFilter || TRAIN_FILTER_ALL
      : appState.viewMode || VIEW_MODE_TIME,
    hideDeparture: !!appState.hideBusDeparture,
    favoritesOnly: !!appState.favoritesOnly,
    boardLoading: !!appState.boardLoadingHint,
    boardNotice: String(appState.boardNoticeHint || ""),
    timestamp: Date.now(),
  };

  try {
    window.parent.postMessage(payload, "*");
  } catch {
    // ignore
  }
}

function notifyFavoritesOnlyChange() {
  try {
    if (typeof appState._favoriteFilterChanged === "function") {
      appState._favoriteFilterChanged(!!appState.favoritesOnly);
    }
  } catch (e) {
    console.warn("[MesDeparts][ui] favoritesOnly hook failed", e);
  }
}

function updateFavoritesToggleUi() {
  const active = !!appState.favoritesOnly;
  if (filterUi.favQuickToggle) {
    filterUi.favQuickToggle.classList.toggle("is-active", active);
    filterUi.favQuickToggle.setAttribute("aria-pressed", active ? "true" : "false");
    filterUi.favQuickToggle.setAttribute("aria-expanded", favoritesState.isOpen ? "true" : "false");
  }
  if (filterUi.favoritesSwitch) {
    filterUi.favoritesSwitch.checked = active;
  }
}

function updateFilterButtonState() {
  const activePlatforms = normalizeFilterArray(appState.platformFilter);
  const activeLines = normalizeFilterArray(appState.lineFilter);
  const activeHideDeparture = !appState.lastBoardIsTrain && appState.hideBusDeparture;

  const parts = [];
  if (activePlatforms.length) parts.push(`${t("filterPlatformsShort")} ${activePlatforms.join(", ")}`);
  if (activeLines.length) parts.push(`${t("filterLinesShort")} ${activeLines.join(", ")}`);
  if (activeHideDeparture) parts.push(t("filterHideDepartureShort"));

  const activeCount =
    (activePlatforms.length ? 1 : 0) +
    (activeLines.length ? 1 : 0) +
    (activeHideDeparture ? 1 : 0);

  if (filterUi.label) {
    filterUi.label.textContent = parts.length ? parts.join(" • ") : t("filterButton");
  }

  if (filterUi.openBtn) {
    filterUi.openBtn.classList.toggle("is-active", activeCount > 0);
  }

  if (filterUi.quickReset) {
    if (activeCount > 0) filterUi.quickReset.classList.remove("is-hidden");
    else filterUi.quickReset.classList.add("is-hidden");
  }
}

function applyLineBadgeFilter(lineId) {
  const cleanId = String(lineId || "").trim();
  if (!cleanId) return;

  const allowed = (appState.lineOptions || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });
  if (!allowed.includes(cleanId)) return;

  const current = normalizeFilterArray(appState.lineFilter, allowed);
  const nextSet = new Set(current);
  if (nextSet.has(cleanId)) nextSet.delete(cleanId);
  else nextSet.add(cleanId);
  const next = normalizeFilterArray(Array.from(nextSet), allowed);

  appState.lineFilter = next.length ? next : null;
  filterPending.lines = normalizeFilterArray(appState.lineFilter, allowed);

  applyFiltersToLegacySelects();
  updateFilterButtonState();

  if (filterSheetOpen) {
    syncPendingFromState({ preserveSelections: true });
    renderFilterSheet();
  }

  renderLineChips(allowed);

  if (typeof filtersOnChange === "function") filtersOnChange();
}

function syncPendingFromState({ preserveSelections = false } = {}) {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  const currentPlatforms = normalizeFilterArray(appState.platformFilter, platforms);
  const currentLines = normalizeFilterArray(appState.lineFilter, lines);
  appState.platformFilter = currentPlatforms.length ? currentPlatforms : null;
  appState.lineFilter = currentLines.length ? currentLines : null;
  filterPending.hideDeparture = !!appState.hideBusDeparture;

  filterPending.platforms = preserveSelections
    ? normalizeFilterArray(filterPending.platforms, platforms)
    : currentPlatforms.slice();

  filterPending.lines = preserveSelections
    ? normalizeFilterArray(filterPending.lines, lines)
    : currentLines.slice();
}

function toggleChip(type, value) {
  const target = type === "platforms" ? filterPending.platforms : filterPending.lines;
  if (value === "__all__") {
    target.splice(0, target.length);
  } else {
    const idx = target.indexOf(value);
    if (idx >= 0) target.splice(idx, 1);
    else target.push(value);
  }
  renderFilterSheet();
  applyPendingFilters();
}

function renderFilterChips(type, options, container) {
  if (!container) return;
  container.innerHTML = "";

  const selected = type === "platforms" ? filterPending.platforms : filterPending.lines;
  if (!options.length) return;

  const clearChip = document.createElement("button");
  clearChip.type = "button";
  clearChip.className = "filter-chip";
  if (selected.length === 0) clearChip.classList.add("is-active");
  clearChip.dataset.type = type;
  clearChip.dataset.value = "__all__";
  clearChip.textContent = t("filterAll");
  clearChip.addEventListener("click", () => toggleChip(type, "__all__"));
  container.appendChild(clearChip);

  for (const val of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    if (selected.includes(val)) chip.classList.add("is-active");
    chip.dataset.type = type;
    chip.dataset.value = val;
    chip.textContent = val;
    chip.addEventListener("click", () => toggleChip(type, val));
    container.appendChild(chip);
  }
}

function updateSheetResetState() {
  const hasPending =
    filterPending.platforms.length > 0 ||
    filterPending.lines.length > 0 ||
    !!filterPending.hideDeparture;

  if (filterUi.resetBtn) {
    filterUi.resetBtn.disabled = !hasPending;
  }
}

function renderFilterSheet() {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  if (filterUi.platformEmpty) {
    filterUi.platformEmpty.classList.toggle("is-hidden", platforms.length > 0);
  }
  if (filterUi.lineEmpty) {
    filterUi.lineEmpty.classList.toggle("is-hidden", lines.length > 0);
  }

  renderFilterChips("platforms", platforms, filterUi.platformChips);
  renderFilterChips("lines", lines, filterUi.lineChips);

  if (filterUi.hideDepartureToggle) {
    filterUi.hideDepartureToggle.checked = !!filterPending.hideDeparture;
  }

  updateSheetResetState();
}

function openFiltersSheet() {
  if (!filterUi.sheet) return;
  filterSheetOpen = true;
  if ("inert" in filterUi.sheet) {
    filterUi.sheet.inert = false;
  }
  filterUi.sheet.classList.remove("is-hidden");
  filterUi.sheet.setAttribute("aria-hidden", "false");
  if (filterUi.openBtn) filterUi.openBtn.setAttribute("aria-expanded", "true");
  syncPendingFromState();
  renderFilterSheet();
}

function closeFiltersSheet(applyChanges = false) {
  if (applyChanges) {
    applyPendingFilters();
  } else {
    syncPendingFromState();
  }

  if (filterUi.sheet) {
    const active = document.activeElement;
    if (active && filterUi.sheet.contains(active)) {
      if (filterUi.openBtn && typeof filterUi.openBtn.focus === "function") {
        filterUi.openBtn.focus();
      } else if (typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
    }
    if ("inert" in filterUi.sheet) {
      filterUi.sheet.inert = true;
    }
    filterUi.sheet.classList.add("is-hidden");
    filterUi.sheet.setAttribute("aria-hidden", "true");
  }
  if (filterUi.openBtn) filterUi.openBtn.setAttribute("aria-expanded", "false");

  filterSheetOpen = false;
  updateFavoritesToggleUi();
}

function resetAppliedFilters() {
  filterPending.platforms = [];
  filterPending.lines = [];
  filterPending.hideDeparture = false;
  closeFiltersSheet(true);
}

function updateFiltersVisibility() {
  const platformSel = filterUi.platformSelect || document.getElementById("platform-filter");
  const platWrap = platformSel ? platformSel.closest(".platform-filter-container") : null;
  const lineSelect = filterUi.lineSelect || document.getElementById("line-filter");
  const lineWrap = lineSelect ? lineSelect.closest(".line-filter-container") : null;

  const hideBecauseView = false;
  const hideBecauseTrain = appState.lastBoardIsTrain;
  const hasPlatforms = (appState.platformOptions || []).length > 0;
  const displaySection = document.getElementById("filters-section-display");
  const showDisplay = !hideBecauseTrain;

  const showPlatform =
    !hideBecauseView &&
    !hideBecauseTrain &&
    appState.lastBoardHasBus &&
    appState.lastBoardHasBusPlatform &&
    hasPlatforms;

  const showLine =
    !hideBecauseView && !hideBecauseTrain && appState.lastBoardHasBus;

  if (platWrap) platWrap.style.display = showPlatform ? "" : "none";
  if (!showPlatform && platformSel) {
    platformSel.value = "";
    appState.platformFilter = null;
    filterPending.platforms = [];
  }
  if (lineWrap) lineWrap.style.display = showLine ? "" : "none";
  if (!showLine) {
    appState.lineFilter = null;
    filterPending.lines = [];
  }

  if (!showDisplay) {
    appState.hideBusDeparture = false;
    filterPending.hideDeparture = false;
  }

  if (displaySection) displaySection.style.display = showDisplay ? "" : "none";

  const filtersAvailable = showPlatform || showLine || showDisplay;
  if (filterUi.openBtn) {
    filterUi.openBtn.disabled = !filtersAvailable;
    filterUi.openBtn.style.opacity = filtersAvailable ? "1" : "0.65";
  }
  if (!filtersAvailable && filterSheetOpen) {
    closeFiltersSheet(false);
  }

  const platformSection = document.getElementById("filters-section-platforms");
  const lineSection = document.getElementById("filters-section-lines");
  if (platformSection) platformSection.style.display = showPlatform ? "" : "none";
  if (lineSection) lineSection.style.display = showLine ? "" : "none";

  updateFilterButtonState();
}

export function setupFilters(onChange) {
  // Legacy header controls path disabled: replaced by ui/headerControls2.js
  return;

  filtersOnChange = onChange;
  filterUi.openBtn = document.getElementById("filters-open");
  filterUi.label = document.getElementById("filters-open-label");
  filterUi.quickReset = document.getElementById("filters-reset-inline");
  filterUi.sheet = document.getElementById("filters-popover");
  filterUi.resetBtn = document.getElementById("filters-reset");
  filterUi.applyBtn = document.getElementById("filters-apply");
  filterUi.platformChips = document.getElementById("platform-chip-list");
  filterUi.lineChips = document.getElementById("line-chip-list");
  filterUi.favoritesChips = document.getElementById("favorites-chip-list");
  filterUi.favoritesEmpty = document.getElementById("favorites-empty");
  filterUi.favoritesStatus = document.getElementById("favorites-status");
  filterUi.favoritesSaveCurrent = document.getElementById("favorites-save-current");
  filterUi.platformEmpty = document.getElementById("platforms-empty");
  filterUi.lineEmpty = document.getElementById("lines-empty");
  filterUi.favoritesSwitch = null;
  filterUi.manageFavorites = document.getElementById("favorites-manage");
  filterUi.favoritesDelete = document.getElementById("favorites-delete");
  filterUi.favPopover = document.getElementById("favorites-popover");
  filterUi.favBackdrop = document.getElementById("favorites-backdrop");
  filterUi.favQuickToggle = document.getElementById("favorites-only-toggle");
  filterUi.platformSelect = document.getElementById("platform-filter");
  filterUi.lineSelect = document.getElementById("line-filter");
  filterUi.hideDepartureToggle = document.getElementById("filters-hide-departure");
  const selectInteraction = { platform: false, line: false };
  if (filterUi.favPopover) {
    filterUi.favPopover.hidden = true;
  }
  if (filterUi.favoritesStatus) {
    filterUi.favoritesStatus.textContent = "";
    filterUi.favoritesStatus.classList.add("is-hidden");
  }
  if (filterUi.favBackdrop) {
    filterUi.favBackdrop.hidden = true;
    filterUi.favBackdrop.classList.add("is-hidden");
  }
  if (filterUi.openBtn) {
    filterUi.openBtn.setAttribute("aria-expanded", "false");
  }

  if (typeof appState._setFavoritesOnly !== "function") {
    appState._setFavoritesOnly = (val) => {
      appState.favoritesOnly = !!val;
      updateFavoritesToggleUi();
      notifyFavoritesOnlyChange();
    };
  }

  if (filterUi.openBtn) {
    filterUi.openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFavorites();
      if (filterSheetOpen) closeFiltersSheet(false);
      else openFiltersSheet();
    });
  }

  if (filterUi.quickReset) {
    filterUi.quickReset.addEventListener("click", () => resetAppliedFilters());
  }

  if (filterUi.sheet) {
    filterUi.sheet.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.filterPopoverClose === "true") {
        closeFiltersSheet(false);
      }
    });
  }

  if (filterUi.resetBtn) {
    filterUi.resetBtn.addEventListener("click", () => resetAppliedFilters());
  }

  if (filterUi.applyBtn) {
    filterUi.applyBtn.addEventListener("click", () => closeFiltersSheet(true));
  }

  if (filterUi.hideDepartureToggle) {
    filterUi.hideDepartureToggle.addEventListener("change", () => {
      filterPending.hideDeparture = !!filterUi.hideDepartureToggle.checked;
      renderFilterSheet();
    });
  }

  if (filterUi.favQuickToggle) {
    filterUi.favQuickToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorites(e.currentTarget || filterUi.favQuickToggle);
    });
  }

  if (filterUi.manageFavorites) {
    filterUi.manageFavorites.addEventListener("click", () => {
      setFavoritesManageMode(!favoritesManageMode);
    });
  }

  if (filterUi.favoritesSaveCurrent) {
    filterUi.favoritesSaveCurrent.addEventListener("click", () => {
      saveCurrentStopToFavorites();
    });
  }

  if (filterUi.favoritesDelete) {
    filterUi.favoritesDelete.addEventListener("click", () => {
      if (selectedFavorites.size === 0) return;
      const ok = window.confirm(t("favoritesDeleteConfirm"));
      if (!ok) return;

      const favs = loadFavorites();
      for (const id of Array.from(selectedFavorites)) {
        const exists = favs.find((f) => f.id === id);
        if (exists) removeFavorite(id);
      }
      selectedFavorites.clear();
      renderFavoritesSelect(appState.stationId);
      refreshFavToggleFromState();
      renderFavoriteChipsList();
      updateFavoritesDeleteState();
      if (loadFavorites().length === 0) {
        applyFavoritesOnlyMode(false);
      }
    });
  }

  if (filterUi.favPopover) {
    filterUi.favPopover.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.favPopoverClose === "true") {
        closeFavorites();
      }
    });
  }

  if (filterUi.favBackdrop) {
    filterUi.favBackdrop.addEventListener("click", () => closeFavorites());
  }

  updateSaveCurrentBtn();
  document.addEventListener("click", (e) => {
    if (
      favoritesState.isOpen &&
      filterUi.favPopover &&
      !filterUi.favPopover.contains(e.target) &&
      (!filterUi.favQuickToggle || !filterUi.favQuickToggle.contains(e.target))
    ) {
      closeFavorites();
    }

    if (
      filterSheetOpen &&
      filterUi.sheet &&
      !filterUi.sheet.contains(e.target) &&
      (!filterUi.openBtn || !filterUi.openBtn.contains(e.target))
    ) {
      closeFiltersSheet(false);
    }
  });

  if (filterUi.platformSelect) {
    const mark = () => { selectInteraction.platform = true; };
    filterUi.platformSelect.addEventListener("pointerdown", mark);
    filterUi.platformSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) mark();
    });
    filterUi.platformSelect.addEventListener("change", () => {
      if (!selectInteraction.platform) {
        // Guard against iOS restoring a stale <select> value without user interaction.
        filterUi.platformSelect.value = "";
        appState.platformFilter = null;
        filterPending.platforms = [];
        updateFilterButtonState();
        if (typeof filtersOnChange === "function") filtersOnChange();
        return;
      }
      selectInteraction.platform = false;
      const v = filterUi.platformSelect.value;
      appState.platformFilter = v ? [v] : null;
      filterPending.platforms = normalizeFilterArray(appState.platformFilter, appState.platformOptions);
      updateFilterButtonState();
      if (typeof filtersOnChange === "function") filtersOnChange();
    });
  }

  if (filterUi.lineSelect) {
    const mark = () => { selectInteraction.line = true; };
    filterUi.lineSelect.addEventListener("pointerdown", mark);
    filterUi.lineSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) mark();
    });
    filterUi.lineSelect.addEventListener("change", () => {
      if (!selectInteraction.line) {
        // Guard against iOS restoring a stale <select> value without user interaction.
        filterUi.lineSelect.value = "";
        appState.lineFilter = null;
        filterPending.lines = [];
        updateFilterButtonState();
        if (typeof filtersOnChange === "function") filtersOnChange();
        return;
      }
      selectInteraction.line = false;
      const v = filterUi.lineSelect.value;
      appState.lineFilter = v ? [v] : null;
      filterPending.lines = normalizeFilterArray(appState.lineFilter, appState.lineOptions);
      updateFilterButtonState();
      if (typeof filtersOnChange === "function") filtersOnChange();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && favoritesState.isOpen) {
      trapFocusInFavoritesPopover(e);
      return;
    }
    if (e.key === "Escape") {
      if (filterSheetOpen) closeFiltersSheet(false);
      if (favoritesState.isOpen) closeFavorites();
    }
  });

  syncPendingFromState();
  applyFiltersToLegacySelects();
  updateFavoritesManageUi();
  updateFavoritesToggleUi();
  updateFilterButtonState();
  updateFiltersVisibility();
}

export function renderFilterOptions() {
  const platforms = (appState.platformOptions || []).slice().sort((a, b) => a.localeCompare(b, "fr-CH"));
  const lines = (appState.lineOptions || []).slice().sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "fr-CH");
  });

  if (filterUi.platformSelect) setSelectOptions(filterUi.platformSelect, platforms, t("filterPlatforms"));
  if (filterUi.lineSelect) setSelectOptions(filterUi.lineSelect, lines, t("filterLines"));

  // sanitize applied filters against available options
  appState.platformFilter = normalizeFilterArray(appState.platformFilter, platforms);
  if (appState.platformFilter.length === 0) appState.platformFilter = null;

  appState.lineFilter = normalizeFilterArray(appState.lineFilter, lines);
  if (appState.lineFilter.length === 0) appState.lineFilter = null;

  if (!filterSheetOpen) {
    filterPending.platforms = normalizeFilterArray(appState.platformFilter, platforms);
    filterPending.lines = normalizeFilterArray(appState.lineFilter, lines);
  } else {
    syncPendingFromState({ preserveSelections: true });
  }

  applyFiltersToLegacySelects();
  updateFiltersVisibility();
  updateFilterButtonState();

  if (filterSheetOpen) renderFilterSheet();

  renderLineChips(lines);
}

// ---------------- STATION SEARCH ----------------

export function setupStationSearch(onStationPicked) {
  // Legacy header controls path disabled: replaced by ui/headerControls2.js
  return;

  const input = document.getElementById("station-input");
  const list = document.getElementById("station-suggestions");
  const clearBtn = document.getElementById("station-input-clear");
  const btn = document.getElementById("station-search-btn");
  const geoBtn = btn; // single button handles geolocation
  const favBtn = document.getElementById("favorites-only-toggle");
  const favSel = getFavSelectEl();
  const favoritesChipList = filterUi.favoritesChips;
  const favoritesEmpty = filterUi.favoritesEmpty;
  const saveCurrentBtn = filterUi.favoritesSaveCurrent;

  if (!input || !list) return;

  const favoritesInline = document.querySelector(".station-card .favorites-inline");
  if (favoritesInline) {
    favoritesInline.classList.remove("favorites-inline--mobile");
  }

  let lastQuery = "";
  let active = [];
  let favoritesOnly = !!appState.favoritesOnly;

  function syncClearButton() {
    if (!clearBtn) return;
    const hasText = !!(input && String(input.value || "").trim().length > 0);
    clearBtn.classList.toggle("is-hidden", !hasText);
  }

  function renderFavoriteChipsList() {
    if (!favoritesChipList) return;

    const favs = loadFavorites();
    favoritesChipList.innerHTML = "";
    favoritesChipList.classList.toggle("favorites-manage-mode", favoritesManageMode);

    if (favoritesEmpty) {
      favoritesEmpty.classList.toggle("is-hidden", favs.length > 0);
    }

    if (!favs.length) {
      updateFavoritesDeleteState();
      return;
    }

    for (const f of favs) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.id = f.id;

      const content = document.createElement("span");
      content.className = "favorite-chip__content";

      const nameSpan = document.createElement("span");
      nameSpan.className = "favorite-chip__name";
      nameSpan.textContent = f.name;
      nameSpan.addEventListener("click", (e) => {
        e.preventDefault();
        if (favoritesManageMode) return;
        setStationSelection(f.name, f.id, onStationPicked);
        closeFavorites();
      });

      chip.addEventListener("click", (e) => {
        if (favoritesManageMode) return;
        e.preventDefault();
        setStationSelection(f.name, f.id, onStationPicked);
        closeFavorites();
      });

      const select = document.createElement("span");
      select.className = "favorite-chip__select";
      select.style.display = favoritesManageMode ? "inline-flex" : "none";

      const isSel = favoritesManageMode && selectedFavorites.has(f.id);
      if (isSel) {
        chip.classList.add("is-active");
        select.textContent = "✕";
      } else {
        select.textContent = " ";
      }

      select.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!favoritesManageMode) return;
        if (selectedFavorites.has(f.id)) {
          selectedFavorites.delete(f.id);
          chip.classList.remove("is-active");
          select.textContent = " ";
        } else {
          selectedFavorites.add(f.id);
          chip.classList.add("is-active");
          select.textContent = "✕";
        }
        updateFavoritesDeleteState();
      });

      content.appendChild(nameSpan);
      content.appendChild(select);
      chip.appendChild(content);
      favoritesChipList.appendChild(chip);
    }

    updateFavoritesDeleteState();
    updateSaveCurrentBtn();
  }

  function renderFavoriteSuggestions(query) {
    const favs = loadFavorites();
    const q = (query || "").toLowerCase();
    const filtered = favs.filter((f) => !q || (f.name || "").toLowerCase().includes(q));

    list.innerHTML = "";
    active = filtered;

    if (!filtered.length) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.textContent = t("filterNoFavorites");
      li.style.opacity = "0.75";
      list.appendChild(li);
      list.style.display = "";
      return;
    }

    list.style.display = "";

    for (const s of filtered) {
      const li = document.createElement("li");
      li.className = "station-suggestion-item";
      li.textContent = s.name;
      li.addEventListener("click", () => {
        input.value = s.name;
        syncClearButton();
        clear();
        setStationSelection(s.name, s.id, onStationPicked);
      });
      list.appendChild(li);
    }
  }

  function applyFavoritesOnlyMode(next) {
    favoritesOnly = !!next;
    appState.favoritesOnly = favoritesOnly;
    updateFavoritesToggleUi();
    updateFilterButtonState();
    notifyFavoritesOnlyChange();
    if (favoritesOnly) renderFavoriteSuggestions(input.value.trim());
    else clear();
  }

  // Make it easy to overwrite the current station: select all text on focus,
  // and keep that selection even when the click started at the beginning.
  let justAutoSelected = false;
  input.addEventListener("focus", () => {
    if (input.value) {
      input.select();
      justAutoSelected = true;
    }
    if (favoritesOnly) {
      renderFavoriteSuggestions(input.value.trim());
    }
    syncClearButton();
  });
  input.addEventListener("mouseup", (e) => {
    if (justAutoSelected) {
      e.preventDefault(); // keep the full selection instead of placing the caret
      justAutoSelected = false;
    }
  });

  function clear() {
    active = [];
    list.innerHTML = "";
    list.style.display = "none";
  }

  function renderStatus(text) {
    list.innerHTML = "";
    active = [];
    if (!text) {
      list.style.display = "none";
      return;
    }
    const li = document.createElement("li");
    li.className = "station-suggestion-item is-hint";
    li.textContent = text;
    list.appendChild(li);
    list.style.display = "";
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return null;
    if (meters >= 1000) {
      const km = meters / 1000;
      return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
    }
    return `${Math.round(meters)} m`;
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
      const nameSpan = document.createElement("span");
      nameSpan.textContent = s.name;
      li.appendChild(nameSpan);

      const dist = formatDistance(typeof s.distance === "number" ? s.distance : null);
      if (dist) {
        const d = document.createElement("span");
        d.className = "station-suggestion-distance";
        d.textContent = dist;
        li.appendChild(d);
      }

      li.addEventListener("click", () => {
        input.value = s.name;
        syncClearButton();
        clear();
        setStationSelection(s.name, s.id, onStationPicked);
      });
      list.appendChild(li);
    }
  }

  async function doSuggest(q) {
    if (favoritesOnly) {
      renderFavoriteSuggestions(q);
      return;
    }

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

  let debounceTimer = null;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    syncClearButton();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSuggest(q), 180);
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

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      syncClearButton();
      if (favoritesOnly) {
        renderFavoriteSuggestions("");
      } else {
        clear();
      }
      input.focus();
    });
  }

function setGeoLoading(on) {
  if (!geoBtn) return;
  geoBtn.disabled = !!on;
  geoBtn.classList.toggle("is-loading", !!on);
  geoBtn.classList.toggle("is-active", !!on);
  geoBtn.setAttribute("aria-busy", on ? "true" : "false");
  geoBtn.setAttribute("aria-pressed", on ? "true" : "false");
  if (!on) geoBtn.removeAttribute("aria-busy");
}

  async function findNearbyStations() {
    if (!geoBtn) return;
    if (!navigator.geolocation) {
      renderStatus(t("nearbyNoGeo"));
      setGeoLoading(false);
      return;
    }

    applyFavoritesOnlyMode(false);
    setGeoLoading(true);
    renderStatus(t("nearbySearching"));

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 60000,
        });
      });

      const items = await fetchStationsNearby(pos.coords.latitude, pos.coords.longitude, 10);
      lastQuery = "";
      input.value = "";
      if (!items.length) {
        renderStatus(t("nearbyNone"));
        return;
      }
      renderSuggestions(items);
    } catch (e) {
      if (e && typeof e.code === "number" && e.code === 1) {
        renderStatus(t("nearbyDenied"));
      } else {
        renderStatus(t("nearbyError"));
      }
    } finally {
      setGeoLoading(false);
    }
  }

  if (geoBtn) {
    geoBtn.addEventListener("click", () => {
      findNearbyStations();
    });
    geoBtn.setAttribute("aria-label", t("nearbyButton"));
    geoBtn.title = t("nearbyButton");
    geoBtn.setAttribute("aria-pressed", "false");
  }

  // Init favourites UI (dropdown + star)
  syncClearButton();
  renderFavoritesSelect(appState.stationId);
  refreshFavToggleFromState();
  renderFavoriteChipsList();
  updateSaveCurrentBtn();

  if (favSel) {
    favSel.addEventListener("change", () => {
      const v = favSel.value;

      if (!v) return;

      if (v === FAV_CLEAR_VALUE) {
        clearFavorites();
        renderFavoritesSelect(appState.stationId);
        refreshFavToggleFromState();
        renderFavoriteChipsList();
        applyFavoritesOnlyMode(false);
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

  appState._favoriteFilterChanged = (val) => {
    favoritesOnly = !!val;
    updateFavoritesToggleUi();
    updateFilterButtonState();
    if (favoritesOnly) renderFavoriteSuggestions(input.value.trim());
    else clear();
  };

  appState._renderFavoritesPopover = renderFavoriteChipsList;
  appState._setFavoritesOnly = applyFavoritesOnlyMode;

  if (favoritesOnly) {
    renderFavoriteSuggestions(input.value.trim());
  }

  document.addEventListener("click", (e) => {
    if (!list.contains(e.target) && e.target !== input) clear();
  });
}

// ---------------- LINE CHIPS (header summary) ----------------

function renderLineChips(lines) {
  const wrap = document.getElementById("line-chips");
  const container = document.getElementById("line-chips-container");
  if (!wrap || !container) return;
  // HC2 owns the served-lines UI; keep legacy chips hidden to avoid duplicates.
  if (document.getElementById("hc2-served-lines")) {
    wrap.style.display = "none";
    container.innerHTML = "";
    return;
  }

  const normalizedLines = (lines || [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const activeLines = new Set(normalizeFilterArray(appState.lineFilter, normalizedLines));

  wrap.style.display = normalizedLines.length ? "flex" : "none";

  container.innerHTML = "";
  for (const ln of normalizedLines) {
    const badge = document.createElement("span");
    const lineNetwork =
      (appState.lineNetworks && appState.lineNetworks[ln]) ||
      appState.lastBoardNetwork ||
      appState.currentNetwork;
    badge.className = busBadgeClass({ simpleLineId: ln, network: lineNetwork });
    badge.textContent = ln;
    badge.classList.add("is-clickable");
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("aria-pressed", activeLines.has(ln) ? "true" : "false");
    badge.classList.toggle("is-active-filter", activeLines.has(ln));

    badge.title = `${t("filterLines")}: ${ln}`;

    const activate = (e) => {
      e.preventDefault();
      applyLineBadgeFilter(ln);
    };

    badge.addEventListener("click", activate);
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        activate(e);
      }
    });

    container.appendChild(badge);
  }
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

function formatTimeCell(val) {
  const d = parseApiDate(val);
  if (!d) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function stopMatchesStation(stop, stationId, stationName) {
  const targetId = stationId ? String(stationId).trim() : "";
  const targetName = (stationName || "").split(",")[0].trim().toLowerCase();
  if (!stop) return false;

  const candidates = [
    stop.station?.id,
    stop.location?.id,
    stop.id,
    stop.stop?.station?.id,
    stop.stop?.id,
  ]
    .map((v) => (v ? String(v).trim() : ""))
    .filter(Boolean);

  const names = [
    stop.station?.name,
    stop.name,
    stop.stop?.name,
  ]
    .map((v) => (v ? String(v).trim().toLowerCase() : ""))
    .filter(Boolean);

  return (
    (targetId && candidates.some((id) => id === targetId)) ||
    (targetName && names.some((n) => n === targetName))
  );
}

function ensureJourneyOverlay() {
  let overlay = document.getElementById("journey-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "journey-overlay";
  overlay.className = "journey-overlay";
  overlay.innerHTML = `
    <div class="journey-panel tripDetailsModal">
      <div class="tripDetailsHeader">
        <div class="tripDetailsHeaderMain">
          <div class="journey-title tripDetailsTitle"></div>
          <div class="journey-meta tripDetailsMeta"></div>
        </div>
        <button class="journey-close tripDetailsClose" type="button" aria-label="Fermer">×</button>
      </div>
      <div class="tripDetailsBody">
        <div class="tripDetailsStopsCard">
          <div class="journey-alerts"></div>
          <div class="journey-stops stopsList"></div>
        </div>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("is-visible");
  });
  overlay.querySelector(".journey-close").addEventListener("click", () => {
    overlay.classList.remove("is-visible");
  });

  document.body.appendChild(overlay);
  return overlay;
}

function renderJourneyStops(dep, detail) {
  const section = detail?.section || detail;
  const connection = detail?.connection;
  const stopsWrap = document.createElement("div");
  stopsWrap.className = "journey-stops";

  const passList =
    section?.journey?.passList ||
    detail?.journey?.passList ||
    detail?.passList ||
    detail?.stops ||
    [];
  const isTrain = dep.mode === "train";

  const originId =
    dep.fromStationId ||
    section?.departure?.station?.id ||
    connection?.from?.station?.id ||
    appState.stationId ||
    null;
  const originName =
    dep.fromStationName ||
    section?.departure?.station?.name ||
    connection?.from?.station?.name ||
    appState.STATION ||
    "";

  const startIdx = passList.findIndex((item) =>
    stopMatchesStation(item?.stop || item, originId, originName)
  );
  const visiblePassList =
    startIdx >= 0 ? passList.slice(startIdx) : passList.slice();

  if (!visiblePassList.length) {
    const empty = document.createElement("div");
    empty.className = "journey-stop stopRow stopRow--empty";
    empty.textContent = t("journeyNoStops");
    stopsWrap.appendChild(empty);
    return stopsWrap;
  }

  visiblePassList.forEach((item, idx) => {
    const s = item.stop || item;
    const fallbackOrigin =
      idx === 0
        ? dep.fromStationName ||
          section?.departure?.station?.name ||
          section?.departure?.name ||
          ""
        : "";
    const name = s.station?.name || s.name || s.stop?.name || fallbackOrigin || "—";
    const arr = s.arrival || s.prognosis?.arrival || s.arrivalTime;
    const depTime = s.departure || s.prognosis?.departure || s.departureTime;
    const isFirst = idx === 0;
    const isLast = idx === visiblePassList.length - 1;
    const cleanPlat = (p) => (p ? String(p).replace("!", "").trim() : "");

    const platCandidates = [
      s.prognosis?.platform,
      s.stop?.prognosis?.platform,
      s.prognosis?.departure?.platform,
      s.prognosis?.arrival?.platform,
      s.platform,
      s.stop?.platform,
      s.departure?.platform,
      s.arrival?.platform,
      s.stop?.departure?.platform,
      s.stop?.arrival?.platform,
      isFirst ? section?.departure?.platform : null,
      isFirst ? connection?.from?.platform : null,
      isLast ? section?.arrival?.platform : null,
      isLast ? connection?.to?.platform : null,
    ];

    const platform = cleanPlat(platCandidates.find((p) => cleanPlat(p)) || "");
    const li = document.createElement("div");
    li.className = "journey-stop stopRow";
    if (isLast) li.classList.add("is-last");
    if (isFirst) li.classList.add("is-origin");
    if (isFirst) li.classList.add("is-first");

    const gutter = document.createElement("div");
    gutter.className = "stopGutter";
    const dot = document.createElement("span");
    dot.className = "journey-stop-dot stopDot";
    gutter.appendChild(dot);

    const main = document.createElement("div");
    main.className = "journey-stop-main stopMain";

    const nameEl = document.createElement("div");
    nameEl.className = "journey-stop-name stopName";
    nameEl.textContent = name;

    const timeEl = document.createElement("div");
    timeEl.className = "journey-stop-times stopTimes";
    const timeStack = document.createElement("div");
    timeStack.className = "journey-stop-time-stack stopTimeStack";

    const arrStr = arr ? formatTimeCell(arr) : null;
    const depStr = depTime ? formatTimeCell(depTime) : null;

    // For trains: always show both when available.
    // For buses: show arrival only when meaningful; departure by default.
    let showArrival;
    let showDeparture;
    if (isTrain) {
      showArrival = !!arrStr;
      showDeparture = !!depStr;
    } else {
      showArrival =
        (isLast && !!arrStr) ||
        (!!arrStr && !!depStr && arrStr !== depStr && !isFirst) ||
        (!!arrStr && !depStr && !isFirst);
      showDeparture = (!isLast && !!depStr) || (isFirst && !!depStr);
    }

    // For trains, never show an arrival time on the departure station row to avoid stale “now” values.
    if (isTrain && isFirst) {
      showArrival = false;
    }

    const platformPill =
      platform
        ? (() => {
            const plat = document.createElement("span");
            plat.className = "journey-stop-platform small";
            const label = isTrain ? t("columnPlatformTrain") : t("columnPlatformBus");
            plat.textContent = `${label} ${platform}`;
            return plat;
          })()
        : null;

    if (showArrival) {
      const rowArr = document.createElement("div");
      rowArr.className = "journey-stop-time-row stopTimeRow";
      const lbl = document.createElement("span");
      lbl.className = "journey-stop-time-label stopTimeLabel";
      lbl.textContent = "Arr.";
      const val = document.createElement("span");
      val.className = "journey-stop-time-value stopTimeValue";
      val.textContent = arrStr || "--:--";
      rowArr.appendChild(lbl);
      rowArr.appendChild(val);
      timeStack.appendChild(rowArr);
    }

    if (showDeparture) {
      const rowDep = document.createElement("div");
      rowDep.className = "journey-stop-time-row stopTimeRow";
      const lbl = document.createElement("span");
      lbl.className = "journey-stop-time-label stopTimeLabel";
      lbl.textContent = isLast ? "Arr." : "Dép.";
      const val = document.createElement("span");
      val.className = "journey-stop-time-value stopTimeValue";
      val.textContent = depStr || arrStr || "--:--";
      rowDep.appendChild(lbl);
      rowDep.appendChild(val);
      timeStack.appendChild(rowDep);
    }

    timeEl.appendChild(timeStack);
    main.appendChild(nameEl);
    if (platformPill) {
      const sub = document.createElement("div");
      sub.className = "journey-stop-sub stopSub";
      sub.appendChild(platformPill);
      main.appendChild(sub);
    }

    li.appendChild(gutter);
    li.appendChild(main);
    li.appendChild(timeEl);
    stopsWrap.appendChild(li);
  });

  return stopsWrap;
}

async function openJourneyDetails(dep) {
  if (!dep) return;
  const reqId = ++activeJourneyRequestId;
  if (activeJourneyAbort) activeJourneyAbort.abort(new DOMException("Superseded", "AbortError"));
  const abortController = new AbortController();
  activeJourneyAbort = abortController;

  const overlay = ensureJourneyOverlay();
  const panel = overlay.querySelector(".tripDetailsModal");
  if (panel) panel.classList.toggle("debugTimeline", uiDebugEnabled());
  overlay.classList.add("is-visible");

  const titleEl = overlay.querySelector(".journey-title");
  const metaEl = overlay.querySelector(".journey-meta");
  const alertsEl = overlay.querySelector(".journey-alerts");
  const stopsEl = overlay.querySelector(".journey-stops");
  let journeyModalState = journeyModalStateReducer(null, { type: "request_started" });

  // Loading state
  titleEl.textContent = t("journeyTitle");
  metaEl.textContent = t("journeyLoading");
  overlay.dataset.loading = journeyModalState.loading ? "1" : "0";
  if (alertsEl) alertsEl.innerHTML = "";
  stopsEl.innerHTML = "";

  try {
    const detail = await fetchJourneyDetails(dep, { signal: abortController.signal });
    if (reqId !== activeJourneyRequestId) return;
    journeyModalState = journeyModalStateReducer(journeyModalState, { type: "request_succeeded" });
    const section = detail?.section || detail;
    const connection = detail?.connection || null;
    const badge = document.createElement("span");
    if (dep.mode === "train") {
      badge.className = `line-badge line-train ${trainBadgeClass(dep.category || dep.line || "")}`;
      badge.textContent = dep.line || dep.number || dep.category || "";
    } else {
      badge.className = busBadgeClass(dep);
      badge.textContent = normalizeLineId(dep);
    }

    titleEl.innerHTML = "";
    titleEl.appendChild(badge);
    const dest = document.createElement("span");
    dest.className = "journey-dest";
    dest.textContent = `→ ${dep.dest || section?.arrival?.station?.name || section?.journey?.to?.name || ""}`;
    titleEl.appendChild(dest);

    const hasDelay = typeof dep.delayMin === "number" && dep.delayMin !== 0;
    const isTrain = dep.mode === "train";

    const passList =
      section?.journey?.passList ||
      detail?.journey?.passList ||
      detail?.passList ||
      detail?.stops ||
      [];

    const originId =
      dep.fromStationId ||
      section?.departure?.station?.id ||
      connection?.from?.station?.id ||
      appState.stationId ||
      null;
    const originName =
      dep.fromStationName ||
      section?.departure?.station?.name ||
      connection?.from?.station?.name ||
      appState.STATION ||
      "";

    const currentStopItem = passList.find((item) =>
      stopMatchesStation(item?.stop || item, originId, originName)
    );
    const s = currentStopItem?.stop || currentStopItem;
    const detailRealtimePlatform =
      s?.prognosis?.platform ||
      s?.stop?.prognosis?.platform ||
      s?.prognosis?.departure?.platform;
    const detailPlannedPlatform = s?.platform || s?.stop?.platform;

    const platformVal =
      detailRealtimePlatform ||
      dep.platform ||
      detailPlannedPlatform ||
      section?.departure?.platform ||
      section?.departure?.stop?.platform ||
      section?.departure?.prognosis?.platform ||
      connection?.from?.platform ||
      "";

    metaEl.textContent = "";

    const timePill = document.createElement("span");
    timePill.className = "journey-meta-pill journey-meta-pill--time";
    timePill.textContent = `${t("journeyPlannedDeparture")} ${dep.timeStr || ""}`;
    metaEl.appendChild(timePill);

    if (platformVal) {
      const platformPill = document.createElement("span");
      platformPill.className = "journey-meta-pill journey-meta-pill--platform";
      const label = isTrain ? t("columnPlatformTrain") : t("columnPlatformBus");
      platformPill.textContent = `${label} ${String(platformVal).replace("!", "").trim()}`;
      metaEl.appendChild(platformPill);
    }

    if (hasDelay) {
      const pill = document.createElement("span");
      pill.className = "journey-meta-pill journey-meta-pill--delay";
      if (dep.delayMin < 0) {
        pill.classList.add("journey-meta-pill--early");
      }
      const signedDelay = dep.delayMin > 0 ? `+${dep.delayMin}` : `${dep.delayMin}`;
      pill.textContent = `${signedDelay} min`;
      metaEl.appendChild(pill);
    }

    if (dep.status === "cancelled") {
      const pill = document.createElement("span");
      pill.className = "journey-meta-pill journey-meta-pill--cancelled";
      pill.textContent = t("remarkCancelled");
      metaEl.appendChild(pill);
    }

    if (dep.operator) {
      const pill = document.createElement("span");
      pill.className = "journey-meta-pill journey-meta-pill--operator";
      pill.textContent = String(dep.operator);
      metaEl.appendChild(pill);
    }

    if (alertsEl) {
      const detailAlerts = normalizeDepartureAlerts(dep, lastRenderedServiceBanners, {
        suppressBannerDuplicates: false,
      });
      alertsEl.innerHTML = "";
      if (detailAlerts.length > 0) {
        const title = document.createElement("h4");
        title.className = "journey-alerts-title";
        title.textContent = t("alertsTitle");
        alertsEl.appendChild(title);
        const list = document.createElement("div");
        list.className = "journey-alerts-list";
        renderDepartureAlertsList(detailAlerts, list);
        alertsEl.appendChild(list);
      }
    }

    stopsEl.innerHTML = "";
    stopsEl.appendChild(renderJourneyStops(dep, detail));
  } catch (err) {
    if (shouldIgnoreJourneyError(err, { requestId: reqId, activeRequestId: activeJourneyRequestId })) {
      return;
    }
    journeyModalState = journeyModalStateReducer(journeyModalState, {
      type: "request_failed",
      message: err?.message,
    });
    console.error("[MesDeparts][journey] error", err);
    metaEl.textContent = t("journeyStopsError");
    stopsEl.innerHTML = "";
    const retryWrap = document.createElement("div");
    retryWrap.className = "journey-stop stopRow stopRow--empty";
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "hc2__suggestionRetry";
    retryBtn.textContent = t("searchRetry");
    retryBtn.addEventListener("click", (event) => {
      event.preventDefault();
      openJourneyDetails(dep);
    });
    retryWrap.appendChild(retryBtn);
    stopsEl.appendChild(retryWrap);
  } finally {
    if (reqId === activeJourneyRequestId && activeJourneyAbort === abortController) {
      activeJourneyAbort = null;
    }
    if (reqId === activeJourneyRequestId) {
      overlay.dataset.loading = journeyModalState.loading ? "1" : "0";
    }
  }
}

const LINE_CLASS_STYLE_CACHE = new Map();
let lineStyleProbeEl = null;
const FALLBACK_PALETTE_NETWORKS = Object.freeze(["tpg", "tl", "zvv", "tpn", "mbc", "vmcv"]);

function normalizeNetworkToken(value) {
  const net = String(value || "").trim().toLowerCase();
  if (!net) return "";
  if (net === "vbz") return "zvv";
  return net;
}

function buildLineClassForNetwork(network, idForClass) {
  const net = normalizeNetworkToken(network);
  if (!net || net === "generic" || net === "postauto") return "";
  const paletteRule = appState.networkPaletteRules?.[net];
  const classPrefixRaw =
    typeof paletteRule?.classPrefix === "string" && paletteRule.classPrefix.trim()
      ? paletteRule.classPrefix.trim()
      : `line-${net}-`;
  const classPrefix = /-$/.test(classPrefixRaw) ? classPrefixRaw : `${classPrefixRaw}-`;
  return `${classPrefix}${idForClass}`;
}

function getLineStyleProbeElement() {
  if (typeof document === "undefined") return null;
  const body = document.body;
  if (!body) return null;
  if (lineStyleProbeEl && lineStyleProbeEl.isConnected) return lineStyleProbeEl;
  const el = document.createElement("span");
  el.setAttribute("aria-hidden", "true");
  el.style.position = "absolute";
  el.style.left = "-9999px";
  el.style.top = "-9999px";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.className = "line-badge";
  body.appendChild(el);
  lineStyleProbeEl = el;
  return lineStyleProbeEl;
}

function hasStyledLineClass(className) {
  if (!className) return false;
  if (LINE_CLASS_STYLE_CACHE.has(className)) return LINE_CLASS_STYLE_CACHE.get(className) === true;
  const probe = getLineStyleProbeElement();
  if (!probe || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    LINE_CLASS_STYLE_CACHE.set(className, false);
    return false;
  }
  const prev = probe.className;
  probe.className = `line-badge ${className}`;
  const bg = String(window.getComputedStyle(probe).backgroundColor || "").trim();
  probe.className = prev;
  const hasBackground = !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  LINE_CLASS_STYLE_CACHE.set(className, hasBackground);
  return hasBackground;
}

function inferStyledNetworkForLine(idForClass, preferredNetworks) {
  const preferred = Array.from(
    new Set(
      (Array.isArray(preferredNetworks) ? preferredNetworks : [])
        .map((value) => normalizeNetworkToken(value))
        .filter((value) => value && value !== "generic" && value !== "postauto")
    )
  );

  for (const net of preferred) {
    const cls = buildLineClassForNetwork(net, idForClass);
    if (hasStyledLineClass(cls)) return { network: net, className: cls };
  }

  const configured = Array.from(
    new Set([
      ...Object.keys(appState.networkPaletteRules || {}),
      ...FALLBACK_PALETTE_NETWORKS,
    ])
  )
    .map((value) => normalizeNetworkToken(value))
    .filter((value) => value && value !== "generic" && value !== "postauto");

  const matches = [];
  for (const net of configured) {
    const cls = buildLineClassForNetwork(net, idForClass);
    if (hasStyledLineClass(cls)) matches.push({ network: net, className: cls });
  }
  if (matches.length === 1) return matches[0];

  for (const pref of preferred) {
    const match = matches.find((entry) => entry.network === pref);
    if (match) return match;
  }

  return null;
}

function busBadgeClass(dep) {
  if (!dep) return "line-badge";

  const simpleLineId =
    typeof dep.simpleLineId === "string" && dep.simpleLineId.trim()
      ? dep.simpleLineId
      : null;

  if (!simpleLineId) return "line-badge";

  const id = String(simpleLineId).trim().toUpperCase();
  const idForClass = id.replace(/\+/g, "PLUS");

  const preferredNetworks = [
    dep.network,
    appState.lineNetworks?.[simpleLineId],
    appState.lineNetworks?.[id],
    appState.lastBoardNetwork,
    appState.currentNetwork,
  ];
  const net = normalizeNetworkToken(dep.network || appState.currentNetwork || "");

  // PostAuto styling (full yellow pill)
  if (dep.isPostBus || preferredNetworks.some((value) => normalizeNetworkToken(value) === "postauto")) {
    return "line-badge line-postbus";
  }

  const classes = ["line-badge"];

  // Night buses (N1, N2, ...)
  if (id.startsWith("N")) {
    classes.push("line-night");
  }

  let hasColorClass = false;
  const styledMatch = inferStyledNetworkForLine(idForClass, preferredNetworks);
  if (styledMatch?.className) {
    classes.push(styledMatch.className);
    hasColorClass = true;
  } else if (net && net !== "generic") {
    const cls = buildLineClassForNetwork(net, idForClass);
    if (cls && hasStyledLineClass(cls)) {
      classes.push(cls);
      hasColorClass = true;
    }
  }

  if (!hasColorClass) {
    const genericTone = genericBusLineTone(id);
    classes.push("line-generic", `line-generic-tone-${genericTone}`, `line-generic-${idForClass}`);
  }

  return classes.join(" ");
}

function genericBusLineTone(simpleLineId) {
  const id = String(simpleLineId || "").trim().toUpperCase();
  if (!id) return 0;
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 33 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 24;
}

function setMinColumnVisibility(isTrain) {
  const thMin = document.querySelector("th.col-min");
  const thPlat = document.querySelector("th.col-platform");

  if (thMin) thMin.style.display = isTrain ? "none" : "";
  if (thPlat) thPlat.style.display = isTrain ? "" : "";
}

function updatePlatformHeader(isTrain) {
  const thPlat = document.querySelector("th.col-platform");
  if (thPlat) thPlat.textContent = isTrain ? t("columnPlatformTrain") : t("columnPlatformBus");
}

const ARRIVAL_ICON_HTML = `
          <svg class="bus-arrival-icon pulse-bus" viewBox="0 0 24 24" aria-label="Arrive">
            <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3-3.58-3-8-3S4 3 4 6v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14 9 14.67 9 15.5 8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5S15.67 14 16.5 14 18 14.67 18 15.5 17.33 17 16.5 17zM6 11V6h12v5H6z"/>
          </svg>`;

const lastRenderedState = {
  rowKeys: [],
  rows: [],
  boardIsTrain: null,
  hideDeparture: null,
};

function syncDestinationColumnWidth() {
  const th = document.querySelector("th.col-dest");
  if (!th) return;
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 520px)").matches;
  if (!isMobile) {
    document.documentElement.style.removeProperty("--dest-col-width");
    return;
  }
  const rect = th.getBoundingClientRect();
  if (!rect || !rect.width) return;
  const width = Math.ceil(rect.width);
  document.documentElement.style.setProperty("--dest-col-width", `${width}px`);
}

function appendDestinationWithBreaks(target, dest, { emphasizeSuffix = false } = {}) {
  if (!target) return;
  target.textContent = "";
  const text = String(dest || "");
  if (!text) return;
  const normalizedText = text.trim();
  const firstCommaIndex = text.indexOf(",");
  const shouldEmphasizeSuffix = emphasizeSuffix && firstCommaIndex >= 0;
  if (shouldEmphasizeSuffix) {
    const prefix = text.slice(0, firstCommaIndex).trimEnd();
    const suffix = text.slice(firstCommaIndex + 1).trim();
    const split = document.createElement("span");
    split.className = "dest-split-lines";

    const firstLine = document.createElement("strong");
    firstLine.className = "dest-suffix-strong";
    firstLine.textContent = `${prefix},`;
    split.appendChild(firstLine);

    if (suffix) {
      const secondLine = document.createElement("span");
      secondLine.className = "dest-second-line";
      secondLine.textContent = suffix;
      split.appendChild(secondLine);
    }

    target.appendChild(split);
    return;
  }

  if (emphasizeSuffix && normalizedText && firstCommaIndex < 0) {
    const strong = document.createElement("strong");
    strong.className = "dest-suffix-strong";
    strong.textContent = normalizedText;
    target.appendChild(strong);
    return;
  }

  const parts = text.split(/([,\\/\\-–—])/);
  for (const part of parts) {
    if (!part) continue;
    if (part === "," || part === "-" || part === "/" || part === "–" || part === "—") {
      target.appendChild(document.createTextNode(part));
      target.appendChild(document.createElement("wbr"));
      continue;
    }
    target.appendChild(document.createTextNode(part));
  }
}

function getRowKey(dep) {
  if (!dep) return "";
  if (dep.journeyId) return dep.journeyId;
  return `${dep.line || ""}|${dep.dest || ""}|${dep.scheduledTime || ""}`;
}

let activeJourneyAbort = null;
let activeJourneyRequestId = 0;
function isTimeoutAbortError(err) {
  return err instanceof DOMException && err.name === "AbortError" && err.message === "Timeout";
}

export function shouldIgnoreJourneyError(err, { requestId, activeRequestId } = {}) {
  if (Number(requestId) !== Number(activeRequestId)) return true;
  return isAbortErrorFromLogic(err) && !isTimeoutAbortError(err);
}

export function journeyModalStateReducer(state, event) {
  const prev =
    state && typeof state === "object"
      ? state
      : { loading: false, error: null };
  const type = String(event?.type || "").trim().toLowerCase();
  switch (type) {
    case "request_started":
      return { loading: true, error: null };
    case "request_succeeded":
      return { loading: false, error: null };
    case "request_failed":
      return {
        loading: false,
        error: String(event?.message || "request_failed"),
      };
    default:
      return prev;
  }
}

let departuresRowHandlersReady = false;
function ensureDeparturesRowDelegation() {
  if (departuresRowHandlersReady) return;
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;

  const activate = (event, isKeyboard = false) => {
    const tr = event.target?.closest("tr");
    if (!tr || tr.dataset.hasDetails !== "1") return;
    const rows = lastRenderedState.rows || [];
    const idx = Array.prototype.indexOf.call(tr.parentElement?.children || [], tr);
    const dep = idx >= 0 ? rows[idx] : null;
    if (!dep) return;
    if (isKeyboard) event.preventDefault();
    openJourneyDetails(dep);
  };

  tbody.addEventListener("click", (e) => activate(e, false));
  tbody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") activate(e, true);
  });
  departuresRowHandlersReady = true;
}

function setDepartureColumnVisibility(hide) {
  const thTime = document.querySelector("th.col-time");
  const departuresTable = document.querySelector("table.departures");
  if (thTime) thTime.style.display = hide ? "none" : "";
  if (departuresTable) departuresTable.classList.toggle("is-hide-departure", !!hide);
}

export function renderDepartures(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return;

  ensureDeparturesRowDelegation();

  setMinColumnVisibility(appState.lastBoardIsTrain);
  updatePlatformHeader(appState.lastBoardIsTrain);
  const hideDeparture = !!appState.hideBusDeparture && !appState.lastBoardIsTrain;
  setDepartureColumnVisibility(hideDeparture);
  const departuresTable = document.querySelector("table.departures");
  if (departuresTable) {
    departuresTable.classList.toggle("is-train-board", !!appState.lastBoardIsTrain);
    departuresTable.classList.toggle("has-line-alert-column", false);
  }
  lastRenderedState.boardIsTrain = appState.lastBoardIsTrain;
  lastRenderedState.hideDeparture = hideDeparture;
  lastRenderedState.rowKeys = [];
  lastRenderedState.rows = rows || [];
  if (typeof appState._renderViewControls === "function") {
    appState._renderViewControls();
  }

  tbody.innerHTML = "";
  closeDepartureAlertsPopover({ restoreFocus: false });

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

  if (!rows || rows.length === 0) {
    lastRenderedState.rowKeys = [];
    lastRenderedState.rows = [];
    if (departuresTable) departuresTable.classList.toggle("has-line-alert-column", false);
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = hideDeparture ? 5 : 6;
    td.className = "col-empty";
    td.textContent = t("serviceEndedToday");
    tr.appendChild(td);
    tbody.appendChild(tr);
    ensureBoardFitsViewport();
    return;
  }

  let prevLineKey = null;
  const useGroupSeparators =
    !appState.lastBoardIsTrain && appState.viewMode === VIEW_MODE_LINE;

  // Determine wide vs narrow remark format once per render (stable, no per-row flicker).
  const narrowRemark = isNarrowRemarkLayout();
  const inlineAlertsByDeparture = new Map();
  const shouldRenderAlertButtonByDeparture = new Map();
  let hasAnyDelayedBusDeparture = false;
  let hasRenderableAlertButton = false;
  for (const dep of rows || []) {
    if (!dep || dep.mode !== "bus") continue;
    const inlineAlerts = resolveRenderableInlineAlertsForLineAlertButton(
      dep,
      lastRenderedServiceBanners
    );
    inlineAlertsByDeparture.set(dep, inlineAlerts);
    const shouldRenderAlertButton = hasRenderableInlineAlert(inlineAlerts);
    if (!hasAnyDelayedBusDeparture && hasPositiveDelayForAlertColumn(dep)) {
      hasAnyDelayedBusDeparture = true;
    }
    if (!hasRenderableAlertButton && shouldRenderAlertButton) {
      hasRenderableAlertButton = true;
    }
    shouldRenderAlertButtonByDeparture.set(dep, shouldRenderAlertButton);
  }
  const showLineAlertColumn = hasAnyDelayedBusDeparture && hasRenderableAlertButton;
  if (departuresTable) {
    departuresTable.classList.toggle("has-line-alert-column", showLineAlertColumn);
  }

  for (const dep of rows || []) {
    const tr = document.createElement("tr");
    tr.dataset.journeyId = dep.journeyId || "";
    const hasDetails =
      !!dep.journeyId || (Array.isArray(dep.passList) && dep.passList.length > 0);
    tr.classList.toggle("clickable", hasDetails);
    tr.classList.toggle("is-cancelled", dep?.status === "cancelled");
    tr.dataset.hasDetails = hasDetails ? "1" : "0";
    tr.tabIndex = hasDetails ? 0 : -1;

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
          remarkWide: dep?.remarkWide || dep?.remark || "",
          remarkNarrow: dep?.remarkNarrow || "",
        });
      }
    }

    const lineKey = dep?.simpleLineId || dep?.line || dep?.number || "";
    if (useGroupSeparators && prevLineKey && lineKey && lineKey !== prevLineKey) {
      tr.classList.add("line-separator");
    }
    if (lineKey) prevLineKey = lineKey;

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

    const inlineAlerts = inlineAlertsByDeparture.get(dep) || [];
    const shouldRenderAlertButton = shouldRenderAlertButtonByDeparture.get(dep) === true;
    if (dep.mode === "bus" && showLineAlertColumn && shouldRenderAlertButton) {
      const alertBtn = document.createElement("button");
      alertBtn.type = "button";
      alertBtn.className = "line-alert-btn";
      const lineLabel = normalizeLineId(dep) || dep.line || dep.number || "";
      const countSuffix =
        inlineAlerts.length > 1 ? ` (${inlineAlerts.length} ${t("alertsCount")})` : "";
      alertBtn.setAttribute(
        "aria-label",
        `${t("alertsOpen")} ${lineLabel}${countSuffix}`.trim()
      );
      alertBtn.title = t("alertsOpen");
      const glyph = document.createElement("span");
      glyph.className = "line-alert-btn__glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "!";
      alertBtn.appendChild(glyph);
      if (inlineAlerts.length > 1) {
        const count = document.createElement("span");
        count.className = "line-alert-btn__count";
        count.textContent = String(inlineAlerts.length);
        alertBtn.appendChild(count);
      }
      alertBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sameTrigger = activeDepartureAlertsTrigger === alertBtn;
        const isVisible = departureAlertsLayer?.classList.contains("is-visible");
        if (sameTrigger && isVisible) {
          closeDepartureAlertsPopover({ restoreFocus: false });
          return;
        }
        openDepartureAlertsPopover(dep, alertBtn);
      });
      alertBtn.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          openDepartureAlertsPopover(dep, alertBtn);
        }
      });
      tdLine.appendChild(alertBtn);
    }

    // Destination
    const tdTo = document.createElement("td");
    tdTo.className = "col-to-cell";
    appendDestinationWithBreaks(tdTo, dep.dest || "", { emphasizeSuffix: dep.mode !== "train" });

    // Time
    const tdTime = document.createElement("td");
    tdTime.className = "col-time-cell";
    tdTime.textContent = dep.timeStr || "";
    if (hideDeparture) tdTime.style.display = "none";

    // Platform
    const tdPlat = document.createElement("td");
    tdPlat.className = "col-platform-cell";
    const platformVal = dep.platform || "";
    const prevPlatform = dep.previousPlatform || null;

    const showPlatformChange = dep.mode === "train" && dep.platformChanged && platformVal;
    if (showPlatformChange) {
      const span = document.createElement("span");
      span.className = "platform-badge";
      span.textContent = prevPlatform ? `${prevPlatform} ↔ ${platformVal}` : platformVal;
      tdPlat.appendChild(span);
      tdPlat.classList.add("status-delay");
    } else if (platformVal) {
      const badge = document.createElement("span");
      badge.className = "platform-badge";
      badge.textContent = platformVal;
      tdPlat.appendChild(badge);
    } else {
      tdPlat.textContent = "";
    }

    // Min
    const tdMin = document.createElement("td");
    tdMin.className = "col-min-cell";

    if (!appState.lastBoardIsTrain) {
      if (dep.isArriving) {
        tdMin.innerHTML = ARRIVAL_ICON_HTML;
        tdMin.dataset.minValue = "arriving";
        tdMin.dataset.isArriving = "1";
      } else if (typeof dep.inMin === "number") {
        tdMin.textContent = String(dep.inMin);
        tdMin.dataset.minValue = String(dep.inMin);
        tdMin.dataset.isArriving = "0";
      } else {
        tdMin.textContent = "";
        tdMin.dataset.minValue = "";
        tdMin.dataset.isArriving = "0";
      }
    } else {
      tdMin.style.display = "none";
      tdMin.dataset.minValue = "";
      tdMin.dataset.isArriving = "0";
    }

    // Remark — pick narrow (+X min) or wide (Retard env. X min) based on layout
    const tdRemark = document.createElement("td");
    tdRemark.className = "col-remark-cell";
    let effectiveStatus = dep.status;
    const suppressDelayRemark = dep?.suppressDelayRemark === true;
    let remarkText = narrowRemark
      ? (dep.remarkNarrow || dep.remark || "")
      : (dep.remarkWide || dep.remark || "");
    if (!remarkText) {
      if (effectiveStatus === "cancelled") {
        remarkText = t("remarkCancelled");
      } else if (effectiveStatus === "early") {
        remarkText = t("remarkEarly");
      } else if (effectiveStatus === "delay" && !suppressDelayRemark) {
        const delayValue = Number(dep?.displayedDelayMin);
        if (dep?.mode === "train" && Number.isFinite(delayValue) && delayValue > 0) {
          remarkText = narrowRemark
            ? `+${delayValue} min`
            : t("remarkDelayTrainApprox").replace("{min}", String(delayValue));
        } else {
          remarkText = t("remarkDelayShort");
        }
      } else {
        const delayValue = Number(dep?.displayedDelayMin);
        if (!suppressDelayRemark && Number.isFinite(delayValue) && delayValue > 0) {
          effectiveStatus = "delay";
          if (dep?.mode === "train") {
            remarkText = narrowRemark
              ? `+${delayValue} min`
              : t("remarkDelayTrainApprox").replace("{min}", String(delayValue));
          } else {
            remarkText = t("remarkDelayShort");
          }
        }
      }
    }

    if (effectiveStatus === "cancelled" && remarkText) {
      const badge = document.createElement("span");
      badge.className = "remark-pill remark-pill--cancelled";
      badge.textContent = remarkText;
      tdRemark.appendChild(badge);
    } else {
      tdRemark.textContent = remarkText;
    }
    if (effectiveStatus === "cancelled") tdRemark.classList.add("status-cancelled");
    if (effectiveStatus === "delay") tdRemark.classList.add("status-delay");
    if (effectiveStatus === "early") tdRemark.classList.add("status-early");
    if (effectiveStatus === "cancelled" && uiDebugEnabled()) {
      const debugCancel = document.createElement("span");
      debugCancel.className = "remark-debug-cancelled";
      debugCancel.textContent = " CXL";
      tdRemark.appendChild(debugCancel);
    }

    // Assemble
    tr.appendChild(tdLine);
    tr.appendChild(tdTo);
    tr.appendChild(tdTime);
    tr.appendChild(tdPlat);
    tr.appendChild(tdMin);
    tr.appendChild(tdRemark);

    const rowKey = getRowKey(dep);
    tr.dataset.rowKey = rowKey;
    lastRenderedState.rowKeys.push(rowKey);
    tbody.appendChild(tr);
  }

  ensureBoardFitsViewport();
}

export function updateCountdownRows(rows) {
  const tbody = document.getElementById("departures-body");
  if (!tbody) return false;

  const hideDeparture = !!appState.hideBusDeparture && !appState.lastBoardIsTrain;
  if (
    lastRenderedState.boardIsTrain !== appState.lastBoardIsTrain ||
    lastRenderedState.hideDeparture !== hideDeparture
  ) {
    return false;
  }

  if (!rows || rows.length === 0) return false;

  const domRows = Array.from(tbody.querySelectorAll("tr"));
  if (domRows.length !== rows.length) return false;

  for (let i = 0; i < rows.length; i += 1) {
    const expectedKey = getRowKey(rows[i]);
    if (domRows[i].dataset.rowKey !== expectedKey) return false;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const dep = rows[i];
    const tr = domRows[i];
    const minCell = tr.querySelector(".col-min-cell");
    if (!minCell) continue;

    if (dep.mode === "train") {
      if (minCell.style.display !== "none") minCell.style.display = "none";
      minCell.dataset.minValue = "";
      minCell.dataset.isArriving = "0";
      continue;
    }

    const nextValue = typeof dep.inMin === "number" ? String(dep.inMin) : "";
    const nextIsArriving = dep.isArriving ? "1" : "0";

    if (nextIsArriving === "1") {
      if (minCell.dataset.isArriving !== "1") {
        minCell.innerHTML = ARRIVAL_ICON_HTML;
      }
      minCell.dataset.minValue = "arriving";
      minCell.dataset.isArriving = "1";
    } else if (minCell.dataset.minValue !== nextValue || minCell.dataset.isArriving !== "0") {
      minCell.textContent = nextValue;
      minCell.dataset.minValue = nextValue;
      minCell.dataset.isArriving = "0";
    }
  }

  return true;
}
