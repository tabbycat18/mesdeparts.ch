import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const DEFAULT_SERVICE_ALERTS_URL = "https://api.opentransportdata.swiss/la/gtfs-sa";

const CAUSE_BY_CODE = {
  0: "UNKNOWN_CAUSE",
  1: "UNKNOWN_CAUSE",
  2: "OTHER_CAUSE",
  3: "TECHNICAL_PROBLEM",
  4: "STRIKE",
  5: "DEMONSTRATION",
  6: "ACCIDENT",
  7: "HOLIDAY",
  8: "WEATHER",
  9: "MAINTENANCE",
  10: "CONSTRUCTION",
  11: "POLICE_ACTIVITY",
  12: "MEDICAL_EMERGENCY",
};

const EFFECT_BY_CODE = {
  0: "UNKNOWN_EFFECT",
  1: "NO_SERVICE",
  2: "REDUCED_SERVICE",
  3: "SIGNIFICANT_DELAYS",
  4: "DETOUR",
  5: "ADDITIONAL_SERVICE",
  6: "MODIFIED_SERVICE",
  7: "OTHER_EFFECT",
  8: "UNKNOWN_EFFECT",
  9: "STOP_MOVED",
  10: "NO_EFFECT",
  11: "ACCESSIBILITY_ISSUE",
};

const SEVERITY_BY_CODE = {
  0: "unknown",
  1: "unknown",
  2: "info",
  3: "warning",
  4: "severe",
};

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function toNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (typeof value === "object" && value !== null && typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function toDateOrNull(value) {
  const sec = toNumberOrNull(value);
  if (sec == null) return null;
  return new Date(sec * 1000);
}

function toTrimmedOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function normalizeEnumValue(raw, byCodeMap) {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim().toUpperCase();

  const code = toNumberOrNull(raw);
  if (code == null) return null;
  return byCodeMap[code] || null;
}

function normalizeSeverity(raw) {
  if (raw == null) return null;

  if (typeof raw === "string" && raw.trim() !== "") {
    const key = raw.trim().toUpperCase();
    if (key === "SEVERE") return "severe";
    if (key === "WARNING") return "warning";
    if (key === "INFO") return "info";
    return "unknown";
  }

  const code = toNumberOrNull(raw);
  if (code == null) return null;
  return SEVERITY_BY_CODE[code] || "unknown";
}

function pickTextTranslation(translatedString) {
  const entries = Array.isArray(translatedString?.translation)
    ? translatedString.translation
    : [];
  if (!entries.length) return null;

  const preferred = ["de", "fr", "en"];

  for (const lang of preferred) {
    const hit = entries.find((entry) => {
      const text = toTrimmedOrNull(entry?.text);
      const language = toTrimmedOrNull(entry?.language)?.toLowerCase() || "";
      return !!text && language.startsWith(lang);
    });
    if (hit) return toTrimmedOrNull(hit.text);
  }

  for (const entry of entries) {
    const text = toTrimmedOrNull(entry?.text);
    if (text) return text;
  }

  return null;
}

function normalizeInformedEntity(rawEntity) {
  if (!rawEntity || typeof rawEntity !== "object") return null;
  const stopSequence = toNumberOrNull(
    pick(rawEntity, "stop_sequence", "stopSequence")
  );

  return {
    agency_id: toTrimmedOrNull(pick(rawEntity, "agency_id", "agencyId")),
    route_id: toTrimmedOrNull(pick(rawEntity, "route_id", "routeId")),
    trip_id: toTrimmedOrNull(
      pick(
        pick(rawEntity, "trip"),
        "trip_id",
        "tripId"
      ) || pick(rawEntity, "trip_id", "tripId")
    ),
    stop_id: toTrimmedOrNull(pick(rawEntity, "stop_id", "stopId")),
    stop_sequence: stopSequence,
  };
}

function normalizeAlertEntity(entity) {
  const alert = pick(entity, "alert");
  if (!alert || typeof alert !== "object") return null;

  const informedRaw = Array.isArray(pick(alert, "informed_entity", "informedEntity"))
    ? pick(alert, "informed_entity", "informedEntity")
    : [];
  const activeRaw = Array.isArray(pick(alert, "active_period", "activePeriod"))
    ? pick(alert, "active_period", "activePeriod")
    : [];

  return {
    id: toTrimmedOrNull(pick(entity, "id")) || "",
    cause: normalizeEnumValue(pick(alert, "cause"), CAUSE_BY_CODE),
    effect: normalizeEnumValue(pick(alert, "effect"), EFFECT_BY_CODE),
    severity: normalizeSeverity(
      pick(alert, "severity_level", "severityLevel")
    ),
    headerText: pickTextTranslation(pick(alert, "header_text", "headerText")),
    descriptionText: pickTextTranslation(
      pick(alert, "description_text", "descriptionText")
    ),
    activePeriods: activeRaw.map((period) => ({
      start: toDateOrNull(pick(period, "start")),
      end: toDateOrNull(pick(period, "end")),
    })),
    informedEntities: informedRaw
      .map(normalizeInformedEntity)
      .filter((item) => !!item),
  };
}

function resolveApiKey(explicitApiKey) {
  return (
    explicitApiKey ||
    process.env.OPENTDATA_GTFS_SA_KEY ||
    process.env.OPENTDATA_API_KEY ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    ""
  );
}

export async function fetchServiceAlerts({ apiKey, urlOverride, timeoutMs } = {}) {
  const token = resolveApiKey(apiKey);
  if (!token) {
    throw new Error("service_alerts_fetch_failed: missing_api_key");
  }

  const url = urlOverride || DEFAULT_SERVICE_ALERTS_URL;
  const timeout = Number(timeoutMs);
  const effectiveTimeoutMs =
    Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 8000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/octet-stream",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = String(err?.name || "").toLowerCase() === "aborterror";
    if (isAbort) {
      throw new Error(
        `service_alerts_fetch_failed: timeout_${effectiveTimeoutMs}ms`
      );
    }
    throw new Error(
      `service_alerts_fetch_failed: network_error ${String(err?.message || err)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `service_alerts_fetch_failed: http_${response.status}${snippet ? ` ${snippet}` : ""}`
    );
  }

  let feedMessage;
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    feedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  } catch (err) {
    throw new Error(
      `service_alerts_fetch_failed: decode_failed ${String(err?.message || err)}`
    );
  }

  const header = feedMessage?.header || {};
  const entities = Array.isArray(feedMessage?.entity) ? feedMessage.entity : [];

  return {
    feedVersion: toTrimmedOrNull(
      pick(header, "gtfs_realtime_version", "gtfsRealtimeVersion")
    ),
    // Backend convention: unix seconds for feed header timestamp.
    headerTimestamp: toNumberOrNull(pick(header, "timestamp", "headerTimestamp")),
    entities: entities
      .map(normalizeAlertEntity)
      .filter((entity) => entity && entity.id),
  };
}
