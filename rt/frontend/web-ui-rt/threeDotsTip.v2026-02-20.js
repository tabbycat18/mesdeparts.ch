const THREE_DOTS_TIP_STORAGE_KEY = "mesdeparts.hasSeenThreeDotsTip";

function resolveStorage(overrideStorage) {
  if (overrideStorage && typeof overrideStorage.getItem === "function") {
    return overrideStorage;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

export function getHasSeenThreeDotsTip({ storage } = {}) {
  const local = resolveStorage(storage);
  if (!local) return false;

  try {
    const raw = local.getItem(THREE_DOTS_TIP_STORAGE_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

export function setHasSeenThreeDotsTip(value = true, { storage } = {}) {
  const local = resolveStorage(storage);
  if (!local) return;

  try {
    local.setItem(THREE_DOTS_TIP_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}
