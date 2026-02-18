import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
  const fullPath = path.resolve(__dirname, "fixtures", name);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "").trim();
}

function collectBannerTexts(payload) {
  const out = new Set();
  for (const banner of toArray(payload?.banners)) {
    const header = normalize(banner?.header);
    const description = normalize(banner?.description);
    if (header) out.add(header);
    if (description) out.add(description);
  }
  return out;
}

function collectAlertTexts(payload) {
  const out = new Set();
  for (const dep of toArray(payload?.departures)) {
    for (const alert of toArray(dep?.alerts)) {
      const header = normalize(alert?.header);
      const description = normalize(alert?.description);
      if (header) out.add(header);
      if (description) out.add(description);
    }
  }
  return out;
}

function collectDepartureDestinations(payload) {
  return toArray(payload?.departures).map((dep) => normalize(dep?.destination)).filter(Boolean);
}

test("disruption correctness: departure destinations do not mirror full banner/alert text", () => {
  const cancellationFixture = readFixture("lausanne_disruption_cancellations.json");
  const replacementFixture = readFixture("lausanne_disruption_replacement.json");

  for (const payload of [cancellationFixture, replacementFixture]) {
    const destinations = collectDepartureDestinations(payload);
    const bannerTexts = collectBannerTexts(payload);
    const alertTexts = collectAlertTexts(payload);

    for (const destination of destinations) {
      assert.equal(
        bannerTexts.has(destination),
        false,
        `departure destination matches banner text: "${destination}"`
      );
      assert.equal(
        alertTexts.has(destination),
        false,
        `departure destination matches alert text: "${destination}"`
      );
    }
  }
});

test("disruption correctness: cancelled rows remain in departures and are flagged cancelled", () => {
  const payload = readFixture("lausanne_disruption_cancellations.json");
  const departures = toArray(payload?.departures);
  assert.ok(departures.length > 0);

  const cancelled = departures.filter((dep) => dep?.cancelled === true);
  assert.ok(cancelled.length >= 2, "expected at least two cancelled rows in fixture");

  for (const dep of cancelled) {
    assert.equal(dep.cancelled, true);
    assert.ok(normalize(dep?.cancelReasonCode), "cancelled row missing cancelReasonCode");
  }
});

test("disruption correctness: long disruption text is allowed in banners/messages", () => {
  const payload = readFixture("lausanne_disruption_replacement.json");
  const bannerDescriptions = toArray(payload?.banners)
    .map((banner) => normalize(banner?.description))
    .filter(Boolean);

  const hasLongBannerText = bannerDescriptions.some((text) => text.length >= 80);
  assert.equal(hasLongBannerText, true);
});

