import { fetchFeedMeta } from "./lib/fetchGtfsFeedMeta.js";

const TRIP_UPDATES_URL = "https://api.opentransportdata.swiss/la/gtfs-rt";

export async function fetchTripUpdatesMeta(apiKey = process.env.OPENTDATA_API_KEY) {
  return fetchFeedMeta(TRIP_UPDATES_URL, apiKey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const meta = await fetchTripUpdatesMeta();
    if (!meta.feedVersion) {
      throw new Error("GTFS-RT feed_version is empty");
    }
    process.stdout.write(`${meta.feedVersion}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
