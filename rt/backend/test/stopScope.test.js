import test from "node:test";
import assert from "node:assert/strict";

import {
  hasTokenIntersection,
  normalizeStopId,
  stopKeySet,
} from "../src/util/stopScope.js";

test("stopScope normalizes and matches Parent/SLOID ids", () => {
  assert.equal(normalizeStopId(" Parent8501609 "), "Parent8501609");

  const parentKeys = stopKeySet("Parent8501609");
  const sloidKeys = stopKeySet("ch:1:sloid:1609");

  assert.ok(parentKeys.has("parent8501609"));
  assert.ok(parentKeys.has("8501609"));
  assert.ok(parentKeys.has("1609"));
  assert.ok(sloidKeys.has("1609"));
  assert.equal(hasTokenIntersection(parentKeys, sloidKeys), true);
});

test("stopScope maps 85-prefixed ids to tails for SLOID-style matching", () => {
  const parentKeys = stopKeySet("Parent8576646");
  const sloidKeys = stopKeySet("ch:1:sloid:76646");

  assert.ok(parentKeys.has("8576646"));
  assert.ok(parentKeys.has("76646"));
  assert.equal(hasTokenIntersection(parentKeys, sloidKeys), true);
});
