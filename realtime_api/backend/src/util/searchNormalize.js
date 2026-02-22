// "sr" is a common keyboard typo for "st" (adjacent keys). Correct it before
// the st→saint expansion so "sr francois" → "saint francois".
const SR_TYPO_RE = /\bsr\b/g;
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
    .replace(/[-_./’’`]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(SR_TYPO_RE, "st")
    .replace(STOP_ABBREVIATIONS_RE, "saint")
    .replace(HUB_ABBREVIATIONS_RE, "hb")
    .replace(/\s+/g, " ")
    .trim();
}

