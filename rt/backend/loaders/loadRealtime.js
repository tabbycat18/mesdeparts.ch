// backend/loaders/loadRealtime.js
import { pool } from "../db.js";

const GTFS_RT_URL = "https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON";

// Set DEBUG_RT=1 if you want logs
const DEBUG_RT = process.env.DEBUG_RT === "1";

// Default: refresh RT every 15s (tune with GTFS_RT_CACHE_MS)
// The upstream API is rate-limited (often 5 calls/min). We enforce a minimum TTL
// so a single backend instance cannot exceed that, even if the UI polls frequently.
const MAX_CALLS_PER_MIN = Number(process.env.GTFS_RT_MAX_CALLS_PER_MIN || "5");
const MIN_TTL_MS = Math.ceil(
  60000 /
    Math.max(
      1,
      Number.isFinite(MAX_CALLS_PER_MIN) ? MAX_CALLS_PER_MIN : 5
    )
);

const rawTtl = Number(process.env.GTFS_RT_CACHE_MS || "15000");
const CACHE_TTL_MS = Math.max(
  Number.isFinite(rawTtl) ? rawTtl : 15000,
  MIN_TTL_MS
);

const RT_RETENTION_HOURS = Number(process.env.RT_RETENTION_HOURS || "12");
const RT_RETENTION_MS = Math.max(1, RT_RETENTION_HOURS) * 60 * 60 * 1000;

let rtTableReady = false;
let lastCleanupTs = 0;

async function ensureRtUpdatesTable() {
  if (rtTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.rt_updates (
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER,
      departure_epoch BIGINT,
      delay_sec INTEGER,
      seen_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS rt_updates_unique_idx
      ON public.rt_updates (trip_id, stop_id, stop_sequence, departure_epoch);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rt_updates_stop_time_idx
      ON public.rt_updates (stop_id, departure_epoch);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rt_updates_trip_seq_idx
      ON public.rt_updates (trip_id, stop_sequence);
  `);
  rtTableReady = true;
}

async function persistRtUpdates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    await ensureRtUpdatesTable();
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = [];
      const params = [];
      let p = 1;
      for (const r of chunk) {
        values.push(
          r.tripId,
          r.stopId,
          typeof r.stopSequence === "number" ? r.stopSequence : -1,
          r.departureEpoch,
          typeof r.delaySec === "number" ? r.delaySec : null
        );
        params.push(
          `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`
        );
        p += 5;
      }
      const sql = `
        INSERT INTO public.rt_updates
          (trip_id, stop_id, stop_sequence, departure_epoch, delay_sec)
        VALUES ${params.join(", ")}
        ON CONFLICT (trip_id, stop_id, stop_sequence, departure_epoch)
        DO UPDATE SET
          delay_sec = EXCLUDED.delay_sec,
          seen_at = now();
      `;
      await pool.query(sql, values);
    }

    const now = Date.now();
    if (now - lastCleanupTs > RT_RETENTION_MS) {
      lastCleanupTs = now;
      await pool.query(
        `DELETE FROM public.rt_updates WHERE seen_at < now() - ($1 || ' milliseconds')::interval;`,
        [RT_RETENTION_MS]
      );
    }
  } catch (err) {
    if (DEBUG_RT) {
      console.warn("[GTFS-RT] persistRtUpdates failed", err?.message || err);
    }
  }
}

/**
 * Read the GTFS-RT API token from environment variables.
 * You should set one of:
 *   - GTFS_RT_TOKEN
 *   - OPENDATA_SWISS_TOKEN
 */
function getApiToken() {
  const token =
    process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN || "";
  if (!token && DEBUG_RT) {
    console.warn(
      "[GTFS-RT] Missing token (GTFS_RT_TOKEN / OPENDATA_SWISS_TOKEN)."
    );
  }
  return token;
}

/**
 * Some feeds may use stop_id without platform suffix.
 * Example DB: 8501037:0:3  (platform 3)
 * Feed may use: 8501037:0   (no platform)
 */
function stopIdVariants(stopId) {
  if (!stopId) return [];
  const v = new Set([stopId]);

  const parts = String(stopId).split(":");
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (String(last).length <= 2) {
      v.add(parts.slice(0, parts.length - 1).join(":"));
    }
  }
  return Array.from(v);
}

function seqKeyPart(stopSequence) {
  if (stopSequence === undefined || stopSequence === null) return "";
  const n = Number(stopSequence);
  return Number.isFinite(n) ? String(n) : "";
}

/* =========================
   A) Helpers you requested
   ========================= */
function pick(obj, a, b) {
  if (!obj) return undefined;
  if (obj[a] !== undefined) return obj[a];
  if (b && obj[b] !== undefined) return obj[b];
  return undefined;
}

function asNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getTripUpdate(entity) {
  return pick(entity, "trip_update", "tripUpdate") || null;
}

function getStopTimeUpdates(tripUpdate) {
  const u = pick(tripUpdate, "stop_time_update", "stopTimeUpdate");
  return Array.isArray(u) ? u : [];
}

function getStopId(stu) {
  return pick(stu, "stop_id", "stopId") || null;
}

function getStopSequence(stu) {
  const v = pick(stu, "stop_sequence", "stopSequence");
  const n = asNumber(v);
  return n === null ? null : n;
}

function getDelaySeconds(stu) {
  const dep = pick(stu, "departure", "departure") || null;
  const arr = pick(stu, "arrival", "arrival") || null;

  const depDelay = dep ? asNumber(pick(dep, "delay", "delay")) : null;
  const arrDelay = arr ? asNumber(pick(arr, "delay", "delay")) : null;

  if (depDelay !== null) return depDelay;
  if (arrDelay !== null) return arrDelay;
  return 0;
}

function getUpdatedEpoch(stu) {
  const dep = pick(stu, "departure", "departure") || null;
  const arr = pick(stu, "arrival", "arrival") || null;

  const depTime = dep ? asNumber(pick(dep, "time", "time")) : null;
  const arrTime = arr ? asNumber(pick(arr, "time", "time")) : null;

  if (depTime !== null) return depTime;
  if (arrTime !== null) return arrTime;
  return null;
}

/**
 * Fetch the GTFS-RT feed from opentransportdata.swiss as JSON.
 */
export async function fetchGtfsRealtimeFeed() {
  const token = getApiToken();
  if (!token) {
    throw new Error(
      "[GTFS-RT] Missing API token. Set GTFS_RT_TOKEN or OPENDATA_SWISS_TOKEN."
    );
  }

  const res = await fetch(GTFS_RT_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[GTFS-RT] HTTP ${res.status} when fetching GTFS-RT: ${body.slice(0, 200)}`
    );
  }

  const data = await res.json();

  if (DEBUG_RT) {
    const keys = Object.keys(data || {});
    const entityCount = Array.isArray(data?.entity) ? data.entity.length : 0;
    console.log("[GTFS-RT] feed keys:", keys);
    console.log("[GTFS-RT] entity count:", entityCount);
  }

  return data;
}

/**
 * Build an index of delays keyed by (trip_id, stop_id_variant, stop_sequence).
 */
export function buildDelayIndex(gtfsRtFeed) {
  const byKey = Object.create(null);
  const rtRows = [];

  if (!gtfsRtFeed || !Array.isArray(gtfsRtFeed.entity)) {
    if (DEBUG_RT)
      console.warn("[GTFS-RT] Unexpected feed shape (no entity array).");
    return { byKey };
  }

  /* ==========================================
     B) Replace inner loop (your requested loop)
     ========================================== */
  for (const entity of gtfsRtFeed.entity) {
    const tu = getTripUpdate(entity);
    if (!tu) continue;

    const tripObj = pick(tu, "trip", "trip");
    const tripId = tripObj ? pick(tripObj, "trip_id", "tripId") || null : null;
    if (!tripId) continue;

    const updates = getStopTimeUpdates(tu);
    for (const stu of updates) {
      const rawStopId = getStopId(stu);
      if (!rawStopId) continue;

      const stopSequence = getStopSequence(stu);
      const seqPart = seqKeyPart(stopSequence);

      const delaySec = getDelaySeconds(stu);
      const updatedEpoch = getUpdatedEpoch(stu);

      if (updatedEpoch !== null) {
        rtRows.push({
          tripId,
          stopId: rawStopId,
          stopSequence: typeof stopSequence === "number" ? stopSequence : null,
          departureEpoch: updatedEpoch,
          delaySec,
        });
      }

      for (const stopId of stopIdVariants(rawStopId)) {
        const key = `${tripId}|${stopId}|${seqPart}`;

        const prev = byKey[key];
        if (prev) {
          const prevEpoch = prev.updatedDepartureEpoch ?? null;
          if (
            prevEpoch !== null &&
            updatedEpoch !== null &&
            prevEpoch >= updatedEpoch
          )
            continue;
          if (prevEpoch !== null && updatedEpoch === null) continue;
        }

        // NOTE: consider computing delayMin from seconds more "human":
        // delayMinDisplay: delaySec > 0 ? Math.max(1, Math.round(delaySec/60)) : Math.round(delaySec/60)
        byKey[key] = {
          tripId,
          stopId,
          stopSequence: seqPart === "" ? null : Number(seqPart),
          delaySec,
          delayMin: Math.round(delaySec / 60),
          updatedDepartureEpoch: updatedEpoch,
        };
      }
    }
  }

  if (DEBUG_RT) {
    console.log(`[GTFS-RT] Indexed ${Object.keys(byKey).length} delay entries`);
  }

  // Best-effort persistence; do not block GTFS-RT processing if the DB write fails.
  void persistRtUpdates(rtRows).catch((err) => {
    if (DEBUG_RT) console.warn("[GTFS-RT] persistRtUpdates error", err?.message || err);
  });

  return { byKey };
}

export function getDelayForStop(delayIndex, tripId, stopId, stopSequence) {
  if (!delayIndex?.byKey) return null;
  if (!tripId || !stopId) return null;

  const seqPart = seqKeyPart(stopSequence);

  for (const sid of stopIdVariants(stopId)) {
    const k1 = `${tripId}|${sid}|${seqPart}`;
    if (delayIndex.byKey[k1]) return delayIndex.byKey[k1];

    const k2 = `${tripId}|${sid}|`;
    if (delayIndex.byKey[k2]) return delayIndex.byKey[k2];
  }
  return null;
}

export async function loadRealtimeDelayIndex() {
  const feed = await fetchGtfsRealtimeFeed();
  return buildDelayIndex(feed);
}

let cached = { promise: null, ts: 0 };

export function loadRealtimeDelayIndexOnce() {
  const now = Date.now();
  const fresh = cached.promise && now - cached.ts < CACHE_TTL_MS;
  if (fresh) return cached.promise;

  if (DEBUG_RT) {
    const age = cached.ts ? now - cached.ts : null;
    console.log(
      `[GTFS-RT] refresh (ttl=${CACHE_TTL_MS}ms, min=${MIN_TTL_MS}ms, age=${
        age === null ? "n/a" : age + "ms"
      })`
    );
  }

  cached.ts = now;
  cached.promise = loadRealtimeDelayIndex().catch((err) => {
    cached = { promise: null, ts: 0 };
    throw err;
  });

  return cached.promise;
}
