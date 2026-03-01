import test from "node:test";
import assert from "node:assert/strict";

import {
  clearHomeStop,
  getHomeStop,
  setHomeStop,
  shouldShowHomeStopModal,
} from "../v20260301.homeStop.js";

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

  removeItem(key) {
    this.map.delete(String(key));
  }
}

test("home stop guard only hides onboarding when dontAskAgain is true", () => {
  const storage = new MemoryStorage();

  assert.equal(getHomeStop({ storage }), null);
  assert.equal(shouldShowHomeStopModal({ storage }), true);

  setHomeStop(
    {
      id: "Parent8501120",
      name: "Lausanne",
      dontAskAgain: true,
    },
    { storage },
  );
  assert.deepEqual(getHomeStop({ storage }), {
    id: "Parent8501120",
    name: "Lausanne",
    dontAskAgain: true,
  });
  assert.equal(shouldShowHomeStopModal({ storage }), false);

  setHomeStop(
    {
      id: "Parent8501120",
      name: "Lausanne",
      dontAskAgain: false,
    },
    { storage },
  );
  assert.equal(shouldShowHomeStopModal({ storage }), true);

  clearHomeStop({ storage });
  assert.equal(getHomeStop({ storage }), null);
  assert.equal(shouldShowHomeStopModal({ storage }), true);
});
