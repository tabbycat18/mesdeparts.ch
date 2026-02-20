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
 * @property {string} side - "left" or "right" (defaults to "left" for backward compatibility)
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

function normalizeFavorite(input, defaultSide = "left") {
  if (!input) return null;

  const id = safeString(input.id).trim();
  const name = safeString(input.name).trim();
  const side = safeString(input.side).trim() || defaultSide;

  if (!id || !name) return null;

  const addedAtRaw = input.addedAt;
  const addedAt =
    typeof addedAtRaw === "number" && Number.isFinite(addedAtRaw)
      ? addedAtRaw
      : Date.now();

  return { id, name, side, addedAt };
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
 * @param {string} side - "left" or "right" (optional, defaults to "left")
 * @returns {Favorite[]} updated list
 */
export function addFavorite(station, side = "left") {
  const cur = loadFavorites();
  const fav = normalizeFavorite({
    id: station && station.id,
    name: station && station.name,
    side: side,
    addedAt: Date.now(),
  }, side);

  if (!fav) return cur;

  // Put on top, then dedupe & cap
  return saveFavorites([fav, ...cur]);
}

/**
 * Add a favourite for a specific side.
 * @param {string} side - "left" or "right"
 * @param {{id: string, name: string}} station
 * @returns {Favorite[]} updated list
 */
export function addFavoriteForSide(side, station) {
  return addFavorite(station, side);
}

/**
 * Remove a favourite by station id.
 * @param {string} stationId
 * @param {string} side - "left", "right", or null (removes from all sides)
 * @returns {Favorite[]} updated list
 */
export function removeFavorite(stationId, side = null) {
  const id = safeString(stationId).trim();
  if (!id) return loadFavorites();

  const next = loadFavorites().filter((f) => {
    if (f.id !== id) return true;
    if (side === null) return false;
    return f.side !== side;
  });
  return saveFavorites(next);
}

/**
 * Remove a favourite from a specific side.
 * @param {string} side - "left" or "right"
 * @param {string} stationId
 * @returns {Favorite[]} updated list
 */
export function removeFavoriteForSide(side, stationId) {
  return removeFavorite(stationId, side);
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
 * Load favourites for a specific side.
 * @param {string} side - "left" or "right"
 * @returns {Favorite[]}
 */
export function loadFavoritesForSide(side) {
  const sideName = safeString(side).trim() || "left";
  return loadFavorites().filter((f) => (f.side || "left") === sideName);
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

/**
 * Migrate old favorites (without side) to have a side property.
 * Run once on app load to ensure backward compatibility.
 */
export function migrateFavoritesToSided() {
  try {
    const all = loadFavorites();
    const needsMigration = all.some((f) => !f.side);
    if (needsMigration) {
      const migrated = all.map((f) => ({
        ...f,
        side: f.side || "left",
      }));
      saveFavorites(migrated);
    }
  } catch (e) {
    console.warn("[MesDeparts][favorites] migration failed", e);
  }
}

// Convenience export (optional) for UI labels / limits
export const FAVORITES_STORAGE_KEY = LS_KEY;
export const FAVORITES_MAX = MAX_FAVS;
