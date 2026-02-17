export function pickPreferredMergedDeparture(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingCancelled = existing.cancelled === true;
  const incomingCancelled = incoming.cancelled === true;
  if (incomingCancelled && !existingCancelled) return incoming;
  if (existingCancelled && !incomingCancelled) return existing;

  const existingSuppressed = existing.suppressedStop === true;
  const incomingSuppressed = incoming.suppressedStop === true;
  if (existingSuppressed && !incomingSuppressed) return incoming;

  return existing;
}

