import test from "node:test";
import assert from "node:assert/strict";

import { createStopSearchRouteHandler } from "../src/api/stopSearchRoute.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[String(key)] = String(value);
      return this;
    },
    set(key, value) {
      this.headers[String(key)] = String(value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeRoute(handler, query = {}) {
  const req = { query };
  const res = makeMockRes();
  await handler(req, res);
  return res;
}

function makeSearchFn(stops = []) {
  return async (_q, _limit) => stops;
}

// ─── 400 validation ──────────────────────────────────────────────────────────

test("returns 400 with structured error for empty query", async () => {
  const handler = createStopSearchRouteHandler({ searchFn: makeSearchFn() });

  const res = await invokeRoute(handler, { q: "" });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "query_too_short");
  assert.equal(typeof res.body?.minLength, "number");
  assert.ok(res.body?.minLength >= 2, "minLength should be >= 2");
  assert.ok(typeof res.body?.message === "string", "message should be a string");
});

test("returns 400 for missing query param", async () => {
  const handler = createStopSearchRouteHandler({ searchFn: makeSearchFn() });

  const res = await invokeRoute(handler, {});

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "query_too_short");
});

test("returns 400 for single-character query", async () => {
  const handler = createStopSearchRouteHandler({ searchFn: makeSearchFn() });

  const res = await invokeRoute(handler, { q: "a" });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "query_too_short");
});

test("returns 400 for whitespace-only query", async () => {
  const handler = createStopSearchRouteHandler({ searchFn: makeSearchFn() });

  const res = await invokeRoute(handler, { q: "   " });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "query_too_short");
});

// ─── Successful search ───────────────────────────────────────────────────────

test("returns 200 with stops array for valid query", async () => {
  const fakeStop = {
    stop_id: "Parent8591888",
    stop_name: "Lausanne, Forêt",
    stationId: "Parent8591888",
    isParent: true,
    isPlatform: false,
  };
  const handler = createStopSearchRouteHandler({
    searchFn: makeSearchFn([fakeStop]),
  });

  const res = await invokeRoute(handler, { q: "foret" });

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body?.stops), "body.stops should be an array");
  assert.equal(res.body.stops.length, 1);
  assert.equal(res.body.stops[0].stop_id, "Parent8591888");
});

test("returns 200 with empty stops when searchFn returns nothing", async () => {
  const handler = createStopSearchRouteHandler({
    searchFn: makeSearchFn([]),
  });

  const res = await invokeRoute(handler, { q: "zz" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body?.stops, []);
});

// ─── Fallback on search error ────────────────────────────────────────────────

test("uses fallbackFn and returns stops when searchFn throws", async () => {
  const fallbackStop = {
    stop_id: "Parent9999",
    stop_name: "Fallback Stop",
    stationId: "Parent9999",
    isParent: true,
    isPlatform: false,
  };

  let fallbackCalled = false;
  const handler = createStopSearchRouteHandler({
    searchFn: async () => {
      throw new Error("db_timeout");
    },
    fallbackFn: async (_q, _limit, _reason) => {
      fallbackCalled = true;
      return [fallbackStop];
    },
  });

  const res = await invokeRoute(handler, { q: "foret" });

  assert.equal(res.statusCode, 200);
  assert.ok(fallbackCalled, "fallbackFn should have been called");
  assert.equal(res.body.stops.length, 1);
  assert.equal(res.body.stops[0].stop_id, "Parent9999");
});

test("returns empty stops when searchFn throws and no fallbackFn provided", async () => {
  const handler = createStopSearchRouteHandler({
    searchFn: async () => {
      throw new Error("db_timeout");
    },
  });

  const res = await invokeRoute(handler, { q: "foret" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body?.stops, []);
});

// ─── Secondary fallback (empty primary result) ───────────────────────────────

test("tries fallbackFn when searchFn returns empty array", async () => {
  const fallbackStop = {
    stop_id: "Parent8587055",
    stop_name: "Lausanne, Bel-Air",
    stationId: "Parent8587055",
    isParent: true,
    isPlatform: false,
  };

  let fallbackReason = null;
  const handler = createStopSearchRouteHandler({
    searchFn: makeSearchFn([]),
    fallbackFn: async (_q, _limit, reason) => {
      fallbackReason = reason;
      return [fallbackStop];
    },
  });

  const res = await invokeRoute(handler, { q: "bel air" });

  assert.equal(res.statusCode, 200);
  assert.equal(fallbackReason, "empty_primary");
  assert.equal(res.body.stops.length, 1);
  assert.equal(res.body.stops[0].stop_id, "Parent8587055");
});

// ─── Fallback headers ────────────────────────────────────────────────────────

test("setFallbackHeadersFn is called when fallback is triggered by error", async () => {
  let headersCalled = false;
  const handler = createStopSearchRouteHandler({
    searchFn: async () => {
      throw new Error("timeout");
    },
    fallbackFn: async () => [],
    setFallbackHeadersFn: (_res, _reason) => {
      headersCalled = true;
    },
  });

  await invokeRoute(handler, { q: "geneve" });
  assert.ok(headersCalled, "setFallbackHeadersFn should have been called");
});

// ─── Timeout wrapper ─────────────────────────────────────────────────────────

test("wrapWithTimeoutFn wraps the search promise", async () => {
  let wrapped = false;
  const handler = createStopSearchRouteHandler({
    searchFn: makeSearchFn([]),
    wrapWithTimeoutFn: async (promise) => {
      wrapped = true;
      return promise;
    },
  });

  await invokeRoute(handler, { q: "bern" });
  assert.ok(wrapped, "wrapWithTimeoutFn should have been called");
});

// ─── Debug mode ──────────────────────────────────────────────────────────────

test("debug mode uses searchDebugFn when provided", async () => {
  let debugCalled = false;
  const handler = createStopSearchRouteHandler({
    searchFn: makeSearchFn([]),
    searchDebugFn: async (_q, _limit) => {
      debugCalled = true;
      return { stops: [], debug: { query: "test", queryNorm: "test", rawRows: 0 } };
    },
  });

  const res = await invokeRoute(handler, { q: "test", debug: "1" });

  assert.ok(debugCalled, "searchDebugFn should have been called in debug mode");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body?.stops, []);
});

test("debug mode falls back to searchFn when searchDebugFn not provided", async () => {
  let searchCalled = false;
  const handler = createStopSearchRouteHandler({
    searchFn: async (_q, _limit) => {
      searchCalled = true;
      return [];
    },
  });

  await invokeRoute(handler, { q: "test", debug: "1" });
  assert.ok(searchCalled, "searchFn should be used when searchDebugFn is not provided");
});

// ─── Acceptance: query parameter aliases ─────────────────────────────────────

test("accepts 'query' param as alias for 'q'", async () => {
  const fakeStop = { stop_id: "Parent1", stop_name: "Test", stationId: "Parent1", isParent: true, isPlatform: false };
  const handler = createStopSearchRouteHandler({ searchFn: makeSearchFn([fakeStop]) });

  const res = await invokeRoute(handler, { query: "test stop" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stops.length, 1);
});
