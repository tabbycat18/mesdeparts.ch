import { normalizeText } from "./text.js";

function normalizePublicLineToken(token) {
  const value = normalizeText(token);
  if (!value) return "";

  if (/^[0-9]+$/.test(value)) {
    return String(parseInt(value, 10));
  }

  if (/^[A-Za-z]+0*[0-9]+$/.test(value)) {
    const m = value.match(/^([A-Za-z]+)0*([0-9]+)$/);
    if (m) {
      return `${m[1].toUpperCase()}${String(parseInt(m[2], 10))}`;
    }
  }

  return value;
}

/**
 * Swiss GTFS route_id format commonly starts with a numeric category prefix,
 * then a public line token: e.g. "92-N1-H-j26-1" -> "N1".
 *
 * We only apply this extraction for numeric-prefix route IDs to avoid
 * accidentally transforming non-Swiss/custom route IDs.
 */
export function extractSwissPublicLineFromRouteId(routeId) {
  const rid = normalizeText(routeId);
  if (!rid) return "";

  if (/^ojp:/i.test(rid)) {
    const parts = rid.split(":");
    const head = normalizeText(parts[1]);
    if (!head) return "";

    const alphaNumericTail = head.match(/^\d{2,3}([A-Za-z][A-Za-z0-9+]*)$/);
    if (alphaNumericTail) {
      return normalizePublicLineToken(alphaNumericTail[1]);
    }

    const numericTail = head.match(/^\d{2,3}(0*[0-9]{1,4})$/);
    if (numericTail) {
      return normalizePublicLineToken(numericTail[1]);
    }

    return "";
  }

  if (!/^\d{2,3}-/.test(rid)) return "";

  const parts = rid.split("-");
  if (parts.length < 2) return "";

  return normalizePublicLineToken(parts[1]);
}
