import {
  hasTokenIntersection,
  normalizeStopId,
  stopKeySet,
} from "./stopScope.js";

export function stopRootForDebugMatch(stopId) {
  const raw = normalizeStopId(stopId);
  if (!raw) return "";

  const parentMatch = raw.match(/^Parent(\d+)$/i);
  if (parentMatch?.[1]) {
    const id = String(Number(parentMatch[1]));
    return id && id !== "0" ? id : "";
  }

  const sloidMatch = raw.match(/sloid:(\d+)/i);
  if (sloidMatch?.[1]) {
    const id = String(Number(sloidMatch[1]));
    return id && id !== "0" ? id : "";
  }

  const scopedNumericMatch = raw.match(/^(\d+)(?::|$)/);
  if (scopedNumericMatch?.[1]) {
    const id = String(Number(scopedNumericMatch[1]));
    return id && id !== "0" ? id : "";
  }

  return "";
}

export function informedStopMatchesForDebug(entityStopId, requestedStopId) {
  const informed = normalizeStopId(entityStopId);
  const requested = normalizeStopId(requestedStopId);
  if (!informed || !requested) return false;

  const informedKeys = stopKeySet(informed);
  const requestedKeys = stopKeySet(requested);
  if (hasTokenIntersection(informedKeys, requestedKeys)) return true;

  const root = stopRootForDebugMatch(requested);
  if (!root) return false;

  return informed === root || informed.startsWith(`${root}:`);
}
