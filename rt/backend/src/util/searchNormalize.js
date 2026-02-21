const STOP_ABBREVIATIONS_RE = /\b(st|saint)\b/g;
const HUB_ABBREVIATIONS_RE = /\b(hauptbahnhof|hbf|hb)\b/g;

/**
 * Shared stop-search normalization pipeline.
 *
 * Keep this equivalent to SQL `public.normalize_stop_search_text(text)`:
 * - lowercase
 * - accent fold
 * - punctuation/separators to spaces
 * - collapse whitespace
 * - trim
 */
export function normalizeStopSearchText(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";

  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[-_./'’`]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(STOP_ABBREVIATIONS_RE, "saint")
    .replace(HUB_ABBREVIATIONS_RE, "hb")
    .replace(/\s+/g, " ")
    .trim();
}

