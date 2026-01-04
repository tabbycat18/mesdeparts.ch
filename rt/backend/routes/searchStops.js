// backend/routes/searchStops.js
import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// Step A: typeahead search (fast)
// - returns { stops: rows }
// - supports ?limit=
// - ordering:
//   1) parent_station IS NULL first
//   2) exact match first
//   3) no-comma names first
//   4) nb_stop_times DESC
router.get("/stops/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;

    if (q.length < 2) {
      return res.json({ stops: [] });
    }

    const { rows } = await pool.query(
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
          (parent_station IS NULL) ASC,                  -- prefer a platform/child row
          (lower(stop_name) = lower($1)) DESC,           -- exact full-name match
          (lower(after_comma) = lower($1)) DESC,         -- exact after-comma match
          (position(',' in stop_name) = 0) DESC,         -- no-comma first
          nb_stop_times DESC,
          stop_name ASC
      )
      SELECT
        stop_id,
        stop_name,
        nb_stop_times,
        parent_station
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
      [q, limit]
    );

    return res.json({ stops: rows });
  } catch (err) {
    console.error("[searchStops] error", err);
    res.status(500).json({ error: "stop_search_failed" });
  }
});

export default router;
