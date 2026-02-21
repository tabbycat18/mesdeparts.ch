import test from "node:test";
import assert from "node:assert/strict";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

async function loadAlertsFromCacheFn() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../src/rt/loadAlertsFromCache.js");
  return mod.loadAlertsFromCache;
}

function encodeServiceAlertsFeed(entities = []) {
  const nowSec = Math.floor(Date.now() / 1000);
  return Buffer.from(
    GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: nowSec,
      },
      entity: entities,
    }).finish()
  );
}

test("loadAlertsFromCache returns disabled reason when alerts are disabled", async () => {
  const loadAlertsFromCache = await loadAlertsFromCacheFn();
  const out = await loadAlertsFromCache({
    enabled: false,
    readCacheLike: async () => {
      throw new Error("must_not_read");
    },
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "disabled");
  assert.equal(out.meta.feedKey, "la_servicealerts");
  assert.equal(Array.isArray(out.alerts.entities), true);
  assert.equal(out.alerts.entities.length, 0);
});

test("loadAlertsFromCache returns missing_cache when cache has no payload", async () => {
  const loadAlertsFromCache = await loadAlertsFromCacheFn();
  const out = await loadAlertsFromCache({
    enabled: true,
    readCacheLike: async () => ({
      payloadBytes: Buffer.alloc(0),
      fetched_at: new Date(),
      last_status: 200,
      last_error: null,
    }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "missing_cache");
  assert.equal(out.meta.cacheStatus, "MISS");
});

test("loadAlertsFromCache returns stale_cache when payload is older than threshold", async () => {
  const loadAlertsFromCache = await loadAlertsFromCacheFn();
  const out = await loadAlertsFromCache({
    enabled: true,
    nowMs: Date.now(),
    freshnessThresholdMs: 45_000,
    readCacheLike: async () => ({
      payloadBytes: encodeServiceAlertsFeed([]),
      fetched_at: new Date(Date.now() - 60_000),
      last_status: 200,
      last_error: null,
    }),
  });

  assert.equal(out.meta.applied, false);
  assert.equal(out.meta.reason, "stale_cache");
  assert.equal(out.meta.cacheStatus, "STALE");
});

test("loadAlertsFromCache decodes fresh cached protobuf and returns normalized alerts", async () => {
  const loadAlertsFromCache = await loadAlertsFromCacheFn();
  const nowSec = Math.floor(Date.now() / 1000);
  const payloadBytes = encodeServiceAlertsFeed([
    {
      id: "alert-1",
      alert: {
        informedEntity: [
          {
            stopId: "8501120:0:3",
          },
        ],
        activePeriod: [
          {
            start: nowSec - 60,
            end: nowSec + 3600,
          },
        ],
        cause: 6,
        effect: 3,
        severityLevel: 3,
        headerText: {
          translation: [
            {
              language: "de",
              text: "Störung",
            },
          ],
        },
        descriptionText: {
          translation: [
            {
              language: "de",
              text: "Beschreibung",
            },
          ],
        },
      },
    },
  ]);

  const out = await loadAlertsFromCache({
    enabled: true,
    nowMs: Date.now(),
    readCacheLike: async () => ({
      payloadBytes,
      fetched_at: new Date(),
      last_status: 200,
      last_error: null,
    }),
  });

  assert.equal(out.meta.reason, "applied");
  assert.equal(out.meta.applied, true);
  assert.equal(out.meta.available, true);
  assert.equal(Array.isArray(out.alerts.entities), true);
  assert.equal(out.alerts.entities.length, 1);
  assert.equal(out.alerts.entities[0].id, "alert-1");
  assert.equal(out.alerts.entities[0].stop_id, undefined);
  assert.equal(Array.isArray(out.alerts.entities[0].informedEntities), true);
});
