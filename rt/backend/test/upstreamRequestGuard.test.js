import test from "node:test";
import assert from "node:assert/strict";

import {
  guardStationboardRequestPathUpstream,
  isBlockedStationboardUpstreamUrl,
} from "../src/util/upstreamRequestGuard.js";

test("isBlockedStationboardUpstreamUrl matches GTFS-RT/alerts upstream domains", () => {
  assert.equal(isBlockedStationboardUpstreamUrl("https://api.opentransportdata.swiss/la/gtfs-rt"), true);
  assert.equal(isBlockedStationboardUpstreamUrl("https://transport.opendata.ch/v1/stationboard"), true);
  assert.equal(isBlockedStationboardUpstreamUrl("https://api.mesdeparts.ch/api/stationboard"), false);
});

test("guardStationboardRequestPathUpstream throws in development for blocked upstream", () => {
  assert.throws(
    () =>
      guardStationboardRequestPathUpstream("https://api.opentransportdata.swiss/la/gtfs-rt", {
        env: "development",
        scope: "api/stationboard:test",
        logger: { error() {} },
      }),
    /request_path_upstream_blocked/
  );
});

test("guardStationboardRequestPathUpstream logs and returns false in production for blocked upstream", () => {
  const errors = [];
  const out = guardStationboardRequestPathUpstream(
    "https://transport.opendata.ch/v1/stationboard?station=Lausanne",
    {
      env: "production",
      scope: "api/stationboard:test",
      logger: {
        error(message, payload) {
          errors.push({ message, payload });
        },
      },
    }
  );
  assert.equal(out, false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.message || ""), /blocked request-path upstream/i);
  assert.equal(String(errors[0]?.payload?.scope || ""), "api/stationboard:test");
});

test("guardStationboardRequestPathUpstream allows non-blocked upstream URL", () => {
  const out = guardStationboardRequestPathUpstream("https://api.mesdeparts.ch/api/stops/search", {
    env: "production",
    scope: "api/stationboard:test",
    logger: { error() {} },
  });
  assert.equal(out, true);
});
