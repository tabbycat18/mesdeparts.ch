import test from "node:test";
import assert from "node:assert/strict";

import {
  guardStationboardRequestPathUpstream,
  isBlockedStationboardUpstreamUrl,
} from "../src/util/upstreamRequestGuard.js";

test("isBlockedStationboardUpstreamUrl detects blocked GTFS/alerts hosts", () => {
  assert.equal(
    isBlockedStationboardUpstreamUrl("https://api.opentransportdata.swiss/la/gtfs-rt"),
    true
  );
  assert.equal(
    isBlockedStationboardUpstreamUrl("https://transport.opendata.ch/v1/stationboard"),
    true
  );
  assert.equal(
    isBlockedStationboardUpstreamUrl("https://mesdeparts.ch/api/stationboard"),
    false
  );
});

test("guardStationboardRequestPathUpstream throws in non-production", () => {
  assert.throws(
    () =>
      guardStationboardRequestPathUpstream("https://api.opentransportdata.swiss/la/gtfs-sa", {
        env: "development",
      }),
    /request_path_upstream_blocked/i
  );
});

test("guardStationboardRequestPathUpstream logs and returns false in production", () => {
  const logs = [];
  const allowed = guardStationboardRequestPathUpstream(
    "https://transport.opendata.ch/v1/stationboard",
    {
      env: "production",
      logger: {
        error: (...args) => logs.push(args),
      },
    }
  );

  assert.equal(allowed, false);
  assert.ok(logs.length >= 1);
});
