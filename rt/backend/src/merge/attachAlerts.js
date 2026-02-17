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

function stopKeySet(value) {
  const raw = normalizeStopId(value);
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
    if (
      normalizedDigits &&
      normalizedDigits !== "0" &&
      !isPlatformScoped &&
      !isSloid
    ) {
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

function isStationLevelStopId(stopId) {
  const raw = normalizeStopId(stopId).toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("parent")) return true;
  if (raw.includes("sloid:")) return true;
  if (raw.includes(":")) return false;
  return true;
}

function uniqPush(arr, value) {
  if (!Array.isArray(arr) || !value) return;
  if (!arr.includes(value)) arr.push(value);
}

function inferAlertTags(alert) {
  const effect = String(alert?.effect || "").toUpperCase();
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
    /\b(ersatz|replacement|remplacement|sostitutiv|substitute|ev(?:\s*\d+)?)\b/i.test(
      text
    )
  ) {
    tags.push("replacement");
  }

  if (
    /\b(short.?turn|terminate early|terminus avanc[ée]|retournement)\b/i.test(text)
  ) {
    tags.push("short_turn");
  }

  if (/\b(does not stop|sans arr[êe]t|h[äa]lt nicht|non effettua fermata)\b/i.test(text)) {
    tags.push("skipped_stop");
  }

  return tags;
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

function stopMatchesScope(
  informedStopId,
  departureStopId,
  requestedStopId,
  childStopIds,
  scopeStopTokens
) {
  const informed = normalizeStopId(informedStopId);
  const departure = normalizeStopId(departureStopId);
  const requested = normalizeStopId(requestedStopId);
  if (!informed || !departure) return false;
  const informedKeys = stopKeySet(informed);
  const departureKeys = stopKeySet(departure);
  if (hasTokenIntersection(informedKeys, departureKeys)) return true;
  if (
    isStationLevelStopId(informed) &&
    hasTokenIntersection(informedKeys, scopeStopTokens)
  ) {
    return true;
  }

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

function shouldAttachServiceTag(tag, matchCtx, dep) {
  const depLine = String(dep?.line || "").trim();
  const depSource = String(dep?.source || "").trim();
  const depHasReplacementTag = Array.isArray(dep?.tags)
    ? dep.tags.includes("replacement")
    : false;

  if (tag !== "replacement" && tag !== "extra") return true;

  // Avoid painting the whole board as replacement from station-wide alerts.
  // Service-class tags are reliable only when route/trip scoped, or when the
  // departure itself already looks like a replacement-service row.
  if (matchCtx.tripMatch || matchCtx.routeMatch) return true;
  if (/^EV/i.test(depLine)) return true;
  if (depSource === "synthetic_alert") return true;
  if (depHasReplacementTag && tag === "replacement") return true;
  return false;
}

function syntheticOriginAlertId(dep) {
  if (String(dep?.source || "") !== "synthetic_alert") return "";
  const tripId = String(dep?.trip_id || "");
  if (!tripId.startsWith("synthetic_alert:")) return "";
  const parts = tripId.split(":");
  return parts.length >= 3 ? parts[1] : "";
}

function isSyntheticDeparture(dep) {
  return String(dep?.source || "") === "synthetic_alert";
}

export function attachAlerts({
  stopId,
  scopeStopIds,
  routeIds,
  tripIds,
  departures,
  alerts,
  now,
}) {
  const sourceDepartures = Array.isArray(departures) ? departures : [];
  const requestedStopId = normalizeStopId(stopId);
  const childStopIds = new Set();
  for (const dep of sourceDepartures) {
    const sid = normalizeStopId(dep?.stop_id);
    if (sid) childStopIds.add(sid);
  }
  if (Array.isArray(scopeStopIds)) {
    for (const sid of scopeStopIds) {
      const v = normalizeStopId(sid);
      if (v) childStopIds.add(v);
    }
  }
  const scopeStopTokens = new Set();
  for (const sid of childStopIds) {
    for (const key of stopKeySet(sid)) scopeStopTokens.add(key);
  }
  for (const key of stopKeySet(requestedStopId)) scopeStopTokens.add(key);
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

  const departuresOut = sourceDepartures.map((dep) => ({
    ...dep,
    tags: Array.isArray(dep?.tags) ? [...dep.tags] : [],
    alerts: [],
  }));
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
      if (hasTokenIntersection(stopKeySet(informedStop), scopeStopTokens)) return true;
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
            hasTokenIntersection(stopKeySet(informedStop), scopeStopTokens) ||
            (isParentStopId(requestedStopId) && childStopIds.has(informedStop))
          );
        }),
      });
    }

    // B) Per-departure tags.
    for (let idx = 0; idx < departuresOut.length; idx += 1) {
      const dep = departuresOut[idx];
      const originAlertId = syntheticOriginAlertId(dep);
      if (isSyntheticDeparture(dep) && !originAlertId) continue;
      if (originAlertId && String(alert.id) !== originAlertId) continue;
      const isSyntheticOriginMatch =
        !!originAlertId && String(alert.id) === originAlertId;

      const depTripId = dep?.trip_id ? String(dep.trip_id) : "";
      const depRouteId = dep?.route_id ? String(dep.route_id) : "";
      const depStopId = normalizeStopId(dep?.stop_id);
      const depStopSeq =
        dep?.stop_sequence == null ? null : Number(dep.stop_sequence);

      const matchCtx = {
        tripMatch: false,
        routeMatch: false,
        stopMatch: false,
        stopSeqMatch: false,
      };

      const depMatched =
        isSyntheticOriginMatch ||
        informedEntities.some((entity) => {
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
            childStopIds,
            scopeStopTokens
          );

          const stopSeqMatch =
            entity?.stop_sequence != null &&
            depStopSeq != null &&
            Number(entity.stop_sequence) === depStopSeq;

          if (tripMatch) matchCtx.tripMatch = true;
          if (routeMatch) matchCtx.routeMatch = true;
          if (stopMatch) matchCtx.stopMatch = true;
          if (stopSeqMatch) matchCtx.stopSeqMatch = true;

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
      for (const tag of inferAlertTags(alert)) {
        if (!shouldAttachServiceTag(tag, matchCtx, dep)) continue;
        uniqPush(dep.tags, tag);
      }
    }
  }

  return {
    banners,
    departures: departuresOut,
  };
}
