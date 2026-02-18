import test from "node:test";
import assert from "node:assert/strict";

import { supplementFromOtdStationboard } from "../src/merge/supplementFromOtdStationboard.js";

test("supplementFromOtdStationboard keeps only replacement-like EV entries", () => {
  const now = new Date("2026-02-17T00:00:00.000Z");
  const nowSec = Math.floor(now.getTime() / 1000);

  const data = {
    stationboard: [
      {
        id: "ev-1",
        number: "EV1",
        category: "B",
        to: "Renens",
        operator: "SBB",
        stop: {
          departureTimestamp: nowSec + 300,
          platform: "A",
          prognosis: { departureTimestamp: nowSec + 360, platform: "A" },
        },
      },
      {
        id: "normal-bus",
        number: "17",
        category: "B",
        to: "Centre",
        stop: {
          departureTimestamp: nowSec + 300,
        },
      },
    ],
  };

  const out = supplementFromOtdStationboard({
    data,
    stationStopId: "Parent8501120",
    stationName: "Lausanne",
    now,
    windowMinutes: 30,
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].line, "EV1");
  assert.equal(out[0].source, "synthetic_alert");
  assert.ok(out[0].tags.includes("replacement"));
});

test("supplementFromOtdStationboard ignores alert-like EV rows without a timed departure", () => {
  const now = new Date("2026-02-17T00:00:00.000Z");
  const data = {
    stationboard: [
      {
        id: "ev-banner-only",
        number: "EV",
        category: "B",
        to: "Interruption de ligne, merci de consulter l'affichage",
        operator: "SBB",
        stop: {
          prognosis: {
            status: "CANCELLED",
          },
        },
      },
    ],
  };

  const out = supplementFromOtdStationboard({
    data,
    stationStopId: "Parent8501120",
    stationName: "Lausanne",
    now,
    windowMinutes: 30,
  });

  assert.equal(out.length, 0);
});
