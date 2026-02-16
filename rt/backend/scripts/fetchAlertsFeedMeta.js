import { fetchFeedMeta } from "./lib/fetchGtfsFeedMeta.js";

const SERVICE_ALERTS_URL = "https://api.opentransportdata.swiss/la/gtfs-sa";

export async function fetchServiceAlertsMeta(apiKey = process.env.OPENTDATA_API_KEY) {
  return fetchFeedMeta(SERVICE_ALERTS_URL, apiKey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const meta = await fetchServiceAlertsMeta();
    process.stdout.write(`${JSON.stringify(meta)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
