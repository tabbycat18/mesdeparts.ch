import { query as dbQuery } from "../db/query.js";

const DEFAULT_ALERTS_FRESH_MAX_AGE_MS = Math.max(
  5_000,
  Number(process.env.STATIONBOARD_ALERTS_FRESH_MAX_AGE_MS || "120000")
);
const DEFAULT_ALERTS_STALE_GRACE_MS = Math.max(
  0,
  Number(process.env.STATIONBOARD_ALERTS_STALE_GRACE_MS || "1800000")
);
const DEFAULT_ALERTS_MAX_ROWS = Math.max(
  50,
  Number(process.env.STATIONBOARD_ALERTS_PARSED_MAX_ROWS || "500")
);
const DEFAULT_ALERTS_SCOPE_LOOKBACK_MS = Math.max(
  60_000,
  Number(process.env.STATIONBOARD_ALERTS_PARSED_LOOKBACK_MS || "21600000")
);

const EMPTY_ALERTS = Object.freeze({ entities: [] });

function text(value) {
  return String(value || "").trim();
}

function toFiniteNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function parseEpochSecToDate(value) {
  const sec = toFiniteNumberOrNull(value);
  if (!Number.isFinite(sec)) return null;
  return new Date(sec * 1000);
}

function parseUpdatedAtMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeInformedEntity(rawEntity) {
  const src = rawEntity && typeof rawEntity === "object" ? rawEntity : {};
  const stopSequence = toFiniteNumberOrNull(src.stop_sequence ?? src.stopSequence);
  return {
    agency_id: text(src.agency_id ?? src.agencyId) || null,
    route_id: text(src.route_id ?? src.routeId) || null,
    trip_id: text(src.trip_id ?? src.tripId) || null,
    stop_id: text(src.stop_id ?? src.stopId) || null,
    stop_sequence: Number.isFinite(stopSequence) ? Math.trunc(stopSequence) : null,
  };
}

function normalizeInformedEntities(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map(normalizeInformedEntity)
    .filter(
      (entity) =>
        !!(
          entity.stop_id ||
          entity.route_id ||
          entity.trip_id ||
          entity.agency_id ||
          Number.isFinite(entity.stop_sequence)
        )
    );
}

function baseMeta(nowMs) {
  return {
    available: false,
    applied: false,
    reason: "missing_cache",
    alertsSource: "parsed",
    feedKey: "rt_service_alerts",
    fetchedAt: null,
    cacheFetchedAt: null,
    cacheAgeMs: null,
    ageSeconds: null,
    freshnessThresholdMs: DEFAULT_ALERTS_FRESH_MAX_AGE_MS,
    freshnessMaxAgeSeconds: Math.round(DEFAULT_ALERTS_FRESH_MAX_AGE_MS / 1000),
    status: null,
    lastStatus: null,
    lastError: null,
    payloadBytes: null,
    cacheStatus: "MISS",
    alertsPayloadFetchCountThisRequest: 0,
    nowIso: new Date(nowMs).toISOString(),
  };
}

function uniqueText(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = text(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseTranslations(jsonbValue) {
  if (!jsonbValue) return null;
  try {
    if (typeof jsonbValue === "string") {
      const parsed = JSON.parse(jsonbValue);
      return Array.isArray(parsed) ? parsed : null;
    }
    if (Array.isArray(jsonbValue)) {
      return jsonbValue;
    }
  } catch {
    // Ignore parse errors, fall back to single-language
  }
  return null;
}

function matchesScope(entity, { scopeStopIds, scopeRouteIds, scopeTripIds } = {}) {
  const informed = Array.isArray(entity?.informedEntities) ? entity.informedEntities : [];
  if (informed.length === 0) return true;

  const stops = new Set(uniqueText(scopeStopIds));
  const routes = new Set(uniqueText(scopeRouteIds));
  const trips = new Set(uniqueText(scopeTripIds));
  const hasScope = stops.size > 0 || routes.size > 0 || trips.size > 0;
  if (!hasScope) return true;

  for (const informedEntity of informed) {
    const stopId = text(informedEntity?.stop_id);
    const routeId = text(informedEntity?.route_id);
    const tripId = text(informedEntity?.trip_id);
    if (stopId && stops.has(stopId)) return true;
    if (routeId && routes.has(routeId)) return true;
    if (tripId && trips.has(tripId)) return true;
  }
  return false;
}

export async function loadAlertsFromParsedTables(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const enabled = options.enabled !== false;
  const freshnessThresholdMs = Math.max(
    5_000,
    Number(options.freshnessThresholdMs || DEFAULT_ALERTS_FRESH_MAX_AGE_MS)
  );
  const staleGraceInput = Number(options.staleGraceMs);
  const staleGraceMs = Math.max(
    0,
    Number.isFinite(staleGraceInput) ? staleGraceInput : DEFAULT_ALERTS_STALE_GRACE_MS
  );
  const maxRows = Math.max(
    50,
    Number.isFinite(Number(options.maxRows))
      ? Number(options.maxRows)
      : DEFAULT_ALERTS_MAX_ROWS
  );
  const scopeLookbackMs = Math.max(
    60_000,
    Number.isFinite(Number(options.scopeLookbackMs))
      ? Number(options.scopeLookbackMs)
      : DEFAULT_ALERTS_SCOPE_LOOKBACK_MS
  );
  const scopeStopIds = uniqueText(options.scopeStopIds);
  const scopeRouteIds = uniqueText(options.scopeRouteIds);
  const scopeTripIds = uniqueText(options.scopeTripIds);
  const queryLike = typeof options.queryLike === "function" ? options.queryLike : dbQuery;

  const meta = baseMeta(nowMs);
  meta.freshnessThresholdMs = freshnessThresholdMs;
  meta.freshnessMaxAgeSeconds = Math.round(freshnessThresholdMs / 1000);

  if (!enabled) {
    meta.reason = "disabled";
    meta.cacheStatus = "BYPASS";
    return { alerts: EMPTY_ALERTS, meta };
  }

  let rows = [];
  try {
    const res = await queryLike(
      `
        SELECT
          alert_id,
          effect,
          cause,
          severity,
          header_text,
          description_text,
          header_translations,
          description_translations,
          active_start,
          active_end,
          informed_entities,
          updated_at
        FROM public.rt_service_alerts
        WHERE updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
          AND (
            (
              cardinality($2::text[]) = 0
              AND cardinality($3::text[]) = 0
              AND cardinality($4::text[]) = 0
            )
            OR jsonb_array_length(COALESCE(informed_entities, '[]'::jsonb)) = 0
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(informed_entities, '[]'::jsonb)) AS informed
              WHERE
                (informed ->> 'stop_id') = ANY($2::text[])
                OR (informed ->> 'route_id') = ANY($3::text[])
                OR (informed ->> 'trip_id') = ANY($4::text[])
            )
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $5
      `,
      [scopeLookbackMs, scopeStopIds, scopeRouteIds, scopeTripIds, maxRows]
    );
    rows = Array.isArray(res?.rows) ? res.rows : [];
  } catch (err) {
    meta.reason = err?.code === "42P01" ? "parsed_unavailable" : "query_failed";
    meta.cacheStatus = "ERROR";
    meta.lastError = text(err?.message || err) || "parsed_query_failed";
    return { alerts: EMPTY_ALERTS, meta };
  }

  if (rows.length === 0) {
    meta.reason = "missing_cache";
    meta.cacheStatus = "MISS";
    meta.parsedRowCount = 0;
    meta.parsedMaxUpdatedAt = null;
    return { alerts: EMPTY_ALERTS, meta };
  }

  let newestUpdatedAtMs = null;
  const normalizedRows = rows.map((row) => {
    const updatedAtMs = parseUpdatedAtMs(row?.updated_at);
    if (Number.isFinite(updatedAtMs) && (!Number.isFinite(newestUpdatedAtMs) || updatedAtMs > newestUpdatedAtMs)) {
      newestUpdatedAtMs = updatedAtMs;
    }
    const start = parseEpochSecToDate(row?.active_start);
    const end = parseEpochSecToDate(row?.active_end);

    // Prefer JSONB multi-language translations if available; fall back to single-language text columns
    const headerTranslationsFromJsonb = parseTranslations(row?.header_translations);
    const descriptionTranslationsFromJsonb = parseTranslations(row?.description_translations);
    const headerTranslations = headerTranslationsFromJsonb || (text(row?.header_text)
      ? [{ language: "", text: text(row.header_text) }]
      : []);
    const descriptionTranslations = descriptionTranslationsFromJsonb || (text(row?.description_text)
      ? [{ language: "", text: text(row.description_text) }]
      : []);

    return {
      id: text(row?.alert_id),
      cause: text(row?.cause) || null,
      effect: text(row?.effect) || null,
      severity: text(row?.severity).toLowerCase() || null,
      headerTranslations,
      descriptionTranslations,
      headerText: text(row?.header_text) || null,
      descriptionText: text(row?.description_text) || null,
      activePeriods: [{ start, end }],
      informedEntities: normalizeInformedEntities(row?.informed_entities),
      _updatedAtMs: updatedAtMs,
    };
  });

  const activeRows = normalizedRows.filter((row) => {
    const periods = Array.isArray(row.activePeriods) ? row.activePeriods : [];
    if (periods.length === 0) return true;
    return periods.some((period) => {
      const startMs = period?.start instanceof Date ? period.start.getTime() : null;
      const endMs = period?.end instanceof Date ? period.end.getTime() : null;
      const afterStart = startMs == null || nowMs >= startMs;
      const beforeEnd = endMs == null || nowMs <= endMs;
      return afterStart && beforeEnd;
    });
  });

  const scopedRows = activeRows.filter((row) =>
    matchesScope(row, {
      scopeStopIds,
      scopeRouteIds,
      scopeTripIds,
    })
  );

  const fetchedAtIso = toIsoOrNull(newestUpdatedAtMs);
  const ageMs = Number.isFinite(newestUpdatedAtMs) ? Math.max(0, nowMs - newestUpdatedAtMs) : null;
  meta.fetchedAt = fetchedAtIso;
  meta.cacheFetchedAt = fetchedAtIso;
  meta.cacheAgeMs = Number.isFinite(ageMs) ? Math.round(ageMs) : null;
  meta.ageSeconds = Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null;
  meta.parsedRowCount = rows.length;
  meta.parsedMaxUpdatedAt = fetchedAtIso;

  const isStale = Number.isFinite(ageMs) && ageMs > freshnessThresholdMs;
  const staleBeyondGrace =
    Number.isFinite(ageMs) && ageMs > freshnessThresholdMs + staleGraceMs;
  if (staleBeyondGrace) {
    meta.reason = "stale_cache";
    meta.cacheStatus = "STALE";
    return { alerts: EMPTY_ALERTS, meta };
  }

  const entities = scopedRows.map((row) => {
    const out = { ...row };
    delete out._updatedAtMs;
    return out;
  });

  meta.available = entities.length > 0;
  meta.applied = entities.length > 0;
  meta.reason = entities.length > 0 ? (isStale ? "stale_cache" : "applied") : "no_alerts";
  meta.cacheStatus = isStale ? "STALE" : "FRESH";
  return {
    alerts: { entities },
    meta,
  };
}
