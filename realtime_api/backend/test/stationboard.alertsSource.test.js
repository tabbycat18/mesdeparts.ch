import test from "node:test";
import assert from "node:assert/strict";

async function loadAlertsFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../src/api/stationboard.js");
  return mod.createRequestScopedAlertsLoaderLike;
}

test("request-scoped alerts loader uses parsed source when parsed alerts are present", async () => {
  const createRequestScopedAlertsLoaderLike = await loadAlertsFactory();
  let blobCalls = 0;

  const loader = createRequestScopedAlertsLoaderLike({
    loadParsedLike: async () => ({
      alerts: {
        entities: [{ id: "alert-1", informedEntities: [] }],
      },
      meta: {
        applied: true,
        reason: "applied",
      },
    }),
    loadBlobLike: async () => {
      blobCalls += 1;
      throw new Error("blob_must_not_be_called");
    },
  });

  const out = await loader({ enabled: true });
  assert.equal(blobCalls, 0);
  assert.equal(out.meta.alertsSource, "parsed");
  assert.equal(out.meta.applied, true);
});

test("request-scoped alerts loader keeps blob fallback disabled by default when parsed is missing", async () => {
  const createRequestScopedAlertsLoaderLike = await loadAlertsFactory();
  let blobCalls = 0;

  const loader = createRequestScopedAlertsLoaderLike({
    loadParsedLike: async () => ({
      alerts: { entities: [] },
      meta: {
        applied: false,
        reason: "missing_cache",
      },
    }),
    loadBlobLike: async () => {
      blobCalls += 1;
      return {
        alerts: { entities: [] },
        meta: {
          applied: false,
          reason: "stale_cache",
        },
      };
    },
  });

  const out = await loader({ enabled: true });
  assert.equal(blobCalls, 0);
  assert.equal(out.meta.alertsSource, "parsed");
  assert.equal(out.meta.reason, "missing_cache");
});

test("request-scoped alerts loader uses blob source only in explicit debug blob mode", async () => {
  const createRequestScopedAlertsLoaderLike = await loadAlertsFactory();
  let blobCalls = 0;

  const loader = createRequestScopedAlertsLoaderLike({
    allowBlobFallback: true,
    forceBlobMode: true,
    loadParsedLike: async () => ({
      alerts: { entities: [] },
      meta: {
        applied: false,
        reason: "missing_cache",
      },
    }),
    loadBlobLike: async () => {
      blobCalls += 1;
      return {
        alerts: { entities: [{ id: "blob-alert" }] },
        meta: { applied: true, reason: "applied" },
      };
    },
  });

  const out = await loader({ enabled: true });
  assert.equal(blobCalls, 1);
  assert.equal(out.meta.alertsSource, "blob_fallback");
  assert.equal(out.meta.reason, "applied");
});
