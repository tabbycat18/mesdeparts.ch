import { query } from "./query.js";

export const LA_TRIPUPDATES_FEED_KEY = "la_tripupdates";
export const LA_SERVICEALERTS_FEED_KEY = "la_servicealerts";

function normalizeFeedKey(feedKey) {
  const value = String(feedKey || "").trim();
  if (!value) {
    throw new Error("rt_cache_invalid_feed_key");
  }
  return value;
}

function normalizePayloadBytes(payloadBytes) {
  if (Buffer.isBuffer(payloadBytes)) return payloadBytes;
  if (payloadBytes instanceof Uint8Array) return Buffer.from(payloadBytes);
  throw new Error("rt_cache_invalid_payload_bytes");
}

function normalizeFetchedAt(value) {
  const out = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(out.getTime())) {
    throw new Error("rt_cache_invalid_fetched_at");
  }
  return out;
}

function toNullableText(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function toNullableInt(value) {
  if (value == null) return null;
  const out = Number(value);
  return Number.isFinite(out) ? Math.trunc(out) : null;
}

function rowToCacheRecord(row) {
  if (!row) return null;
  if (row.write_skipped_by_lock === true) {
    return {
      payloadBytes: null,
      fetched_at: null,
      etag: null,
      last_status: null,
      last_error: null,
      writeSkippedByLock: true,
    };
  }
  return {
    payloadBytes: Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload || []),
    fetched_at: row.fetched_at,
    etag: row.etag,
    last_status: row.last_status,
    last_error: row.last_error,
    writeSkippedByLock: false,
  };
}

function rowToCacheMeta(row) {
  if (!row) return null;
  const payloadBytes = Number(row.payload_bytes);
  return {
    fetched_at: row.fetched_at || null,
    last_status: Number.isFinite(Number(row.last_status)) ? Number(row.last_status) : null,
    payload_bytes: Number.isFinite(payloadBytes) ? payloadBytes : 0,
    has_payload: Number.isFinite(payloadBytes) ? payloadBytes > 0 : false,
  };
}

export async function upsertRtCache(
  feed_key,
  payloadBytes,
  fetchedAt,
  etag,
  last_status,
  last_error,
  options = {}
) {
  const feedKey = normalizeFeedKey(feed_key);
  const payload = normalizePayloadBytes(payloadBytes);
  const fetchedAtDate = normalizeFetchedAt(fetchedAt || new Date());
  const writeLockId = Number(options?.writeLockId);
  const hasWriteLockId = Number.isFinite(writeLockId);
  const values = [
    feedKey,
    fetchedAtDate,
    payload,
    toNullableText(etag),
    toNullableInt(last_status),
    toNullableText(last_error),
  ];
  const result = await query(
    hasWriteLockId
      ? `
          WITH lock_state AS (
            SELECT pg_try_advisory_xact_lock($7::bigint) AS acquired
          ),
          upserted AS (
            INSERT INTO public.rt_cache (
              feed_key,
              fetched_at,
              payload,
              etag,
              last_status,
              last_error
            )
            SELECT $1, $2, $3, $4, $5, $6
            FROM lock_state
            WHERE acquired
            ON CONFLICT (feed_key)
            DO UPDATE SET
              fetched_at = EXCLUDED.fetched_at,
              payload = EXCLUDED.payload,
              etag = EXCLUDED.etag,
              last_status = EXCLUDED.last_status,
              last_error = EXCLUDED.last_error
            RETURNING payload, fetched_at, etag, last_status, last_error
          )
          SELECT
            payload,
            fetched_at,
            etag,
            last_status,
            last_error,
            false AS write_skipped_by_lock
          FROM upserted
          UNION ALL
          SELECT
            NULL::bytea,
            NULL::timestamptz,
            NULL::text,
            NULL::integer,
            NULL::text,
            true AS write_skipped_by_lock
          FROM lock_state
          WHERE NOT acquired
          LIMIT 1
        `
      : `
          INSERT INTO public.rt_cache (
            feed_key,
            fetched_at,
            payload,
            etag,
            last_status,
            last_error
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (feed_key)
          DO UPDATE SET
            fetched_at = EXCLUDED.fetched_at,
            payload = EXCLUDED.payload,
            etag = EXCLUDED.etag,
            last_status = EXCLUDED.last_status,
            last_error = EXCLUDED.last_error
          RETURNING payload, fetched_at, etag, last_status, last_error, false AS write_skipped_by_lock
        `,
    hasWriteLockId ? [...values, Math.trunc(writeLockId)] : values
  );

  return rowToCacheRecord(result.rows[0] || null);
}

export async function getRtCache(feed_key) {
  const feedKey = normalizeFeedKey(feed_key);
  const result = await query(
    `
      SELECT payload, fetched_at, etag, last_status, last_error
      FROM public.rt_cache
      WHERE feed_key = $1
      LIMIT 1
    `,
    [feedKey]
  );
  return rowToCacheRecord(result.rows[0] || null);
}

export async function getRtCacheMeta(feed_key) {
  const feedKey = normalizeFeedKey(feed_key);
  const result = await query(
    `
      SELECT
        fetched_at,
        last_status,
        octet_length(payload) AS payload_bytes
      FROM public.rt_cache
      WHERE feed_key = $1
      LIMIT 1
    `,
    [feedKey]
  );
  return rowToCacheMeta(result.rows[0] || null);
}
