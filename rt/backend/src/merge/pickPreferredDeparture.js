export function pickPreferredMergedDeparture(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingSource = String(existing.source || "");
  const incomingSource = String(incoming.source || "");
  const existingCancelled = existing.cancelled === true;
  const incomingCancelled = incoming.cancelled === true;
  if (incomingCancelled && !existingCancelled) return incoming;
  if (existingCancelled && !incomingCancelled) return existing;

  const existingSuppressed = existing.suppressedStop === true;
  const incomingSuppressed = incoming.suppressedStop === true;
  if (incomingSuppressed && !existingSuppressed) return incoming;
  if (existingSuppressed && !incomingSuppressed) return existing;

  const existingRealtimeMs = Date.parse(existing.realtimeDeparture || "");
  const incomingRealtimeMs = Date.parse(incoming.realtimeDeparture || "");
  const existingScheduledMs = Date.parse(existing.scheduledDeparture || "");
  const incomingScheduledMs = Date.parse(incoming.scheduledDeparture || "");
  const existingRealtimeSignal =
    (Number.isFinite(existingRealtimeMs) &&
      Number.isFinite(existingScheduledMs) &&
      existingRealtimeMs !== existingScheduledMs) ||
    existingSource === "tripupdate" ||
    existingSource === "rt_added" ||
    Number(existing.delayMin || 0) !== 0;
  const incomingRealtimeSignal =
    (Number.isFinite(incomingRealtimeMs) &&
      Number.isFinite(incomingScheduledMs) &&
      incomingRealtimeMs !== incomingScheduledMs) ||
    incomingSource === "tripupdate" ||
    incomingSource === "rt_added" ||
    Number(incoming.delayMin || 0) !== 0;
  if (incomingRealtimeSignal && !existingRealtimeSignal) return incoming;
  if (existingRealtimeSignal && !incomingRealtimeSignal) return existing;

  const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
  const incomingTags = Array.isArray(incoming.tags) ? incoming.tags : [];
  const existingReplacement = existingTags.includes("replacement");
  const incomingReplacement = incomingTags.includes("replacement");
  if (incomingReplacement && !existingReplacement) return incoming;
  if (existingReplacement && !incomingReplacement) return existing;

  const existingSynthetic = existingSource === "synthetic_alert" || existingSource === "rt_added";
  const incomingSynthetic = incomingSource === "synthetic_alert" || incomingSource === "rt_added";
  if (incomingSynthetic && !existingSynthetic) return incoming;
  if (existingSynthetic && !incomingSynthetic) return existing;

  return existing;
}
