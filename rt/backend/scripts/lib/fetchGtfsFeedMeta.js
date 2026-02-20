import GtfsRealtimeBindings from "gtfs-realtime-bindings";

function getAuthHeaders(apiKey) {
  if (!apiKey) {
    throw new Error("OPENTDATA_API_KEY is required");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/octet-stream",
  };
}

function toHeaderTimestamp(feedHeader) {
  if (!feedHeader || feedHeader.timestamp == null) {
    return null;
  }

  const raw = feedHeader.timestamp;
  if (typeof raw === "object" && raw !== null && typeof raw.toNumber === "function") {
    return raw.toNumber();
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

export async function fetchFeedMeta(url, apiKey) {
  const response = await fetch(url, {
    method: "GET",
    headers: getAuthHeaders(apiKey),
    redirect: "follow",
  });

  if (!response.ok) {
    const err = new Error(`Failed to fetch feed ${url}: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const feedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  const feedVersion =
    String(feedMessage?.header?.feedVersion || "").trim() ||
    String(feedMessage?.feedVersion || "").trim() ||
    String(feedMessage?.header?.gtfsRealtimeVersion || "").trim() ||
    "";
  const headerTimestamp = toHeaderTimestamp(feedMessage?.header);

  return { feedVersion, headerTimestamp };
}
