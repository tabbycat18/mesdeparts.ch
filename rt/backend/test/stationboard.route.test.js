import test from "node:test";
import assert from "node:assert/strict";

import { createStationboardRouteHandler } from "../src/api/stationboardRoute.js";

function makeUnknownStopError() {
  const err = new Error("unknown_stop");
  err.code = "unknown_stop";
  err.status = 400;
  return err;
}

function makeStopNotFoundError(details = {}) {
  const err = new Error("stop_not_found");
  err.code = "stop_not_found";
  err.status = 404;
  err.tried = Array.isArray(details?.tried) ? details.tried : [];
  err.details = details?.meta || { reason: "stop_id_not_found_in_static_db" };
  return err;
}

function makeResolveStopStub(mapping) {
  return async (input) => {
    const key = input?.stop_id
      ? `stop:${String(input.stop_id)}`
      : `station:${String(input?.stationId || "")}`;
    const match = mapping[key];
    if (!match) throw makeUnknownStopError();
    return {
      canonical: { id: match.resolvedStopId || match.resolvedRootId || null },
      rootId: match.resolvedRootId || null,
    };
  };
}

function makeStationboardStub(calls) {
  return async (input) => {
    calls.push(input);
    const includeAlertsRequested = input.includeAlerts !== false;
    const includeAlertsApplied =
      process.env.STATIONBOARD_ENABLE_M2 !== "0" && includeAlertsRequested;

    return {
      station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
      rt: {
        available: false,
        applied: false,
        reason: "missing",
        feedKey: "la_tripupdates",
        fetchedAt: null,
        cacheFetchedAt: null,
        cacheAgeMs: null,
        ageMs: null,
        freshnessThresholdMs: 45000,
        ageSeconds: null,
        status: null,
        instance: {
          id: "test-instance",
          allocId: null,
          host: "localhost",
          pid: 1,
          build: "test",
        },
      },
      alerts: {
        available: false,
        applied: false,
        reason: "disabled",
        fetchedAt: null,
        ageSeconds: null,
      },
      departures: [
        {
          line: "R3",
          destination: "Vallorbe",
          scheduledDeparture: "2026-02-17T04:49:00.000Z",
          cancelled: false,
        },
      ],
      ...(input.debug
        ? {
            debug: {
              includeAlertsRequested,
              includeAlertsApplied,
            },
          }
        : {}),
    };
  };
}

function makeRtCacheMetaStub({
  fetchedAt = "2026-02-21T15:00:00.000Z",
  lastStatus = 200,
  payloadBytes = 1024,
  hasPayload = true,
} = {}) {
  return {
    fetched_at: fetchedAt,
    last_status: lastStatus,
    payload_bytes: payloadBytes,
    has_payload: hasPayload,
  };
}

function createRouteHandler(options = {}) {
  return createStationboardRouteHandler({
    getRtCacheMetaLike: async () =>
      makeRtCacheMetaStub({
        fetchedAt: null,
        lastStatus: null,
        payloadBytes: 0,
        hasPayload: false,
      }),
    ...options,
  });
}

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = String(value);
      return this;
    },
    set(key, value) {
      this.headers[key] = String(value);
      return this;
    },
    getHeader(key) {
      return this.headers[key];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end(payload = "") {
      this.body = payload || null;
      return this;
    },
  };
}

async function invokeRoute(handler, { query = {}, headers = {} } = {}) {
  const req = { query, headers };
  const res = makeMockRes();
  await handler(req, res);
  return res;
}

async function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("stationboard route returns 400 conflicting_stop_id when canonical roots differ", async () => {
  const calls = [];
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    resolveStopLike: makeResolveStopStub({
      "stop:ParentAAA": { resolvedStopId: "ParentAAA", resolvedRootId: "ParentAAA" },
      "station:ParentBBB": { resolvedStopId: "ParentBBB", resolvedRootId: "ParentBBB" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "ParentAAA",
      stationId: "ParentBBB",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "conflicting_stop_id");
  assert.equal(res.body.precedence, "stop_id");
  assert.equal(res.body.received?.stop_id, "ParentAAA");
  assert.equal(res.body.received?.stationId, "ParentBBB");
  assert.equal(res.body.resolved?.stop_id?.stop, "ParentAAA");
  assert.equal(res.body.resolved?.stop_id?.root, "ParentAAA");
  assert.equal(res.body.resolved?.stationId?.stop, "ParentBBB");
  assert.equal(res.body.resolved?.stationId?.root, "ParentBBB");
  assert.match(String(res.body.detail || ""), /different canonical roots/i);

  assert.equal(calls.length, 0);
});

test("stationboard route does not conflict when params resolve to same canonical root", async () => {
  const calls = [];
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    resolveStopLike: makeResolveStopStub({
      "stop:8501120:0:1": {
        resolvedStopId: "8501120:0:1",
        resolvedRootId: "Parent8501120",
      },
      "station:Parent8501120": {
        resolvedStopId: "Parent8501120",
        resolvedRootId: "Parent8501120",
      },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "8501120:0:1",
      stationId: "Parent8501120",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.departures));
  assert.equal(res.body.departures.length, 1);
  assert.equal(typeof res.body?.rt, "object");
  assert.equal(typeof res.body?.alerts, "object");
  assert.equal(
    res.headers["Cache-Control"] || res.headers["cache-control"],
    "public, max-age=0, must-revalidate"
  );
  assert.equal(
    res.headers["CDN-Cache-Control"] || res.headers["cdn-cache-control"],
    "public, max-age=12, stale-while-revalidate=24"
  );
  assert.equal(
    res.headers["Vary"] || res.headers["vary"],
    "Origin, Accept-Encoding"
  );
  assert.equal(res.headers["x-md-rt-applied"], "0");
  assert.equal(res.headers["x-md-rt-reason"], "missing");
  assert.equal(res.headers["x-md-rt-age-ms"], "-1");
  assert.equal(res.headers["x-md-rt-fetched-at"], "");
  assert.equal(res.headers["x-md-rt-status"], "");
  assert.equal(typeof res.headers["x-md-instance"], "string");
  assert.ok(String(res.headers["x-md-instance"]).length > 0);
  assert.equal(typeof res.headers["x-md-cache-key"], "string");
  assert.equal(res.body?.rt?.feedKey, "la_tripupdates");
  assert.equal(typeof res.body?.rt?.freshnessThresholdMs, "number");
  assert.equal(typeof res.body?.rt?.instance?.id, "string");
  assert.equal(typeof res.body?.alerts?.reason, "string");

  assert.equal(calls.length, 1);
});

test("stationboard route does not throw conflict when stationId fails resolve but stop_id resolves", async () => {
  const calls = [];
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    resolveStopLike: makeResolveStopStub({
      "stop:ParentAAA": { resolvedStopId: "ParentAAA", resolvedRootId: "ParentAAA" },
      // station:ParentMISSING intentionally omitted to force unknown_stop for that side
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "ParentAAA",
      stationId: "ParentMISSING",
    },
  });

  assert.notEqual(res.body?.error, "conflicting_stop_id");
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.departures));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stopId, "ParentAAA");
  assert.equal(calls[0].stationId, "ParentMISSING");
});

test("stationboard route does not throw conflict when stop_id fails resolve but stationId resolves", async () => {
  const calls = [];
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    resolveStopLike: makeResolveStopStub({
      // stop:ParentMISSING intentionally omitted to force unknown_stop for that side
      "station:ParentBBB": { resolvedStopId: "ParentBBB", resolvedRootId: "ParentBBB" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "ParentMISSING",
      stationId: "ParentBBB",
    },
  });

  assert.notEqual(res.body?.error, "conflicting_stop_id");
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.departures));
  assert.equal(calls.length, 1);
  // Precedence remains stop_id even when stationId resolves and stop_id does not.
  assert.equal(calls[0].stopId, "ParentMISSING");
  assert.equal(calls[0].stationId, "ParentBBB");
});

test("stationboard route returns 400 invalid_since_rt for malformed since_rt", async () => {
  const calls = [];
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
      since_rt: "not-a-date",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error?.code, "invalid_since_rt");
  assert.match(String(res.body?.error?.message || ""), /since_rt/i);
  assert.equal(calls.length, 0);
});

test("stationboard route returns 204 when since_rt is unchanged", async () => {
  const calls = [];
  const fetchedAt = "2026-02-21T16:00:00.000Z";
  const handler = createRouteHandler({
    getStationboardLike: makeStationboardStub(calls),
    getRtCacheMetaLike: async () =>
      makeRtCacheMetaStub({
        fetchedAt,
        lastStatus: 200,
        payloadBytes: 2048,
        hasPayload: true,
      }),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
      since_rt: fetchedAt,
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, null);
  assert.equal(res.headers["CDN-Cache-Control"] || res.headers["cdn-cache-control"], "public, max-age=2, stale-while-revalidate=4");
  assert.equal(res.headers["x-md-rt-reason"], "unchanged_since_rt");
  assert.equal(res.headers["x-md-rt-fetched-at"], fetchedAt);
  assert.equal(res.headers["x-md-rt-status"], "200");
  assert.equal(calls.length, 0);
});

test("stationboard route returns 200 when since_rt is older than current cache", async () => {
  const calls = [];
  const fetchedAt = "2026-02-21T16:00:00.000Z";
  const handler = createRouteHandler({
    getStationboardLike: async (input) => {
      calls.push(input);
      return {
        station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
        rt: {
          available: true,
          applied: true,
          reason: "fresh",
          feedKey: "la_tripupdates",
          fetchedAt,
          cacheFetchedAt: fetchedAt,
          cacheAgeMs: 1000,
          freshnessThresholdMs: 45000,
          ageSeconds: 1,
          status: 200,
          lastStatus: 200,
          instance: {
            id: "test-instance",
            allocId: null,
            host: "localhost",
            pid: 1,
            build: "test",
          },
        },
        alerts: {
          available: false,
          applied: false,
          reason: "disabled",
          fetchedAt: null,
          ageSeconds: null,
        },
        departures: [],
      };
    },
    getRtCacheMetaLike: async () =>
      makeRtCacheMetaStub({
        fetchedAt,
        lastStatus: 200,
        payloadBytes: 2048,
        hasPayload: true,
      }),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
      since_rt: "2026-02-21T15:59:59.000Z",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(Array.isArray(res.body?.departures), true);
  assert.equal(res.body?.rt?.fetchedAt, fetchedAt);
  assert.equal(calls.length, 1);
});

test("stationboard route include_alerts=1 with STATIONBOARD_ENABLE_M2=0 keeps requested=true and applied=false in debug", async () => {
  await withEnv("STATIONBOARD_ENABLE_M2", "0", async () => {
    const calls = [];
    const handler = createRouteHandler({
      getStationboardLike: makeStationboardStub(calls),
      resolveStopLike: makeResolveStopStub({
        "stop:ParentAAA": { resolvedStopId: "ParentAAA", resolvedRootId: "ParentAAA" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const res = await invokeRoute(handler, {
      query: {
        stop_id: "ParentAAA",
        include_alerts: "1",
        debug: "1",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.departures));
    assert.equal(res.body.debug?.includeAlertsRequested, true);
    assert.equal(res.body.debug?.includeAlertsApplied, false);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].includeAlerts, true);
  });
});

test("stationboard route includeAlerts=1 camel-case also maps to requested=true with M2 gate off", async () => {
  await withEnv("STATIONBOARD_ENABLE_M2", "0", async () => {
    const calls = [];
    const handler = createRouteHandler({
      getStationboardLike: makeStationboardStub(calls),
      resolveStopLike: makeResolveStopStub({
        "stop:ParentAAA": { resolvedStopId: "ParentAAA", resolvedRootId: "ParentAAA" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const res = await invokeRoute(handler, {
      query: {
        stop_id: "ParentAAA",
        includeAlerts: "1",
        debug: "1",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.debug?.includeAlertsRequested, true);
    assert.equal(res.body.debug?.includeAlertsApplied, false);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].includeAlerts, true);
  });
});

test("stationboard route accepts include_alerts when M2 is enabled", async () => {
  await withEnv("STATIONBOARD_ENABLE_M2", "1", async () => {
    const calls = [];
    const handler = createRouteHandler({
      getStationboardLike: makeStationboardStub(calls),
      resolveStopLike: makeResolveStopStub({
        "stop:ParentAAA": { resolvedStopId: "ParentAAA", resolvedRootId: "ParentAAA" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const res = await invokeRoute(handler, {
      query: {
        stop_id: "ParentAAA",
        include_alerts: "1",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.departures));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].includeAlerts, true);
  });
});

test("stationboard route returns structured 404 stop_not_found with debug payload", async () => {
  const handler = createRouteHandler({
    getStationboardLike: async () => {
      throw makeStopNotFoundError({
        tried: ["Parent9999999"],
        meta: {
          reason: "parent_stop_id_not_found_in_static_db",
          requestedStopId: "Parent9999999",
        },
      });
    },
    resolveStopLike: makeResolveStopStub({
      "stop:Parent9999999": { resolvedStopId: "Parent9999999", resolvedRootId: "Parent9999999" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent9999999",
      debug: "1",
    },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body?.error, "stop_not_found");
  assert.equal(res.body?.detail, "parent_stop_id_not_found_in_static_db");
  assert.deepEqual(res.body?.tried, ["Parent9999999"]);
  assert.equal(
    res.body?.debug?.details?.requestedStopId,
    "Parent9999999"
  );
});

test("stationboard route normalizes rt/alerts metadata when omitted by builder", async () => {
  const handler = createRouteHandler({
    getStationboardLike: async (input) => ({
      station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
      departures: [{ line: "R1", destination: "Renens", scheduledDeparture: "2026-02-17T04:49:00.000Z", cancelled: false }],
    }),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body?.rt, "object");
  assert.equal(typeof res.body?.alerts, "object");
  assert.equal(res.body?.rt?.applied, false);
  assert.equal(typeof res.body?.rt?.reason, "string");
  assert.equal(typeof res.body?.rt?.instance?.id, "string");
  assert.equal(res.headers["x-md-rt-applied"], "0");
  assert.equal(typeof res.headers["x-md-rt-reason"], "string");
});

test("stationboard route maps stale cache RT reason to canonical 'stale'", async () => {
  const handler = createRouteHandler({
    getStationboardLike: async (input) => ({
      station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
      rt: {
        available: true,
        applied: false,
        reason: "stale_cache",
        fetchedAt: "2026-02-21T15:59:00.000Z",
        cacheAgeMs: 75_000,
        freshnessThresholdMs: 45_000,
        lastStatus: 200,
      },
      alerts: {
        available: false,
        applied: false,
        reason: "disabled",
        fetchedAt: null,
        ageSeconds: null,
      },
      departures: [],
    }),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.rt?.applied, false);
  assert.equal(res.body?.rt?.reason, "stale");
  assert.equal(res.headers["x-md-rt-reason"], "stale");
});

test("stationboard route preserves structured noService payload when departures are empty", async () => {
  const handler = createRouteHandler({
    getStationboardLike: async (input) => ({
      station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
      departures: [],
      noService: {
        reason: "no_service_in_time_window",
      },
    }),
    resolveStopLike: makeResolveStopStub({
      "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
    }),
    dbQueryLike: async () => ({ rows: [] }),
    logger: { log() {}, error() {} },
  });

  const res = await invokeRoute(handler, {
    query: {
      stop_id: "Parent8501120",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body?.departures));
  assert.equal(res.body.departures.length, 0);
  assert.equal(res.body?.noService?.reason, "no_service_in_time_window");
});

test("stationboard route serves cached response when build times out", async () => {
  await withEnv("STATIONBOARD_ROUTE_TIMEOUT_MS", "20", async () => {
    let callCount = 0;
    const handler = createRouteHandler({
      getStationboardLike: async (input) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
            departures: [{ line: "R1", destination: "Renens" }],
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          station: { id: input.stopId || "Parent8501120", name: "Lausanne" },
          departures: [{ line: "R2", destination: "Morges" }],
        };
      },
      resolveStopLike: makeResolveStopStub({
        "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const first = await invokeRoute(handler, { query: { stop_id: "Parent8501120", lang: "fr" } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body?.departures?.[0]?.line, "R1");

    const second = await invokeRoute(handler, { query: { stop_id: "Parent8501120", lang: "fr" } });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body?.departures?.[0]?.line, "R1");
    assert.equal(second.headers["x-md-stale"], "1");
    assert.equal(second.headers["x-md-stale-reason"], "stationboard_timeout");
  });
});

test("stationboard route does not call upstream fetch on request path", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must_not_call_fetch");
  };
  try {
    const calls = [];
    const handler = createRouteHandler({
      getStationboardLike: makeStationboardStub(calls),
      resolveStopLike: makeResolveStopStub({
        "stop:Parent8501120": { resolvedStopId: "Parent8501120", resolvedRootId: "Parent8501120" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const res = await invokeRoute(handler, {
      query: {
        stop_id: "Parent8501120",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stationboard route returns 504 when build times out and no cache exists", async () => {
  await withEnv("STATIONBOARD_ROUTE_TIMEOUT_MS", "20", async () => {
    const handler = createRouteHandler({
      getStationboardLike: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          station: { id: "Parent8509999", name: "Lausanne" },
          departures: [{ line: "R1", destination: "Renens" }],
        };
      },
      resolveStopLike: makeResolveStopStub({
        "stop:Parent8509999": { resolvedStopId: "Parent8509999", resolvedRootId: "Parent8509999" },
      }),
      dbQueryLike: async () => ({ rows: [] }),
      logger: { log() {}, error() {} },
    });

    const res = await invokeRoute(handler, {
      query: {
        stop_id: "Parent8509999",
        lang: "fr",
      },
    });
    assert.equal(res.statusCode, 504);
    assert.equal(res.body?.error, "stationboard_timeout");
  });
});
