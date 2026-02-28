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

function normalizeSha256(value) {
  const out = String(value || "").trim().toLowerCase();
  if (!out) return null;
  return /^[0-9a-f]{64}$/.test(out) ? out : null;
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

function toIsoOrNull(value) {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
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
    etag: row.etag || null,
    last_error: row.last_error || null,
    last_successful_poll_at: toIsoOrNull(row.last_successful_poll_at),
  };
}

function payloadShaMetaKey(feedKey) {
  return `rt_cache_payload_sha256:${feedKey}`;
}

function lastSuccessfulPollMetaKey(feedKey) {
  return `rt_cache_last_successful_poll_at:${feedKey}`;
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

export async function ensureRtCacheMetadataRow(feed_key, options = {}) {
  const feedKey = normalizeFeedKey(feed_key);
  const fetchedAtDate = normalizeFetchedAt(options?.fetchedAt || new Date());
  const writeLockId = Number(options?.writeLockId);
  const hasWriteLockId = Number.isFinite(writeLockId);
  const etag = toNullableText(options?.etag);
  const status = toNullableInt(options?.last_status);
  const error = toNullableText(options?.last_error);
  const values = [feedKey, fetchedAtDate, etag, status, error];
  const result = await query(
    hasWriteLockId
      ? `
          WITH lock_state AS (
            SELECT pg_try_advisory_xact_lock($6::bigint) AS acquired
          ),
          inserted AS (
            INSERT INTO public.rt_cache (
              feed_key,
              fetched_at,
              payload,
              etag,
              last_status,
              last_error
            )
            SELECT $1, $2, NULL::bytea, $3, $4, $5
            FROM lock_state
            WHERE acquired
            ON CONFLICT (feed_key) DO NOTHING
            RETURNING 1 AS touched
          )
          SELECT
            (SELECT EXISTS (SELECT 1 FROM inserted)) AS inserted,
            false AS write_skipped_by_lock
          FROM lock_state
          WHERE acquired
          UNION ALL
          SELECT
            false AS inserted,
            true AS write_skipped_by_lock
          FROM lock_state
          WHERE NOT acquired
          LIMIT 1
        `
      : `
          WITH inserted AS (
            INSERT INTO public.rt_cache (
              feed_key,
              fetched_at,
              payload,
              etag,
              last_status,
              last_error
            )
            VALUES ($1, $2, NULL::bytea, $3, $4, $5)
            ON CONFLICT (feed_key) DO NOTHING
            RETURNING 1 AS touched
          )
          SELECT
            EXISTS (SELECT 1 FROM inserted) AS inserted,
            false AS write_skipped_by_lock
        `,
    hasWriteLockId ? [...values, Math.trunc(writeLockId)] : values
  );
  const row = result.rows[0] || {};
  return {
    inserted: row.inserted === true,
    writeSkippedByLock: row.write_skipped_by_lock === true,
  };
}

export async function updateRtCacheStatus(
  feed_key,
  fetchedAt,
  etag,
  last_status,
  last_error,
  options = {}
) {
  const feedKey = normalizeFeedKey(feed_key);
  const fetchedAtDate = normalizeFetchedAt(fetchedAt || new Date());
  const writeLockId = Number(options?.writeLockId);
  const hasWriteLockId = Number.isFinite(writeLockId);
  const values = [
    feedKey,
    fetchedAtDate,
    toNullableText(etag),
    toNullableInt(last_status),
    toNullableText(last_error),
  ];
  const result = await query(
    hasWriteLockId
      ? `
          WITH lock_state AS (
            SELECT pg_try_advisory_xact_lock($6::bigint) AS acquired
          ),
          updated AS (
            UPDATE public.rt_cache
            SET
              fetched_at = $2,
              etag = COALESCE($3, etag),
              last_status = $4,
              last_error = $5
            FROM lock_state
            WHERE public.rt_cache.feed_key = $1
              AND lock_state.acquired
            RETURNING 1 AS touched
          )
          SELECT
            EXISTS (SELECT 1 FROM updated) AS updated,
            false AS write_skipped_by_lock
          FROM lock_state
          WHERE acquired
          UNION ALL
          SELECT
            false AS updated,
            true AS write_skipped_by_lock
          FROM lock_state
          WHERE NOT acquired
          LIMIT 1
        `
      : `
          WITH updated AS (
            UPDATE public.rt_cache
            SET
              fetched_at = $2,
              etag = COALESCE($3, etag),
              last_status = $4,
              last_error = $5
            WHERE feed_key = $1
            RETURNING 1 AS touched
          )
          SELECT
            EXISTS (SELECT 1 FROM updated) AS updated,
            false AS write_skipped_by_lock
        `,
    hasWriteLockId ? [...values, Math.trunc(writeLockId)] : values
  );
  const row = result.rows[0] || {};
  return {
    updated: row.updated === true,
    writeSkippedByLock: row.write_skipped_by_lock === true,
  };
}

export async function getRtCachePayloadSha(feed_key) {
  const feedKey = normalizeFeedKey(feed_key);
  const result = await query(
    `
      SELECT value
      FROM public.meta_kv
      WHERE key = $1
      LIMIT 1
    `,
    [payloadShaMetaKey(feedKey)]
  );
  return normalizeSha256(result.rows[0]?.value);
}

export async function setRtCachePayloadSha(feed_key, sha256, options = {}) {
  const feedKey = normalizeFeedKey(feed_key);
  const normalizedSha = normalizeSha256(sha256);
  if (!normalizedSha) return { updated: false, writeSkippedByLock: false };

  const writeLockId = Number(options?.writeLockId);
  const hasWriteLockId = Number.isFinite(writeLockId);
  const values = [payloadShaMetaKey(feedKey), normalizedSha];
  const result = await query(
    hasWriteLockId
      ? `
          WITH lock_state AS (
            SELECT pg_try_advisory_xact_lock($3::bigint) AS acquired
          ),
          upserted AS (
            INSERT INTO public.meta_kv (key, value, updated_at)
            SELECT $1, $2, NOW()
            FROM lock_state
            WHERE acquired
            ON CONFLICT (key)
            DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = NOW()
            RETURNING 1 AS touched
          )
          SELECT
            EXISTS (SELECT 1 FROM upserted) AS updated,
            false AS write_skipped_by_lock
          FROM lock_state
          WHERE acquired
          UNION ALL
          SELECT
            false AS updated,
            true AS write_skipped_by_lock
          FROM lock_state
          WHERE NOT acquired
          LIMIT 1
        `
      : `
          INSERT INTO public.meta_kv (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key)
          DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
          RETURNING true AS updated, false AS write_skipped_by_lock
        `,
    hasWriteLockId ? [...values, Math.trunc(writeLockId)] : values
  );
  const row = result.rows[0] || {};
  return {
    updated: row.updated === true,
    writeSkippedByLock: row.write_skipped_by_lock === true,
  };
}

export async function getRtCacheLastSuccessfulPollAt(feed_key) {
  const feedKey = normalizeFeedKey(feed_key);
  const result = await query(
    `
      SELECT value
      FROM public.meta_kv
      WHERE key = $1
      LIMIT 1
    `,
    [lastSuccessfulPollMetaKey(feedKey)]
  );
  return toIsoOrNull(result.rows[0]?.value);
}

export async function setRtCacheLastSuccessfulPollAt(feed_key, at = new Date(), options = {}) {
  const feedKey = normalizeFeedKey(feed_key);
  const isoValue = toIsoOrNull(at);
  if (!isoValue) return { updated: false, writeSkippedByLock: false };

  const writeLockId = Number(options?.writeLockId);
  const hasWriteLockId = Number.isFinite(writeLockId);
  const values = [lastSuccessfulPollMetaKey(feedKey), isoValue];
  const result = await query(
    hasWriteLockId
      ? `
          WITH lock_state AS (
            SELECT pg_try_advisory_xact_lock($3::bigint) AS acquired
          ),
          upserted AS (
            INSERT INTO public.meta_kv (key, value, updated_at)
            SELECT $1, $2, NOW()
            FROM lock_state
            WHERE acquired
            ON CONFLICT (key)
            DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = NOW()
            RETURNING 1 AS touched
          )
          SELECT
            EXISTS (SELECT 1 FROM upserted) AS updated,
            false AS write_skipped_by_lock
          FROM lock_state
          WHERE acquired
          UNION ALL
          SELECT
            false AS updated,
            true AS write_skipped_by_lock
          FROM lock_state
          WHERE NOT acquired
          LIMIT 1
        `
      : `
          INSERT INTO public.meta_kv (key, value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (key)
          DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
          RETURNING true AS updated, false AS write_skipped_by_lock
        `,
    hasWriteLockId ? [...values, Math.trunc(writeLockId)] : values
  );
  const row = result.rows[0] || {};
  return {
    updated: row.updated === true,
    writeSkippedByLock: row.write_skipped_by_lock === true,
  };
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
        c.fetched_at,
        c.last_status,
        octet_length(c.payload) AS payload_bytes,
        c.etag,
        c.last_error,
        (
          SELECT mk.value
          FROM public.meta_kv mk
          WHERE mk.key = $2
          LIMIT 1
        ) AS last_successful_poll_at
      FROM public.rt_cache c
      WHERE c.feed_key = $1
      LIMIT 1
    `,
    [feedKey, lastSuccessfulPollMetaKey(feedKey)]
  );
  return rowToCacheMeta(result.rows[0] || null);
}
