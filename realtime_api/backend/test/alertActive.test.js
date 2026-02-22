import test from "node:test";
import assert from "node:assert/strict";

import { isAlertActiveNow } from "../src/util/alertActive.js";

test("isAlertActiveNow keeps GTFS active period behavior", () => {
  const alert = {
    activePeriods: [
      {
        start: new Date("2026-02-22T00:00:00.000Z"),
        end: new Date("2026-02-24T00:00:00.000Z"),
      },
    ],
    headerText: "Service advisory",
    descriptionText: "General disruption",
  };

  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T12:00:00.000Z")), true);
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-25T12:00:00.000Z")), false);
});

test("isAlertActiveNow applies recurring night-time text windows when present", () => {
  const alert = {
    activePeriods: [
      {
        start: new Date("2026-02-20T00:00:00.000Z"),
        end: new Date("2026-02-25T00:00:00.000Z"),
      },
    ],
    headerText: "Genève station works",
    descriptionText: "Every night from 01:00 to 05:00 buses replace trains.",
  };

  // Zurich 02:30 (CET) -> active.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T01:30:00.000Z")), true);
  // Zurich 12:00 (CET) -> inactive.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T11:00:00.000Z")), false);
  // Zurich 22:30 (CET) -> active, widened to night start.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T21:30:00.000Z")), true);
  // Zurich 21:00 (CET) -> still inactive.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T20:00:00.000Z")), false);
});

test("isAlertActiveNow does not misread one-off date ranges as recurring daily windows", () => {
  const alert = {
    activePeriods: [
      {
        start: new Date("2026-02-20T00:00:00.000Z"),
        end: new Date("2026-02-23T23:00:00.000Z"),
      },
    ],
    headerText: "Event disruption",
    descriptionText: "Restriction from 20.02.2026, 13:30 until 23.02.2026, 02:00.",
  };

  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T10:00:00.000Z")), true);
});

test("isAlertActiveNow applies plain intraday ranges when GTFS period is broad", () => {
  const alert = {
    activePeriods: [
      {
        start: new Date("2026-02-21T00:00:00.000Z"),
        end: new Date("2026-02-22T23:00:00.000Z"),
      },
    ],
    headerText: "Geneve works",
    descriptionText: "Valid from 21 to 22. 21:00 to 05:00 at station.",
  };

  // Zurich 22:30 -> active.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-21T21:30:00.000Z")), true);
  // Zurich 12:00 -> inactive even though GTFS period is active.
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-21T11:00:00.000Z")), false);
});

test("isAlertActiveNow parses French 'a/à' separators for night windows", () => {
  const alert = {
    activePeriods: [
      {
        start: new Date("2026-02-21T00:00:00.000Z"),
        end: new Date("2026-02-23T00:00:00.000Z"),
      },
    ],
    headerText: "Travaux",
    descriptionText: "Valable la nuit: 01:00 à 05:00.",
  };

  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T02:30:00.000Z")), true);
  assert.equal(isAlertActiveNow(alert, new Date("2026-02-22T11:00:00.000Z")), false);
});
