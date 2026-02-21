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
const { resolveStop } = await import("./src/resolve/resolveStop.js");
const { searchStops, searchStopsWithDebug } = await import("./src/search/stopsSearch.js");
const { createStationboardRouteHandler } = await import("./src/api/stationboardRoute.js");
const { fetchServiceAlerts } = await import("./src/loaders/fetchServiceAlerts.js");
const { fetchTripUpdates } = await import("./src/loaders/fetchTripUpdates.js");
const { summarizeTripUpdates } = await import("./src/loaders/tripUpdatesSummary.js");
const { readTripUpdatesFeedFromCache } = await import("./loaders/loadRealtime.js");
const { normalizeStopId } = await import("./src/util/stopScope.js");
const { informedStopMatchesForDebug } = await import("./src/util/alertDebugScope.js");
const { normalizeStopSearchText } = await import("./src/util/searchNormalize.js");

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

const OTD_API_BASE = "https://transport.opendata.ch/v1/";
const OTD_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.OTD_FETCH_TIMEOUT_MS || "8000")
);
const STOPS_SEARCH_QUERY_TIMEOUT_MS = Math.max(
  120,
  Number(process.env.STOPS_SEARCH_QUERY_TIMEOUT_MS || "1100")
);
const STOPS_SEARCH_TOTAL_TIMEOUT_MS = Math.max(
  300,
  Number(process.env.STOPS_SEARCH_TOTAL_TIMEOUT_MS || "2600")
);
const STOPS_SEARCH_FALLBACK_QUERY_TIMEOUT_MS = Math.max(
  80,
  Number(process.env.STOPS_SEARCH_FALLBACK_QUERY_TIMEOUT_MS || "900")
);
const STOPS_SEARCH_DEGRADED_TIMEOUT_MS = Math.max(
  120,
  Number(process.env.STOPS_SEARCH_DEGRADED_TIMEOUT_MS || "1500")
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

function resolveServiceAlertsApiKey() {
  return (
    process.env.OPENTDATA_GTFS_SA_KEY ||
    process.env.OPENTDATA_API_KEY ||
    process.env.GTFS_RT_TOKEN ||
    process.env.OPENDATA_SWISS_TOKEN ||
    process.env.OPENTDATA_GTFS_RT_KEY ||
    ""
  );
}

function alertIsActiveNow(alert, now) {
  const periods = Array.isArray(alert?.activePeriods) ? alert.activePeriods : [];
  if (periods.length === 0) return true;
  const nowMs = now.getTime();
  for (const p of periods) {
    const startMs = p?.start instanceof Date ? p.start.getTime() : null;
    const endMs = p?.end instanceof Date ? p.end.getTime() : null;
    const afterStart = startMs == null || nowMs >= startMs;
    const beforeEnd = endMs == null || nowMs <= endMs;
    if (afterStart && beforeEnd) return true;
  }
  return false;
}

function hasReplacementSignal(alert) {
  const effect = String(alert?.effect || "").toUpperCase();
  const text = `${alert?.headerText || ""} ${alert?.descriptionText || ""}`.toLowerCase();
  if (effect === "DETOUR" || effect === "MODIFIED_SERVICE" || effect === "NO_SERVICE") {
    return true;
  }
  return /\b(ersatz|replacement|remplacement|sostitutiv|substitute|ev(?:\s*\d+)?)\b/i.test(
    text
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

function isDebugRequest(req) {
  if (process.env.DEBUG === "1") return true;
  return String(req?.query?.debug || "").trim() === "1";
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

function createTimedSearchDb() {
  return {
    query(sql, params = []) {
      return pool.query({
        text: String(sql || ""),
        values: params,
        query_timeout: STOPS_SEARCH_QUERY_TIMEOUT_MS,
      });
    },
    queryWithTimeout(sql, params = [], timeoutMs = STOPS_SEARCH_QUERY_TIMEOUT_MS) {
      const effectiveTimeout = Math.max(
        80,
        Math.min(STOPS_SEARCH_QUERY_TIMEOUT_MS, Math.trunc(Number(timeoutMs) || 0))
      );
      return pool.query({
        text: String(sql || ""),
        values: params,
        query_timeout: effectiveTimeout,
      });
    },
  };
}

async function searchStopsPrefix(query, limit) {
  const timedDb = createTimedSearchDb();
  return searchStops(timedDb, query, limit);
}

function withTimeout(promise, timeoutMs, code = "timeout") {
  const effectiveTimeout = Math.max(100, Math.trunc(Number(timeoutMs) || 0));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(code);
      err.code = code;
      reject(err);
    }, effectiveTimeout);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function foldSearchText(value) {
  return normalizeStopSearchText(value);
}

async function fastStopsSearchFallback(query, limit) {
  const q = foldSearchText(query);
  if (q.length < 2) return [];
  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
  let res;
  try {
    res = await pool.query({
      text: `
        WITH params AS (
          SELECT $1::text AS q_norm
        ),
        ranked AS (
          SELECT
            b.group_id,
            b.stop_id,
            b.stop_name,
            b.parent_station,
            b.location_type,
            b.name_norm,
            b.is_parent,
            b.nb_stop_times,
            similarity(b.name_norm, p.q_norm)::float8 AS sim,
            CASE
              WHEN b.name_norm = p.q_norm THEN 4
              WHEN b.name_norm LIKE p.q_norm || '%' THEN 3
              WHEN b.search_text LIKE '%' || p.q_norm || '%' THEN 2
              WHEN b.search_text % p.q_norm THEN 1
              ELSE 0
            END AS tier
          FROM public.stop_search_index b
          CROSS JOIN params p
          WHERE
            p.q_norm <> ''
            AND (
              b.name_norm LIKE p.q_norm || '%'
              OR b.search_text LIKE '%' || p.q_norm || '%'
              OR b.search_text % p.q_norm
            )
        ),
        per_group AS (
          SELECT DISTINCT ON (group_id)
            group_id,
            stop_id,
            stop_name,
            parent_station,
            location_type,
            name_norm,
            is_parent,
            nb_stop_times,
            sim,
            tier
          FROM ranked
          WHERE tier > 0
          ORDER BY
            group_id,
            tier DESC,
            sim DESC,
            is_parent DESC,
            nb_stop_times DESC,
            stop_name ASC
        )
        SELECT
          group_id,
          stop_id,
          stop_name,
          parent_station,
          location_type,
          name_norm AS stop_fold
        FROM per_group
        ORDER BY
          tier DESC,
          sim DESC,
          is_parent DESC,
          nb_stop_times DESC,
          stop_name ASC
        LIMIT $2
      `,
      values: [q, lim],
      query_timeout: STOPS_SEARCH_FALLBACK_QUERY_TIMEOUT_MS,
    });
  } catch (err) {
    // Prefix-only, no trigram operator, still uses indexed normalized columns.
    res = await pool.query({
      text: `
        WITH params AS (
          SELECT
            $1::text AS q_norm,
            split_part($1::text, ' ', 1) AS q_head,
            left($1::text, 1) AS q_first
        ),
        ranked AS (
          SELECT
            b.group_id,
            b.stop_id,
            b.stop_name,
            b.parent_station,
            b.location_type,
            b.name_norm,
            b.is_parent,
            b.nb_stop_times,
            CASE
              WHEN b.name_norm = p.q_norm THEN 4
              WHEN b.name_norm LIKE p.q_norm || '%' THEN 3
              WHEN b.search_text LIKE '%' || p.q_norm || '%' THEN 2
              WHEN p.q_head <> '' AND b.name_norm LIKE p.q_head || '%' THEN 1
              WHEN p.q_first <> '' AND b.name_norm LIKE p.q_first || '%' THEN 1
              ELSE 0
            END AS tier
          FROM public.stop_search_index b
          CROSS JOIN params p
          WHERE
            p.q_norm <> ''
            AND (
              b.name_norm LIKE p.q_norm || '%'
              OR b.search_text LIKE '%' || p.q_norm || '%'
              OR (p.q_head <> '' AND b.name_norm LIKE p.q_head || '%')
              OR (p.q_first <> '' AND b.name_norm LIKE p.q_first || '%')
            )
        ),
        per_group AS (
          SELECT DISTINCT ON (group_id)
            group_id,
            stop_id,
            stop_name,
            parent_station,
            location_type,
            name_norm,
            is_parent,
            nb_stop_times,
            tier
          FROM ranked
          WHERE tier > 0
          ORDER BY
            group_id,
            tier DESC,
            is_parent DESC,
            nb_stop_times DESC,
            stop_name ASC
        )
        SELECT
          group_id,
          stop_id,
          stop_name,
          parent_station,
          location_type,
          name_norm AS stop_fold
        FROM per_group
        ORDER BY
          tier DESC,
          is_parent DESC,
          nb_stop_times DESC,
          stop_name ASC
        LIMIT $2
      `,
      values: [q, lim],
      query_timeout: STOPS_SEARCH_FALLBACK_QUERY_TIMEOUT_MS,
    });
    if (!res?.rows) {
      throw err;
    }
  }

  return (res.rows || []).map((row) => {
    const stationId = row.group_id || row.stop_id;
    return {
      id: row.stop_id,
      name: row.stop_name,
      stop_id: row.stop_id,
      stationId,
      stationName: row.stop_name,
      group_id: stationId,
      raw_stop_id: row.stop_id,
      stop_name: row.stop_name,
      parent_station: row.parent_station || null,
      location_type: row.location_type || "",
      isParent:
        !row.parent_station ||
        String(row.location_type || "").trim() === "1" ||
        String(row.stop_id || "").startsWith("Parent"),
      isPlatform: !!row.parent_station && String(row.location_type || "").trim() !== "1",
      aliasesMatched: [],
    };
  });
}

function setSearchFallbackHeaders(res, reason) {
  const fallbackReason = String(reason || "error");
  if (typeof res.setHeader === "function") {
    res.setHeader("x-md-search-fallback", "1");
    res.setHeader("x-md-search-fallback-reason", fallbackReason);
    return;
  }
  if (typeof res.set === "function") {
    res.set("x-md-search-fallback", "1");
    res.set("x-md-search-fallback-reason", fallbackReason);
  }
}

async function safeStopsSearchFallback(query, limit, reason = "error") {
  try {
    return await withTimeout(
      fastStopsSearchFallback(query, limit),
      STOPS_SEARCH_DEGRADED_TIMEOUT_MS,
      "stops_search_fallback_timeout"
    );
  } catch (fallbackErr) {
    console.warn("[API] /api/stops/search fallback failed", {
      q: String(query || ""),
      limit,
      reason: String(reason || "error"),
      fallbackReason: String(fallbackErr?.code || fallbackErr?.message || fallbackErr),
    });
    return [];
  }
}

function parseBooleanish(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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
    const debug = parseBooleanish(req.query.debug);
    console.log("[API] /api/stops/search params", { q, limit, debug });

    let searchResult;
    try {
      searchResult = await withTimeout(
        debug
          ? searchStopsWithDebug(createTimedSearchDb(), q, limit)
          : searchStopsPrefix(q, limit),
        STOPS_SEARCH_TOTAL_TIMEOUT_MS,
        "stops_search_timeout"
      );
    } catch (err) {
      const reason = String(err?.code || err?.message || "error");
      console.warn("[API] /api/stops/search degraded fallback", {
        q,
        limit,
        reason,
      });
      const fallbackStops = await safeStopsSearchFallback(q, limit, reason);
      setSearchFallbackHeaders(res, reason);
      return res.json({ stops: fallbackStops });
    }

    let stops = Array.isArray(searchResult) ? searchResult : searchResult?.stops || [];
    if (stops.length === 0 && q.length >= 2) {
      const fallbackStops = await safeStopsSearchFallback(q, limit, "empty_primary");
      if (fallbackStops.length > 0) {
        setSearchFallbackHeaders(res, "empty_primary");
        stops = fallbackStops;
      }
    }

    if (debug && searchResult?.debug) {
      const rankedTop = Array.isArray(searchResult.debug.rankedTop)
        ? searchResult.debug.rankedTop
        : [];
      console.log("[API] /api/stops/search debug top_candidates", {
        query: searchResult.debug.query || q,
        queryNorm: searchResult.debug.queryNorm || null,
        candidateLimit: searchResult.debug.candidateLimit || null,
        rawRows: searchResult.debug.rawRows || 0,
        top: rankedTop.slice(0, 10),
      });
    }

    return res.json({ stops });
  } catch (err) {
    console.error("[API] /api/stops/search failed:", err);
    const q = String(req.query.q || req.query.query || "").trim();
    const limit = Number(req.query.limit || "20");
    const reason = String(err?.code || err?.message || "unexpected_error");
    const fallbackStops = await safeStopsSearchFallback(q, limit, reason);
    setSearchFallbackHeaders(res, reason);
    return res.json({ stops: fallbackStops });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || "").trim();
    const limit = Number(req.query.limit || "20");
    console.log("[API] /api/search params", { q, limit });
    const stops = await searchStopsPrefix(q, limit);
    return res.json({ stops });
  } catch (err) {
    console.error("[API] /api/search failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        error: "search_failed",
        detail: String(err?.message || err),
      });
    }
    return res.status(500).json({ error: "search_failed" });
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

const stationboardRouteHandler = createStationboardRouteHandler({
  getStationboardLike: getStationboard,
  resolveStopLike: resolveStop,
  dbQueryLike: (sql, params = []) => pool.query(sql, params),
  logger: console,
});
app.get("/api/stationboard", stationboardRouteHandler);

app.get("/api/debug/alerts", async (req, res) => {
  try {
    const stopId = String(req.query.stop_id || "").trim();
    const sampleLimit = Math.max(1, Math.min(Number(req.query.sample || "8"), 30));
    const now = new Date();
    const key = resolveServiceAlertsApiKey();

    const alerts = await fetchServiceAlerts({
      apiKey: key,
      timeoutMs: Math.max(500, Number(process.env.SERVICE_ALERTS_FETCH_TIMEOUT_MS || "3000")),
    });
    const entities = Array.isArray(alerts?.entities) ? alerts.entities : [];

    let activeCount = 0;
    let replacementCount = 0;
    let replacementActiveCount = 0;
    let stopMatchedActiveCount = 0;
    let stopMatchedReplacementCount = 0;

    const sample = [];
    for (const alert of entities) {
      const active = alertIsActiveNow(alert, now);
      const replacement = hasReplacementSignal(alert);
      const informed = Array.isArray(alert?.informedEntities) ? alert.informedEntities : [];
      const stopIds = informed.map((e) => normalizeStopId(e?.stop_id)).filter(Boolean);
      const matchedByStop = stopId
        ? informed.some((e) => informedStopMatchesForDebug(e?.stop_id, stopId))
        : false;

      if (active) activeCount += 1;
      if (replacement) replacementCount += 1;
      if (active && replacement) replacementActiveCount += 1;
      if (active && matchedByStop) stopMatchedActiveCount += 1;
      if (active && matchedByStop && replacement) stopMatchedReplacementCount += 1;

      if (
        sample.length < sampleLimit &&
        (matchedByStop || (active && replacement))
      ) {
        sample.push({
          id: alert?.id || "",
          active,
          replacement,
          effect: alert?.effect || "",
          severity: alert?.severity || "",
          header: alert?.headerText || "",
          description: String(alert?.descriptionText || "").slice(0, 240),
          matchedByStop,
          stopIds: stopIds.slice(0, 6),
          routeIds: informed.map((e) => e?.route_id).filter(Boolean).slice(0, 6),
          tripIds: informed.map((e) => e?.trip_id).filter(Boolean).slice(0, 6),
        });
      }
    }

    return res.json({
      ok: true,
      stopId,
      now: now.toISOString(),
      hasServiceAlertsKey: !!key,
      feedVersion: alerts?.feedVersion || "",
      headerTimestamp: alerts?.headerTimestamp ?? null,
      counts: {
        total: entities.length,
        active: activeCount,
        replacement: replacementCount,
        replacementActive: replacementActiveCount,
        stopMatchedActive: stopMatchedActiveCount,
        stopMatchedReplacement: stopMatchedReplacementCount,
      },
      sample,
    });
  } catch (err) {
    console.error("[API] /api/debug/alerts failed:", err);
    return res.status(500).json({
      ok: false,
      error: "alerts_debug_failed",
      detail: String(err?.message || err),
    });
  }
});

app.get("/api/_debug/tripupdates_summary", async (req, res) => {
  if (!isDebugRequest(req)) {
    return res.status(404).json({ error: "not_found" });
  }

  try {
    const sampleLimit = Math.max(1, Math.min(Number(req.query.sample || "5"), 20));
    const wantsForceUpstream = String(req.query.force_upstream || "").trim() === "1";
    const allowForceUpstream = process.env.NODE_ENV === "development";
    const shouldForceUpstream = allowForceUpstream && wantsForceUpstream;

    let feed;
    let cacheInfo = null;
    let source = "db_cache";

    if (shouldForceUpstream) {
      feed = await fetchTripUpdates();
      source = "upstream_forced";
    } else {
      const cached = await readTripUpdatesFeedFromCache();
      cacheInfo = {
        hasPayload: cached?.hasPayload === true,
        fetchedAt: Number.isFinite(cached?.fetchedAtMs)
          ? new Date(cached.fetchedAtMs).toISOString()
          : null,
        lastStatus: Number.isFinite(Number(cached?.lastStatus))
          ? Number(cached.lastStatus)
          : null,
        lastError: cached?.lastError || null,
        decodeError: cached?.decodeError ? String(cached.decodeError.message || cached.decodeError) : null,
      };
      feed = cached?.feed || { entities: [], entity: [] };
    }

    const summary = summarizeTripUpdates(feed, { sampleLimit });
    return res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      source,
      forceUpstream: {
        requested: wantsForceUpstream,
        applied: shouldForceUpstream,
      },
      cache: cacheInfo,
      headerTimestamp: summary.headerTimestamp,
      counts: {
        totalEntities: summary.totalEntities,
        tripDescriptorCanceled: summary.tripDescriptorCanceledCount,
        stopTimeSkipped: summary.stopTimeSkippedCount,
        stopTimeNoData: summary.stopTimeNoDataCount,
      },
      sample: summary.sampleCancellationSignals,
    });
  } catch (err) {
    console.error("[API] /api/_debug/tripupdates_summary failed:", err);
    return res.status(500).json({
      ok: false,
      error: "tripupdates_summary_failed",
      detail: String(err?.message || err),
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MesDeparts RT backend listening on http://0.0.0.0:${PORT}`);
  console.log("[ENV]", {
    ENABLE_RT: process.env.ENABLE_RT === "1",
    hasDATABASE_URL: !!process.env.DATABASE_URL,
    hasToken: !!(process.env.GTFS_RT_TOKEN || process.env.OPENDATA_SWISS_TOKEN),
  });
});
