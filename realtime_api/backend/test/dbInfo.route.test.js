import test from "node:test";
import assert from "node:assert/strict";

import { createDbInfoRouteHandler } from "../src/api/dbInfoRoute.js";

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
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

async function invokeRoute(handler, { query = {} } = {}) {
  const req = { query };
  const res = makeMockRes();
  await handler(req, res);
  return res;
}

test("dbinfo route is hidden when debug is disabled", async () => {
  const handler = createDbInfoRouteHandler({
    dbQueryLike: async () => ({ rows: [] }),
    isDebugLike: () => false,
  });
  const res = await invokeRoute(handler, { query: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body?.error, "not_found");
});

test("dbinfo route returns db marker fields when debug is enabled", async () => {
  const handler = createDbInfoRouteHandler({
    dbQueryLike: async () => ({
      rows: [
        {
          now: "2026-02-26T12:35:00.000Z",
          current_database: "neondb",
          inet_server_addr: "127.0.0.1",
          inet_server_port: 5432,
          application_name: "md_backend",
        },
      ],
    }),
    isDebugLike: () => true,
  });
  const res = await invokeRoute(handler, { query: { debug: "1" } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.current_database, "neondb");
  assert.equal(res.body?.inet_server_addr, "127.0.0.1");
  assert.equal(res.body?.inet_server_port, 5432);
  assert.equal(res.body?.application_name, "md_backend");
  assert.equal(res.body?.now, "2026-02-26T12:35:00.000Z");
});
