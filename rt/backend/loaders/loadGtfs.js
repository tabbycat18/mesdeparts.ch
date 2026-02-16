import { createReadStream } from "fs";
import { access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_GTFS_DIR = path.join(__dirname, "..", "..", "data", "gtfs-static-local");
const LEGACY_GTFS_DIR = path.join(__dirname, "..", "..", "data", "gtfs-static");

const GTFS_DIR = process.env.GTFS_DIR || LOCAL_GTFS_DIR;

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
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

async function loadCsv(relativePath, maxRows = Infinity) {
  let fullPath = path.join(GTFS_DIR, relativePath);
  if (!process.env.GTFS_DIR) {
    try {
      await access(fullPath);
    } catch {
      fullPath = path.join(LEGACY_GTFS_DIR, relativePath);
    }
  }

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

    if (!headers) {
      headers = parseCsvLine(trimmed);
      continue;
    }

    const parts = parseCsvLine(trimmed);
    const record = {};

    for (let i = 0; i < headers.length; i++) {
      record[headers[i]] = parts[i] ?? "";
    }

    rows.push(record);

    if (rows.length >= maxRows) {
      break;
    }
  }

  return rows;
}

export async function loadGtfs() {
  const [agencies, routes, stops, trips, stopTimes, calendar, calendarDates] =
    await Promise.all([
      loadCsv("agency.txt"),
      loadCsv("routes.txt"),
      loadCsv("stops.txt"),
      loadCsv("trips.txt", 200_000),
      loadCsv("stop_times.txt", 500_000),
      loadCsv("calendar.txt"),
      loadCsv("calendar_dates.txt", 50_000),
    ]);

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

  const stopTimesByTripId = new Map();
  const stopTimesByStopId = new Map();

  for (const st of stopTimes) {
    const tripId = st.trip_id;
    const stopId = st.stop_id;
    if (!tripId || !stopId) continue;

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

  for (const arr of stopTimesByTripId.values()) {
    arr.sort((a, b) => a._stop_sequence_num - b._stop_sequence_num);
  }
  for (const arr of stopTimesByStopId.values()) {
    arr.sort((a, b) => a._stop_sequence_num - b._stop_sequence_num);
  }

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

let cachedPromise;
export function loadGtfsOnce() {
  if (!cachedPromise) {
    cachedPromise = loadGtfs();
  }
  return cachedPromise;
}
