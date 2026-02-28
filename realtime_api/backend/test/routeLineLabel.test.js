import test from "node:test";
import assert from "node:assert/strict";

import { extractSwissPublicLineFromRouteId } from "../src/util/routeLineLabel.js";

test("extractSwissPublicLineFromRouteId extracts Swiss dashed route-id line tokens", () => {
  assert.equal(extractSwissPublicLineFromRouteId("92-N1-H-j26-1"), "N1");
  assert.equal(extractSwissPublicLineFromRouteId("92-N5-D-j26-1"), "N5");
  assert.equal(extractSwissPublicLineFromRouteId("92-N3-H-j26-1"), "N3");
  assert.equal(extractSwissPublicLineFromRouteId("10-IC5-j26-1"), "IC5");
  assert.equal(extractSwissPublicLineFromRouteId("91-009-K-j26-1"), "9");
});

test("extractSwissPublicLineFromRouteId extracts OJP prefixed line tokens", () => {
  assert.equal(extractSwissPublicLineFromRouteId("ojp:920N2:G:H:j26"), "N2");
  assert.equal(extractSwissPublicLineFromRouteId("ojp:92010:G:H:j26"), "10");
});

test("extractSwissPublicLineFromRouteId ignores non-Swiss/non-OJP ids", () => {
  assert.equal(extractSwissPublicLineFromRouteId("route-foo"), "");
  assert.equal(extractSwissPublicLineFromRouteId("EV1"), "");
  assert.equal(extractSwissPublicLineFromRouteId(""), "");
});
