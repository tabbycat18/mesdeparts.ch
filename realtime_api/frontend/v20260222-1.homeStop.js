const HOME_STOP_STORAGE_KEY = "mesdeparts.homeStop.v1";

function resolveStorage(overrideStorage) {
  if (overrideStorage && typeof overrideStorage.getItem === "function") {
    return overrideStorage;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

function normalizeStopPayload(input) {
  if (!input || typeof input !== "object") return null;

  const idRaw = typeof input.id === "string" ? input.id.trim() : "";
  const nameRaw = typeof input.name === "string" ? input.name.trim() : "";
  const dontAskAgain = input.dontAskAgain === true;

  if (!idRaw && !nameRaw) return null;

  return {
    id: idRaw || null,
    name: nameRaw || "",
    dontAskAgain,
  };
}

function parseStoredValue(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return normalizeStopPayload(parsed);
  } catch {
    return null;
  }
}

export function getHomeStop({ storage } = {}) {
  const local = resolveStorage(storage);
  if (!local) return null;

  try {
    const raw = local.getItem(HOME_STOP_STORAGE_KEY);
    return parseStoredValue(raw);
  } catch {
    return null;
  }
}

export function setHomeStop(stop, { storage } = {}) {
  const normalized = normalizeStopPayload(stop);
  if (!normalized) return null;

  const local = resolveStorage(storage);
  if (!local) return normalized;

  try {
    local.setItem(HOME_STOP_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }
  return normalized;
}

export function clearHomeStop({ storage } = {}) {
  const local = resolveStorage(storage);
  if (!local) return;
  try {
    local.removeItem(HOME_STOP_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function shouldShowHomeStopModal({ homeStop, storage } = {}) {
  const saved = homeStop !== undefined ? normalizeStopPayload(homeStop) : getHomeStop({ storage });
  // Decision rules:
  // - show when no saved home stop exists
  // - hide only when user explicitly opted out with dontAskAgain=true
  return !saved || saved.dontAskAgain !== true;
}
