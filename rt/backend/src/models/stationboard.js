import { normalizeText, toArray, uniqueStrings } from "../util/text.js";
import {
  computeDelaySecondsFromTimestamps,
  computeDepartureDelayDisplayFromSeconds,
} from "../util/departureDelay.js";

function asNullableText(value) {
  const text = normalizeText(value);
  return text || null;
}

function asNullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function bool(value) {
  return value === true;
}

function hasTag(tags, tag) {
  return toArray(tags).map((v) => normalizeText(v).toLowerCase()).includes(tag.toLowerCase());
}

function inferTripCancelledSignal(raw, reasons) {
  if (normalizeText(raw?.cancelReasonCode).toUpperCase() === "CANCELED_TRIP") return true;
  if (reasons.some((item) => item === "trip_schedule_relationship_canceled")) return true;
  if (reasons.some((item) => item === "otd_prognosis_status_cancelled")) return true;
  return false;
}

function inferSkippedStopSignal(raw) {
  return bool(raw?.suppressedStop) || hasTag(raw?.tags, "skipped_stop");
}

function mapReplacementType(raw, tags, line) {
  const explicit = normalizeText(raw?.replacementType).toUpperCase();
  if (explicit) return explicit;
  if (tags.includes("replacement") || /^EV/i.test(normalizeText(line))) return "EV";
  return null;
}

function normalizeAlert(alert) {
  return {
    id: normalizeText(alert?.id),
    severity: asNullableText(alert?.severity),
    header: asNullableText(alert?.header),
    description: asNullableText(alert?.description),
  };
}

function sanitizeDebugSource(rawSource) {
  const source = normalizeText(rawSource);
  return source || "scheduled";
}

function normalizeFlags(raw, tags, reasons, source, skippedStopSignal, tripCancelledSignal) {
  const out = [];

  if (tripCancelledSignal || normalizeText(raw?.cancelReasonCode).toUpperCase() === "CANCELED_TRIP") {
    out.push("TRIP_CANCELLED");
  }
  if (skippedStopSignal) out.push("STOP_SKIPPED");
  if (tags.includes("replacement") || /^EV/i.test(normalizeText(raw?.line))) {
    out.push("REPLACEMENT_SERVICE");
  }
  if (tags.includes("extra")) out.push("EXTRA_SERVICE");
  if (tags.includes("short_turn")) out.push("SHORT_TURN");
  if (tags.includes("short_turn_terminus")) out.push("SHORT_TURN_TERMINUS");

  if (source !== "scheduled" || raw?._rtMatched === true) {
    out.push("RT_CONFIRMED");
  }

  for (const reason of reasons) {
    if (reason === "trip_schedule_relationship_canceled") out.push("TRIP_CANCELLED");
    if (reason === "short_turn_terminus_next_stop_skipped") out.push("STOP_SKIPPED");
  }

  return uniqueStrings(out);
}

function normalizeCancelReasonCode(raw, flags, skippedStopSignal, tripCancelledSignal) {
  const explicit = normalizeText(raw?.cancelReasonCode).toUpperCase();
  if (explicit) return explicit;

  if (tripCancelledSignal || flags.includes("TRIP_CANCELLED")) return "CANCELED_TRIP";
  if (skippedStopSignal || flags.includes("STOP_SKIPPED")) return "SKIPPED_STOP";

  const reasons = toArray(raw?.cancelReasons).map((item) => normalizeText(item).toLowerCase());
  if (reasons.includes("trip_schedule_relationship_canceled")) return "CANCELED_TRIP";
  if (reasons.includes("otd_prognosis_status_cancelled")) return "CANCELED_TRIP";
  if (reasons.includes("short_turn_terminus_next_stop_skipped")) return "SKIPPED_STOP";
  return null;
}

function normalizeDebugFlags(raw, flags, cancelReasonCode, skippedStopSignal, tripCancelledSignal) {
  const out = [];
  for (const item of toArray(raw?.debugFlags)) {
    const text = normalizeText(item);
    if (text) out.push(text);
  }

  for (const item of toArray(raw?.cancelReasons)) {
    const text = normalizeText(item).toLowerCase();
    if (!text) continue;
    out.push(`reason:${text}`);
  }

  for (const flag of flags) {
    if (flag === "TRIP_CANCELLED") out.push("cancel:canceled_trip");
    if (flag === "STOP_SKIPPED") out.push("cancel:skipped_stop");
  }

  if (skippedStopSignal) out.push("cancel:skipped_stop");
  if (tripCancelledSignal) out.push("cancel:canceled_trip");
  if (cancelReasonCode) out.push(`cancel:${cancelReasonCode.toLowerCase()}`);

  return uniqueStrings(out);
}

function asFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function computeDisplayFields(dep, options = {}) {
  const includeDelayDebug = options?.includeDelayDebug === true;
  const delayMeta =
    options?.delayMeta && typeof options.delayMeta === "object" ? options.delayMeta : null;
  const rtMatched = delayMeta?.rtMatched === true;
  const rtMatchReason = normalizeText(delayMeta?.rtMatchReason).toLowerCase() || null;

  const out = {
    ...dep,
    debug: {
      source: sanitizeDebugSource(dep?.debug?.source),
      flags: uniqueStrings(dep?.debug?.flags),
    },
  };

  const scheduledMs = Date.parse(out.scheduledDeparture || "");
  const realtimeMs = Date.parse(out.realtimeDeparture || "");
  const rtConfirmed = out.flags.includes("RT_CONFIRMED") || out.debug.flags.includes("rt:confirmed");
  const sourceHint = normalizeText(delayMeta?.sourceUsed).toLowerCase();
  let sourceUsed = "scheduled_fallback";
  let rawRtDelaySecUsed = null;
  let computedDelaySec = null;
  let computedDelayMinBeforeClamp = null;
  let computedDelayMinAfterClamp = null;
  let roundingMethodUsed = "ceil";

  if (!Number.isFinite(realtimeMs)) {
    out.delayMin = null;
    out.debug.flags = uniqueStrings([...out.debug.flags, "delay:unknown_no_rt"]);
  } else if (!Number.isFinite(scheduledMs)) {
    out.delayMin = null;
    out.debug.flags = uniqueStrings([...out.debug.flags, "delay:unknown_no_schedule"]);
  } else if (realtimeMs !== scheduledMs) {
    sourceUsed =
      sourceHint === "rt_delay_field" || sourceHint === "rt_trip_fallback_delay_field"
        ? sourceHint
        : "rt_time_diff";
    rawRtDelaySecUsed =
      sourceUsed === "rt_delay_field" || sourceUsed === "rt_trip_fallback_delay_field"
        ? asFiniteNumber(delayMeta?.rawRtDelaySecUsed)
        : null;
    computedDelaySec =
      (sourceUsed === "rt_delay_field" ||
        sourceUsed === "rt_trip_fallback_delay_field") &&
      Number.isFinite(rawRtDelaySecUsed)
        ? rawRtDelaySecUsed
        : computeDelaySecondsFromTimestamps(scheduledMs, realtimeMs);

    const delayDisplay =
      computeDepartureDelayDisplayFromSeconds(computedDelaySec);
    out.delayMin = delayDisplay.delayMinAfterClamp;
    computedDelayMinBeforeClamp = delayDisplay.delayMinBeforeClamp;
    computedDelayMinAfterClamp = delayDisplay.delayMinAfterClamp;
    roundingMethodUsed = delayDisplay.roundingMethodUsed;
    out.debug.flags = uniqueStrings([
      ...out.debug.flags,
      sourceUsed === "rt_time_diff" ? "delay:from_rt_diff" : "delay:from_rt_delay_field",
    ]);
  } else if (rtConfirmed) {
    out.delayMin = 0;
    sourceUsed =
      sourceHint === "rt_delay_field" || sourceHint === "rt_trip_fallback_delay_field"
        ? sourceHint
        : "rt_time_diff";
    rawRtDelaySecUsed =
      sourceUsed === "rt_delay_field" || sourceUsed === "rt_trip_fallback_delay_field"
        ? asFiniteNumber(delayMeta?.rawRtDelaySecUsed)
        : null;
    computedDelaySec = 0;
    const delayDisplay = computeDepartureDelayDisplayFromSeconds(computedDelaySec);
    computedDelayMinBeforeClamp = delayDisplay.delayMinBeforeClamp;
    computedDelayMinAfterClamp = delayDisplay.delayMinAfterClamp;
    roundingMethodUsed = delayDisplay.roundingMethodUsed;
    out.debug.flags = uniqueStrings([...out.debug.flags, "delay:rt_equal_confirmed_zero"]);
  } else {
    out.delayMin = null;
    out.debug.flags = uniqueStrings([...out.debug.flags, "delay:unknown_scheduled_fallback"]);
  }

  if (includeDelayDebug) {
    const rawScheduledEpochSec = Number.isFinite(scheduledMs)
      ? Math.trunc(scheduledMs / 1000)
      : null;
    const rawRealtimeEpochSec = Number.isFinite(realtimeMs)
      ? Math.trunc(realtimeMs / 1000)
      : null;
    const fallbackComputedDelaySec =
      Number.isFinite(scheduledMs) && Number.isFinite(realtimeMs)
        ? computeDelaySecondsFromTimestamps(scheduledMs, realtimeMs)
        : null;

    out.debug.delayComputation = {
      rawScheduledISO: out.scheduledDeparture || null,
      rawRealtimeISO: out.realtimeDeparture || null,
      rawScheduledEpochSec,
      rawRealtimeEpochSec,
      rawRtDelaySecUsed,
      computedDelaySec: computedDelaySec ?? fallbackComputedDelaySec,
      computedDelayMinBeforeClamp,
      computedDelayMinAfterClamp,
      roundingMethodUsed,
      sourceUsed,
      delaySourceUsed: sourceUsed,
      rtMatched,
      rtMatchReason,
      matchReason: rtMatchReason,
    };
  }

  const hasTripCancel = out.flags.includes("TRIP_CANCELLED");
  const hasSkippedStop = out.flags.includes("STOP_SKIPPED");
  if (hasTripCancel || hasSkippedStop) {
    out.cancelled = true;
  }

  out.stopEvent = hasSkippedStop ? "SKIPPED" : null;

  if (hasTripCancel) {
    out.status = "CANCELLED";
    out.cancelReasonCode = "CANCELED_TRIP";
  } else if (hasSkippedStop) {
    out.status = "SKIPPED_STOP";
    out.cancelReasonCode = out.cancelReasonCode || "SKIPPED_STOP";
  } else if (out.delayMin == null) {
    out.status = "UNKNOWN";
  } else if (out.delayMin > 0) {
    out.status = "DELAYED";
  } else if (out.delayMin < 0) {
    out.status = "EARLY";
  } else {
    out.status = "ON_TIME";
  }

  return out;
}

export function normalizeDeparture(raw, ctx = {}) {
  const source = sanitizeDebugSource(raw?.debugSource || raw?.source);
  const tags = uniqueStrings(toArray(raw?.tags));
  const reasons = uniqueStrings(toArray(raw?.cancelReasons).map((item) => normalizeText(item).toLowerCase()));

  const skippedStopSignal = inferSkippedStopSignal(raw);
  const tripCancelledSignal = inferTripCancelledSignal(raw, reasons);

  const flags = normalizeFlags(raw, tags, reasons, source, skippedStopSignal, tripCancelledSignal);
  const cancelReasonCode = normalizeCancelReasonCode(raw, flags, skippedStopSignal, tripCancelledSignal);

  const scheduledDeparture = isoOrNull(raw?.scheduledDeparture) || new Date(0).toISOString();
  const realtimeDeparture = isoOrNull(raw?.realtimeDeparture);

  const dep = {
    key: `${normalizeText(raw?.trip_id)}|${normalizeText(raw?.stop_id)}|${scheduledDeparture}`,
    trip_id: asNullableText(raw?.trip_id),
    route_id: asNullableText(raw?.route_id),
    stop_id: normalizeText(raw?.stop_id) || normalizeText(ctx?.stopId),
    stop_sequence: asNullableNumber(raw?.stop_sequence),

    line: normalizeText(raw?.line || raw?.name || raw?.number || ""),
    category: asNullableText(raw?.category),
    number: asNullableText(raw?.number),
    destination: normalizeText(raw?.destination || ""),

    scheduledDeparture,
    realtimeDeparture,

    delayMin: asNullableNumber(raw?.delayMin),
    platform: asNullableText(raw?.platform),
    platformChanged: bool(raw?.platformChanged),

    cancelled: bool(raw?.cancelled) || skippedStopSignal || tripCancelledSignal,
    cancelReasonCode,
    replacementType: mapReplacementType(raw, tags, raw?.line),

    alerts: toArray(raw?.alerts)
      .map(normalizeAlert)
      .filter((item) => item.id),

    status: "UNKNOWN",
    flags,
    stopEvent: skippedStopSignal ? "SKIPPED" : null,

    debug: {
      source,
      flags: normalizeDebugFlags(raw, flags, cancelReasonCode, skippedStopSignal, tripCancelledSignal),
    },
  };

  return computeDisplayFields(dep, {
    includeDelayDebug: ctx?.includeDelayDebug === true,
    delayMeta: {
      sourceUsed: raw?._delaySourceUsed,
      rawRtDelaySecUsed: raw?._rawRtDelaySecUsed,
      rtMatched: raw?._rtMatched === true,
      rtMatchReason: raw?._rtMatchReason,
    },
  });
}
