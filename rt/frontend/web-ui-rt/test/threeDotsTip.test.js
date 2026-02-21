import test from "node:test";
import assert from "node:assert/strict";

import {
  getHasSeenThreeDotsTip,
  setHasSeenThreeDotsTip,
} from "../threeDotsTip.v2026-02-21-1.js";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
}

test("three dots tip persistence stores seen=true after dismissal", () => {
  const storage = new MemoryStorage();

  assert.equal(getHasSeenThreeDotsTip({ storage }), false);
  setHasSeenThreeDotsTip(true, { storage });
  assert.equal(getHasSeenThreeDotsTip({ storage }), true);

  setHasSeenThreeDotsTip(false, { storage });
  assert.equal(getHasSeenThreeDotsTip({ storage }), false);
});
