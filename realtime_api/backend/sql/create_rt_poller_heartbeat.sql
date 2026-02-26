-- Create shared poller heartbeat table.
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/create_rt_poller_heartbeat.sql

CREATE TABLE IF NOT EXISTS public.rt_poller_heartbeat (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tripupdates_updated_at TIMESTAMPTZ NULL,
  alerts_updated_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  instance_id TEXT NULL
);
