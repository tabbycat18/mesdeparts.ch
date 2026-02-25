import test from "node:test";
import assert from "node:assert/strict";

async function createScopedLoaderFactory() {
  process.env.DATABASE_URL ||= "postgres://localhost:5432/mesdeparts_test";
  const mod = await import("../src/api/stationboard.js");
  return mod.createRequestScopedTripUpdatesLoaderLike;
}

test("stationboard scoped RT loader uses parsed source and avoids blob fallback when parsed data is available", async () => {
  const createRequestScopedTripUpdatesLoaderLike = await createScopedLoaderFactory();
  let blobCalled = false;

  const loader = createRequestScopedTripUpdatesLoaderLike({
    loadParsedLike: async () => ({
      tripUpdates: {
        byKey: {
          "trip-1|8503000:0:1|3|20260225": {
            tripId: "trip-1",
            stopId: "8503000:0:1",
            stopSequence: 3,
            delaySec: 120,
            delayMin: 2,
            updatedDepartureEpoch: Math.floor((Date.now() + 60_000) / 1000),
            tripStartDate: "20260225",
          },
        },
      },
      meta: {
        applied: true,
        reason: "applied",
      },
    }),
    loadBlobLike: async () => {
      blobCalled = true;
      throw new Error("blob_fallback_should_not_be_called");
    },
  });

  const out = await loader({
    enabled: true,
    scopeTripIds: ["trip-1"],
    scopeStopIds: ["8503000:0:1"],
  });

  assert.equal(blobCalled, false);
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(out.meta.applied, true);
});

test("stationboard scoped RT loader keeps blob fallback disabled by default when parsed is missing", async () => {
  const createRequestScopedTripUpdatesLoaderLike = await createScopedLoaderFactory();
  let blobCalled = false;

  const loader = createRequestScopedTripUpdatesLoaderLike({
    loadParsedLike: async () => ({
      tripUpdates: { byKey: {} },
      meta: {
        applied: false,
        reason: "missing_cache",
      },
    }),
    loadBlobLike: async () => {
      blobCalled = true;
      return {
        tripUpdates: { entities: [] },
        meta: {
          applied: false,
          reason: "stale_cache",
        },
      };
    },
  });

  const out = await loader({
    enabled: true,
    scopeTripIds: ["trip-2"],
  });

  assert.equal(blobCalled, false);
  assert.equal(out.meta.rtSource, "parsed");
  assert.equal(out.meta.reason, "missing_cache");
});

test("stationboard scoped RT loader uses blob source only in explicit debug blob mode", async () => {
  const createRequestScopedTripUpdatesLoaderLike = await createScopedLoaderFactory();
  let blobCalled = false;

  const loader = createRequestScopedTripUpdatesLoaderLike({
    forceBlobMode: true,
    allowBlobFallback: true,
    loadParsedLike: async () => ({
      tripUpdates: { byKey: {} },
      meta: {
        applied: false,
        reason: "missing_cache",
      },
    }),
    loadBlobLike: async () => {
      blobCalled = true;
      return {
        tripUpdates: { entities: [] },
        meta: {
          applied: false,
          reason: "stale_cache",
        },
      };
    },
  });

  const out = await loader({
    enabled: true,
    scopeTripIds: ["trip-blob-1"],
  });

  assert.equal(blobCalled, true);
  assert.equal(out.meta.rtSource, "blob");
  assert.equal(out.meta.reason, "stale_cache");
});
