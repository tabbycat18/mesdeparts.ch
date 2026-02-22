-- Create shared RT payload cache table.
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/create_rt_cache.sql

CREATE TABLE IF NOT EXISTS public.rt_cache (
  feed_key TEXT PRIMARY KEY,
  fetched_at TIMESTAMPTZ NOT NULL,
  payload BYTEA NOT NULL,
  etag TEXT NULL,
  last_status INT NULL,
  last_error TEXT NULL
);
