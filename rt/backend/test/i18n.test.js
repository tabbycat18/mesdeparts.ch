import test from "node:test";
import assert from "node:assert/strict";

import { pickTranslation, resolveLangPrefs } from "../src/util/i18n.js";

test("pickTranslation uses exact/prefix language match", () => {
  const text = pickTranslation(
    {
      translation: [
        { language: "de", text: "Bauarbeiten" },
        { language: "fr-CH", text: "Travaux" },
      ],
    },
    ["fr"]
  );

  assert.equal(text, "Travaux");
});

test("pickTranslation falls back to de when preferred language missing", () => {
  const text = pickTranslation(
    {
      translation: [
        { language: "de", text: "Umleitung" },
        { language: "it", text: "Deviazione" },
      ],
    },
    ["en"]
  );

  assert.equal(text, "Umleitung");
});

test("pickTranslation falls back to first available translation", () => {
  const text = pickTranslation(
    {
      translation: [
        { language: "it", text: "Sostituzione" },
        { language: "fr", text: "Remplacement" },
      ],
    },
    ["es"]
  );

  assert.equal(text, "Sostituzione");
});

test("pickTranslation supports single-string inputs", () => {
  assert.equal(pickTranslation("Single message", ["fr"]), "Single message");
});

test("resolveLangPrefs prefers query lang over accept-language", () => {
  const prefs = resolveLangPrefs({
    queryLang: "fr",
    acceptLanguageHeader: "de-CH,de;q=0.9,en;q=0.8",
  });

  assert.equal(prefs[0], "fr");
  assert.ok(prefs.includes("de"));
  assert.ok(prefs.includes("en"));
});
