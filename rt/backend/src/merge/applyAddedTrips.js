import { computeDepartureDelayDisplayFromSeconds } from "../util/departureDelay.js";

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function uniqTags(tags) {
  const out = [];
  for (const tag of tags || []) {
    const t = normalizeText(tag);
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function normalizeScheduleRelationship(raw) {
  if (typeof raw === "string") return raw.toUpperCase();
  const n = asNumber(raw);
  switch (n) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "ADDED";
    case 2:
      return "UNSCHEDULED";
    case 3:
      return "CANCELED";
    case 4:
      return "DUPLICATED";
    default:
      return "";
  }
}

function normalizeStopTimeRelationship(raw) {
  if (typeof raw === "string") return raw.toUpperCase();
  const n = asNumber(raw);
  switch (n) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "SKIPPED";
    case 2:
      return "NO_DATA";
    case 3:
      return "UNSCHEDULED";
    default:
      return "";
  }
}

function getStopIdVariants(stopId) {
  const out = new Set();
  const base = normalizeText(stopId);
  if (!base) return out;
  out.add(base);

  const parts = base.split(":");
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (last.length <= 2) out.add(parts.slice(0, parts.length - 1).join(":"));
  }
  return out;
}

function matchesStopScope(stopId, scopeStopIds) {
  if (!stopId || !(scopeStopIds instanceof Set) || scopeStopIds.size === 0) return false;
  const variants = getStopIdVariants(stopId);
  for (const variant of variants) {
    if (scopeStopIds.has(variant)) return true;
  }
  return false;
}

function parseRailLine(label) {
  const cleaned = normalizeText(label).replace(/\s+/g, "");
  const m = cleaned.match(/^([A-Za-z]{1,4})(\d{1,4})$/);
  if (!m) return null;
  return {
    category: m[1].toUpperCase(),
    number: String(m[2]).replace(/^0+/, "") || "0",
    line: cleaned,
  };
}

function inferTagsFromText(...parts) {
  const text = parts
    .map((v) => normalizeText(v))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const tags = [];
  if (
    /\b(ersatz|replacement|remplacement|sostitutiv|substitute|bus\breplacement|rail replacement|ev(?:\s*\d+)?)\b/i.test(
      text
    )
  ) {
    tags.push("replacement");
  }
  if (/\b(extra|zusatz|special)\b/i.test(text)) {
    tags.push("extra");
  }
  return tags;
}

function deriveLineFields({ routeId, tripShortName, tripId, tags }) {
  const raw = normalizeText(tripShortName) || normalizeText(routeId);
  const baseLine = raw || (tags.includes("extra") ? "EXTRA" : "RT");
  const rail = parseRailLine(baseLine);
  if (rail) {
    return {
      category: rail.category,
      line: rail.line,
      number: rail.number,
    };
  }

  if (tags.includes("replacement")) {
    return {
      category: "B",
      line: baseLine,
      number: baseLine,
    };
  }

  const letterMatch = (baseLine || normalizeText(tripId)).match(/[A-Za-z]/);
  const category = letterMatch ? letterMatch[0].toUpperCase() : "R";
  return {
    category,
    line: baseLine || "RT",
    number: baseLine || "RT",
  };
}

function extractAddedStopUpdates(tripUpdates) {
  if (Array.isArray(tripUpdates?.addedTripStopUpdates)) {
    return tripUpdates.addedTripStopUpdates;
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];
  const out = [];
  const seen = new Set();

  for (const entity of entities) {
    const update = pick(entity, "trip_update", "tripUpdate");
    if (!update) continue;

    const trip = pick(update, "trip") || null;
    const tripId = normalizeText(pick(trip, "trip_id", "tripId"));
    if (!tripId) continue;
    const tripStartDate = normalizeText(
      pick(trip, "start_date", "startDate")
    ).replace(/[^0-9]/g, "");
    if (normalizeScheduleRelationship(pick(trip, "schedule_relationship", "scheduleRelationship")) !== "ADDED") {
      continue;
    }

    const routeId = normalizeText(pick(trip, "route_id", "routeId"));
    const tripShortName = normalizeText(pick(trip, "trip_short_name", "tripShortName"));
    const tripHeadsign = normalizeText(pick(trip, "trip_headsign", "tripHeadsign"));

    const stopUpdates = Array.isArray(pick(update, "stop_time_update", "stopTimeUpdate"))
      ? pick(update, "stop_time_update", "stopTimeUpdate")
      : [];
    for (const stu of stopUpdates) {
      const stopId = normalizeText(pick(stu, "stop_id", "stopId"));
      if (!stopId) continue;

      const stopRel = normalizeStopTimeRelationship(
        pick(stu, "schedule_relationship", "scheduleRelationship")
      );
      if (stopRel === "SKIPPED") continue;

      const dep = pick(stu, "departure") || null;
      const depEpoch = asNumber(pick(dep, "time"));
      if (depEpoch === null) continue;
      const delaySec = asNumber(pick(dep, "delay"));
      const delayDisplay = computeDepartureDelayDisplayFromSeconds(delaySec);

      const stopSequence = asNumber(pick(stu, "stop_sequence", "stopSequence"));
      const key = `${tripId}|${stopId}|${stopSequence ?? ""}|${depEpoch}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        tripId,
        routeId,
        stopId,
        stopSequence,
        departureEpoch: depEpoch,
        delaySec,
        delayMin: delayDisplay.delayMinAfterClamp ?? 0,
        tripStartDate: tripStartDate.length === 8 ? tripStartDate : "",
        tripShortName,
        tripHeadsign,
      });
    }
  }

  return out;
}

export function applyAddedTrips({
  tripUpdates,
  stationStopIds,
  platformByStopId,
  stationName,
  now,
  windowMinutes = 180,
  departedGraceSeconds = 45,
  limit = 500,
} = {}) {
  const added = extractAddedStopUpdates(tripUpdates);
  if (!Array.isArray(added) || added.length === 0) return [];

  const scopeStopIds = new Set();
  for (const stopId of stationStopIds || []) {
    for (const variant of getStopIdVariants(stopId)) scopeStopIds.add(variant);
  }

  const out = [];
  const seen = new Set();
  const nowDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const nowMs = nowDate.getTime();
  const windowMs = Math.max(1, Number(windowMinutes) || 180) * 60 * 1000;
  const graceMs = Math.max(0, Number(departedGraceSeconds) || 45) * 1000;

  for (const item of added) {
    const stopId = normalizeText(item?.stopId);
    if (!matchesStopScope(stopId, scopeStopIds)) continue;

    const depEpoch = asNumber(item?.departureEpoch);
    if (depEpoch === null) continue;
    const realtimeMs = depEpoch * 1000;
    const msUntil = realtimeMs - nowMs;
    if (msUntil < -graceMs) continue;
    if (msUntil > windowMs) continue;

    const tags = inferTagsFromText(
      item?.routeId,
      item?.tripId,
      item?.tripShortName,
      item?.tripHeadsign
    );
    if (!tags.includes("replacement") && !tags.includes("extra")) {
      tags.push("extra");
    }
    const lineFields = deriveLineFields({
      routeId: item?.routeId,
      tripShortName: item?.tripShortName,
      tripId: item?.tripId,
      tags,
    });
    const stopSequence = asNumber(item?.stopSequence);

    const dedupeKey = `${item.tripId}|${stopId}|${item.stopSequence ?? ""}|${depEpoch}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const realtimeIso = new Date(realtimeMs).toISOString();
    out.push({
      trip_id: item.tripId,
      route_id: normalizeText(item?.routeId),
      stop_id: stopId,
      stop_sequence: stopSequence === null ? null : stopSequence,
      category: lineFields.category,
      number: lineFields.number,
      line: lineFields.line,
      name: lineFields.line,
      destination: normalizeText(item?.tripHeadsign) || stationName || "Extra service",
      operator: "",
      scheduledDeparture: realtimeIso,
      realtimeDeparture: realtimeIso,
      delayMin: Number.isFinite(item?.delayMin) ? Number(item.delayMin) : 0,
      minutesLeft: msUntil <= 0 ? 0 : Math.floor(msUntil / 60000),
      platform:
        (platformByStopId && platformByStopId.get(stopId)) ||
        (platformByStopId && platformByStopId.get(stopId.split(":").slice(0, -1).join(":"))) ||
        "",
      platformChanged: false,
      cancelled: false,
      source: "rt_added",
      tags: uniqTags(tags),
      alerts: [],
    });
  }

  out.sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    const ax = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bx = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return ax - bx;
  });

  return out.slice(0, Math.max(1, Math.min(Number(limit) || 500, 1000)));
}
