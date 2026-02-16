import test from "node:test";
import assert from "node:assert/strict";

import { attachAlerts } from "../src/merge/attachAlerts.js";

test("attachAlerts adds stop banners, per-departure matches, active filtering, and dedup", () => {
  const now = new Date("2026-02-16T20:00:00.000Z");

  const departures = [
    {
      trip_id: "trip-1",
      route_id: "route-1",
      stop_id: "8501120:0:1",
      stop_sequence: 5,
      destination: "A",
    },
    {
      trip_id: "trip-2",
      route_id: "route-2",
      stop_id: "8501120:0:2",
      stop_sequence: 7,
      destination: "B",
    },
  ];

  const alerts = {
    entities: [
      {
        id: "banner-child",
        severity: "warning",
        headerText: "Child stop disruption",
        descriptionText: "child",
        activePeriods: [],
        informedEntities: [{ stop_id: "8501120:0:1" }],
      },
      {
        id: "banner-parent",
        severity: "info",
        headerText: "Parent disruption",
        descriptionText: "parent",
        activePeriods: [],
        informedEntities: [{ stop_id: "Parent8501120" }],
      },
      {
        id: "trip-match",
        severity: "severe",
        headerText: "Trip issue",
        descriptionText: "trip",
        activePeriods: [],
        informedEntities: [{ trip_id: "trip-2" }],
      },
      {
        id: "route-match",
        severity: "warning",
        headerText: "Route issue",
        descriptionText: "route",
        activePeriods: [],
        informedEntities: [{ route_id: "route-1" }],
      },
      {
        id: "seq-match",
        severity: "info",
        headerText: "Seq issue",
        descriptionText: "seq",
        activePeriods: [],
        informedEntities: [{ stop_sequence: 7 }],
      },
      {
        id: "inactive",
        severity: "warning",
        headerText: "Old",
        descriptionText: "old",
        activePeriods: [
          {
            start: new Date("2026-02-16T10:00:00.000Z"),
            end: new Date("2026-02-16T11:00:00.000Z"),
          },
        ],
        informedEntities: [{ trip_id: "trip-1" }],
      },
      {
        id: "dep-dedup",
        severity: "warning",
        headerText: "Duplicate dep match",
        descriptionText: "dedup",
        activePeriods: [],
        informedEntities: [{ trip_id: "trip-1" }, { route_id: "route-1" }],
      },
      {
        id: "banner-dedup",
        severity: "warning",
        headerText: "Duplicate banner match",
        descriptionText: "dedup-banner",
        activePeriods: [],
        informedEntities: [{ stop_id: "8501120:0:1" }, { stop_id: "8501120:0:2" }],
      },
    ],
  };

  const result = attachAlerts({
    stopId: "Parent8501120",
    routeIds: departures.map((dep) => dep.route_id),
    tripIds: departures.map((dep) => dep.trip_id),
    departures,
    alerts,
    now,
  });

  const bannerIds = new Set(result.banners.map((banner) => banner.header));
  assert.equal(result.banners.length, 3);
  assert.ok(bannerIds.has("Child stop disruption"));
  assert.ok(bannerIds.has("Parent disruption"));
  assert.ok(bannerIds.has("Duplicate banner match"));

  const dep1 = result.departures.find((dep) => dep.trip_id === "trip-1");
  const dep2 = result.departures.find((dep) => dep.trip_id === "trip-2");
  assert.ok(dep1);
  assert.ok(dep2);

  const dep1Ids = dep1.alerts.map((item) => item.id).sort();
  const dep2Ids = dep2.alerts.map((item) => item.id).sort();

  assert.deepEqual(dep1Ids, [
    "banner-child",
    "banner-dedup",
    "banner-parent",
    "dep-dedup",
    "route-match",
  ]);
  assert.deepEqual(dep2Ids, [
    "banner-dedup",
    "banner-parent",
    "seq-match",
    "trip-match",
  ]);

  // Dedup: same alert id should appear only once per departure.
  assert.equal(dep1Ids.filter((id) => id === "dep-dedup").length, 1);
  // Inactive alert must not match.
  assert.equal(dep1Ids.includes("inactive"), false);
});

