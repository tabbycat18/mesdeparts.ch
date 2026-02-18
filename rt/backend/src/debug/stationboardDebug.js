function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function shouldEnableStationboardDebug(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function summarizeCancellation(rows, limit = 20) {
  const list = Array.isArray(rows) ? rows : [];
  const cancelledRows = [];
  for (const row of list) {
    if (row?.cancelled !== true) continue;
    const reasons = Array.isArray(row?.cancelReasons)
      ? row.cancelReasons.map((item) => String(item)).filter(Boolean)
      : [];
    cancelledRows.push({
      trip_id: String(row?.trip_id || ""),
      stop_id: String(row?.stop_id || ""),
      stop_sequence:
        row?.stop_sequence == null || row?.stop_sequence === ""
          ? null
          : safeNumber(row.stop_sequence, null),
      scheduledDeparture: String(row?.scheduledDeparture || ""),
      realtimeDeparture: String(row?.realtimeDeparture || ""),
      source: String(row?.source || ""),
      reasons,
    });
    if (cancelledRows.length >= limit) break;
  }
  return {
    total: list.length,
    cancelled: list.filter((row) => row?.cancelled === true).length,
    cancelledRows,
  };
}

export function createStationboardDebugLogger({ enabled = false, requestId = "", scope = "" } = {}) {
  return function log(event, payload = {}) {
    if (!enabled) return;
    const row = {
      logType: "stationboard_debug",
      ts: new Date().toISOString(),
      requestId: String(requestId || ""),
      scope: String(scope || ""),
      event: String(event || ""),
      ...payload,
    };
    console.log(JSON.stringify(row));
  };
}
