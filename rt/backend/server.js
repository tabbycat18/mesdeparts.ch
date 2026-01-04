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
const { buildStationboard } = await import("./logic/buildStationboard.js");

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

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

  const result = await pool.query(
    `
    SELECT stop_id, stop_name, nb_stop_times
    FROM public.search_stops
    WHERE lower(stop_name) LIKE lower($1) || '%'
    ORDER BY nb_stop_times DESC NULLS LAST, stop_name
    LIMIT $2;
    `,
    [q, lim]
  );

  return (result.rows || []).map((r) => ({
    stop_id: r.stop_id,
    stop_name: r.stop_name,
    nb_stop_times: r.nb_stop_times ?? 0,
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
    return res.status(500).json({ error: "stops_search_failed" });
  }
});

app.get("/api/stationboard", async (req, res) => {
  try {
    const locationId = String(req.query.location_id || "");
    const limit = Number(req.query.limit || "300");
    console.log("[API] /api/stationboard params", { locationId, limit });
    if (!locationId) return res.status(400).json({ error: "missing_location_id" });

    const result = await buildStationboard(locationId, { limit, windowMinutes: 180 });
    return res.json(result);
  } catch (err) {
    console.error("[API] /api/stationboard failed:", err);
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