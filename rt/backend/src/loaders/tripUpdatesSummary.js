function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (typeof value === "object" && value !== null && typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function normalizeTripScheduleRelationship(raw) {
  if (typeof raw === "string") {
    const rel = raw.trim().toUpperCase();
    if (rel === "CANCELLED") return "CANCELED";
    return rel;
  }
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
  if (typeof raw === "string") {
    const rel = raw.trim().toUpperCase();
    if (rel === "CANCELLED") return "CANCELED";
    return rel;
  }
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

function normalizeTripId(value) {
  if (value == null) return "";
  const id = String(value).trim();
  return id || "";
}

function normalizeStopId(value) {
  if (value == null) return "";
  const id = String(value).trim();
  return id || "";
}

function normalizeStopSequence(value) {
  const n = asNumber(value);
  return n === null ? null : n;
}

function getEntities(feed) {
  if (Array.isArray(feed?.entities)) return feed.entities;
  if (Array.isArray(feed?.entity)) return feed.entity;
  return [];
}

function getHeaderTimestamp(feed) {
  const direct = asNumber(feed?.headerTimestamp);
  if (direct !== null) return direct;
  const header = pick(feed, "header") || null;
  if (!header) return null;
  return asNumber(pick(header, "timestamp", "headerTimestamp"));
}

export function summarizeTripUpdates(feed, { sampleLimit = 5 } = {}) {
  const entities = getEntities(feed);
  const limit = Math.max(0, Number(sampleLimit) || 0);

  let tripDescriptorCanceledCount = 0;
  let stopTimeSkippedCount = 0;
  let stopTimeNoDataCount = 0;

  const sampleCancellationSignals = [];
  const sampleSeen = new Set();

  function pushSample(sample) {
    if (sampleCancellationSignals.length >= limit) return;
    const key = `${sample.tripId}|${sample.relationship}|${sample.stopId || ""}|${
      sample.stopSequence == null ? "" : sample.stopSequence
    }`;
    if (sampleSeen.has(key)) return;
    sampleSeen.add(key);
    sampleCancellationSignals.push(sample);
  }

  for (const entity of entities) {
    const update = pick(entity, "trip_update", "tripUpdate");
    if (!update) continue;

    const trip = pick(update, "trip") || null;
    const tripId = normalizeTripId(pick(trip, "trip_id", "tripId"));
    const tripRelationship = normalizeTripScheduleRelationship(
      pick(trip, "schedule_relationship", "scheduleRelationship")
    );

    if (tripRelationship === "CANCELED") {
      tripDescriptorCanceledCount += 1;
      if (tripId) {
        pushSample({
          tripId,
          relationship: "CANCELED",
          stopId: null,
          stopSequence: null,
        });
      }
    }

    const stopTimeUpdates = Array.isArray(pick(update, "stop_time_update", "stopTimeUpdate"))
      ? pick(update, "stop_time_update", "stopTimeUpdate")
      : [];

    for (const stu of stopTimeUpdates) {
      const relationship = normalizeStopTimeRelationship(
        pick(stu, "schedule_relationship", "scheduleRelationship")
      );
      if (relationship === "SKIPPED") {
        stopTimeSkippedCount += 1;
        if (tripId) {
          pushSample({
            tripId,
            relationship: "SKIPPED",
            stopId: normalizeStopId(pick(stu, "stop_id", "stopId")) || null,
            stopSequence: normalizeStopSequence(
              pick(stu, "stop_sequence", "stopSequence")
            ),
          });
        }
      } else if (relationship === "NO_DATA") {
        stopTimeNoDataCount += 1;
      }
    }
  }

  return {
    headerTimestamp: getHeaderTimestamp(feed),
    totalEntities: entities.length,
    tripDescriptorCanceledCount,
    stopTimeSkippedCount,
    stopTimeNoDataCount,
    sampleCancellationSignals,
  };
}

