import test from "node:test";
import assert from "node:assert/strict";

import {
  informedStopMatchesForDebug,
  stopRootForDebugMatch,
} from "../src/util/alertDebugScope.js";

test("stopRootForDebugMatch normalizes Parent and SLOID roots", () => {
  assert.equal(stopRootForDebugMatch("Parent8501120"), "8501120");
  assert.equal(stopRootForDebugMatch("ch:1:sloid:1120"), "1120");
  assert.equal(stopRootForDebugMatch("8501120:3"), "8501120");
  assert.equal(stopRootForDebugMatch("ch:1:foo:bar"), "");
});

test("informedStopMatchesForDebug does not over-match namespaced IDs", () => {
  assert.equal(
    informedStopMatchesForDebug("ch:1:sloid:1576", "ch:1:sloid:1120"),
    false
  );
});

test("informedStopMatchesForDebug keeps valid parent/platform and sloid/platform matches", () => {
  assert.equal(
    informedStopMatchesForDebug("8501120:3", "Parent8501120"),
    true
  );
  assert.equal(
    informedStopMatchesForDebug("1120:0", "ch:1:sloid:1120"),
    true
  );
});
