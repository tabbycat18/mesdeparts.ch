import test from "node:test";
import assert from "node:assert/strict";

import { PG_APPLICATION_NAMES } from "../src/db/applicationName.js";
import { resolveDatabaseConnection } from "../src/db/connectionConfig.js";

test("resolveDatabaseConnection uses DATABASE_URL for backend app", () => {
  const out = resolveDatabaseConnection({
    applicationName: PG_APPLICATION_NAMES.backend,
    env: {
      DATABASE_URL: "postgres://backend-db",
      DATABASE_URL_POLLER: "postgres://poller-db",
    },
  });

  assert.equal(out.connectionString, "postgres://backend-db");
  assert.equal(out.source, "DATABASE_URL");
});

test("resolveDatabaseConnection prefers DATABASE_URL_POLLER for poller app", () => {
  const out = resolveDatabaseConnection({
    applicationName: PG_APPLICATION_NAMES.poller,
    env: {
      DATABASE_URL: "postgres://backend-db",
      DATABASE_URL_POLLER: "postgres://poller-db",
    },
  });

  assert.equal(out.connectionString, "postgres://poller-db");
  assert.equal(out.source, "DATABASE_URL_POLLER");
});

test("resolveDatabaseConnection falls back to DATABASE_URL when poller URL is missing", () => {
  const out = resolveDatabaseConnection({
    applicationName: PG_APPLICATION_NAMES.poller,
    env: {
      DATABASE_URL: "postgres://backend-db",
    },
  });

  assert.equal(out.connectionString, "postgres://backend-db");
  assert.equal(out.source, "DATABASE_URL");
});
