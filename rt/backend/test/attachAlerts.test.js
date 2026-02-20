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
        id: "banner-sloid",
        severity: "warning",
        headerText: "SLOID disruption",
        descriptionText: "sloid",
        activePeriods: [],
        informedEntities: [{ stop_id: "ch:1:sloid:1120" }],
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
      {
        id: "ev-replacement",
        severity: "warning",
        headerText: "EV 1",
        descriptionText: "Ersatzverkehr",
        activePeriods: [],
        informedEntities: [{ route_id: "route-1" }],
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
  assert.equal(result.banners.length, 4);
  assert.ok(bannerIds.has("Child stop disruption"));
  assert.ok(bannerIds.has("Parent disruption"));
  assert.ok(bannerIds.has("Duplicate banner match"));
  assert.ok(bannerIds.has("SLOID disruption"));

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
    "banner-sloid",
    "dep-dedup",
    "ev-replacement",
    "route-match",
  ]);
  assert.deepEqual(dep2Ids, [
    "banner-dedup",
    "banner-parent",
    "banner-sloid",
    "seq-match",
    "trip-match",
  ]);

  // Dedup: same alert id should appear only once per departure.
  assert.equal(dep1Ids.filter((id) => id === "dep-dedup").length, 1);
  // Inactive alert must not match.
  assert.equal(dep1Ids.includes("inactive"), false);
  assert.ok(dep1.tags.includes("replacement"));
});

test("attachAlerts keeps synthetic rows pinned to origin alert only", () => {
  const now = new Date("2026-02-16T20:00:00.000Z");
  const departures = [
    {
      trip_id: "synthetic_alert:origin-alert:1771287962",
      route_id: "",
      stop_id: "Parent8501120",
      source: "synthetic_alert",
      tags: ["replacement"],
      destination: "Origin alert row",
    },
    {
      trip_id: "otd-ev-fallback-row",
      route_id: "",
      stop_id: "Parent8501120",
      source: "synthetic_alert",
      tags: ["replacement"],
      destination: "No explicit origin id",
    },
  ];
  const alerts = {
    entities: [
      {
        id: "origin-alert",
        severity: "warning",
        headerText: "Origin alert",
        descriptionText: "replacement",
        activePeriods: [],
        informedEntities: [{ stop_id: "Parent8501120" }],
      },
      {
        id: "other-alert",
        severity: "warning",
        headerText: "Other alert",
        descriptionText: "replacement",
        activePeriods: [],
        informedEntities: [{ stop_id: "Parent8501120" }],
      },
    ],
  };

  const out = attachAlerts({
    stopId: "Parent8501120",
    departures,
    alerts,
    now,
  });

  const pinned = out.departures.find((d) => d.trip_id === "synthetic_alert:origin-alert:1771287962");
  const noOrigin = out.departures.find((d) => d.trip_id === "otd-ev-fallback-row");
  assert.ok(pinned);
  assert.ok(noOrigin);
  assert.deepEqual(pinned.alerts.map((a) => a.id), ["origin-alert"]);
  assert.equal(noOrigin.alerts.length, 0);
});

test("attachAlerts falls back to route/trip banners when no stop-scoped banners exist", () => {
  const now = new Date("2026-02-20T21:00:00.000Z");
  const departures = [
    {
      trip_id: "trip-s5",
      route_id: "route-s5",
      stop_id: "8507000:0:13AB",
      stop_sequence: 6,
      destination: "Kerzers",
      tags: [],
      source: "scheduled",
    },
    {
      trip_id: "trip-s1",
      route_id: "route-s1",
      stop_id: "8507000:0:13D-F",
      stop_sequence: 7,
      destination: "Thun",
      tags: [],
      source: "scheduled",
    },
  ];

  const alerts = {
    entities: [
      {
        id: "route-disruption",
        severity: "warning",
        headerText: "Limited train service between Kerzers and Payerne",
        descriptionText: "Construction work, replacement transport.",
        activePeriods: [],
        informedEntities: [{ route_id: "route-s5" }],
      },
      {
        id: "trip-disruption",
        severity: "warning",
        headerText: "Limited train service between Thörishaus and Flamatt",
        descriptionText: "Construction work, timetable changes.",
        activePeriods: [],
        informedEntities: [{ trip_id: "trip-s1" }],
      },
    ],
  };

  const out = attachAlerts({
    stopId: "Parent8507000",
    routeIds: departures.map((dep) => dep.route_id),
    tripIds: departures.map((dep) => dep.trip_id),
    departures,
    alerts,
    now,
  });

  const bannerHeaders = out.banners.map((banner) => banner.header).sort();
  assert.deepEqual(bannerHeaders, [
    "Limited train service between Kerzers and Payerne",
    "Limited train service between Thörishaus and Flamatt",
  ]);

  const depS5 = out.departures.find((dep) => dep.trip_id === "trip-s5");
  const depS1 = out.departures.find((dep) => dep.trip_id === "trip-s1");
  assert.ok(depS5);
  assert.ok(depS1);
  assert.deepEqual(depS5.alerts.map((alert) => alert.id), ["route-disruption"]);
  assert.deepEqual(depS1.alerts.map((alert) => alert.id), ["trip-disruption"]);
});

test("attachAlerts does not apply skipped_stop tag from stop-only alert to all departures", () => {
  const now = new Date("2026-02-19T12:00:00.000Z");
  const departures = [
    {
      trip_id: "trip-route-1",
      route_id: "route-1",
      stop_id: "8503000:0:1",
      stop_sequence: 4,
      destination: "A",
      tags: [],
      source: "scheduled",
    },
    {
      trip_id: "trip-route-2",
      route_id: "route-2",
      stop_id: "8503000:0:2",
      stop_sequence: 8,
      destination: "B",
      tags: [],
      source: "scheduled",
    },
  ];

  const alerts = {
    entities: [
      {
        id: "stop-only-skipped",
        severity: "warning",
        headerText: "Network disruption",
        descriptionText: "Die Linie EC h\u00e4lt nicht in Z\u00fcrich Flughafen.",
        activePeriods: [],
        informedEntities: [{ stop_id: "Parent8503000" }],
      },
      {
        id: "route-scoped-skipped",
        severity: "warning",
        headerText: "Route specific disruption",
        descriptionText: "The train does not stop at this station.",
        activePeriods: [],
        informedEntities: [{ route_id: "route-1" }],
      },
    ],
  };

  const out = attachAlerts({
    stopId: "Parent8503000",
    routeIds: departures.map((dep) => dep.route_id),
    tripIds: departures.map((dep) => dep.trip_id),
    departures,
    alerts,
    now,
  });

  const dep1 = out.departures.find((dep) => dep.trip_id === "trip-route-1");
  const dep2 = out.departures.find((dep) => dep.trip_id === "trip-route-2");
  assert.ok(dep1);
  assert.ok(dep2);

  assert.ok(dep1.tags.includes("skipped_stop"));
  assert.equal(dep2.tags.includes("skipped_stop"), false);
});
