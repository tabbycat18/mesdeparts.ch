function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 2_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 2_000_000_000 ? n * 1000 : n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasReplacementSignal(...parts) {
  const hay = parts
    .map((p) => normalizeText(p))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!hay) return false;
  return /\b(ev(?:\s*\d+)?|ersatz|replacement|remplacement|sostitutiv|substitute)\b/i.test(
    hay
  );
}

function dedupeKey(entry) {
  return `${entry.trip_id}|${entry.stop_id}|${entry.scheduledDeparture}|${entry.line}`;
}

export function supplementFromOtdStationboard({
  data,
  stationStopId,
  stationName,
  now,
  windowMinutes = 180,
  departedGraceSeconds = 45,
  limit = 30,
} = {}) {
  const list = Array.isArray(data?.stationboard) ? data.stationboard : [];
  if (list.length === 0) return [];

  const nowDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const nowMs = nowDate.getTime();
  const windowMs = Math.max(1, Number(windowMinutes) || 180) * 60 * 1000;
  const graceMs = Math.max(0, Number(departedGraceSeconds) || 45) * 1000;
  const out = [];
  const seen = new Set();

  for (const row of list) {
    const stop = row?.stop || {};
    const prognosis = stop?.prognosis || {};
    const plannedMs =
      toEpochMs(stop?.departureTimestamp) ||
      toEpochMs(stop?.departure) ||
      toEpochMs(row?.stop?.departure);
    if (!Number.isFinite(plannedMs)) continue;

    const realtimeMs =
      toEpochMs(prognosis?.departureTimestamp) ||
      toEpochMs(prognosis?.departure) ||
      plannedMs;
    if (!Number.isFinite(realtimeMs)) continue;

    const msUntil = realtimeMs - nowMs;
    if (msUntil < -graceMs) continue;
    if (msUntil > windowMs) continue;

    const number = normalizeText(row?.number);
    const category = normalizeText(row?.category);
    const name = normalizeText(row?.name);
    const to = normalizeText(row?.to);
    const operator = normalizeText(row?.operator);

    if (!hasReplacementSignal(number, name, to, category, operator)) continue;

    const line = number || name || "EV";
    const scheduledIso = new Date(plannedMs).toISOString();
    const realtimeIso = new Date(realtimeMs).toISOString();
    const item = {
      trip_id: normalizeText(row?.id) || `otd-ev:${line}:${Math.floor(plannedMs / 1000)}`,
      route_id: "",
      stop_id: normalizeText(stationStopId) || "",
      stop_sequence: null,
      category: "B",
      number: line,
      line,
      name: line,
      destination: to || stationName || "",
      operator,
      scheduledDeparture: scheduledIso,
      realtimeDeparture: realtimeIso,
      delayMin: Math.round((realtimeMs - plannedMs) / 60000),
      minutesLeft: msUntil <= 0 ? 0 : Math.floor(msUntil / 60000),
      platform: normalizeText(prognosis?.platform) || normalizeText(stop?.platform) || "",
      platformChanged: false,
      cancelled: normalizeText(prognosis?.status).toUpperCase() === "CANCELLED",
      cancelReasons:
        normalizeText(prognosis?.status).toUpperCase() === "CANCELLED"
          ? ["otd_prognosis_status_cancelled"]
          : [],
      source: "synthetic_alert",
      tags: ["replacement"],
      alerts: [],
    };

    const key = dedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
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
