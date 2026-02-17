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

function stopKeySet(value) {
  const raw = normalize(value);
  const out = new Set();
  if (!raw) return out;

  const lowerRaw = raw.toLowerCase();
  out.add(lowerRaw);

  const noParent = lowerRaw.startsWith("parent")
    ? lowerRaw.slice("parent".length)
    : lowerRaw;
  if (noParent) out.add(noParent);
  const isSloid = lowerRaw.includes("sloid:");
  const isPlatformScoped = noParent.includes(":") && !isSloid;

  const base = noParent.split(":")[0] || noParent;
  if (base && !isPlatformScoped && !isSloid) out.add(base);

  const sloidMatch = lowerRaw.match(/sloid:(\d+)/i);
  if (sloidMatch?.[1]) {
    const sl = String(Number(sloidMatch[1]));
    if (sl && sl !== "0") out.add(sl);
  }

  if (/^\d+$/.test(base)) {
    const normalizedDigits = String(Number(base));
    if (normalizedDigits && normalizedDigits !== "0" && !isPlatformScoped && !isSloid) {
      out.add(normalizedDigits);
    }
    if (!isPlatformScoped && !isSloid && base.startsWith("850") && base.length > 3) {
      const tail = String(Number(base.slice(3)));
      if (tail && tail !== "0") out.add(tail);
    }
  }

  return out;
}

function hasTokenIntersection(aSet, bSet) {
  for (const token of aSet) {
    if (bSet.has(token)) return true;
  }
  return false;
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
  return normalize(stopId).startsWith("Parent");
}

function stationRootFromRequestedStop(stopId) {
  const raw = normalize(stopId);
  if (!raw) return "";
  if (raw.startsWith("Parent")) return raw.slice("Parent".length);
  const parts = raw.split(":");
  return parts[0] || raw;
}

function stopMatchesScope(informedStopId, requestedStopId, childStopIds) {
  const informed = normalize(informedStopId);
  const requested = normalize(requestedStopId);
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

    const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
    const periodList = periods.length ? periods : [{ start: null, end: null }];
    for (const period of periodList) {
      const startMs = getPeriodMs(period?.start);
      const endMs = getPeriodMs(period?.end);
      const isActiveNow =
        (startMs == null || startMs <= nowMs) &&
        (endMs == null || endMs >= nowMs - graceMs);

      // If an alert period already started and is still active, place a synthetic
      // replacement row near "now" (not at original past start time).
      let effectiveStartMs = null;
      if (Number.isFinite(startMs)) {
        effectiveStartMs =
          startMs < nowMs - graceMs && isActiveNow ? nowMs + 2 * 60 * 1000 : startMs;
      } else if (isActiveNow) {
        effectiveStartMs = nowMs + 2 * 60 * 1000;
      }
      if (!Number.isFinite(effectiveStartMs)) continue;

      const msUntil = effectiveStartMs - nowMs;
      if (msUntil < -graceMs) continue;
      if (msUntil > windowMs) continue;

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
