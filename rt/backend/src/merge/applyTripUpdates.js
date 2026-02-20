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

function normalizeTripStartDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return "";
  return digits;
}

function buildStopKey(tripId, stopId, seqPart, tripStartDate = "") {
  const start = normalizeTripStartDate(tripStartDate);
  const base = `${tripId}|${stopId}|${seqPart}`;
  return start ? `${base}|${start}` : base;
}

function buildTripStartKey(tripId, tripStartDate = "") {
  const id = String(tripId || "").trim();
  if (!id) return "";
  const start = normalizeTripStartDate(tripStartDate);
  return start ? `${id}|${start}` : `${id}|`;
}

const ZURICH_YMD_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function ymdZurichFromIso(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  const parts = ZURICH_YMD_FORMATTER.formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  if (!year || !month || !day) return "";
  return `${year}${month}${day}`;
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

function getTripStartDateFromUpdate(update) {
  const trip = pick(update, "trip") || null;
  return normalizeTripStartDate(pick(trip, "start_date", "startDate"));
}

function getScheduleRelationship(update) {
  const trip = pick(update, "trip") || null;
  const rel = pick(trip, "schedule_relationship", "scheduleRelationship");
  if (typeof rel === "string") {
    const normalized = rel.toUpperCase();
    return normalized === "CANCELLED" ? "CANCELED" : normalized;
  }
  const n = asNumber(rel);
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

function getStopScheduleRelationship(stu) {
  const rel = pick(stu, "schedule_relationship", "scheduleRelationship");
  if (typeof rel === "string") return rel.toUpperCase();
  const n = asNumber(rel);
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

function addTag(tags, tag) {
  if (!Array.isArray(tags) || !tag) return;
  if (!tags.includes(tag)) tags.push(tag);
}

function addCancelReason(row, reason) {
  if (!reason) return;
  if (!Array.isArray(row.cancelReasons)) row.cancelReasons = [];
  if (!row.cancelReasons.includes(reason)) row.cancelReasons.push(reason);
}

function shouldApplyRealtimeEpoch(scheduledMs, realtimeMs) {
  if (!Number.isFinite(realtimeMs)) return false;
  if (!Number.isFinite(scheduledMs)) return true;

  // TripUpdates are keyed without service date in our merge key.
  // Guard against cross-day collisions by rejecting implausible offsets.
  const maxDriftMinutes = Math.max(
    30,
    Number(process.env.RT_MERGE_MAX_DRIFT_MINUTES || "240")
  );
  const driftMs = Math.abs(realtimeMs - scheduledMs);
  return driftMs <= maxDriftMinutes * 60 * 1000;
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
    const tripStartDate = getTripStartDateFromUpdate(tu);

    for (const stu of getStopTimeUpdates(tu)) {
      const rawStopId = getStopId(stu);
      if (!rawStopId) continue;

      const stopSequence = getStopSequence(stu);
      const seqPart = seqKeyPart(stopSequence);
      const delaySec = getDelaySeconds(stu);
      const updatedEpoch = getUpdatedEpoch(stu);

      for (const stopId of stopIdVariants(rawStopId)) {
        const key = buildStopKey(tripId, stopId, seqPart, tripStartDate);

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
          tripStartDate,
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

    // Cancellation at trip-level: explicit TripDescriptor.schedule_relationship=CANCELED.
    if (getScheduleRelationship(tu) === "CANCELED") {
      cancelled.add(String(tripId));
    }
  }

  return cancelled;
}

function buildCancelledTripStartDatesByTripId(tripUpdates) {
  if (
    tripUpdates?.cancelledTripStartDatesByTripId &&
    typeof tripUpdates.cancelledTripStartDatesByTripId === "object"
  ) {
    return tripUpdates.cancelledTripStartDatesByTripId;
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];

  const out = Object.create(null);
  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;
    const tripId = getTripIdFromUpdate(tu);
    if (!tripId) continue;
    if (getScheduleRelationship(tu) !== "CANCELED") continue;

    const key = String(tripId);
    if (!out[key]) out[key] = new Set();
    out[key].add(getTripStartDateFromUpdate(tu));
  }
  return out;
}

function buildStopStatusIndex(tripUpdates) {
  if (tripUpdates?.stopStatusByKey && typeof tripUpdates.stopStatusByKey === "object") {
    return tripUpdates.stopStatusByKey;
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
    const tripStartDate = getTripStartDateFromUpdate(tu);

    for (const stu of getStopTimeUpdates(tu)) {
      const stopId = getStopId(stu);
      if (!stopId) continue;
      const seq = getStopSequence(stu);
      const seqPart = seqKeyPart(seq);
      const rel = getStopScheduleRelationship(stu);
      if (!rel) continue;
      const epoch = getUpdatedEpoch(stu);
      for (const sid of stopIdVariants(stopId)) {
        const key = buildStopKey(tripId, sid, seqPart, tripStartDate);
        const prev = byKey[key];
        const prevEpoch =
          prev && Number.isFinite(prev.updatedDepartureEpoch)
            ? prev.updatedDepartureEpoch
            : null;
        const nextEpoch = Number.isFinite(epoch) ? epoch : null;
        if (prevEpoch !== null && nextEpoch !== null && prevEpoch > nextEpoch) continue;
        if (prevEpoch !== null && nextEpoch === null) continue;
        byKey[key] = {
          relationship: rel,
          updatedDepartureEpoch: nextEpoch,
          tripStartDate,
        };
      }
    }
  }
  return byKey;
}

function buildTripFlagsByTripId(tripUpdates) {
  if (tripUpdates?.tripFlagsByTripId && typeof tripUpdates.tripFlagsByTripId === "object") {
    return tripUpdates.tripFlagsByTripId;
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];

  const out = Object.create(null);
  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;
    const tripId = getTripIdFromUpdate(tu);
    if (!tripId) continue;

    for (const stu of getStopTimeUpdates(tu)) {
      const rel = getStopScheduleRelationship(stu);
      if (rel !== "SKIPPED") continue;

      const seq = getStopSequence(stu);
      const key = String(tripId);
      const prev = out[key] || {
        hasSuppressedStop: false,
        maxSuppressedStopSequence: null,
        minSuppressedStopSequence: null,
        hasUnknownSuppressedSequence: false,
      };
      prev.hasSuppressedStop = true;
      if (Number.isFinite(seq)) {
        const n = Number(seq);
        if (prev.maxSuppressedStopSequence === null || n > prev.maxSuppressedStopSequence) {
          prev.maxSuppressedStopSequence = n;
        }
        if (prev.minSuppressedStopSequence === null || n < prev.minSuppressedStopSequence) {
          prev.minSuppressedStopSequence = n;
        }
      } else {
        prev.hasUnknownSuppressedSequence = true;
      }
      out[key] = prev;
    }
  }

  return out;
}

function buildTripFlagsByTripStartKey(tripUpdates) {
  if (
    tripUpdates?.tripFlagsByTripStartKey &&
    typeof tripUpdates.tripFlagsByTripStartKey === "object"
  ) {
    return tripUpdates.tripFlagsByTripStartKey;
  }

  const entities = Array.isArray(tripUpdates?.entities)
    ? tripUpdates.entities
    : Array.isArray(tripUpdates?.entity)
      ? tripUpdates.entity
      : [];

  const out = Object.create(null);
  for (const entity of entities) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;
    const tripId = getTripIdFromUpdate(tu);
    if (!tripId) continue;
    const tripStartDate = getTripStartDateFromUpdate(tu);

    for (const stu of getStopTimeUpdates(tu)) {
      const rel = getStopScheduleRelationship(stu);
      if (rel !== "SKIPPED") continue;

      const seq = getStopSequence(stu);
      const key = buildTripStartKey(tripId, tripStartDate);
      const prev = out[key] || {
        tripId: String(tripId),
        tripStartDate,
        hasSuppressedStop: false,
        maxSuppressedStopSequence: null,
        minSuppressedStopSequence: null,
        hasUnknownSuppressedSequence: false,
      };
      prev.hasSuppressedStop = true;
      if (Number.isFinite(seq)) {
        const n = Number(seq);
        if (prev.maxSuppressedStopSequence === null || n > prev.maxSuppressedStopSequence) {
          prev.maxSuppressedStopSequence = n;
        }
        if (prev.minSuppressedStopSequence === null || n < prev.minSuppressedStopSequence) {
          prev.minSuppressedStopSequence = n;
        }
      } else {
        prev.hasUnknownSuppressedSequence = true;
      }
      out[key] = prev;
    }
  }

  return out;
}

function matchesTripStartDate(candidate, rowTripStartDate) {
  const rowStart = normalizeTripStartDate(rowTripStartDate);
  if (!rowStart) return true;
  const candidateStart = normalizeTripStartDate(candidate?.tripStartDate);
  if (!candidateStart) return true;
  return candidateStart === rowStart;
}

function getDelayForRow(delayByKey, tripId, stopId, stopSequence, tripStartDate = "") {
  if (!delayByKey || !tripId || !stopId) return null;

  const seqPart = seqKeyPart(stopSequence);
  const start = normalizeTripStartDate(tripStartDate);
  for (const sid of stopIdVariants(stopId)) {
    const keyWithSeq = buildStopKey(tripId, sid, seqPart, start);
    if (delayByKey[keyWithSeq] && matchesTripStartDate(delayByKey[keyWithSeq], start)) {
      return delayByKey[keyWithSeq];
    }

    const keyNoSeq = buildStopKey(tripId, sid, "", start);
    if (delayByKey[keyNoSeq] && matchesTripStartDate(delayByKey[keyNoSeq], start)) {
      return delayByKey[keyNoSeq];
    }

    // Backward-compatible fallback for legacy indexes that had no start-date in key.
    const legacyWithSeq = `${tripId}|${sid}|${seqPart}`;
    if (delayByKey[legacyWithSeq] && matchesTripStartDate(delayByKey[legacyWithSeq], start)) {
      return delayByKey[legacyWithSeq];
    }
    const legacyNoSeq = `${tripId}|${sid}|`;
    if (delayByKey[legacyNoSeq] && matchesTripStartDate(delayByKey[legacyNoSeq], start)) {
      return delayByKey[legacyNoSeq];
    }
  }

  return null;
}

function getStopStatusForRow(
  stopStatusByKey,
  tripId,
  stopId,
  stopSequence,
  tripStartDate = ""
) {
  if (!stopStatusByKey || !tripId || !stopId) return null;
  const seqPart = seqKeyPart(stopSequence);
  const start = normalizeTripStartDate(tripStartDate);

  for (const sid of stopIdVariants(stopId)) {
    const withSeq = stopStatusByKey[buildStopKey(tripId, sid, seqPart, start)];
    if (withSeq?.relationship && matchesTripStartDate(withSeq, start)) {
      return withSeq.relationship;
    }

    const withoutSeq = stopStatusByKey[buildStopKey(tripId, sid, "", start)];
    if (withoutSeq?.relationship && matchesTripStartDate(withoutSeq, start)) {
      return withoutSeq.relationship;
    }

    const legacyWithSeq = stopStatusByKey[`${tripId}|${sid}|${seqPart}`];
    if (legacyWithSeq?.relationship && matchesTripStartDate(legacyWithSeq, start)) {
      return legacyWithSeq.relationship;
    }

    const legacyWithoutSeq = stopStatusByKey[`${tripId}|${sid}|`];
    if (legacyWithoutSeq?.relationship && matchesTripStartDate(legacyWithoutSeq, start)) {
      return legacyWithoutSeq.relationship;
    }
  }
  return null;
}

export function applyTripUpdates(baseRows, tripUpdates) {
  if (!Array.isArray(baseRows) || baseRows.length === 0) {
    return [];
  }

  const delayByKey = buildRealtimeIndex(tripUpdates);
  const cancelledTripIds = buildCancelledTripIdSet(tripUpdates);
  const cancelledTripStartDatesByTripId =
    buildCancelledTripStartDatesByTripId(tripUpdates);
  const stopStatusByKey = buildStopStatusIndex(tripUpdates);
  const tripFlagsByTripId = buildTripFlagsByTripId(tripUpdates);
  const tripFlagsByTripStartKey = buildTripFlagsByTripStartKey(tripUpdates);

  return baseRows.map((row) => {
    const merged = {
      ...row,
      cancelled: row?.cancelled === true,
      cancelReasons: Array.isArray(row?.cancelReasons) ? [...row.cancelReasons] : [],
      source: row?.source || "scheduled",
      tags: Array.isArray(row?.tags) ? [...row.tags] : [],
      suppressedStop: false,
      _rtMatched: row?._rtMatched === true,
    };
    if (merged.cancelled) addCancelReason(merged, "preexisting_cancelled_flag");

    const scheduledMs = Date.parse(row.scheduledDeparture || "");
    const rowTripStartDate =
      ymdZurichFromIso(row.scheduledDeparture || row.realtimeDeparture || "");
    const delay = getDelayForRow(
      delayByKey,
      row.trip_id,
      row.stop_id,
      row.stop_sequence,
      rowTripStartDate
    );

    let realtimeMs = Number.isFinite(scheduledMs) ? scheduledMs : null;
    let delayMin = typeof row.delayMin === "number" ? row.delayMin : null;

    if (delay) {
      merged._rtMatched = true;
      if (typeof delay.updatedDepartureEpoch === "number") {
        const candidateRealtimeMs = delay.updatedDepartureEpoch * 1000;
        if (shouldApplyRealtimeEpoch(scheduledMs, candidateRealtimeMs)) {
          realtimeMs = candidateRealtimeMs;
          if (Number.isFinite(scheduledMs)) {
            delayMin = Math.round((realtimeMs - scheduledMs) / 60000);
          } else if (typeof delay.delayMin === "number") {
            delayMin = delay.delayMin;
          }
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
    const tripIdKey = String(row.trip_id || "");
    const cancelledStartSet = cancelledTripStartDatesByTripId[tripIdKey];
    const hasStartSpecificCancellation = cancelledStartSet instanceof Set && cancelledStartSet.size > 0;
    const isCancelledForStart =
      cancelledStartSet instanceof Set &&
      (cancelledStartSet.has(rowTripStartDate) || cancelledStartSet.has(""));
    if (isCancelledForStart || (!hasStartSpecificCancellation && cancelledTripIds.has(tripIdKey))) {
      merged.cancelled = true;
      addCancelReason(merged, "trip_schedule_relationship_canceled");
      merged._rtMatched = true;
    }
    const stopStatus = getStopStatusForRow(
      stopStatusByKey,
      row.trip_id,
      row.stop_id,
      row.stop_sequence,
      rowTripStartDate
    );
    if (stopStatus) {
      merged._rtMatched = true;
    }
    if (stopStatus === "SKIPPED") {
      merged.suppressedStop = true;
      addTag(merged.tags, "skipped_stop");
      merged.cancelled = true;
      addCancelReason(merged, "skipped_stop");
    }

    const tripStartKey = buildTripStartKey(row.trip_id, rowTripStartDate);
    const tripFlags =
      tripFlagsByTripStartKey[tripStartKey] ||
      (row?.trip_id ? tripFlagsByTripId[String(row.trip_id)] : null);
    const rowStopSeqRaw = row?.stop_sequence;
    const rowStopSeq = rowStopSeqRaw == null ? Number.NaN : Number(rowStopSeqRaw);
    if (tripFlags?.hasSuppressedStop && !merged.suppressedStop) {
      const hasDownstreamSuppression =
        Number.isFinite(rowStopSeq) &&
        Number.isFinite(tripFlags.maxSuppressedStopSequence) &&
        tripFlags.maxSuppressedStopSequence > rowStopSeq;
      const suppressionStartsAtNextStop =
        Number.isFinite(rowStopSeq) &&
        Number.isFinite(tripFlags.minSuppressedStopSequence) &&
        tripFlags.minSuppressedStopSequence === rowStopSeq + 1;
      const noSeqSignal = !Number.isFinite(rowStopSeq) && tripFlags.hasSuppressedStop;
      if (hasDownstreamSuppression || noSeqSignal || tripFlags.hasUnknownSuppressedSequence) {
        addTag(merged.tags, "short_turn");
      }
      if (suppressionStartsAtNextStop) {
        merged.cancelled = true;
        addCancelReason(merged, "short_turn_terminus_next_stop_skipped");
        addTag(merged.tags, "short_turn_terminus");
      }
    }

    if (merged._rtMatched && merged.source === "scheduled") {
      merged.source = "tripupdate";
    }

    return merged;
  });
}
