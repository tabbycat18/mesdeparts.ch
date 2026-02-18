function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedSourceTag(dep) {
  const source = String(dep?.source || dep?.debug?.source || "").toLowerCase();
  if (source === "scheduled") return "static";
  if (source === "tripupdate" || source === "rt_added") return "tripupdate";
  if (source === "synthetic_alert" || source === "supplement") return "alert";
  return "static";
}

function existsBecause(dep) {
  const source = String(dep?.source || dep?.debug?.source || "").toLowerCase();
  const flags = toArray(dep?.flags).map((v) => String(v || ""));

  if (source === "scheduled") return "scheduled";
  if (source === "tripupdate") return "realtime_tripupdate_merge";
  if (source === "rt_added") return "realtime_added_trip";
  if (source === "synthetic_alert" && flags.includes("REPLACEMENT_SERVICE")) {
    return "injected_replacement";
  }
  if (source === "synthetic_alert") return "injected_synthesis";
  if (source === "supplement") return "supplement_replacement";
  return "unknown";
}

function cancellationWhy(dep) {
  const reason = String(dep?.cancelReasonCode || "").toUpperCase();
  if (reason === "CANCELED_TRIP") return "trip_cancelled";
  if (reason === "SKIPPED_STOP") return "stop_skipped";
  return null;
}

export function buildDepartureAudit(rows) {
  const out = [];
  for (const dep of toArray(rows)) {
    const source = String(dep?.source || dep?.debug?.source || "").toLowerCase();
    const sourceTags = [normalizedSourceTag(dep)];
    if (source === "synthetic_alert") sourceTags.push("synthesis");

    out.push({
      key: dep?.key || null,
      trip_id: dep?.trip_id || null,
      line: dep?.line || null,
      destination: dep?.destination || null,
      sourceTags: Array.from(new Set(sourceTags)),
      cancelled: dep?.cancelled === true,
      cancelledBecause: cancellationWhy(dep),
      existsBecause: existsBecause(dep),
      alertIds: toArray(dep?.alerts).map((alert) => String(alert?.id || "")).filter(Boolean),
    });
  }
  return out;
}

