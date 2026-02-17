function asRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function tripIdOf(row) {
  if (!row || row.trip_id == null) return "";
  return String(row.trip_id).trim();
}

function snapshot(rows) {
  const list = asRows(rows);
  let cancelled = 0;
  const cancelledTripIds = new Set();

  for (const row of list) {
    if (row?.cancelled !== true) continue;
    cancelled += 1;
    const tripId = tripIdOf(row);
    if (tripId) cancelledTripIds.add(tripId);
  }

  return {
    total: list.length,
    cancelled,
    cancelledTripIds,
  };
}

function lostTripIds(beforeIds, afterIds, limit = 3) {
  const out = [];
  for (const tripId of beforeIds) {
    if (afterIds.has(tripId)) continue;
    out.push(tripId);
    if (out.length >= limit) break;
  }
  return out;
}

export function createCancellationTracer(scope, { enabled = false } = {}) {
  let previous = null;

  return function trace(step, rows) {
    if (!enabled) return;
    const current = snapshot(rows);
    const payload = {
      scope,
      step,
      total: current.total,
      cancelled: current.cancelled,
    };

    if (previous) {
      payload.prevCancelled = previous.cancelled;
      if (current.cancelled < previous.cancelled) {
        const lost = lostTripIds(previous.cancelledTripIds, current.cancelledTripIds, 3);
        if (lost.length) payload.lostCancelledTripIds = lost;
      }
    }

    console.log("[cancel-trace]", payload);
    previous = current;
  };
}

