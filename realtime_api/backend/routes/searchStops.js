// backend/routes/searchStops.js
// Deprecated standalone SQL route. Keep behavior aligned with src/search/stopsSearch.js.
import express from "express";
import { pool } from "../db.js";
import { searchStops } from "../src/search/stopsSearch.js";

const router = express.Router();

router.get("/stops/search", async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || "").trim();
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;

    const stops = await searchStops(pool, q, limit);
    return res.json({ stops });
  } catch (err) {
    console.error("[searchStops route] error", err);
    return res.status(500).json({ error: "stop_search_failed" });
  }
});

export default router;
