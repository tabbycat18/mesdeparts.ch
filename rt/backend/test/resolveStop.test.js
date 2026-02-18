import test from "node:test";
import assert from "node:assert/strict";

import { resolveStop } from "../src/resolve/resolveStop.js";

function makeDb() {
  const stopsById = new Map(
    [
      {
        stop_id: "Parent8501120",
        stop_name: "Lausanne",
        location_type: "1",
        parent_station: "",
        platform_code: "",
      },
      {
        stop_id: "8501120:0:1",
        stop_name: "Lausanne",
        location_type: "0",
        parent_station: "Parent8501120",
        platform_code: "1",
      },
      {
        stop_id: "8501120:0:2",
        stop_name: "Lausanne",
        location_type: "0",
        parent_station: "Parent8501120",
        platform_code: "2",
      },
      {
        stop_id: "Parent8592082",
        stop_name: "Lausanne, Motte",
        location_type: "1",
        parent_station: "",
        platform_code: "",
      },
      {
        stop_id: "8592082:0:1",
        stop_name: "Lausanne, Motte",
        location_type: "0",
        parent_station: "Parent8592082",
        platform_code: "1",
      },
    ].map((row) => [row.stop_id, row])
  );

  const childrenByParent = new Map();
  for (const row of stopsById.values()) {
    const parent = String(row.parent_station || "").trim();
    if (!parent) continue;
    const list = childrenByParent.get(parent) || [];
    list.push(row);
    childrenByParent.set(parent, list);
  }

  const aliases = new Map([
    ["8592082", "Parent8592082"],
    ["Lausanne, Motte", "Parent8592082"],
    ["lausanne motte", "Parent8592082"],
  ]);

  return {
    async query(sql, params = []) {
      const text = String(sql || "").replace(/\s+/g, " ").toLowerCase();

      if (text.includes("from public.app_stop_aliases")) {
        if (text.includes("where a.alias = any")) {
          const keys = Array.isArray(params[0]) ? params[0] : [];
          for (const key of keys) {
            const match = aliases.get(String(key || ""));
            if (match) return { rows: [{ stop_id: match }] };
          }
          return { rows: [] };
        }
        if (text.includes("where lower(a.alias) = any")) {
          const wanted = new Set((Array.isArray(params[0]) ? params[0] : []).map((v) => String(v || "").toLowerCase()));
          for (const [alias, stopId] of aliases.entries()) {
            if (wanted.has(String(alias).toLowerCase())) {
              return { rows: [{ stop_id: stopId }] };
            }
          }
          return { rows: [] };
        }
      }

      if (text.includes("from public.gtfs_stops s") && text.includes("where s.stop_id = $1")) {
        const id = String(params[0] || "");
        const row = stopsById.get(id);
        return { rows: row ? [{ ...row }] : [] };
      }

      if (
        text.includes("from public.gtfs_stops s") &&
        (text.includes("where (to_jsonb(s) ->> 'parent_station') = $1") ||
          text.includes("where s.parent_station = $1"))
      ) {
        const parent = String(params[0] || "");
        const rows = childrenByParent.get(parent) || [];
        if (text.includes("select 1 as ok")) {
          return { rows: rows.length > 0 ? [{ ok: 1 }] : [] };
        }
        if (text.includes("limit 1")) {
          return { rows: rows.length > 0 ? [{ ...rows[0] }] : [] };
        }
        return { rows: rows.map((row) => ({ ...row })) };
      }

      throw new Error(`Unhandled SQL in test mock: ${text}`);
    },
  };
}

test("resolveStop: parent stop_id returns parent canonical and all children", async () => {
  const db = makeDb();
  const out = await resolveStop({ stop_id: "Parent8501120" }, { db });

  assert.equal(out.source, "direct");
  assert.equal(out.canonical.id, "Parent8501120");
  assert.equal(out.canonical.kind, "parent");
  assert.equal(out.displayName, "Lausanne");
  assert.deepEqual(out.children.map((c) => c.id), ["8501120:0:1", "8501120:0:2"]);
});

test("resolveStop: platform stop_id promotes to parent", async () => {
  const db = makeDb();
  const out = await resolveStop({ stop_id: "8501120:0:1" }, { db });

  assert.equal(out.source, "direct");
  assert.equal(out.canonical.id, "Parent8501120");
  assert.equal(out.canonical.kind, "parent");
  assert.deepEqual(out.children.map((c) => c.id), ["8501120:0:1", "8501120:0:2"]);
});

test("resolveStop: legacy stationId numeric works", async () => {
  const db = makeDb();
  const out = await resolveStop({ stationId: "8501120" }, { db });

  assert.equal(out.source, "direct");
  assert.equal(out.canonical.id, "Parent8501120");
  assert.equal(out.canonical.kind, "parent");
});

test("resolveStop: alias lookup works", async () => {
  const db = makeDb();
  const out = await resolveStop({ stationName: "Lausanne, Motte" }, { db });

  assert.equal(out.source, "alias");
  assert.equal(out.canonical.id, "Parent8592082");
  assert.equal(out.displayName, "Lausanne, Motte");
  assert.deepEqual(out.children.map((c) => c.id), ["8592082:0:1"]);
});

test("resolveStop: unknown stop throws unknown_stop with tried keys", async () => {
  const db = makeDb();

  await assert.rejects(
    () => resolveStop({ stop_id: "definitely-unknown-stop" }, { db }),
    (err) => {
      assert.equal(err?.code, "unknown_stop");
      assert.ok(Array.isArray(err?.tried));
      assert.ok(err.tried.includes("definitely-unknown-stop"));
      return true;
    }
  );
});
