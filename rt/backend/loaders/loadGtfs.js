import { createReadStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory where GTFS .txt files live
const GTFS_DIR = path.join(__dirname, "..", "data");

/**
 * Minimal CSV line parser that supports:
 * - comma-separated values
 * - double quotes around fields
 * - escaped quotes inside a quoted field ("")
 */
function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ",") {
        result.push(current);
        current = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }

  result.push(current);
  return result;
}

/**
 * Load a GTFS .txt file from GTFS_DIR and return an array of objects:
 * [{col1: value1, col2: value2, ...}, ...]
 */
// Stream a CSV file line by line to avoid building a multi-GB string
// Stream a CSV file line by line, with an optional row cap
async function loadCsv(relativePath, maxRows = Infinity) {
  const dataDir = path.resolve(new URL("../data", import.meta.url).pathname);
  const fullPath = path.join(dataDir, relativePath);

  const stream = createReadStream(fullPath, { encoding: "utf8" });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let headers = null;
  const rows = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // First non-empty line = header row
    if (!headers) {
      headers = trimmed.split(",");
      continue;
    }

    const parts = trimmed.split(",");
    const record = {};

    for (let i = 0; i < headers.length; i++) {
      record[headers[i]] = parts[i] ?? "";
    }

    rows.push(record);

    // 🔴 IMPORTANT: stop before we blow up memory
    if (rows.length >= maxRows) {
      break;
    }
  }

  return rows;
}

/**
 * Load all GTFS static tables we care about and build useful in-memory indexes.
 * Returns:
 *  {
 *    raw: { agencies, routes, stops, trips, stopTimes, calendar, calendarDates },
 *    index: {
 *      stopsById,
 *      routesById,
 *      tripsById,
 *      tripsByRouteId,
 *      stopTimesByTripId,
 *      stopTimesByStopId,
 *      servicesById,
 *      calendarDatesByServiceId,
 *    }
 *  }
 */
export async function loadGtfs() {
  const [agencies, routes, stops, trips, stopTimes, calendar, calendarDates] =
    await Promise.all([
      // These are usually small enough to load fully
      loadCsv("agency.txt"), // few rows
      loadCsv("routes.txt"), // moderate
      loadCsv("stops.txt"), // moderate

      // These are HUGE — cap them to avoid OOM
      // [Inference] These limits are guesses based on your 3 GB dataset.
      loadCsv("trips.txt", 200_000), // first 200k trips
      loadCsv("stop_times.txt", 500_000), // first 500k stop times

      loadCsv("calendar.txt"), // usually small
      loadCsv("calendar_dates.txt", 50_000), // cap exceptions
    ]);

  // Basic lookup maps
  const stopsById = new Map();
  for (const s of stops) {
    if (!s.stop_id) continue;
    stopsById.set(s.stop_id, s);
  }

  const routesById = new Map();
  for (const r of routes) {
    if (!r.route_id) continue;
    routesById.set(r.route_id, r);
  }

  const tripsById = new Map();
  const tripsByRouteId = new Map();
  for (const t of trips) {
    if (!t.trip_id) continue;
    tripsById.set(t.trip_id, t);
    if (t.route_id) {
      const arr = tripsByRouteId.get(t.route_id) || [];
      arr.push(t);
      tripsByRouteId.set(t.route_id, arr);
    }
  }

  // stop_times indexed both by trip and by stop
  const stopTimesByTripId = new Map();
  const stopTimesByStopId = new Map();

  for (const st of stopTimes) {
    const tripId = st.trip_id;
    const stopId = st.stop_id;
    if (!tripId || !stopId) continue;

    // Normalise stop_sequence to a number
    const seq = Number(st.stop_sequence || "0");
    st._stop_sequence_num = Number.isNaN(seq) ? 0 : seq;

    let arrTrip = stopTimesByTripId.get(tripId);
    if (!arrTrip) {
      arrTrip = [];
      stopTimesByTripId.set(tripId, arrTrip);
    }
    arrTrip.push(st);

    let arrStop = stopTimesByStopId.get(stopId);
    if (!arrStop) {
      arrStop = [];
      stopTimesByStopId.set(stopId, arrStop);
    }
    arrStop.push(st);
  }

  // Ensure deterministic order
  for (const arr of stopTimesByTripId.values()) {
    arr.sort((a, b) => a._stop_sequence_num - b._stop_sequence_num);
  }
  for (const arr of stopTimesByStopId.values()) {
    arr.sort((a, b) => a._stop_sequence_num - b._stop_sequence_num);
  }

  // Service calendars
  const servicesById = new Map();
  for (const c of calendar) {
    if (!c.service_id) continue;
    servicesById.set(c.service_id, c);
  }

  const calendarDatesByServiceId = new Map();
  for (const cd of calendarDates) {
    if (!cd.service_id) continue;
    const arr = calendarDatesByServiceId.get(cd.service_id) || [];
    arr.push(cd);
    calendarDatesByServiceId.set(cd.service_id, arr);
  }

  const raw = {
    agencies,
    routes,
    stops,
    trips,
    stopTimes,
    calendar,
    calendarDates,
  };

  const index = {
    stopsById,
    routesById,
    tripsById,
    tripsByRouteId,
    stopTimesByTripId,
    stopTimesByStopId,
    servicesById,
    calendarDatesByServiceId,
  };

  console.log(
    `[GTFS] Loaded ${stops.length} stops, ${routes.length} routes, ${trips.length} trips, ${stopTimes.length} stop_times`
  );

  return { raw, index };
}

// Optional singleton-style loader so the data is only parsed once
let cachedPromise;
export function loadGtfsOnce() {
  if (!cachedPromise) {
    cachedPromise = loadGtfs();
  }
  return cachedPromise;
}
