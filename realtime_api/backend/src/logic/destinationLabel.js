function normalizePlaceNameForCompare(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isSamePlaceName(a, b) {
  const na = normalizePlaceNameForCompare(a);
  const nb = normalizePlaceNameForCompare(b);
  if (!na || !nb) return false;
  return na === nb;
}

export function chooseDestinationLabel({ tripHeadsign, routeLongName, stationName }) {
  const headsign = String(tripHeadsign || "").trim();
  const routeLong = String(routeLongName || "").trim();
  const station = String(stationName || "").trim();

  if (headsign) {
    // Guard against self-destination artifacts at the current stop.
    if (station && isSamePlaceName(headsign, station)) {
      if (routeLong && !isSamePlaceName(routeLong, station)) return routeLong;
    }
    return headsign;
  }

  if (routeLong) return routeLong;
  return station;
}

