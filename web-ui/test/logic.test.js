import assert from "node:assert/strict";

import {
  classifyMode,
  detectNetworkFromStation,
  parseApiDate,
} from "../logic.v2026-02-06.js";

// classifyMode should categorize common transport codes
assert.equal(classifyMode("IC"), "train");
assert.equal(classifyMode("RE"), "train");
assert.equal(classifyMode("BUS"), "bus");
assert.equal(classifyMode("T"), "bus"); // tram grouped with bus

// parseApiDate should normalize the +0100 offset format
const parsed = parseApiDate("2025-11-25T21:35:00+0100");
assert.ok(parsed instanceof Date);
assert.equal(parsed.toISOString(), "2025-11-25T20:35:00.000Z");

// detectNetworkFromStation should pick up city-specific networks
assert.equal(detectNetworkFromStation("Lausanne, gare"), "tl");
assert.equal(detectNetworkFromStation("Genève, Cornavin"), "tpg");
assert.equal(detectNetworkFromStation("Zurich HB"), "vbz");
