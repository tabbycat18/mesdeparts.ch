import { normalizeText, looksLikeDisruptionText, toArray } from "./text.js";

function hasParseableDepartureTime(dep) {
  const scheduledMs = Date.parse(normalizeText(dep?.scheduledDeparture));
  const realtimeMs = Date.parse(normalizeText(dep?.realtimeDeparture));
  return Number.isFinite(scheduledMs) || Number.isFinite(realtimeMs);
}

function hasServiceIdentity(dep) {
  const identityFields = [
    dep?.trip_id,
    dep?.journey_id,
    dep?.service_id,
    dep?.number,
    dep?.name,
  ];
  if (identityFields.some((value) => normalizeText(value))) return true;

  const line = normalizeText(dep?.line);
  if (!line) return false;
  if (/^(ev|alert|extra)$/i.test(line)) return false;
  return true;
}

function hasValidDestination(dep) {
  const destination = normalizeText(dep?.destination || dep?.to);
  if (!destination) return false;
  if (destination.length > 80) return false;
  if (looksLikeDisruptionText(destination)) return false;
  return true;
}

export function isRenderableDepartureRow(dep) {
  if (!dep || typeof dep !== "object") return false;
  if (!hasParseableDepartureTime(dep)) return false;
  if (!hasValidDestination(dep)) return false;
  if (!hasServiceIdentity(dep)) return false;
  return true;
}

export function filterRenderableDepartures(rows) {
  const list = toArray(rows);
  const kept = [];
  const dropped = [];

  for (const dep of list) {
    if (isRenderableDepartureRow(dep)) kept.push(dep);
    else dropped.push(dep);
  }

  return { kept, dropped };
}

