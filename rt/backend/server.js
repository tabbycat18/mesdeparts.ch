// backend/server.js
// Lightweight .env loader (no external deps)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const candidates = [
    path.resolve(__dirname, ".env"), // backend/.env
    path.resolve(process.cwd(), ".env"),
  ];

  const envPath = candidates.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  if (!envPath) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();

    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

import express from "express";
import cors from "cors";

const { pool } = await import("./db.js");
const { getStationboard } = await import("./src/api/stationboard.js");

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

const OTD_API_BASE = "https://transport.opendata.ch/v1/";
const OTD_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.OTD_FETCH_TIMEOUT_MS || "8000")
);

function resolveOtdApiKey() {
  return (
    process.env.OPENTDATA_API_KEY ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    process.env.GTFS_RT_TOKEN ||
    ""
  );
}

function buildOtdUrl(pathname, queryObj = {}) {
  const safePath = String(pathname || "").replace(/^\/+/, "");
  const url = new URL(safePath, OTD_API_BASE);
  for (const [key, rawVal] of Object.entries(queryObj || {})) {
    if (rawVal === undefined || rawVal === null) continue;
    const val = String(rawVal).trim();
    if (!val) continue;
    url.searchParams.set(key, val);
  }
  return url.toString();
}

async function fetchOtdJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTD_FETCH_TIMEOUT_MS);
  const apiKey = resolveOtdApiKey();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const err = new Error(
        `upstream_http_${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`
      );
      err.status = response.status;
      throw err;
    }

    return await response.json();
  } catch (err) {
    const aborted = String(err?.name || "").toLowerCase() === "aborterror";
    if (aborted) {
      const e = new Error(`upstream_timeout_${OTD_FETCH_TIMEOUT_MS}ms`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health", async (_req, res) => {
  try {
    const dbOk = await pool.query("SELECT 1 AS ok;");
    return res.json({
      ok: true,
      port: PORT,
      db: dbOk?.rows?.[0]?.ok === 1,
      ENABLE_RT: process.env.ENABLE_RT === "1",
      hasToken: !!(process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.use((req, _res, next) => {
  console.log("[API DEBUG]", {
    method: req.method,
    path: req.path,
    query: req.query,
    time: new Date().toISOString(),
  });
  next();
});

async function searchStopsPrefix(query, limit) {
  const q = String(query || "").trim();
  if (!q) return [];
  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));

  let result;
  try {
    result = await pool.query(
      `
      WITH candidates AS (
        SELECT
          COALESCE(st.parent_station, st.stop_id) AS group_id,
          ss.stop_id,
          ss.stop_name,
          ss.nb_stop_times,
          st.parent_station,
          trim(split_part(ss.stop_name, ',', 2)) AS after_comma
        FROM public.search_stops ss
        JOIN public.stops_union st ON st.stop_id = ss.stop_id
        WHERE
          lower(ss.stop_name) LIKE lower($1) || '%'
          OR lower(trim(split_part(ss.stop_name, ',', 2))) LIKE lower($1) || '%'
      ),
      per_group AS (
        SELECT DISTINCT ON (group_id)
          group_id,
          stop_id,
          stop_name,
          nb_stop_times,
          parent_station,
          after_comma
        FROM candidates
        ORDER BY
          group_id,
          (parent_station IS NULL) DESC,                 -- prefer parent rows
          (lower(stop_name) = lower($1)) DESC,           -- exact full-name match
          (lower(after_comma) = lower($1)) DESC,         -- exact after-comma match
          (position(',' in stop_name) = 0) DESC,         -- no-comma first
          nb_stop_times DESC,
          stop_name ASC
      )
      SELECT
        group_id,
        stop_id,
        stop_name,
        nb_stop_times,
        parent_station,
        after_comma
      FROM per_group
      ORDER BY
        (parent_station IS NULL) DESC,
        (lower(stop_name) = lower($1)) DESC,
        (lower(after_comma) = lower($1)) DESC,
        (position(',' in stop_name) = 0) DESC,
        nb_stop_times DESC,
        stop_name ASC
      LIMIT $2;
      `,
      [q, lim]
    );
  } catch (err) {
    console.warn("[API] searchStopsPrefix fallback query (search_stops/stops_union unavailable):", err?.message || err);
    result = await pool.query(
      `
      WITH candidates AS (
        SELECT
          COALESCE(to_jsonb(s) ->> 'parent_station', s.stop_id) AS group_id,
          s.stop_id,
          s.stop_name,
          0::int AS nb_stop_times,
          to_jsonb(s) ->> 'parent_station' AS parent_station,
          trim(split_part(s.stop_name, ',', 2)) AS after_comma
        FROM public.gtfs_stops s
        WHERE
          lower(s.stop_name) LIKE lower($1) || '%'
          OR lower(trim(split_part(s.stop_name, ',', 2))) LIKE lower($1) || '%'
      ),
      per_group AS (
        SELECT DISTINCT ON (group_id)
          group_id,
          stop_id,
          stop_name,
          nb_stop_times,
          parent_station,
          after_comma
        FROM candidates
        ORDER BY
          group_id,
          (parent_station IS NULL) DESC,
          (lower(stop_name) = lower($1)) DESC,
          (lower(after_comma) = lower($1)) DESC,
          (position(',' in stop_name) = 0) DESC,
          stop_name ASC
      )
      SELECT
        group_id,
        stop_id,
        stop_name,
        nb_stop_times,
        parent_station,
        after_comma
      FROM per_group
      ORDER BY
        (parent_station IS NULL) DESC,
        (lower(stop_name) = lower($1)) DESC,
        (lower(after_comma) = lower($1)) DESC,
        (position(',' in stop_name) = 0) DESC,
        stop_name ASC
      LIMIT $2;
      `,
      [q, lim]
    );
  }

  return (result.rows || []).map((r) => ({
    stop_id: r.group_id || r.stop_id,
    group_id: r.group_id,
    raw_stop_id: r.stop_id,
    stop_name: r.stop_name,
    parent_station: r.parent_station,
    nb_stop_times: r.nb_stop_times ?? 0,
  }));
}

async function searchStopsNearby(lat, lon, limit) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return [];

  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));

  let result;
  try {
    result = await pool.query(
      `
      WITH candidates AS (
        SELECT
          COALESCE(st.parent_station, st.stop_id) AS group_id,
          st.stop_id,
          st.stop_name,
          st.parent_station,
          ss.nb_stop_times,
          2 * 6371000 * ASIN(
            LEAST(
              1.0,
              SQRT(
                POWER(SIN(RADIANS(($1 - st.stop_lat) / 2)), 2) +
                COS(RADIANS($1)) * COS(RADIANS(st.stop_lat)) *
                POWER(SIN(RADIANS(($2 - st.stop_lon) / 2)), 2)
              )
            )
          ) AS distance_m
        FROM public.stops st
        LEFT JOIN public.search_stops ss ON ss.stop_id = st.stop_id
        WHERE st.stop_lat IS NOT NULL AND st.stop_lon IS NOT NULL
      ),
      per_group AS (
        SELECT DISTINCT ON (group_id)
          group_id,
          stop_id,
          stop_name,
          parent_station,
          nb_stop_times,
          distance_m
        FROM candidates
        ORDER BY
          group_id,
          distance_m ASC
      )
      SELECT
        group_id,
        stop_id,
        stop_name,
        parent_station,
        nb_stop_times,
        distance_m
      FROM per_group
      ORDER BY distance_m ASC
      LIMIT $3;
      `,
      [latNum, lonNum, lim]
    );
  } catch (err) {
    console.warn("[API] searchStopsNearby fallback query (stops/search_stops unavailable):", err?.message || err);
    result = await pool.query(
      `
      WITH candidates AS (
        SELECT
          COALESCE(to_jsonb(s) ->> 'parent_station', s.stop_id) AS group_id,
          s.stop_id,
          s.stop_name,
          to_jsonb(s) ->> 'parent_station' AS parent_station,
          0::int AS nb_stop_times,
          2 * 6371000 * ASIN(
            LEAST(
              1.0,
              SQRT(
                POWER(SIN(RADIANS(($1 - s.stop_lat) / 2)), 2) +
                COS(RADIANS($1)) * COS(RADIANS(s.stop_lat)) *
                POWER(SIN(RADIANS(($2 - s.stop_lon) / 2)), 2)
              )
            )
          ) AS distance_m
        FROM public.gtfs_stops s
        WHERE s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
      ),
      per_group AS (
        SELECT DISTINCT ON (group_id)
          group_id,
          stop_id,
          stop_name,
          parent_station,
          nb_stop_times,
          distance_m
        FROM candidates
        ORDER BY
          group_id,
          distance_m ASC
      )
      SELECT
        group_id,
        stop_id,
        stop_name,
        parent_station,
        nb_stop_times,
        distance_m
      FROM per_group
      ORDER BY distance_m ASC
      LIMIT $3;
      `,
      [latNum, lonNum, lim]
    );
  }

  return (result.rows || []).map((r) => ({
    stop_id: r.group_id || r.stop_id,
    group_id: r.group_id,
    raw_stop_id: r.stop_id,
    stop_name: r.stop_name,
    parent_station: r.parent_station,
    nb_stop_times: r.nb_stop_times ?? 0,
    distance_m: typeof r.distance_m === "number" ? r.distance_m : Number(r.distance_m) || null,
  }));
}

app.get("/api/stops/search", async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || "").trim();
    const limit = Number(req.query.limit || "20");
    console.log("[API] /api/stops/search params", { q, limit });
    const stops = await searchStopsPrefix(q, limit);
    return res.json({ stops });
  } catch (err) {
    console.error("[API] /api/stops/search failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        error: "stops_search_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(500).json({ error: "stops_search_failed" });
  }
});

app.get("/api/stops/nearby", async (req, res) => {
  try {
    const latRaw = req.query.lat ?? req.query.latitude;
    const lonRaw = req.query.lon ?? req.query.longitude;
    const limit = Number(req.query.limit || "20");

    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    console.log("[API] /api/stops/nearby params", { lat, lon, limit });

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "invalid_coordinates" });
    }

    const stops = await searchStopsNearby(lat, lon, limit);
    return res.json({ stops });
  } catch (err) {
    console.error("[API] /api/stops/nearby failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        error: "stops_nearby_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(500).json({ error: "stops_nearby_failed" });
  }
});

app.get("/api/journey", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const passlist = String(req.query.passlist || "1").trim();
    if (!id) {
      return res.status(400).json({ error: "missing_id", expected: ["id"] });
    }

    const url = buildOtdUrl("/journey", { id, passlist });
    console.log("[API] /api/journey params", { id, passlist });
    const data = await fetchOtdJson(url);
    return res.json(data);
  } catch (err) {
    const status = Number(err?.status) || 502;
    console.error("[API] /api/journey failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(status).json({
        error: "journey_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(status).json({ error: "journey_failed" });
  }
});

app.get("/api/connections", async (req, res) => {
  try {
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const date = String(req.query.date || "").trim();
    const time = String(req.query.time || "").trim();
    const limit = String(req.query.limit || "6").trim();

    if (!from || !to) {
      return res.status(400).json({
        error: "missing_from_to",
        expected: ["from", "to"],
      });
    }

    const url = buildOtdUrl("/connections", { from, to, date, time, limit });
    console.log("[API] /api/connections params", { from, to, date, time, limit });
    const data = await fetchOtdJson(url);
    return res.json(data);
  } catch (err) {
    const status = Number(err?.status) || 502;
    console.error("[API] /api/connections failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(status).json({
        error: "connections_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(status).json({ error: "connections_failed" });
  }
});

app.get("/api/stationboard", async (req, res) => {
  try {
    const stopId = String(req.query.stop_id || "").trim();
    const limit = Number(req.query.limit || "300");
    console.log("[API] /api/stationboard params", { stopId, limit });
    if (!stopId) {
      return res.status(400).json({ error: "missing_stop_id", expected: ["stop_id"] });
    }

    const result = await getStationboard({ stopId, limit });
    return res.json(result);
  } catch (err) {
    console.error("[API] /api/stationboard failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        error: "stationboard_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(500).json({ error: "stationboard_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`MesDeparts RT backend listening on http://localhost:${PORT}`);
  console.log("[ENV]", {
    ENABLE_RT: process.env.ENABLE_RT === "1",
    hasDATABASE_URL: !!process.env.DATABASE_URL,
    hasToken: !!(process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN),
  });
});
