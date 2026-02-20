import {
  computeDelaySecondsFromTimestamps,
  computeDepartureDelayDisplayFromSeconds,
} from "../util/departureDelay.js";

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

const RT_TRIP_FALLBACK_MAX_SEQ_GAP = Math.max(
  1,
  Number(process.env.RT_TRIP_FALLBACK_MAX_SEQ_GAP || "4")
);

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
  const depDelay = dep ? asNumber(pick(dep, "delay")) : null;
  if (depDelay !== null) return depDelay;
  return null;
}

function getUpdatedEpoch(stu) {
  const dep = pick(stu, "departure") || null;
  const depTime = dep ? asNumber(pick(dep, "time")) : null;
  if (depTime !== null) return depTime;
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

function upsertTripFallbackCandidate(byTripStart, candidate) {
  if (!byTripStart || typeof byTripStart !== "object") return;
  const tripId = String(candidate?.tripId || "").trim();
  if (!tripId) return;
  const start = normalizeTripStartDate(candidate?.tripStartDate);
  const seq = Number(candidate?.stopSequence);
  if (!Number.isFinite(seq)) return;

  const delaySecRaw =
    typeof candidate?.delaySec === "number" && Number.isFinite(candidate.delaySec)
      ? Number(candidate.delaySec)
      : typeof candidate?.delayMin === "number" && Number.isFinite(candidate.delayMin)
        ? Number(candidate.delayMin) * 60
        : null;
  if (!Number.isFinite(delaySecRaw)) return;

  const key = start ? `${tripId}|${start}` : `${tripId}|`;
  if (!byTripStart[key]) byTripStart[key] = [];
  const list = byTripStart[key];
  const next = {
    tripId,
    tripStartDate: start,
    stopSequence: seq,
    delaySec: delaySecRaw,
    delayMin:
      typeof candidate?.delayMin === "number" && Number.isFinite(candidate.delayMin)
        ? Number(candidate.delayMin)
        : null,
    updatedDepartureEpoch:
      typeof candidate?.updatedDepartureEpoch === "number" &&
      Number.isFinite(candidate.updatedDepartureEpoch)
        ? Number(candidate.updatedDepartureEpoch)
        : null,
  };

  const existingIndex = list.findIndex((row) => Number(row?.stopSequence) === seq);
  if (existingIndex < 0) {
    list.push(next);
    return;
  }
  const prev = list[existingIndex];
  const prevEpoch =
    typeof prev?.updatedDepartureEpoch === "number" && Number.isFinite(prev.updatedDepartureEpoch)
      ? Number(prev.updatedDepartureEpoch)
      : null;
  const nextEpoch = next.updatedDepartureEpoch;

  if (prevEpoch !== null && nextEpoch !== null && prevEpoch > nextEpoch) return;
  if (prevEpoch !== null && nextEpoch === null) return;
  list[existingIndex] = next;
}

function deriveTripFallbackByTripStart(delayByKey) {
  const out = Object.create(null);
  for (const value of Object.values(delayByKey || {})) {
    upsertTripFallbackCandidate(out, value);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => Number(a?.stopSequence || 0) - Number(b?.stopSequence || 0));
  }
  return out;
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
  const tripFallbackByTripStart = Object.create(null);

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
      const delayDisplay = computeDepartureDelayDisplayFromSeconds(delaySec);
      upsertTripFallbackCandidate(tripFallbackByTripStart, {
        tripId,
        tripStartDate,
        stopSequence,
        delaySec,
        delayMin: delayDisplay.delayMinAfterClamp,
        updatedDepartureEpoch: updatedEpoch,
      });

      for (const stopId of stopIdVariants(rawStopId)) {
        const candidateKeys = [buildStopKey(tripId, stopId, seqPart, tripStartDate)];
        if (seqPart !== "") {
          // Keep a no-sequence alias so static/RT sequence drifts still match by trip+stop.
          candidateKeys.push(buildStopKey(tripId, stopId, "", tripStartDate));
        }

        for (const key of candidateKeys) {
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
            delayMin: delayDisplay.delayMinAfterClamp,
            updatedDepartureEpoch: updatedEpoch,
            tripStartDate,
          };
        }
      }
    }
  }

  return {
    byKey,
    tripFallbackByTripStart,
  };
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

function getDelayMatchForRow(delayByKey, tripId, stopId, stopSequence, tripStartDate = "") {
  if (!delayByKey || !tripId || !stopId) return null;

  const seqPart = seqKeyPart(stopSequence);
  const hasStopSequence = seqPart !== "";
  const start = normalizeTripStartDate(tripStartDate);
  for (const sid of stopIdVariants(stopId)) {
    const keyWithSeq = buildStopKey(tripId, sid, seqPart, start);
    if (delayByKey[keyWithSeq] && matchesTripStartDate(delayByKey[keyWithSeq], start)) {
      return {
        delay: delayByKey[keyWithSeq],
        matchReason: hasStopSequence ? "stop_exact" : "stop_noseq",
      };
    }

    const keyNoSeq = buildStopKey(tripId, sid, "", start);
    if (delayByKey[keyNoSeq] && matchesTripStartDate(delayByKey[keyNoSeq], start)) {
      return {
        delay: delayByKey[keyNoSeq],
        matchReason: "stop_noseq",
      };
    }

    // Backward-compatible fallback for legacy indexes that had no start-date in key.
    const legacyWithSeq = `${tripId}|${sid}|${seqPart}`;
    if (delayByKey[legacyWithSeq] && matchesTripStartDate(delayByKey[legacyWithSeq], start)) {
      return {
        delay: delayByKey[legacyWithSeq],
        matchReason: hasStopSequence ? "stop_exact" : "stop_noseq",
      };
    }
    const legacyNoSeq = `${tripId}|${sid}|`;
    if (delayByKey[legacyNoSeq] && matchesTripStartDate(delayByKey[legacyNoSeq], start)) {
      return {
        delay: delayByKey[legacyNoSeq],
        matchReason: "stop_noseq",
      };
    }
  }

  return null;
}

function getTripFallbackDelayForRow(
  tripFallbackByTripStart,
  tripId,
  stopSequence,
  tripStartDate = ""
) {
  if (!tripFallbackByTripStart || !tripId) return null;
  const start = normalizeTripStartDate(tripStartDate);
  const keyWithStart = start ? `${tripId}|${start}` : "";
  const keyNoStart = `${tripId}|`;
  const candidates = Array.isArray(tripFallbackByTripStart[keyWithStart])
    ? tripFallbackByTripStart[keyWithStart]
    : Array.isArray(tripFallbackByTripStart[keyNoStart])
      ? tripFallbackByTripStart[keyNoStart]
      : [];
  if (!candidates.length) return null;

  const rowSeq = Number(stopSequence);
  if (Number.isFinite(rowSeq)) {
    let best = null;
    for (const item of candidates) {
      const seq = Number(item?.stopSequence);
      if (!Number.isFinite(seq)) continue;
      const gap = Math.abs(seq - rowSeq);
      if (!Number.isFinite(gap) || gap > RT_TRIP_FALLBACK_MAX_SEQ_GAP) continue;
      const isDownstream = seq > rowSeq ? 1 : 0;
      const updatedEpoch =
        typeof item?.updatedDepartureEpoch === "number" &&
        Number.isFinite(item.updatedDepartureEpoch)
          ? Number(item.updatedDepartureEpoch)
          : -1;
      const score = [gap, isDownstream, -updatedEpoch];
      if (!best || score[0] < best.score[0]) {
        best = { item, score };
        continue;
      }
      if (score[0] > best.score[0]) continue;
      if (score[1] < best.score[1]) {
        best = { item, score };
        continue;
      }
      if (score[1] > best.score[1]) continue;
      if (score[2] < best.score[2]) best = { item, score };
    }
    return best?.item || null;
  }

  return candidates.find((item) => Number.isFinite(Number(item?.delaySec))) || null;
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

  const realtimeIndex = buildRealtimeIndex(tripUpdates);
  const delayByKey =
    realtimeIndex?.byKey && typeof realtimeIndex.byKey === "object"
      ? realtimeIndex.byKey
      : realtimeIndex && typeof realtimeIndex === "object"
        ? realtimeIndex
        : Object.create(null);
  const tripFallbackByTripStart =
    tripUpdates?.tripFallbackByTripStart &&
    typeof tripUpdates.tripFallbackByTripStart === "object"
      ? tripUpdates.tripFallbackByTripStart
      : realtimeIndex?.tripFallbackByTripStart &&
          typeof realtimeIndex.tripFallbackByTripStart === "object"
        ? realtimeIndex.tripFallbackByTripStart
        : deriveTripFallbackByTripStart(delayByKey);
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
      _rtMatchReason: typeof row?._rtMatchReason === "string" ? row._rtMatchReason : null,
    };
    if (merged.cancelled) addCancelReason(merged, "preexisting_cancelled_flag");

    const scheduledMs = Date.parse(row.scheduledDeparture || "");
    const rowTripStartDate =
      ymdZurichFromIso(row.scheduledDeparture || row.realtimeDeparture || "");
    const delayMatch = getDelayMatchForRow(
      delayByKey,
      row.trip_id,
      row.stop_id,
      row.stop_sequence,
      rowTripStartDate
    );
    const delay = delayMatch?.delay || null;
    if (delayMatch?.matchReason) {
      merged._rtMatchReason = delayMatch.matchReason;
    }
    const tripFallbackDelay = delay
      ? null
      : getTripFallbackDelayForRow(
          tripFallbackByTripStart,
          row.trip_id,
          row.stop_sequence,
          rowTripStartDate
        );

    let realtimeMs = Number.isFinite(scheduledMs) ? scheduledMs : null;
    let delayMin = typeof row.delayMin === "number" ? row.delayMin : null;
    let delayComputationMeta = null;

    const applyDelayFieldFallback = (
      delaySecCandidate,
      sourceUsed = "rt_delay_field",
      rawRtDelaySecUsed = delaySecCandidate
    ) => {
      if (!Number.isFinite(delaySecCandidate)) return false;
      const delayDisplay = computeDepartureDelayDisplayFromSeconds(delaySecCandidate);
      delayMin = delayDisplay.delayMinAfterClamp;
      if (Number.isFinite(scheduledMs)) {
        // Preserve raw realtime timestamp so clients can keep countdowns accurate
        // even when display delay is clamped (early/jitter cosmetic suppression).
        realtimeMs = scheduledMs + delaySecCandidate * 1000;
      }
      delayComputationMeta = {
        sourceUsed,
        rawRtDelaySecUsed: Number.isFinite(rawRtDelaySecUsed) ? Number(rawRtDelaySecUsed) : null,
      };
      return true;
    };

    if (delay) {
      merged._rtMatched = true;
      const delayFieldSec = Number.isFinite(delay?.delaySec)
        ? Number(delay.delaySec)
        : Number.isFinite(delay?.delayMin)
          ? Number(delay.delayMin) * 60
          : null;

      if (typeof delay.updatedDepartureEpoch === "number") {
        const candidateRealtimeMs = delay.updatedDepartureEpoch * 1000;
        if (shouldApplyRealtimeEpoch(scheduledMs, candidateRealtimeMs)) {
          realtimeMs = candidateRealtimeMs;
          if (Number.isFinite(scheduledMs)) {
            const computedDelaySec = computeDelaySecondsFromTimestamps(
              scheduledMs,
              realtimeMs
            );
            const delayDisplay =
              computeDepartureDelayDisplayFromSeconds(computedDelaySec);
            delayMin = delayDisplay.delayMinAfterClamp;
            delayComputationMeta = {
              sourceUsed: "rt_time_diff",
              rawRtDelaySecUsed: null,
            };
          } else if (
            !applyDelayFieldFallback(
              delayFieldSec,
              "rt_delay_field",
              Number.isFinite(delay?.delaySec) ? Number(delay.delaySec) : null
            )
          ) {
            delayMin = null;
          }
        } else if (
          !applyDelayFieldFallback(
            delayFieldSec,
            "rt_delay_field",
            Number.isFinite(delay?.delaySec) ? Number(delay.delaySec) : null
          )
        ) {
          delayMin = null;
        }
      } else if (
        !applyDelayFieldFallback(
          delayFieldSec,
          "rt_delay_field",
          Number.isFinite(delay?.delaySec) ? Number(delay.delaySec) : null
        )
      ) {
        delayMin = null;
      }
    } else if (tripFallbackDelay) {
      const fallbackDelaySec = Number.isFinite(tripFallbackDelay?.delaySec)
        ? Number(tripFallbackDelay.delaySec)
        : Number.isFinite(tripFallbackDelay?.delayMin)
          ? Number(tripFallbackDelay.delayMin) * 60
          : null;
      const fallbackRawDelaySec = Number.isFinite(tripFallbackDelay?.delaySec)
        ? Number(tripFallbackDelay.delaySec)
        : null;
      if (
        applyDelayFieldFallback(
          fallbackDelaySec,
          "rt_trip_fallback_delay_field",
          fallbackRawDelaySec
        )
      ) {
        merged._rtMatched = true;
        merged._rtMatchReason = "trip_fallback";
      }
    }

    if (realtimeMs !== null) {
      merged.realtimeDeparture = new Date(realtimeMs).toISOString();
    }

    merged.delayMin = delayMin;
    if (delayComputationMeta) {
      merged._delaySourceUsed = delayComputationMeta.sourceUsed;
      merged._rawRtDelaySecUsed = delayComputationMeta.rawRtDelaySecUsed;
    }
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
