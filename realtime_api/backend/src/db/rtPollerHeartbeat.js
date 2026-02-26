import { query } from "./query.js";

const HEARTBEAT_ROW_ID = 1;

function asText(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function asDate(value) {
  const out = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(out.getTime())) return new Date();
  return out;
}

function resolveInstanceId(instanceId) {
  return (
    asText(instanceId) ||
    asText(process.env.FLY_MACHINE_ID) ||
    asText(process.env.HOSTNAME) ||
    null
  );
}

export async function touchTripUpdatesHeartbeat({ at = new Date(), instanceId } = {}) {
  const nowAt = asDate(at);
  await query(
    `
      INSERT INTO public.rt_poller_heartbeat (
        id,
        updated_at,
        tripupdates_updated_at,
        last_error,
        instance_id
      )
      VALUES ($1, $2, $2, NULL, $3)
      ON CONFLICT (id)
      DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        tripupdates_updated_at = EXCLUDED.tripupdates_updated_at,
        last_error = NULL,
        instance_id = COALESCE(EXCLUDED.instance_id, public.rt_poller_heartbeat.instance_id)
    `,
    [HEARTBEAT_ROW_ID, nowAt, resolveInstanceId(instanceId)]
  );
}

export async function touchAlertsHeartbeat({ at = new Date(), instanceId } = {}) {
  const nowAt = asDate(at);
  await query(
    `
      INSERT INTO public.rt_poller_heartbeat (
        id,
        updated_at,
        alerts_updated_at,
        last_error,
        instance_id
      )
      VALUES ($1, $2, $2, NULL, $3)
      ON CONFLICT (id)
      DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        alerts_updated_at = EXCLUDED.alerts_updated_at,
        last_error = NULL,
        instance_id = COALESCE(EXCLUDED.instance_id, public.rt_poller_heartbeat.instance_id)
    `,
    [HEARTBEAT_ROW_ID, nowAt, resolveInstanceId(instanceId)]
  );
}

export async function touchPollerHeartbeatError({
  at = new Date(),
  errorMessage,
  instanceId,
} = {}) {
  const nowAt = asDate(at);
  await query(
    `
      INSERT INTO public.rt_poller_heartbeat (
        id,
        updated_at,
        last_error,
        instance_id
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id)
      DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        last_error = EXCLUDED.last_error,
        instance_id = COALESCE(EXCLUDED.instance_id, public.rt_poller_heartbeat.instance_id)
    `,
    [HEARTBEAT_ROW_ID, nowAt, asText(errorMessage), resolveInstanceId(instanceId)]
  );
}

export async function getPollerHeartbeat() {
  const res = await query(
    `
      SELECT
        updated_at,
        tripupdates_updated_at,
        alerts_updated_at,
        last_error,
        instance_id
      FROM public.rt_poller_heartbeat
      WHERE id = $1
      LIMIT 1
    `,
    [HEARTBEAT_ROW_ID]
  );
  return res.rows?.[0] || null;
}
