// state.js
// --------------------------------------------------------
// Config & shared state
// --------------------------------------------------------

// Station / app-level config
export const DEFAULT_STATION = "Lausanne, motte";

export const MAX_LINES_BUS = 15;
export const DEPS_PER_LINE = 2;
export const MIN_ROWS = 8;
export const MAX_TRAIN_ROWS = 20;

export const REFRESH_DEPARTURES = 10_000;

// Delay display thresholds (in minutes)
export const BUS_DELAY_MIN_THRESHOLD = 2;
export const TRAIN_DELAY_MIN_THRESHOLD = 1;

// Arrival icon pulse window (in seconds)
export const ARRIVAL_PULSE_BEFORE_SEC = 15;
export const ARRIVAL_PULSE_AFTER_SEC = 45;

export const DEBUG_FORCE_NOW = false;
// Debug: log scheduled vs realtime vs delay (early/late) end-to-end
export const DEBUG_EARLY = true;

export const VIEW_MODES = {
  DOWN: "down",        // Centre-ville / Descendre (Motte only)
  GROUPED: "grouped",  // Par ligne
  CHRONO: "chrono",    // Heurelogique
};

export const appState = {
  STATION: DEFAULT_STATION,
  stationId: null,
  stationIsMotte: DEFAULT_STATION.toLowerCase().includes("motte"),
  filterEnabled: DEFAULT_STATION.toLowerCase().includes("motte"),
  viewMode: null, // set on start / station change
  filterButton: null,
  currentNetwork: "generic",

  // Filtres
  platformFilter: null,
  // Nouveau: filtre par numéro de ligne (bus)
  lineFilter: null,

  // Infos sur le board courant
  lastBoardIsTrain: false,
  lastBoardHasBus: false,
  lastBoardHasBusPlatform: false,

  // NEW: list of platforms detected on the latest board (bus only)
  platformOptions: [],

  // NEW: list of bus lines detected on the latest board
  lineOptions: [],
};

appState.viewMode = appState.stationIsMotte
  ? VIEW_MODES.DOWN
  : VIEW_MODES.GROUPED;