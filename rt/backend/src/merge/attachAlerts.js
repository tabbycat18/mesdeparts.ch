function toSet(values) {
  if (!values) return new Set();
  if (values instanceof Set) return new Set(values);
  if (Array.isArray(values)) return new Set(values.map((v) => String(v)));
  return new Set([String(values)]);
}

function hasValues(values) {
  if (!values) return false;
  if (values instanceof Set) return values.size > 0;
  if (Array.isArray(values)) return values.length > 0;
  return true;
}

function normalizeStopId(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeNow(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now;
  return new Date();
}

function getPeriodTime(periodValue) {
  if (periodValue == null) return null;
  if (periodValue instanceof Date) {
    return Number.isFinite(periodValue.getTime()) ? periodValue.getTime() : null;
  }
  if (typeof periodValue === "number" && Number.isFinite(periodValue)) {
    // Support unix-seconds and ms values.
    return periodValue < 2_000_000_000 ? periodValue * 1000 : periodValue;
  }
  if (typeof periodValue === "string" && periodValue.trim() !== "") {
    const asNumber = Number(periodValue);
    if (Number.isFinite(asNumber)) {
      return asNumber < 2_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(periodValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isActiveNow(alert, now) {
  const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
  if (periods.length === 0) return true;

  const nowMs = normalizeNow(now).getTime();
  for (const period of periods) {
    const startMs = getPeriodTime(period?.start);
    const endMs = getPeriodTime(period?.end);
    const afterStart = startMs == null ? true : nowMs >= startMs;
    const beforeEnd = endMs == null ? true : nowMs <= endMs;
    if (afterStart && beforeEnd) return true;
  }
  return false;
}

function isParentStopId(stopId) {
  return normalizeStopId(stopId).startsWith("Parent");
}

function stopMatchesScope(informedStopId, departureStopId, requestedStopId, childStopIds) {
  const informed = normalizeStopId(informedStopId);
  const departure = normalizeStopId(departureStopId);
  const requested = normalizeStopId(requestedStopId);
  if (!informed || !departure) return false;
  if (informed === departure) return true;

  if (!requested || !isParentStopId(requested)) return false;

  // Parent->child and child->parent matching within the requested station scope.
  if (informed === requested && childStopIds.has(departure)) return true;
  if (departure === requested && childStopIds.has(informed)) return true;
  return false;
}

function pickFirstAffected(informedEntities, matchFn) {
  for (const entity of informedEntities) {
    if (matchFn(entity)) {
      return {
        stop_id: entity.stop_id || undefined,
        route_id: entity.route_id || undefined,
        trip_id: entity.trip_id || undefined,
      };
    }
  }
  return {};
}

export function attachAlerts({
  stopId,
  routeIds,
  tripIds,
  departures,
  alerts,
  now,
}) {
  const sourceDepartures = Array.isArray(departures) ? departures : [];
  const requestedStopId = normalizeStopId(stopId);
  const childStopIds = new Set(
    sourceDepartures.map((dep) => normalizeStopId(dep?.stop_id)).filter(Boolean)
  );
  const effectiveRouteIds = toSet(
    hasValues(routeIds)
      ? routeIds
      : sourceDepartures.map((dep) => dep?.route_id).filter(Boolean)
  );
  const effectiveTripIds = toSet(
    hasValues(tripIds)
      ? tripIds
      : sourceDepartures.map((dep) => dep?.trip_id).filter(Boolean)
  );
  const allAlerts = Array.isArray(alerts?.entities) ? alerts.entities : [];
  const currentNow = normalizeNow(now);

  const banners = [];
  const bannerSeen = new Set();

  const departuresOut = sourceDepartures.map((dep) => ({ ...dep, alerts: [] }));
  const depSeenByIndex = departuresOut.map(() => new Set());

  for (const alert of allAlerts) {
    if (!alert || !alert.id) continue;
    if (!isActiveNow(alert, currentNow)) continue;

    const informedEntities = Array.isArray(alert.informedEntities)
      ? alert.informedEntities
      : [];

    // A) Stop-level banners.
    const bannerMatch = informedEntities.some((entity) => {
      const informedStop = normalizeStopId(entity?.stop_id);
      if (!informedStop) return false;
      if (informedStop === requestedStopId) return true;
      if (isParentStopId(requestedStopId) && childStopIds.has(informedStop)) return true;
      return false;
    });

    if (bannerMatch && !bannerSeen.has(alert.id)) {
      bannerSeen.add(alert.id);
      banners.push({
        severity: alert.severity || "unknown",
        header: alert.headerText || "",
        description: alert.descriptionText || "",
        affected: pickFirstAffected(informedEntities, (entity) => {
          const informedStop = normalizeStopId(entity?.stop_id);
          return (
            informedStop === requestedStopId ||
            (isParentStopId(requestedStopId) && childStopIds.has(informedStop))
          );
        }),
      });
    }

    // B) Per-departure tags.
    for (let idx = 0; idx < departuresOut.length; idx += 1) {
      const dep = departuresOut[idx];
      const depTripId = dep?.trip_id ? String(dep.trip_id) : "";
      const depRouteId = dep?.route_id ? String(dep.route_id) : "";
      const depStopId = normalizeStopId(dep?.stop_id);
      const depStopSeq =
        dep?.stop_sequence == null ? null : Number(dep.stop_sequence);

      const depMatched = informedEntities.some((entity) => {
        const tripMatch =
          !!depTripId &&
          !!entity?.trip_id &&
          String(entity.trip_id) === depTripId &&
          (effectiveTripIds.size === 0 || effectiveTripIds.has(depTripId));

        const routeMatch =
          !!depRouteId &&
          !!entity?.route_id &&
          String(entity.route_id) === depRouteId &&
          (effectiveRouteIds.size === 0 || effectiveRouteIds.has(depRouteId));

        const stopMatch = stopMatchesScope(
          entity?.stop_id,
          depStopId,
          requestedStopId,
          childStopIds
        );

        const stopSeqMatch =
          entity?.stop_sequence != null &&
          depStopSeq != null &&
          Number(entity.stop_sequence) === depStopSeq;

        return tripMatch || routeMatch || stopMatch || stopSeqMatch;
      });

      if (!depMatched) continue;
      if (depSeenByIndex[idx].has(alert.id)) continue;

      depSeenByIndex[idx].add(alert.id);
      dep.alerts.push({
        id: alert.id,
        severity: alert.severity || "unknown",
        header: alert.headerText || "",
      });
    }
  }

  return {
    banners,
    departures: departuresOut,
  };
}
