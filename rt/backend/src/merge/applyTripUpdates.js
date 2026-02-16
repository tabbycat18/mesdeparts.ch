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

function seqKeyPart(stopSequence) {
  if (stopSequence === undefined || stopSequence === null) return "";
  const n = Number(stopSequence);
  return Number.isFinite(n) ? String(n) : "";
}

function stopIdVariants(stopId) {
  if (!stopId) return [];
  const variants = new Set([String(stopId)]);

  const parts = String(stopId).split(":");
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (String(last).length <= 2) {
      variants.add(parts.slice(0, parts.length - 1).join(":"));
    }
  }

  return Array.from(variants);
}

function getTripUpdate(entity) {
  return pick(entity, "trip_update", "tripUpdate") || null;
}

function getTripIdFromUpdate(update) {
  const trip = pick(update, "trip") || null;
  return pick(trip, "trip_id", "tripId") || null;
}

function getScheduleRelationship(update) {
  const trip = pick(update, "trip") || null;
  const rel = pick(trip, "schedule_relationship", "scheduleRelationship");
  return typeof rel === "string" ? rel.toUpperCase() : "";
}

function getStopTimeUpdates(update) {
  const updates = pick(update, "stop_time_update", "stopTimeUpdate");
  return Array.isArray(updates) ? updates : [];
}

function getStopId(stu) {
  return pick(stu, "stop_id", "stopId") || null;
}

function getStopSequence(stu) {
  const raw = pick(stu, "stop_sequence", "stopSequence");
  const n = asNumber(raw);
  return n === null ? null : n;
}

function getDelaySeconds(stu) {
  const dep = pick(stu, "departure") || null;
  const arr = pick(stu, "arrival") || null;

  const depDelay = dep ? asNumber(pick(dep, "delay")) : null;
  const arrDelay = arr ? asNumber(pick(arr, "delay")) : null;

  if (depDelay !== null) return depDelay;
  if (arrDelay !== null) return arrDelay;
  return 0;
}

function getUpdatedEpoch(stu) {
  const dep = pick(stu, "departure") || null;
  const arr = pick(stu, "arrival") || null;

  const depTime = dep ? asNumber(pick(dep, "time")) : null;
  const arrTime = arr ? asNumber(pick(arr, "time")) : null;

  if (depTime !== null) return depTime;
  if (arrTime !== null) return arrTime;
  return null;
}

function buildRealtimeIndex(tripUpdates) {
  if (tripUpdates?.byKey && typeof tripUpdates.byKey === "object") {
    return tripUpdates.byKey;
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];

  const byKey = Object.create(null);

  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;

    const tripId = getTripIdFromUpdate(tu);
    if (!tripId) continue;

    for (const stu of getStopTimeUpdates(tu)) {
      const rawStopId = getStopId(stu);
      if (!rawStopId) continue;

      const stopSequence = getStopSequence(stu);
      const seqPart = seqKeyPart(stopSequence);
      const delaySec = getDelaySeconds(stu);
      const updatedEpoch = getUpdatedEpoch(stu);

      for (const stopId of stopIdVariants(rawStopId)) {
        const key = `${tripId}|${stopId}|${seqPart}`;

        const prev = byKey[key];
        if (prev) {
          const prevEpoch = prev.updatedDepartureEpoch ?? null;
          if (prevEpoch !== null && updatedEpoch !== null && prevEpoch >= updatedEpoch) {
            continue;
          }
          if (prevEpoch !== null && updatedEpoch === null) {
            continue;
          }
        }

        byKey[key] = {
          tripId,
          stopId,
          stopSequence: seqPart === "" ? null : Number(seqPart),
          delaySec,
          delayMin: Math.round(delaySec / 60),
          updatedDepartureEpoch: updatedEpoch,
        };
      }
    }
  }

  return byKey;
}

function buildCancelledTripIdSet(tripUpdates) {
  if (tripUpdates?.cancelledTripIds instanceof Set) {
    return tripUpdates.cancelledTripIds;
  }

  if (Array.isArray(tripUpdates?.cancelledTripIds)) {
    return new Set(tripUpdates.cancelledTripIds.map((id) => String(id)));
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];

  const cancelled = new Set();

  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;

    const tripId = getTripIdFromUpdate(tu);
    if (!tripId) continue;

    // Cancellation rule for M1: only explicit TripDescriptor.schedule_relationship=CANCELED.
    if (getScheduleRelationship(tu) === "CANCELED") {
      cancelled.add(String(tripId));
    }
  }

  return cancelled;
}

function getDelayForRow(delayByKey, tripId, stopId, stopSequence) {
  if (!delayByKey || !tripId || !stopId) return null;

  const seqPart = seqKeyPart(stopSequence);
  for (const sid of stopIdVariants(stopId)) {
    const keyWithSeq = `${tripId}|${sid}|${seqPart}`;
    if (delayByKey[keyWithSeq]) return delayByKey[keyWithSeq];

    const keyNoSeq = `${tripId}|${sid}|`;
    if (delayByKey[keyNoSeq]) return delayByKey[keyNoSeq];
  }

  return null;
}

export function applyTripUpdates(baseRows, tripUpdates) {
  if (!Array.isArray(baseRows) || baseRows.length === 0) {
    return [];
  }

  const delayByKey = buildRealtimeIndex(tripUpdates);
  const cancelledTripIds = buildCancelledTripIdSet(tripUpdates);

  return baseRows.map((row) => {
    const merged = {
      ...row,
      cancelled: false,
    };

    const scheduledMs = Date.parse(row.scheduledDeparture || "");
    const delay = getDelayForRow(delayByKey, row.trip_id, row.stop_id, row.stop_sequence);

    let realtimeMs = Number.isFinite(scheduledMs) ? scheduledMs : null;
    let delayMin = typeof row.delayMin === "number" ? row.delayMin : 0;

    if (delay) {
      if (typeof delay.updatedDepartureEpoch === "number") {
        realtimeMs = delay.updatedDepartureEpoch * 1000;
        if (Number.isFinite(scheduledMs)) {
          delayMin = Math.round((realtimeMs - scheduledMs) / 60000);
        } else if (typeof delay.delayMin === "number") {
          delayMin = delay.delayMin;
        }
      } else if (typeof delay.delayMin === "number") {
        delayMin = delay.delayMin;
        if (Number.isFinite(scheduledMs)) {
          realtimeMs = scheduledMs + delayMin * 60 * 1000;
        }
      }
    }

    if (realtimeMs !== null) {
      merged.realtimeDeparture = new Date(realtimeMs).toISOString();
    }

    merged.delayMin = delayMin;
    merged.cancelled = cancelledTripIds.has(String(row.trip_id || ""));

    return merged;
  });
}
