import { buildStationboard } from "../../logic/buildStationboard.js";
import { fetchServiceAlerts } from "../rt/fetchServiceAlerts.js";
import { attachAlerts } from "../merge/attachAlerts.js";

const ALERTS_CACHE_MS = Math.max(
  1_000,
  Number(process.env.SERVICE_ALERTS_CACHE_MS || "30000")
);
const ALERTS_FETCH_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.SERVICE_ALERTS_FETCH_TIMEOUT_MS || "3000")
);

let alertsCacheValue = null;
let alertsCacheTs = 0;
let alertsInflight = null;

function resolveServiceAlertsApiKey() {
  return (
    process.env.OPENTDATA_GTFS_SA_KEY ||
    process.env.OPENTDATA_API_KEY ||
    ""
  );
}

async function refreshAlertsCache() {
  const next = await fetchServiceAlerts({
    apiKey: resolveServiceAlertsApiKey(),
    timeoutMs: ALERTS_FETCH_TIMEOUT_MS,
  });
  alertsCacheValue = next;
  alertsCacheTs = Date.now();
  return next;
}

async function getServiceAlertsCached() {
  const now = Date.now();
  const fresh = alertsCacheValue && now - alertsCacheTs <= ALERTS_CACHE_MS;
  if (fresh) return alertsCacheValue;

  if (alertsInflight) {
    if (alertsCacheValue) return alertsCacheValue;
    return alertsInflight;
  }

  alertsInflight = refreshAlertsCache()
    .catch((err) => {
      if (alertsCacheValue) return alertsCacheValue;
      throw err;
    })
    .finally(() => {
      alertsInflight = null;
    });

  if (alertsCacheValue) {
    // Stale-while-revalidate: do not block stationboard on refresh.
    return alertsCacheValue;
  }

  return alertsInflight;
}

export async function getStationboard({
  stopId,
  fromTs,
  toTs,
  limit,
  includeAlerts,
} = {}) {
  void fromTs;
  void toTs;
  const shouldIncludeAlerts = includeAlerts !== false;

  const locationId = String(stopId || "").trim();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
  const alertsPromise = shouldIncludeAlerts ? getServiceAlertsCached() : null;
  const board = await buildStationboard(locationId, {
    limit: boundedLimit,
    windowMinutes: 180,
  });

  const departures = Array.isArray(board?.departures) ? board.departures : [];
  const baseResponse = {
    ...board,
    banners: [],
    departures: departures.map((dep) =>
      Array.isArray(dep?.alerts) ? dep : { ...dep, alerts: [] }
    ),
  };

  if (!shouldIncludeAlerts) return baseResponse;

  const routeIds = departures.map((dep) => dep?.route_id).filter(Boolean);
  const tripIds = departures.map((dep) => dep?.trip_id).filter(Boolean);

  try {
    const alerts = await alertsPromise;
    const attached = attachAlerts({
      stopId: locationId,
      routeIds,
      tripIds,
      departures: baseResponse.departures,
      alerts,
      now: new Date(),
    });
    return {
      ...baseResponse,
      banners: attached.banners,
      departures: attached.departures,
    };
  } catch (err) {
    const response = {
      ...baseResponse,
      banners: [],
    };
    if (process.env.NODE_ENV !== "production") {
      response.debug = {
        ...(response.debug || {}),
        alerts_error: String(err?.message || err),
      };
    }
    return response;
  }
}
