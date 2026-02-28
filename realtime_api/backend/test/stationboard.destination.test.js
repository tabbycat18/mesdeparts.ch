import assert from "node:assert/strict";
import test from "node:test";

import { chooseDestinationLabel } from "../src/logic/destinationLabel.js";

test("keeps trip headsign when it differs from station name", () => {
  const destination = chooseDestinationLabel({
    tripHeadsign: "Lausanne, Blécherette",
    routeLongName: "Motte - Blécherette",
    stationName: "Lausanne, Motte",
  });
  assert.equal(destination, "Lausanne, Blécherette");
});

test("prefers route_long_name when trip headsign equals current station", () => {
  const destination = chooseDestinationLabel({
    tripHeadsign: "Lausanne, Motte",
    routeLongName: "Motte - Bellevaux",
    stationName: "Lausanne, Motte",
  });
  assert.equal(destination, "Motte - Bellevaux");
});

test("same-place compare is accent/punctuation tolerant", () => {
  const destination = chooseDestinationLabel({
    tripHeadsign: "Lausanne Motte",
    routeLongName: "Motte - St-François",
    stationName: "Lausanne, Motté",
  });
  assert.equal(destination, "Motte - St-François");
});

test("falls back to station name when neither headsign nor route long name exists", () => {
  const destination = chooseDestinationLabel({
    tripHeadsign: "",
    routeLongName: "",
    stationName: "Lausanne, Motte",
  });
  assert.equal(destination, "Lausanne, Motte");
});
