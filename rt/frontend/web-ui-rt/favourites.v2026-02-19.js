// favourites.js
// --------------------------------------------------------
// Local favourites (no account) stored in localStorage
// --------------------------------------------------------

const LS_KEY = "md_favorites_v1";
const MAX_FAVS = 50;

/**
 * @typedef {Object} Favorite
 * @property {string} id
 * @property {string} name
 * @property {number} addedAt
 */

function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function safeString(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeFavorite(input) {
  if (!input) return null;

  const id = safeString(input.id).trim();
  const name = safeString(input.name).trim();

  if (!id || !name) return null;

  const addedAtRaw = input.addedAt;
  const addedAt =
    typeof addedAtRaw === "number" && Number.isFinite(addedAtRaw)
      ? addedAtRaw
      : Date.now();

  return { id, name, addedAt };
}

function dedupeAndSort(list) {
  const map = new Map();

  for (const item of Array.isArray(list) ? list : []) {
    const fav = normalizeFavorite(item);
    if (!fav) continue;

    // Dedupe by id: keep the most recent addedAt
    const prev = map.get(fav.id);
    if (!prev || fav.addedAt > prev.addedAt) {
      map.set(fav.id, fav);
    }
  }

  const out = Array.from(map.values());

  // Sort by addedAt desc (most recent first)
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  // Hard cap
  return out.slice(0, MAX_FAVS);
}

/**
 * Load favourites from localStorage.
 * @returns {Favorite[]}
 */
export function loadFavorites() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];

    const parsed = safeParseJSON(raw);
    return dedupeAndSort(parsed);
  } catch (e) {
    console.warn("[MesDeparts][favorites] load failed", e);
    return [];
  }
}

/**
 * Persist a favourites list to localStorage.
 * @param {Favorite[]} list
 * @returns {Favorite[]} the normalized list actually saved
 */
export function saveFavorites(list) {
  const normalized = dedupeAndSort(list);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(normalized));
  } catch (e) {
    console.warn("[MesDeparts][favorites] save failed", e);
  }
  return normalized;
}

/**
 * Add (or refresh) a favourite station.
 * @param {{id: string, name: string}} station
 * @returns {Favorite[]} updated list
 */
export function addFavorite(station) {
  const cur = loadFavorites();
  const fav = normalizeFavorite({
    id: station && station.id,
    name: station && station.name,
    addedAt: Date.now(),
  });

  if (!fav) return cur;

  // Put on top, then dedupe & cap
  return saveFavorites([fav, ...cur]);
}

/**
 * Remove a favourite by station id.
 * @param {string} stationId
 * @returns {Favorite[]} updated list
 */
export function removeFavorite(stationId) {
  const id = safeString(stationId).trim();
  if (!id) return loadFavorites();

  const next = loadFavorites().filter((f) => f.id !== id);
  return saveFavorites(next);
}

/**
 * Check if a station id is in favourites.
 * @param {string} stationId
 * @returns {boolean}
 */
export function isFavorite(stationId) {
  const id = safeString(stationId).trim();
  if (!id) return false;

  return loadFavorites().some((f) => f.id === id);
}

/**
 * Clear all favourites.
 */
export function clearFavorites() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch (e) {
    console.warn("[MesDeparts][favorites] clear failed", e);
  }
}

// Convenience export (optional) for UI labels / limits
export const FAVORITES_STORAGE_KEY = LS_KEY;
export const FAVORITES_MAX = MAX_FAVS;
