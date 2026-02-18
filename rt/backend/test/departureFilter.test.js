import test from "node:test";
import assert from "node:assert/strict";

import { filterRenderableDepartures } from "../src/util/departureFilter.js";

test("departure filter removes EV disruption-text pseudo rows", () => {
  const rows = [
    {
      line: "EV",
      destination:
        "Limited train service on the Geneve - Lausanne line between Renens VD and Lausanne.",
      scheduledDeparture: "2026-02-18T10:10:00.000Z",
      realtimeDeparture: "2026-02-18T10:10:00.000Z",
    },
  ];

  const { kept, dropped } = filterRenderableDepartures(rows);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test("departure filter keeps EV replacement service rows with valid identity", () => {
  const rows = [
    {
      trip_id: "ev-trip-1",
      line: "EV1",
      number: "EV1",
      destination: "Renens VD",
      scheduledDeparture: "2026-02-18T10:15:00.000Z",
      realtimeDeparture: "2026-02-18T10:17:00.000Z",
    },
  ];

  const { kept, dropped } = filterRenderableDepartures(rows);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

