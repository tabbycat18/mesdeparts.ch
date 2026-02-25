import test from "node:test";
import assert from "node:assert/strict";

import {
  PG_APPLICATION_NAMES,
  resolvePgApplicationName,
} from "../src/db/applicationName.js";

test("resolvePgApplicationName defaults to backend app name", () => {
  const appName = resolvePgApplicationName({
    env: {},
    argv: ["node", "/app/server.js"],
  });
  assert.equal(appName, PG_APPLICATION_NAMES.backend);
});

test("resolvePgApplicationName uses poller app name for poller entrypoints", () => {
  const appName = resolvePgApplicationName({
    env: {},
    argv: ["node", "/app/scripts/pollFeeds.js"],
  });
  assert.equal(appName, PG_APPLICATION_NAMES.poller);
});

test("resolvePgApplicationName keeps explicit PGAPPNAME override", () => {
  const appName = resolvePgApplicationName({
    env: { PGAPPNAME: "custom_name" },
    argv: ["node", "/app/scripts/pollLaTripUpdates.js"],
  });
  assert.equal(appName, "custom_name");
});
