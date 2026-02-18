export function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function lower(value) {
  return normalizeText(value).toLowerCase();
}

export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values) {
  const out = [];
  for (const value of toArray(values)) {
    const text = normalizeText(value);
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

export function routeLabel(dep) {
  return (
    normalizeText(dep?.route_short_name) ||
    normalizeText(dep?.routeShortName) ||
    normalizeText(dep?.line) ||
    normalizeText(dep?.name) ||
    normalizeText(dep?.number)
  );
}

export function departureReasons(dep) {
  const out = [];
  for (const key of ["cancelReasons", "debugFlags", "reasons"]) {
    for (const value of toArray(dep?.[key])) {
      const text = normalizeText(value);
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}
