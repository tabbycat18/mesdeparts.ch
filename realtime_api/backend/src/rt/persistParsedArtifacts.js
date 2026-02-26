import { pool } from "../../db.js";
import { normalizeAlertEntity } from "../loaders/fetchServiceAlerts.js";

const DEFAULT_RT_PARSED_RETENTION_HOURS = Math.max(
  1,
  Number(process.env.RT_PARSED_RETENTION_HOURS || "6")
);

function text(value) {
  return String(value || "").trim();
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const out = Number(value);
    return Number.isFinite(out) ? out : null;
  }
  if (value && typeof value === "object" && typeof value.toNumber === "function") {
    const out = value.toNumber();
    return Number.isFinite(out) ? out : null;
  }
  return null;
}

function normalizeTripStartDate(value) {
  const raw = text(value);
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 8) return "";
  return digits;
}

function normalizeTripRelationship(raw) {
  if (typeof raw === "string") {
    const out = raw.toUpperCase();
    return out === "CANCELLED" ? "CANCELED" : out;
  }
  const n = asNumber(raw);
  switch (n) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "ADDED";
    case 2:
      return "UNSCHEDULED";
    case 3:
      return "CANCELED";
    case 4:
      return "DUPLICATED";
    default:
      return "";
  }
}

function normalizeStopRelationship(raw) {
  if (typeof raw === "string") {
    const out = raw.toUpperCase();
    return out === "CANCELLED" ? "CANCELED" : out;
  }
  const n = asNumber(raw);
  switch (n) {
    case 0:
      return "SCHEDULED";
    case 1:
      return "SKIPPED";
    case 2:
      return "NO_DATA";
    case 3:
      return "UNSCHEDULED";
    default:
      return "";
  }
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function getTripUpdate(entity) {
  return pick(entity, "trip_update", "tripUpdate") || null;
}

function getStopTimeUpdates(tripUpdate) {
  const updates = pick(tripUpdate, "stop_time_update", "stopTimeUpdate");
  return Array.isArray(updates) ? updates : [];
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// Upsert batch-sizing constants.
// UPSERT_MAX_PARAMS is the hard cap on bound parameters per statement (protects
// against oversized wire payloads that cause connection stalls).
// Effective batch size = min(desired, floor(MAX_PARAMS / paramsPerRow)).
export const UPSERT_MAX_PARAMS = 30_000;
export const TRIP_PARAMS_PER_ROW = 4;   // trip_id, route_id, start_date, schedule_relationship
export const STOP_PARAMS_PER_ROW = 9;   // trip_id, stop_sequence, stop_id, dep_delay, arr_delay, dep_time, arr_time, platform, sched_rel

const TRIP_UPSERT_DESIRED_BATCH_ROWS = 500;
const STOP_UPSERT_DESIRED_BATCH_ROWS = 500;

export const TRIP_UPSERT_BATCH_SIZE = Math.min(
  TRIP_UPSERT_DESIRED_BATCH_ROWS,
  Math.floor(UPSERT_MAX_PARAMS / TRIP_PARAMS_PER_ROW)
);
export const STOP_UPSERT_BATCH_SIZE = Math.min(
  STOP_UPSERT_DESIRED_BATCH_ROWS,
  Math.floor(UPSERT_MAX_PARAMS / STOP_PARAMS_PER_ROW)
);

function parseActivePeriodBounds(periods = []) {
  let minStart = null;
  let maxEnd = null;
  for (const period of periods) {
    const startDate = period?.start instanceof Date ? period.start : null;
    const endDate = period?.end instanceof Date ? period.end : null;
    const startSec = startDate ? Math.floor(startDate.getTime() / 1000) : null;
    const endSec = endDate ? Math.floor(endDate.getTime() / 1000) : null;
    if (Number.isFinite(startSec) && (minStart == null || startSec < minStart)) minStart = startSec;
    if (Number.isFinite(endSec) && (maxEnd == null || endSec > maxEnd)) maxEnd = endSec;
  }
  return { activeStart: minStart, activeEnd: maxEnd };
}

function extractTripUpdatesRows(feed) {
  const entities = Array.isArray(feed?.entities)
    ? feed.entities
    : Array.isArray(feed?.entity)
      ? feed.entity
      : [];

  const tripMap = new Map();
  const stopMap = new Map();

  for (const entity of entities) {
    const tripUpdate = getTripUpdate(entity);
    if (!tripUpdate) continue;

    const trip = pick(tripUpdate, "trip") || null;
    const tripId = text(pick(trip, "trip_id", "tripId"));
    if (!tripId) continue;
    const routeId = text(pick(trip, "route_id", "routeId")) || null;
    const startDate = normalizeTripStartDate(pick(trip, "start_date", "startDate"));
    const tripRel = normalizeTripRelationship(
      pick(trip, "schedule_relationship", "scheduleRelationship")
    );
    tripMap.set(`${tripId}|${startDate}`, {
      trip_id: tripId,
      route_id: routeId,
      start_date: startDate || null,
      schedule_relationship: tripRel || null,
    });

    for (const stu of getStopTimeUpdates(tripUpdate)) {
      const stopId = text(pick(stu, "stop_id", "stopId"));
      if (!stopId) continue;
      const stopSequence = asNumber(pick(stu, "stop_sequence", "stopSequence"));
      const dep = pick(stu, "departure") || null;
      const arr = pick(stu, "arrival") || null;
      const departureDelay = asNumber(pick(dep, "delay"));
      const arrivalDelay = asNumber(pick(arr, "delay"));
      const departureTimeRt = asNumber(pick(dep, "time"));
      const arrivalTimeRt = asNumber(pick(arr, "time"));
      const stopRel = normalizeStopRelationship(
        pick(stu, "schedule_relationship", "scheduleRelationship")
      );
      const key = `${tripId}|${stopId}|${Number.isFinite(stopSequence) ? stopSequence : ""}`;
      stopMap.set(key, {
        trip_id: tripId,
        stop_sequence: Number.isFinite(stopSequence) ? Math.trunc(stopSequence) : null,
        stop_id: stopId,
        departure_delay: Number.isFinite(departureDelay) ? Math.trunc(departureDelay) : null,
        arrival_delay: Number.isFinite(arrivalDelay) ? Math.trunc(arrivalDelay) : null,
        departure_time_rt: Number.isFinite(departureTimeRt) ? Math.trunc(departureTimeRt) : null,
        arrival_time_rt: Number.isFinite(arrivalTimeRt) ? Math.trunc(arrivalTimeRt) : null,
        platform: null,
        schedule_relationship: stopRel || null,
      });
    }
  }

  return {
    tripRows: Array.from(tripMap.values()),
    stopRows: Array.from(stopMap.values()),
  };
}

function extractServiceAlertsRows(feed) {
  const entities = Array.isArray(feed?.entity) ? feed.entity : [];
  const rows = [];
  for (const entity of entities) {
    const normalized = normalizeAlertEntity(entity);
    if (!normalized || !text(normalized.id)) continue;
    const { activeStart, activeEnd } = parseActivePeriodBounds(
      Array.isArray(normalized.activePeriods) ? normalized.activePeriods : []
    );
    rows.push({
      alert_id: text(normalized.id),
      effect: text(normalized.effect) || null,
      cause: text(normalized.cause) || null,
      severity: text(normalized.severity) || null,
      header_text: text(normalized.headerText) || null,
      description_text: text(normalized.descriptionText) || null,
      // Store full multi-language translations in JSONB for localization at read time
      header_translations: Array.isArray(normalized.headerTranslations) && normalized.headerTranslations.length > 0
        ? JSON.stringify(normalized.headerTranslations)
        : null,
      description_translations: Array.isArray(normalized.descriptionTranslations) && normalized.descriptionTranslations.length > 0
        ? JSON.stringify(normalized.descriptionTranslations)
        : null,
      active_start: Number.isFinite(activeStart) ? Math.trunc(activeStart) : null,
      active_end: Number.isFinite(activeEnd) ? Math.trunc(activeEnd) : null,
      informed_entities: JSON.stringify(
        Array.isArray(normalized.informedEntities) ? normalized.informedEntities : []
      ),
    });
  }
  return rows;
}

async function withAdvisoryWriteLock(lockId, fn, poolLike = pool) {
  const client = await poolLike.connect();
  let caughtError = null;
  const txDiagnostics = {
    transactionClientUsed: true,
    transactionCommitted: false,
    transactionRolledBack: false,
    clientReleased: null,
  };
  try {
    await client.query("BEGIN");
    const lockRes = await client.query(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [Math.trunc(lockId)]
    );
    const acquired = lockRes.rows?.[0]?.acquired === true;
    if (!acquired) {
      await client.query("ROLLBACK");
      txDiagnostics.transactionRolledBack = true;
      return {
        updated: false,
        writeSkippedByLock: true,
        txDiagnostics,
      };
    }

    const out = await fn(client);
    await client.query("COMMIT");
    txDiagnostics.transactionCommitted = true;
    return {
      updated: true,
      writeSkippedByLock: false,
      ...out,
      txDiagnostics,
    };
  } catch (err) {
    caughtError = err;
    try {
      if (!txDiagnostics.transactionCommitted && !txDiagnostics.transactionRolledBack) {
        await client.query("ROLLBACK");
        txDiagnostics.transactionRolledBack = true;
      }
    } catch {}
    if (err && typeof err === "object") {
      err.txDiagnostics = txDiagnostics;
    }
    throw err;
  } finally {
    try {
      if (!txDiagnostics.transactionCommitted && !txDiagnostics.transactionRolledBack) {
        await client.query("ROLLBACK");
        txDiagnostics.transactionRolledBack = true;
      }
    } catch {}
    try {
      client.release();
      txDiagnostics.clientReleased = true;
    } catch {
      txDiagnostics.clientReleased = false;
      if (caughtError && typeof caughtError === "object") {
        caughtError.txDiagnostics = txDiagnostics;
      }
    }
  }
}

function resolveRetentionHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RT_PARSED_RETENTION_HOURS;
  return n;
}

async function deleteOlderThanRetention(client, tableName, retentionHours) {
  const res = await client.query(
    `
      DELETE FROM ${tableName}
      WHERE updated_at < NOW() - ($1::double precision * INTERVAL '1 hour')
    `,
    [retentionHours]
  );
  return Number(res?.rowCount || 0);
}

async function insertTripRows(client, rows = []) {
  if (!rows.length) return;
  for (const group of chunk(rows, 500)) {
    const values = [];
    const params = [];
    let p = 1;
    for (const row of group) {
      values.push(
        row.trip_id,
        row.route_id,
        row.start_date,
        row.schedule_relationship
      );
      params.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, NOW())`);
      p += 4;
    }
    await client.query(
      `
        INSERT INTO public.rt_trip_updates (
          trip_id,
          route_id,
          start_date,
          schedule_relationship,
          updated_at
        )
        VALUES ${params.join(",")}
      `,
      values
    );
  }
}

async function insertStopRows(client, rows = []) {
  if (!rows.length) return;
  for (const group of chunk(rows, 500)) {
    const values = [];
    const params = [];
    let p = 1;
    for (const row of group) {
      values.push(
        row.trip_id,
        row.stop_sequence,
        row.stop_id,
        row.departure_delay,
        row.arrival_delay,
        row.departure_time_rt,
        row.arrival_time_rt,
        row.platform,
        row.schedule_relationship
      );
      params.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, NOW())`
      );
      p += 9;
    }
    await client.query(
      `
        INSERT INTO public.rt_stop_time_updates (
          trip_id,
          stop_sequence,
          stop_id,
          departure_delay,
          arrival_delay,
          departure_time_rt,
          arrival_time_rt,
          platform,
          schedule_relationship,
          updated_at
        )
        VALUES ${params.join(",")}
      `,
      values
    );
  }
}

async function upsertTripRows(client, rows = []) {
  if (!rows.length) return { batchCount: 0, maxBatchSize: 0 };
  let batchCount = 0;
  let maxBatchSize = 0;
  for (const group of chunk(rows, TRIP_UPSERT_BATCH_SIZE)) {
    batchCount++;
    if (group.length > maxBatchSize) maxBatchSize = group.length;
    const values = [];
    const params = [];
    let p = 1;
    for (const row of group) {
      values.push(
        row.trip_id,
        row.route_id,
        row.start_date,
        row.schedule_relationship
      );
      params.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, NOW())`);
      p += 4;
    }
    await client.query(
      `
        INSERT INTO public.rt_trip_updates (
          trip_id,
          route_id,
          start_date,
          schedule_relationship,
          updated_at
        )
        VALUES ${params.join(",")}
        ON CONFLICT (trip_id) DO UPDATE SET
          route_id              = EXCLUDED.route_id,
          start_date            = EXCLUDED.start_date,
          schedule_relationship = EXCLUDED.schedule_relationship,
          updated_at            = EXCLUDED.updated_at
      `,
      values
    );
  }
  return { batchCount, maxBatchSize };
}

async function upsertStopRows(client, rows = []) {
  if (!rows.length) return { batchCount: 0, maxBatchSize: 0 };
  let batchCount = 0;
  let maxBatchSize = 0;
  for (const group of chunk(rows, STOP_UPSERT_BATCH_SIZE)) {
    batchCount++;
    if (group.length > maxBatchSize) maxBatchSize = group.length;
    const values = [];
    const params = [];
    let p = 1;
    for (const row of group) {
      values.push(
        row.trip_id,
        row.stop_sequence,
        row.stop_id,
        row.departure_delay,
        row.arrival_delay,
        row.departure_time_rt,
        row.arrival_time_rt,
        row.platform,
        row.schedule_relationship
      );
      params.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, NOW())`
      );
      p += 9;
    }
    await client.query(
      `
        INSERT INTO public.rt_stop_time_updates (
          trip_id,
          stop_sequence,
          stop_id,
          departure_delay,
          arrival_delay,
          departure_time_rt,
          arrival_time_rt,
          platform,
          schedule_relationship,
          updated_at
        )
        VALUES ${params.join(",")}
        ON CONFLICT (trip_id, stop_id, stop_sequence) DO UPDATE SET
          departure_delay       = EXCLUDED.departure_delay,
          arrival_delay         = EXCLUDED.arrival_delay,
          departure_time_rt     = EXCLUDED.departure_time_rt,
          arrival_time_rt       = EXCLUDED.arrival_time_rt,
          platform              = EXCLUDED.platform,
          schedule_relationship = EXCLUDED.schedule_relationship,
          updated_at            = EXCLUDED.updated_at
      `,
      values
    );
  }
  return { batchCount, maxBatchSize };
}

async function insertAlertRows(client, rows = []) {
  if (!rows.length) return;
  for (const group of chunk(rows, 300)) {
    const values = [];
    const params = [];
    let p = 1;
    for (const row of group) {
      values.push(
        row.alert_id,
        row.effect,
        row.cause,
        row.severity,
        row.header_text,
        row.description_text,
        row.header_translations ?? null,
        row.description_translations ?? null,
        row.active_start,
        row.active_end,
        row.informed_entities
      );
      params.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}::jsonb, $${p + 7}::jsonb, $${p + 8}, $${p + 9}, $${p + 10}::jsonb, NOW())`
      );
      p += 11;
    }
    await client.query(
      `
        INSERT INTO public.rt_service_alerts (
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
        )
        VALUES ${params.join(",")}
      `,
      values
    );
  }
}

export async function persistParsedTripUpdatesSnapshot(
  feed,
  { writeLockId, retentionHours, poolLike } = {}
) {
  const lockId = Number(writeLockId);
  if (!Number.isFinite(lockId)) {
    throw new Error("persist_parsed_trip_updates_missing_lock_id");
  }
  const effectiveRetentionHours = resolveRetentionHours(retentionHours);

  const { tripRows, stopRows } = extractTripUpdatesRows(feed);
  return withAdvisoryWriteLock(lockId, async (client) => {
    const deletedByRetentionStopRows = await deleteOlderThanRetention(
      client,
      "public.rt_stop_time_updates",
      effectiveRetentionHours
    );
    const deletedByRetentionTripRows = await deleteOlderThanRetention(
      client,
      "public.rt_trip_updates",
      effectiveRetentionHours
    );
    const deletedBySnapshotStop = await client.query("DELETE FROM public.rt_stop_time_updates");
    const deletedBySnapshotTrip = await client.query("DELETE FROM public.rt_trip_updates");
    await insertTripRows(client, tripRows);
    await insertStopRows(client, stopRows);
    return {
      retentionHours: effectiveRetentionHours,
      tripRows: tripRows.length,
      stopRows: stopRows.length,
      deletedByRetentionTripRows,
      deletedByRetentionStopRows,
      deletedBySnapshotTripRows: Number(deletedBySnapshotTrip?.rowCount || 0),
      deletedBySnapshotStopRows: Number(deletedBySnapshotStop?.rowCount || 0),
    };
  }, poolLike);
}

export async function persistParsedTripUpdatesIncremental(
  feed,
  { writeLockId, retentionHours, poolLike } = {}
) {
  const lockId = Number(writeLockId);
  if (!Number.isFinite(lockId)) {
    throw new Error("persist_parsed_trip_updates_missing_lock_id");
  }
  const effectiveRetentionHours = resolveRetentionHours(retentionHours);

  const { tripRows, stopRows } = extractTripUpdatesRows(feed);
  return withAdvisoryWriteLock(lockId, async (client) => {
    const deletedByRetentionStopRows = await deleteOlderThanRetention(
      client,
      "public.rt_stop_time_updates",
      effectiveRetentionHours
    );
    const deletedByRetentionTripRows = await deleteOlderThanRetention(
      client,
      "public.rt_trip_updates",
      effectiveRetentionHours
    );
    const { batchCount: tripBatchCount, maxBatchSize: tripMaxBatchSize } =
      await upsertTripRows(client, tripRows);
    const { batchCount: stopBatchCount, maxBatchSize: stopMaxBatchSize } =
      await upsertStopRows(client, stopRows);
    return {
      retentionHours: effectiveRetentionHours,
      tripRows: tripRows.length,
      stopRows: stopRows.length,
      deletedByRetentionTripRows,
      deletedByRetentionStopRows,
      tripBatchCount,
      tripMaxBatchSize,
      stopBatchCount,
      stopMaxBatchSize,
    };
  }, poolLike);
}

export async function persistParsedServiceAlertsSnapshot(
  feed,
  { writeLockId, retentionHours, poolLike } = {}
) {
  const lockId = Number(writeLockId);
  if (!Number.isFinite(lockId)) {
    throw new Error("persist_parsed_service_alerts_missing_lock_id");
  }
  const effectiveRetentionHours = resolveRetentionHours(retentionHours);

  const rows = extractServiceAlertsRows(feed);
  return withAdvisoryWriteLock(lockId, async (client) => {
    const deletedByRetentionAlertRows = await deleteOlderThanRetention(
      client,
      "public.rt_service_alerts",
      effectiveRetentionHours
    );
    const deletedBySnapshot = await client.query("DELETE FROM public.rt_service_alerts");
    await insertAlertRows(client, rows);
    return {
      retentionHours: effectiveRetentionHours,
      alertRows: rows.length,
      deletedByRetentionAlertRows,
      deletedBySnapshotAlertRows: Number(deletedBySnapshot?.rowCount || 0),
    };
  }, poolLike);
}
