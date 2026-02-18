import test from "node:test";
import assert from "node:assert/strict";

import { buildDepartureAudit } from "../src/debug/departureAudit.js";

const ALLOWED_SOURCE_TAGS = new Set(["static", "tripupdate", "alert", "synthesis"]);

test("debug departureAudit: scheduled row maps to static source and scheduled existence", () => {
  const audit = buildDepartureAudit([
    {
      key: "trip-1|stop-1|2026-02-18T12:00:00.000Z",
      trip_id: "trip-1",
      line: "IC5",
      destination: "Lausanne",
      source: "scheduled",
      cancelled: false,
      alerts: [],
    },
  ]);

  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].sourceTags, ["static"]);
  assert.equal(audit[0].cancelledBecause, null);
  assert.equal(audit[0].existsBecause, "scheduled");
  assert.deepEqual(audit[0].alertIds, []);
});

test("debug departureAudit: skipped-stop cancellation maps to stop_skipped", () => {
  const audit = buildDepartureAudit([
    {
      key: "trip-2|stop-2|2026-02-18T12:05:00.000Z",
      trip_id: "trip-2",
      line: "RE33",
      destination: "Geneve",
      source: "tripupdate",
      cancelled: true,
      cancelReasonCode: "SKIPPED_STOP",
      alerts: [{ id: "alert-skip" }],
    },
  ]);

  assert.equal(audit.length, 1);
  assert.ok(audit[0].sourceTags.includes("tripupdate"));
  assert.equal(audit[0].cancelledBecause, "stop_skipped");
  assert.equal(audit[0].existsBecause, "realtime_tripupdate_merge");
  assert.deepEqual(audit[0].alertIds, ["alert-skip"]);
});

test("debug departureAudit: synthetic replacement row includes alert + synthesis tags", () => {
  const audit = buildDepartureAudit([
    {
      key: "trip-3|stop-3|2026-02-18T12:10:00.000Z",
      trip_id: "synthetic_alert:a1:1771287962",
      line: "EV1",
      destination: "Renens VD",
      source: "synthetic_alert",
      flags: ["REPLACEMENT_SERVICE"],
      cancelled: false,
      alerts: [{ id: "a1" }, { id: "a2" }],
    },
  ]);

  assert.equal(audit.length, 1);
  assert.deepEqual(new Set(audit[0].sourceTags), new Set(["alert", "synthesis"]));
  assert.equal(audit[0].existsBecause, "injected_replacement");
  assert.equal(audit[0].cancelledBecause, null);
  assert.deepEqual(audit[0].alertIds, ["a1", "a2"]);
});

test("debug departureAudit: supplement rows fold source tag into alert", () => {
  const audit = buildDepartureAudit([
    {
      key: "trip-4|stop-4|2026-02-18T12:20:00.000Z",
      trip_id: "otd-ev:EV:1771289200",
      line: "EV",
      destination: "Renens VD",
      source: "supplement",
      cancelled: false,
      alerts: [],
    },
  ]);

  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].sourceTags, ["alert"]);
  assert.equal(audit[0].existsBecause, "supplement_replacement");
});

test("debug departureAudit sourceTags are constrained to allowed enum values", () => {
  const audit = buildDepartureAudit([
    { trip_id: "a", source: "scheduled" },
    { trip_id: "b", source: "tripupdate" },
    { trip_id: "c", source: "rt_added" },
    { trip_id: "d", source: "synthetic_alert" },
    { trip_id: "e", source: "supplement" },
    { trip_id: "f", source: "something_unexpected" },
  ]);

  for (const row of audit) {
    for (const tag of row.sourceTags) {
      assert.equal(ALLOWED_SOURCE_TAGS.has(tag), true, `unexpected source tag: ${tag}`);
    }
  }
});
