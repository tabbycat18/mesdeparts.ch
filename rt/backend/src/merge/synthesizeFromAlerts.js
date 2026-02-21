import {
  addDaysToYmdInt,
  dateFromZurichServiceDateAndSeconds,
  ymdIntInZurich,
} from "../time/zurichTime.js";
import {
  hasTokenIntersection,
  normalizeStopId,
  stopKeySet,
} from "../util/stopScope.js";

function normalize(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeText(value) {
  return normalize(value).toLowerCase();
}

function textContains(haystack, needle) {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  return !!h && !!n && h.includes(n);
}

function isAlertRelevantForWindow(alert, nowMs, windowMs, graceMs) {
  const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
  if (periods.length === 0) return true;

  for (const period of periods) {
    const startMs = getPeriodMs(period?.start);
    const endMs = getPeriodMs(period?.end);
    const endsAfterNow = endMs == null ? true : endMs >= nowMs - graceMs;
    const startsBeforeWindowEnd = startMs == null ? true : startMs <= nowMs + windowMs;
    if (endsAfterNow && startsBeforeWindowEnd) return true;
  }
  return false;
}

function getPeriodMs(periodValue) {
  if (periodValue == null) return null;
  if (periodValue instanceof Date) {
    return Number.isFinite(periodValue.getTime()) ? periodValue.getTime() : null;
  }
  if (typeof periodValue === "number" && Number.isFinite(periodValue)) {
    return periodValue < 2_000_000_000 ? periodValue * 1000 : periodValue;
  }
  const raw = String(periodValue || "").trim();
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum < 2_000_000_000 ? asNum * 1000 : asNum;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isParentStopId(stopId) {
  return normalizeStopId(stopId).startsWith("Parent");
}

function stationRootFromRequestedStop(stopId) {
  const raw = normalizeStopId(stopId);
  if (!raw) return "";
  if (raw.startsWith("Parent")) return raw.slice("Parent".length);
  const parts = raw.split(":");
  return parts[0] || raw;
}

function stopMatchesScope(informedStopId, requestedStopId, childStopIds) {
  const informed = normalizeStopId(informedStopId);
  const requested = normalizeStopId(requestedStopId);
  if (!informed) return false;
  const informedKeys = stopKeySet(informed);
  const requestedKeys = stopKeySet(requested);
  if (hasTokenIntersection(informedKeys, requestedKeys)) return true;

  const childScopeTokens = new Set();
  for (const sid of childStopIds || []) {
    for (const token of stopKeySet(sid)) childScopeTokens.add(token);
  }
  if (hasTokenIntersection(informedKeys, childScopeTokens)) return true;

  const requestedRoot = stationRootFromRequestedStop(requested);
  if (requestedRoot && (informed === requestedRoot || informed.startsWith(`${requestedRoot}:`))) {
    return true;
  }
  if (!requested || !isParentStopId(requested)) return false;
  if (childStopIds.has(informed)) return true;
  return false;
}

function classifyTags(alert) {
  const effect = normalize(alert?.effect).toUpperCase();
  const text = `${alert?.headerText || ""} ${alert?.descriptionText || ""}`.toLowerCase();
  const tags = [];

  if (
    effect === "ADDITIONAL_SERVICE" ||
    /\b(extra|zusatz|special|suppl[ée]mentaire)\b/i.test(text)
  ) {
    tags.push("extra");
  }
  if (
    effect === "DETOUR" ||
    effect === "MODIFIED_SERVICE" ||
    effect === "NO_SERVICE" ||
    /\b(ersatz|replacement|remplacement|sostitutiv|substitute|ev(?:\s*\d+)?)\b/i.test(
      text
    )
  ) {
    tags.push("replacement");
  }
  return tags;
}

function pickLine(routeId, tags) {
  const r = normalize(routeId);
  if (r) return r;
  if (tags.includes("replacement")) return "EV";
  if (tags.includes("extra")) return "EXTRA";
  return "ALERT";
}

function pickCategory(line, tags) {
  if (tags.includes("replacement")) return "B";
  const label = normalize(line);
  const match = label.match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : "R";
}

function addUniqueMs(list, seen, ms, nowMs, windowMs, graceMs) {
  if (!Number.isFinite(ms)) return;
  if (ms < nowMs - graceMs) return;
  if (ms > nowMs + windowMs) return;
  const key = String(Math.trunc(ms));
  if (seen.has(key)) return;
  seen.add(key);
  list.push(ms);
}

function collectExplicitTimesFromText(text) {
  const value = String(text || "");
  if (!value) return [];
  const out = [];
  const seen = new Set();

  const colon = /(^|[^0-9])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;
  const hForm = /(^|[^0-9])([01]?\d|2[0-3])h([0-5]\d)(?!\d)/gi;
  for (const re of [colon, hForm]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(value)) !== null) {
      const hh = Number(m[2] || "0");
      const mm = Number(m[3] || "0");
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
      const key = `${hh}:${mm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hour: hh, minute: mm });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function timePairToCandidateMs(nowDate, nowMs, graceMs, hour, minute) {
  const todayYmd = ymdIntInZurich(nowDate);
  const secOfDay = hour * 3600 + minute * 60;
  let candidateDate = dateFromZurichServiceDateAndSeconds(todayYmd, secOfDay);
  if (!(candidateDate instanceof Date) || !Number.isFinite(candidateDate.getTime())) return null;
  let candidate = candidateDate.getTime();
  if (candidate < nowMs - graceMs) {
    const tomorrowYmd = addDaysToYmdInt(todayYmd, 1);
    candidateDate = dateFromZurichServiceDateAndSeconds(tomorrowYmd, secOfDay);
    if (!(candidateDate instanceof Date) || !Number.isFinite(candidateDate.getTime())) return null;
    candidate = candidateDate.getTime();
  }
  return candidate;
}

function collectStructuredTimes(alert) {
  const out = [];
  const candidates = [
    alert?.departureTimestamp,
    alert?.departure_time,
    alert?.departureTime,
    alert?.prognosis?.departureTimestamp,
    alert?.prognosis?.departure_time,
    alert?.prognosis?.departureTime,
  ];
  for (const raw of candidates) {
    const ms = getPeriodMs(raw);
    if (Number.isFinite(ms)) out.push(ms);
  }
  return out;
}

function collectExplicitDepartureTimes(alert, nowDate, nowMs, windowMs, graceMs) {
  const explicit = [];
  const seen = new Set();

  const text = `${alert?.headerText || ""}\n${alert?.descriptionText || ""}`;
  const textTimes = collectExplicitTimesFromText(text);
  for (const item of textTimes) {
    const ms = timePairToCandidateMs(nowDate, nowMs, graceMs, item.hour, item.minute);
    addUniqueMs(explicit, seen, ms, nowMs, windowMs, graceMs);
  }

  const structuredTimes = collectStructuredTimes(alert);
  for (const ms of structuredTimes) {
    addUniqueMs(explicit, seen, ms, nowMs, windowMs, graceMs);
  }

  explicit.sort((a, b) => a - b);
  return explicit;
}

export function synthesizeFromAlerts({
  alerts,
  stopId,
  departures,
  scopeStopIds,
  stationName,
  now,
  windowMinutes = 180,
  departedGraceSeconds = 45,
  limit = 30,
} = {}) {
  const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];
  if (entities.length === 0) return [];

  const nowDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const nowMs = nowDate.getTime();
  const windowMs = Math.max(1, Number(windowMinutes) || 180) * 60 * 1000;
  const graceMs = Math.max(0, Number(departedGraceSeconds) || 45) * 1000;

  const baseDepartures = Array.isArray(departures) ? departures : [];
  const departureRouteIds = new Set(
    baseDepartures.map((dep) => normalize(dep?.route_id)).filter(Boolean)
  );
  const existingTripIds = new Set(
    baseDepartures.map((dep) => normalize(dep?.trip_id)).filter(Boolean)
  );
  const childStopIds = new Set(
    baseDepartures.map((dep) => normalize(dep?.stop_id)).filter(Boolean)
  );
  if (Array.isArray(scopeStopIds)) {
    for (const sid of scopeStopIds) {
      const v = normalize(sid);
      if (v) childStopIds.add(v);
    }
  }

  const out = [];
  const seen = new Set();
  for (const alert of entities) {
    if (!alert || !alert.id) continue;
    if (!isAlertRelevantForWindow(alert, nowMs, windowMs, graceMs)) continue;

    const tags = classifyTags(alert);
    // Explicit anti-garbage rule: only synthesize if alert clearly implies
    // replacement or extra service.
    if (tags.length === 0) continue;

    const informed = Array.isArray(alert?.informedEntities) ? alert.informedEntities : [];
    const matchedStopsRaw = informed.filter((entity) =>
      stopMatchesScope(entity?.stop_id, stopId, childStopIds)
    );
    const hasStopScopedEntities = informed.some((entity) => normalize(entity?.stop_id));
    const hasRouteOverlap = informed.some((entity) =>
      departureRouteIds.has(normalize(entity?.route_id))
    );
    const hasStationTextHit =
      textContains(alert?.headerText, stationName) ||
      textContains(alert?.descriptionText, stationName);
    let matchedStops = matchedStopsRaw;
    if (
      matchedStops.length === 0 &&
      !hasStopScopedEntities &&
      (hasRouteOverlap || hasStationTextHit)
    ) {
      matchedStops = [{ stop_id: normalize(stopId), route_id: "", trip_id: "" }];
    }
    if (matchedStops.length === 0) continue;

    // Only synthesize timed rows when explicit timetable signals exist.
    // Generic disruption text belongs in banners (attachAlerts), not departures.
    const explicitTimes = collectExplicitDepartureTimes(
      alert,
      nowDate,
      nowMs,
      windowMs,
      graceMs
    );
    if (explicitTimes.length === 0) continue;

    for (const effectiveStartMs of explicitTimes) {
      const msUntil = effectiveStartMs - nowMs;

      for (const entity of matchedStops) {
        const routeId = normalize(entity?.route_id);
        const tripId = normalize(entity?.trip_id);
        if (tripId && existingTripIds.has(tripId)) continue;
        if (!routeId && !tripId && !tags.includes("replacement")) continue;

        const line = pickLine(routeId, tags);
        const key = `${alert.id}|${tripId || ""}|${routeId || ""}|${
          entity?.stop_id || stopId || ""
        }|${effectiveStartMs}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const realtimeIso = new Date(effectiveStartMs).toISOString();
        out.push({
          trip_id:
            tripId || `synthetic_alert:${alert.id}:${Math.floor(effectiveStartMs / 1000)}`,
          route_id: routeId,
          stop_id: normalize(entity?.stop_id) || normalize(stopId),
          stop_sequence: null,
          category: pickCategory(line, tags),
          number: line,
          line,
          name: line,
          destination: normalize(alert?.headerText) || normalize(stationName) || "Alert service",
          operator: "",
          scheduledDeparture: realtimeIso,
          realtimeDeparture: realtimeIso,
          delayMin: 0,
          minutesLeft: msUntil <= 0 ? 0 : Math.floor(msUntil / 60000),
          platform: "",
          platformChanged: false,
          cancelled: false,
          source: "synthetic_alert",
          tags,
          alerts: [],
        });
      }
    }
  }

  out.sort((a, b) => {
    const aMs = Date.parse(a?.realtimeDeparture || a?.scheduledDeparture || "");
    const bMs = Date.parse(b?.realtimeDeparture || b?.scheduledDeparture || "");
    const ax = Number.isFinite(aMs) ? aMs : Number.MAX_SAFE_INTEGER;
    const bx = Number.isFinite(bMs) ? bMs : Number.MAX_SAFE_INTEGER;
    return ax - bx;
  });

  return out.slice(0, Math.max(1, Math.min(Number(limit) || 30, 120)));
}
