import test from "node:test";
import assert from "node:assert/strict";

import { resolveStop } from "../src/resolve/resolveStop.js";

function makeMockDb({ stops = [], aliases = [] } = {}) {
  const stopRows = stops.map((row) => ({
    stop_id: String(row.stop_id || "").trim(),
    stop_name: String(row.stop_name || "").trim(),
    parent_station: String(row.parent_station || "").trim(),
    platform_code: String(row.platform_code || "").trim(),
    location_type: String(row.location_type || "").trim(),
  }));
  const aliasRows = aliases.map((row) => ({
    alias: String(row.alias || "").trim(),
    stop_id: String(row.stop_id || "").trim(),
  }));

  return {
    async query(sql, params = []) {
      const normalizedSql = String(sql || "").replace(/\s+/g, " ").trim();
      const id = String(params[0] || "").trim();

      if (
        normalizedSql.includes("FROM public.gtfs_stops s") &&
        normalizedSql.includes("WHERE s.stop_id = $1")
      ) {
        const row = stopRows.find((item) => item.stop_id === id) || null;
        return {
          rows: row
            ? [
                {
                  stop_id: row.stop_id,
                  stop_name: row.stop_name,
                  location_type: row.location_type,
                  parent_station: row.parent_station,
                  platform_code: row.platform_code,
                },
              ]
            : [],
        };
      }

      if (
        normalizedSql.includes("FROM public.gtfs_stops s") &&
        normalizedSql.includes("WHERE s.parent_station = $1")
      ) {
        const rows = stopRows
          .filter((row) => row.parent_station === id)
          .map((row) => ({
            stop_id: row.stop_id,
            stop_name: row.stop_name,
            location_type: row.location_type,
            parent_station: row.parent_station,
            platform_code: row.platform_code,
          }));
        return {
          rows,
        };
      }

      if (
        normalizedSql.includes("JOIN public.gtfs_stops p ON p.stop_id = c.parent_station")
      ) {
        const child = stopRows.find((row) => row.stop_id === id || row.stop_id.startsWith(`${id}:`));
        if (!child?.parent_station) return { rows: [] };
        const parent = stopRows.find((row) => row.stop_id === child.parent_station);
        if (!parent) return { rows: [] };
        return {
          rows: [
            {
              stop_id: parent.stop_id,
              stop_name: parent.stop_name,
              location_type: parent.location_type,
              parent_station: parent.parent_station,
              platform_code: parent.platform_code,
            },
          ],
        };
      }

      if (normalizedSql.includes("FROM public.app_stop_aliases a")) {
        const keyValues = Array.isArray(params[0]) ? params[0].map((value) => String(value)) : [];
        const found = aliasRows.find((row) => keyValues.includes(row.alias));
        return {
          rows: found ? [{ stop_id: found.stop_id }] : [],
        };
      }

      throw new Error(`Unhandled SQL in mock db: ${normalizedSql}`);
    },
  };
}

test("resolveStop returns 404 stop_not_found when Parent id is missing", async () => {
  const db = makeMockDb({ stops: [] });
  await assert.rejects(
    resolveStop({ stop_id: "Parent9999999" }, { db }),
    (err) => {
      assert.equal(err?.code, "stop_not_found");
      assert.equal(Number(err?.status), 404);
      assert.equal(err?.details?.reason, "parent_stop_id_not_found_in_static_db");
      return true;
    }
  );
});

test("resolveStop falls back child-like id to parent station when available", async () => {
  const db = makeMockDb({
    stops: [
      {
        stop_id: "Parent8501120",
        stop_name: "Lausanne",
        parent_station: "",
        location_type: "1",
      },
      {
        stop_id: "8501120:0:1",
        stop_name: "Lausanne, voie 1",
        parent_station: "Parent8501120",
        location_type: "0",
      },
    ],
  });

  const resolved = await resolveStop({ stop_id: "8501120:0" }, { db });
  assert.equal(resolved?.canonical?.id, "Parent8501120");
  assert.equal(resolved?.canonical?.kind, "parent");
  assert.ok(Array.isArray(resolved?.children));
  assert.ok(resolved.children.some((child) => child.id === "8501120:0:1"));
});
