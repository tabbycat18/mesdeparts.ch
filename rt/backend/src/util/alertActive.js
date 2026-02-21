import { secondsSinceZurichMidnight } from "../time/zurichTime.js";

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

function isInsidePeriod(period, nowMs) {
  const startMs = getPeriodTime(period?.start);
  const endMs = getPeriodTime(period?.end);
  const afterStart = startMs == null ? true : nowMs >= startMs;
  const beforeEnd = endMs == null ? true : nowMs <= endMs;
  return afterStart && beforeEnd;
}

function activeByGtfsPeriod(alert, nowDate) {
  const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
  if (periods.length === 0) return true;
  const nowMs = normalizeNow(nowDate).getTime();
  return periods.some((period) => isInsidePeriod(period, nowMs));
}

function toSecondsOfDay(hh, mm) {
  const hour = Number(hh);
  const minute = Number(mm);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 3600 + minute * 60;
}

function hasDateNearIndex(text, index) {
  if (!Number.isFinite(index)) return false;
  const start = Math.max(0, index - 16);
  const end = Math.min(text.length, index + 16);
  const slice = text.slice(start, end);
  return /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/.test(slice);
}

function extractRecurringDailyWindows(text) {
  const value = String(text || "");
  if (!value) return { windows: [], hasNightHint: false, hasRecurringHint: false };

  const hasNightHint =
    /\b(every\s+night|nightly|during\s+the\s+night|chaque\s+nuit|toutes?\s+les\s+nuits|la\s+nuit|nachts?|jede\s+nacht|nocturne)\b/i.test(
      value
    );
  const hasRecurringHint =
    hasNightHint ||
    /\b(every\s+day|daily|tous\s+les\s+jours|t[äa]glich|quotidien(?:nement)?)\b/i.test(
      value
    );

  const out = [];
  const re =
    /(?:^|[^\d])([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\s*(?:-|–|—|to|until|au|a|à|jusqu['’]?\s*à|bis)\s*([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)(?!\d)/gi;
  let match;
  while ((match = re.exec(value)) !== null) {
    const full = String(match[0] || "");
    const startIndex = Math.max(0, match.index + full.indexOf(match[1] || ""));
    const endIndex = Math.max(0, match.index + full.lastIndexOf(match[3] || ""));
    if (hasDateNearIndex(value, startIndex) || hasDateNearIndex(value, endIndex)) continue;
    const start = toSecondsOfDay(match[1], match[2]);
    const end = toSecondsOfDay(match[3], match[4]);
    if (start == null || end == null) continue;
    out.push({ start, end });
    if (out.length >= 4) break;
  }
  return { windows: out, hasNightHint, hasRecurringHint };
}

function hasLongGtfsPeriod(alert) {
  const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
  for (const period of periods) {
    const startMs = getPeriodTime(period?.start);
    const endMs = getPeriodTime(period?.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs - startMs >= 10 * 60 * 60 * 1000) return true;
  }
  return false;
}

function isInsideDailyWindow(secondsOfDay, window) {
  if (!window) return false;
  const start = Number(window.start);
  const end = Number(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return true;
  if (start < end) return secondsOfDay >= start && secondsOfDay < end;
  return secondsOfDay >= start || secondsOfDay < end;
}

function activeByRecurringTextWindow(alert, nowDate) {
  const text = `${alert?.headerText || ""}\n${alert?.descriptionText || ""}`;
  const { windows, hasNightHint, hasRecurringHint } = extractRecurringDailyWindows(text);
  if (windows.length === 0) return true;
  const shouldApplyWindow = hasRecurringHint || hasLongGtfsPeriod(alert);
  if (!shouldApplyWindow) return true;
  const nowSeconds = secondsSinceZurichMidnight(nowDate);
  const effectiveWindows = windows.map((window) => {
    if (!hasNightHint) return window;
    const start = Number(window?.start);
    const end = Number(window?.end);
    const startsAfterMidnight = start >= 0 && start <= 5 * 3600;
    const endsInEarlyMorning = end > 0 && end <= 6 * 3600;
    if (!startsAfterMidnight || !endsInEarlyMorning || start >= end) return window;
    return {
      start: 22 * 3600,
      end,
    };
  });
  return effectiveWindows.some((window) => isInsideDailyWindow(nowSeconds, window));
}

export function isAlertActiveNow(alert, nowDate) {
  const current = normalizeNow(nowDate);
  if (!activeByGtfsPeriod(alert, current)) return false;
  return activeByRecurringTextWindow(alert, current);
}
