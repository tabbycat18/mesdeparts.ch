import { normalizeText, uniqueStrings } from "./text.js";

const DEFAULT_FALLBACK_LANGS = ["de", "fr", "en", "it"];

function normalizeLangCode(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";
  return raw.replace(/_/g, "-");
}

function parseAcceptLanguage(headerValue) {
  const raw = normalizeText(headerValue);
  if (!raw) return [];

  const parsed = [];
  for (const token of raw.split(",")) {
    const part = normalizeText(token);
    if (!part) continue;
    const [langPart, ...params] = part.split(";");
    const lang = normalizeLangCode(langPart);
    if (!lang || lang === "*") continue;
    let q = 1;
    for (const param of params) {
      const match = normalizeText(param).match(/^q=([0-9.]+)$/i);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value)) q = value;
    }
    parsed.push({ lang, q });
  }

  parsed.sort((a, b) => b.q - a.q);
  return parsed.map((item) => item.lang);
}

function toTranslations(translatedString) {
  if (translatedString == null) return [];
  if (typeof translatedString === "string") {
    const text = normalizeText(translatedString);
    return text ? [{ language: "", text }] : [];
  }

  if (Array.isArray(translatedString)) {
    const out = [];
    for (const item of translatedString) {
      if (typeof item === "string") {
        const text = normalizeText(item);
        if (text) out.push({ language: "", text });
        continue;
      }
      const text = normalizeText(item?.text);
      if (!text) continue;
      out.push({
        language: normalizeLangCode(item?.language),
        text,
      });
    }
    return out;
  }

  const list = Array.isArray(translatedString?.translation)
    ? translatedString.translation
    : [];
  const out = [];
  for (const entry of list) {
    const text = normalizeText(entry?.text);
    if (!text) continue;
    out.push({
      language: normalizeLangCode(entry?.language),
      text,
    });
  }
  return out;
}

function langMatches(preferred, candidate) {
  if (!preferred || !candidate) return false;
  return (
    preferred === candidate ||
    preferred.startsWith(`${candidate}-`) ||
    candidate.startsWith(`${preferred}-`)
  );
}

export function resolveLangPrefs({ queryLang, acceptLanguageHeader } = {}) {
  const fromQuery = normalizeLangCode(queryLang);
  if (fromQuery) {
    return uniqueStrings([fromQuery, ...DEFAULT_FALLBACK_LANGS]).map((lang) =>
      normalizeLangCode(lang)
    );
  }

  const fromHeader = parseAcceptLanguage(acceptLanguageHeader);
  return uniqueStrings([...fromHeader, ...DEFAULT_FALLBACK_LANGS]).map((lang) =>
    normalizeLangCode(lang)
  );
}

export function pickTranslation(translatedString, langPrefs = []) {
  const translations = toTranslations(translatedString);
  if (translations.length === 0) return null;

  const prefs = uniqueStrings(langPrefs).map((lang) => normalizeLangCode(lang));

  for (const preferred of prefs) {
    const hit = translations.find((entry) => langMatches(preferred, entry.language));
    if (hit?.text) return hit.text;
  }

  const german = translations.find((entry) => langMatches("de", entry.language));
  if (german?.text) return german.text;

  return translations[0]?.text || null;
}
