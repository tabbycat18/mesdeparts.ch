const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_CACHE_TAG = "md-stationboard";
const DEFAULT_PURGE_TIMEOUT_MS = 2_500;

let lastPurgeAtMs = 0;

function text(value) {
  return String(value || "").trim();
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.trunc(n));
}

function normalizeMode(raw) {
  const mode = text(raw).toLowerCase();
  if (!mode || mode === "0" || mode === "off" || mode === "disabled" || mode === "none") {
    return "off";
  }
  if (mode === "tags" || mode === "tag") return "tags";
  if (mode === "everything" || mode === "purge_everything") return "everything";
  return "off";
}

function parseCsv(raw) {
  return text(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function purgeCloudflareStationboardCache({
  feedKey = null,
  reason = "rt_changed_write",
  fetchLike = fetch,
} = {}) {
  const mode = normalizeMode(process.env.CF_STATIONBOARD_PURGE_MODE);
  if (mode === "off") {
    return { attempted: false, skipped: "mode_off" };
  }

  const zoneId = text(process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID);
  const token = text(
    process.env.CLOUDFLARE_API_TOKEN ||
      process.env.CF_API_TOKEN ||
      process.env.CLOUDFLARE_PURGE_API_TOKEN
  );
  if (!zoneId || !token) {
    return { attempted: false, skipped: "missing_credentials", mode };
  }

  const minIntervalMs = toPositiveInt(process.env.CF_STATIONBOARD_PURGE_MIN_INTERVAL_MS, 0);
  const nowMs = Date.now();
  if (minIntervalMs > 0 && nowMs - lastPurgeAtMs < minIntervalMs) {
    return {
      attempted: false,
      skipped: "cooldown",
      mode,
      minIntervalMs,
      sinceLastMs: nowMs - lastPurgeAtMs,
    };
  }

  let payload;
  if (mode === "everything") {
    payload = { purge_everything: true };
  } else {
    const tags = parseCsv(process.env.CF_STATIONBOARD_PURGE_TAGS || DEFAULT_CACHE_TAG);
    if (!tags.length) {
      return { attempted: false, skipped: "missing_tags", mode };
    }
    payload = { tags };
  }

  const apiBase = text(process.env.CF_API_BASE_URL) || DEFAULT_API_BASE;
  const timeoutMs = toPositiveInt(process.env.CF_STATIONBOARD_PURGE_TIMEOUT_MS, DEFAULT_PURGE_TIMEOUT_MS);
  const endpoint = `${apiBase}/zones/${encodeURIComponent(zoneId)}/purge_cache`;
  const startedAtMs = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await safeJson(response);
    const ok = response.ok && body?.success === true;
    if (ok) {
      lastPurgeAtMs = Date.now();
    }
    return {
      attempted: true,
      ok,
      mode,
      status: response.status,
      feedKey: text(feedKey) || null,
      reason: text(reason) || "rt_changed_write",
      elapsedMs: Date.now() - startedAtMs,
      errors: Array.isArray(body?.errors) ? body.errors : [],
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      attempted: true,
      ok: false,
      mode,
      status: null,
      feedKey: text(feedKey) || null,
      reason: text(reason) || "rt_changed_write",
      elapsedMs: Date.now() - startedAtMs,
      errorCode: text(error?.name) || (aborted ? "AbortError" : null),
      errorMessage: text(error?.message || error) || (aborted ? "request_aborted" : "unknown_error"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
