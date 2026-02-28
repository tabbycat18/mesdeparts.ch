import test from "node:test";
import assert from "node:assert/strict";

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

test("help center i18n keys resolve for FR/EN/DE/IT and language switch hides overlay safely", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousLocalStorage = globalThis.localStorage;

  const storage = new MemoryStorage();
  let hideCalls = 0;
  let removed = false;
  const fakeOverlay = {
    __infoControls: {
      hide() {
        hideCalls += 1;
      },
    },
    remove() {
      removed = true;
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { search: "" },
      matchMedia: () => ({ matches: false }),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      documentElement: { lang: "fr" },
      getElementById(id) {
        return id === "info-overlay" ? fakeOverlay : null;
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      languages: ["fr-FR"],
      language: "fr-FR",
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });

  try {
    const i18n = await import(`../v20260228.i18n.js?test=${Date.now()}`);
    const requiredKeys = [
      "infoTitle",
      "infoModalDescription",
      "infoTabHelp",
      "infoTabRealtime",
      "infoTabCredits",
      "infoHelpSectionQuickStartTitle",
      "infoHelpQuickStartItem1",
      "infoHelpQuickStartItem2",
      "infoHelpSectionReadingTitle",
      "infoHelpReadingItem1",
      "infoHelpReadingItem2",
      "infoHelpSectionFiltersTitle",
      "infoHelpFiltersItem1",
      "infoHelpFiltersItem2",
      "infoHelpSectionPersonalizationTitle",
      "infoHelpPersonalizationItem1",
      "infoHelpPersonalizationItem2",
      "infoRealtimeSectionMinDepartureTitle",
      "infoRealtimeMinDepartureItem1",
      "infoRealtimeMinDepartureItem2",
      "infoRealtimeSectionOfficialTitle",
      "infoRealtimeOfficialItem1",
      "infoRealtimeOfficialItem2",
      "infoRealtimeSectionThresholdsTitle",
      "infoRealtimeThresholdItem1",
      "infoRealtimeThresholdItem2",
      "infoRealtimeThresholdItem3",
      "infoRealtimeSectionDisruptionsTitle",
      "infoRealtimeDisruptionsItem1",
      "infoRealtimeDisruptionsItem2",
      "infoRealtimeSectionCheckTitle",
      "infoRealtimeCheckItem1",
      "infoRealtimeCheckItem2",
      "infoCreditsSectionSourcesTitle",
      "infoCreditsSourcesItem1",
      "infoCreditsSourcesItem2",
      "infoCreditsSectionClockTitle",
      "infoCreditsClockItem1",
      "infoCreditsClockItem2",
      "infoCreditsSectionLicenseTitle",
      "infoCreditsLicenseItem1",
      "infoCreditsLicenseItem2",
      "infoCreditsSectionIndependenceTitle",
      "infoCreditsIndependenceItem1",
    ];

    for (const lang of ["fr", "en", "de", "it"]) {
      i18n.setLanguage(lang);
      for (const key of requiredKeys) {
        const val = i18n.t(key);
        assert.equal(typeof val, "string");
        assert.ok(val.length > 0);
        assert.notEqual(val, key);
      }
    }

    assert.equal(hideCalls >= 1, true);
    assert.equal(removed, true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
    if (previousDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previousDocument });
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: previousNavigator });
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: previousLocalStorage });
  }
});
