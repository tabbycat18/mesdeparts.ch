export const DELAY_JITTER_SEC = 30;

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function computeDelaySecondsFromTimestamps(scheduledMs, realtimeMs) {
  const scheduled = toFiniteNumber(scheduledMs);
  const realtime = toFiniteNumber(realtimeMs);
  if (!Number.isFinite(scheduled) || !Number.isFinite(realtime)) return null;
  return (realtime - scheduled) / 1000;
}

/**
 * Departure display rule:
 * - never show negative delay (no early departures in stationboard UI)
 * - ignore tiny RT jitter below DELAY_JITTER_SEC
 * - for positive delays, ceil minutes to avoid systematic under-reporting
 */
export function computeDepartureDelayDisplayFromSeconds(delaySec, options = {}) {
  const seconds = toFiniteNumber(delaySec);
  if (!Number.isFinite(seconds)) {
    return {
      delaySec: null,
      delayMinBeforeClamp: null,
      delayMinAfterClamp: null,
      roundingMethodUsed: "ceil",
      jitterSec: DELAY_JITTER_SEC,
    };
  }

  const jitterCandidate = toFiniteNumber(options?.jitterSec);
  const jitterSec = Number.isFinite(jitterCandidate)
    ? Math.max(0, Math.trunc(jitterCandidate))
    : DELAY_JITTER_SEC;

  const delayMinBeforeClamp = Math.ceil(seconds / 60);
  let delayMinAfterClamp = delayMinBeforeClamp;

  if (seconds <= 0) {
    delayMinAfterClamp = 0;
  } else if (seconds < jitterSec) {
    delayMinAfterClamp = 0;
  }

  return {
    delaySec: seconds,
    delayMinBeforeClamp,
    delayMinAfterClamp,
    roundingMethodUsed: "ceil",
    jitterSec,
  };
}
