// state.js
// --------------------------------------------------------
// Config & shared state
// --------------------------------------------------------

export const DEFAULT_STATION = "Lausanne, motte";

// Legacy (kept for compatibility with older imports)
export const MAX_LINES_BUS = 15;

// Board sizing
export const DEPS_PER_LINE = 2;
export const MIN_ROWS = 12;
export const MAX_TRAIN_ROWS = 20;

// Refresh cadence
export const REFRESH_DEPARTURES = 20_000;
export const REFRESH_DIRECT = 10_000;

// How far ahead we keep departures (client-side window).
// Note: the upstream API may not return a full 3h horizon for every stop.
export const BOARD_HORIZON_MINUTES = 210; // 3 hours

// Arrival “blinking” window (for the icon in the minutes column)
export const ARRIVAL_LEAD_SECONDS = 15;     // start blinking 15s before departure
export const DEPARTED_GRACE_SECONDS = 30;   // keep blinking up to 45s after departure

// Delay label thresholds (minutes)
export const BUS_DELAY_LABEL_THRESHOLD_MIN = 2;   // buses: show delay text from 2 min
export const TRAIN_DELAY_LABEL_THRESHOLD_MIN = 1; // trains: show delay text from 1 min

// Debug switches
export const DEBUG_FORCE_NOW = false;
// Debug: log scheduled vs realtime vs delay (early/late)
export const DEBUG_EARLY = false;

// View modes (buses/trams/metro only)
export const VIEW_MODE_TIME = "time";   // chronological list
export const VIEW_MODE_LINE = "line";   // grouped by line
export const VIEW_MODE_DOWN = "down";   // Motte special filter (“Descendre” / centre-ville)

export const API_MODE_BOARD = "board";
export const API_MODE_DIRECT = "direct";
export const API_MODE_STORAGE_KEY = "md_api_mode";
export const API_MODE_AUTO_OFF_KEY = "md_api_mode_auto_off";
export const API_MODE_AUTO_SWITCH_MS = 120_000;

export const appState = {
  // Station
  STATION: DEFAULT_STATION,
  stationId: null,
  stationIsMotte: DEFAULT_STATION.toLowerCase().includes("motte"),
  currentNetwork: "generic",
  language: "fr",

  // View (controls bus display + Motte filter)
  viewMode: VIEW_MODE_LINE,

  // API mode: board (Cloudflare) vs direct (transport.opendata.ch)
  apiMode: API_MODE_BOARD,

  // UI refs
  viewSelect: null,              // dropdown (#view-select)
  viewButton: null,              // legacy toggle (#filter-toggle) fallback
  _ensureViewSelectOptions: null, // set by ui.js to rebuild options on station change

  // Filters
  platformFilter: null,
  lineFilter: null,
  favoritesOnly: false,
  lastPlatforms: {},

  // Infos sur le board courant
  lastBoardIsTrain: false,
  lastBoardHasBus: false,
  lastBoardHasBusPlatform: false,
  lastBoardNetwork: "generic",
  lineNetworks: {}, // map lineId -> network for chips colors

  // Options detected on latest board (bus only)
  platformOptions: [],
  lineOptions: [],
};
