const DEFAULT_TRIP_UPDATES_URL = "https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON";

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function resolveApiKey(explicitApiKey) {
  return (
    explicitApiKey ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    ""
  );
}

function normalizeHeaderTimestamp(header) {
  // For M1 we keep unix seconds as number for downstream consistency.
  const raw = pick(header, "timestamp", "headerTimestamp");
  if (raw == null) return null;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  if (typeof raw === "object" && raw !== null && typeof raw.toNumber === "function") {
    const n = raw.toNumber();
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  return null;
}

export async function fetchTripUpdates({ apiKey, urlOverride } = {}) {
  const token = resolveApiKey(apiKey);
  if (!token) {
    throw new Error(
      "[GTFS-RT] Missing API token. Set GTFS_RT_TOKEN, OPENDATA_SWISS_TOKEN, or OPENTDATA_GTFS_RT_KEY."
    );
  }

  const url = urlOverride || DEFAULT_TRIP_UPDATES_URL;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `[GTFS-RT] HTTP ${response.status} when fetching trip updates: ${body.slice(0, 200)}`
    );
  }

  const raw = await response.json();
  const header = raw?.header || {};
  const entities = Array.isArray(raw?.entity)
    ? raw.entity
    : Array.isArray(raw?.entities)
      ? raw.entities
      : [];

  return {
    feedVersion: pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion") || "",
    headerTimestamp: normalizeHeaderTimestamp(header),
    entities,
    // Compatibility for existing code that still expects `entity`.
    entity: entities,
  };
}
