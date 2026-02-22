export function normalizeStopId(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function stopKeySet(value) {
  const raw = normalizeStopId(value);
  const out = new Set();
  if (!raw) return out;

  const lowerRaw = raw.toLowerCase();
  out.add(lowerRaw);

  const noParent = lowerRaw.startsWith("parent")
    ? lowerRaw.slice("parent".length)
    : lowerRaw;
  if (noParent) out.add(noParent);

  const isSloid = lowerRaw.includes("sloid:");
  const isPlatformScoped = noParent.includes(":") && !isSloid;

  const base = noParent.split(":")[0] || noParent;
  if (base && !isPlatformScoped && !isSloid) out.add(base);

  const sloidMatch = lowerRaw.match(/sloid:(\d+)/i);
  if (sloidMatch?.[1]) {
    const sl = String(Number(sloidMatch[1]));
    if (sl && sl !== "0") out.add(sl);
  }

  if (/^\d+$/.test(base)) {
    const normalizedDigits = String(Number(base));
    if (
      normalizedDigits &&
      normalizedDigits !== "0" &&
      !isPlatformScoped &&
      !isSloid
    ) {
      out.add(normalizedDigits);
    }
    // Map Swiss GTFS stop ids (85xxxxxx) to SLOID-like tails (e.g. 8576646 -> 76646).
    if (!isPlatformScoped && !isSloid && base.startsWith("85") && base.length > 2) {
      const tail = String(Number(base.slice(2)));
      if (tail && tail !== "0") out.add(tail);
    }
  }

  return out;
}

export function hasTokenIntersection(aSet, bSet) {
  for (const token of aSet) {
    if (bSet.has(token)) return true;
  }
  return false;
}
