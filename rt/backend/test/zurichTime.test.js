import test from "node:test";
import assert from "node:assert/strict";

import {
  dateFromZurichServiceDateAndSeconds,
  secondsSinceZurichMidnight,
} from "../src/time/zurichTime.js";

test("secondsSinceZurichMidnight uses Europe/Zurich instead of UTC", () => {
  const nowUtc = new Date("2026-06-15T22:03:00.000Z"); // 00:03 in Zurich (CEST)
  assert.equal(secondsSinceZurichMidnight(nowUtc), 3 * 60);
});

test("dateFromZurichServiceDateAndSeconds maps Zurich service-day times near midnight correctly", () => {
  const dep = dateFromZurichServiceDateAndSeconds(20260616, 3 * 60);
  assert.ok(dep instanceof Date);
  assert.equal(dep.toISOString(), "2026-06-15T22:03:00.000Z");
});

test("dateFromZurichServiceDateAndSeconds supports >24h GTFS values", () => {
  const dep = dateFromZurichServiceDateAndSeconds(20260115, 25 * 3600);
  assert.ok(dep instanceof Date);
  // 2026-01-16 01:00 in Zurich (CET) => 2026-01-16 00:00Z
  assert.equal(dep.toISOString(), "2026-01-16T00:00:00.000Z");
});
