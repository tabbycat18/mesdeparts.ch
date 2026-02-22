import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LA_GTFS_RT_SERVICE_ALERTS_URL,
  resolveServiceAlertsApiKey,
} from "../src/loaders/fetchServiceAlerts.js";
import {
  LA_SERVICEALERTS_FEED_KEY,
  getRtCache,
  upsertRtCache,
} from "../src/db/rtCache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.GTFS_SA_POLL_INTERVAL_MS || "60000")
);
const FETCH_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.GTFS_SA_FETCH_TIMEOUT_MS || process.env.GTFS_RT_FETCH_TIMEOUT_MS || "8000")
);
const BACKOFF_429_BASE_MS = 60_000;
const BACKOFF_429_MAX_MS = 10 * 60_000;
const BACKOFF_ERR_BASE_MS = 15_000;
const BACKOFF_ERR_MAX_MS = 2 * 60_000;
const FEED_KEY = LA_SERVICEALERTS_FEED_KEY;
const UPSTREAM_URL =
  String(process.env.LA_GTFS_SA_URL || "").trim() || LA_GTFS_RT_SERVICE_ALERTS_URL;

function loadDotEnvIfNeeded() {
  const hasToken =
    !!process.env.OPENTDATA_GTFS_SA_KEY ||
    !!process.env.OPENTDATA_API_KEY ||
    !!process.env.GTFS_RT_TOKEN ||
    !!process.env.OPENDATA_SWISS_TOKEN ||
    !!process.env.OPENTDATA_GTFS_RT_KEY;
  if (hasToken) return;

  const candidates = [
    path.resolve(__dirname, "../.env"),
    path.resolve(process.cwd(), ".env"),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    if (
      process.env.OPENTDATA_GTFS_SA_KEY ||
      process.env.OPENTDATA_API_KEY ||
      process.env.GTFS_RT_TOKEN ||
      process.env.OPENDATA_SWISS_TOKEN ||
      process.env.OPENTDATA_GTFS_RT_KEY
    ) {
      return;
    }
  }
}

function toTextOrNull(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function calcAgeMs(fetchedAt) {
  if (!fetchedAt) return null;
  const ms = new Date(fetchedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Date.now() - ms);
}

function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export function createLaServiceAlertsPoller({
  token,
  fetchLike = fetch,
  getRtCacheLike = getRtCache,
  upsertRtCacheLike = upsertRtCache,
  sleepLike = sleep,
  nowLike = () => Date.now(),
  feedKey = FEED_KEY,
  upstreamUrl = UPSTREAM_URL,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  logLike = (payload) => console.log(JSON.stringify(payload)),
} = {}) {
  if (!token) {
    throw new Error("poller_missing_token");
  }

  let consecutive429Count = 0;
  let consecutiveErrCount = 0;

  function logLine(event, { status = null, backoffMs = 0, lastFetchedAgeMs = null, etagPresent = false } = {}) {
    logLike({
      event,
      nowISO: new Date(nowLike()).toISOString(),
      status,
      backoffMs,
      lastFetchedAgeMs,
      etagPresent: etagPresent === true,
    });
  }

  function backoff429Ms() {
    consecutive429Count += 1;
    return Math.min(
      BACKOFF_429_BASE_MS * 2 ** (consecutive429Count - 1),
      BACKOFF_429_MAX_MS
    );
  }

  function backoffErrMs() {
    consecutiveErrCount += 1;
    return Math.min(
      BACKOFF_ERR_BASE_MS * 2 ** (consecutiveErrCount - 1),
      BACKOFF_ERR_MAX_MS
    );
  }

  function resetBackoffState() {
    consecutive429Count = 0;
    consecutiveErrCount = 0;
  }

  async function persistStatusKeepingPayload(cacheRow, { status, errorText, etag, updateFetchedAt }) {
    if (!cacheRow?.payloadBytes) return false;
    await upsertRtCacheLike(
      feedKey,
      cacheRow.payloadBytes,
      updateFetchedAt ? new Date(nowLike()) : cacheRow.fetched_at,
      toTextOrNull(etag) || toTextOrNull(cacheRow.etag),
      status == null ? null : Number(status),
      toTextOrNull(errorText)
    );
    return true;
  }

  async function fetchServiceAlertsBytes({ etag }) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetchLike(upstreamUrl, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function tick() {
    const cacheRow = await getRtCacheLike(feedKey);
    const currentAgeMs = calcAgeMs(cacheRow?.fetched_at);
    const currentEtag = toTextOrNull(cacheRow?.etag);

    logLine("service_alerts_poller_tick", {
      status: cacheRow?.last_status ?? null,
      backoffMs: 0,
      lastFetchedAgeMs: currentAgeMs,
      etagPresent: !!currentEtag,
    });

    let response;
    try {
      response = await fetchServiceAlertsBytes({ etag: currentEtag });
    } catch (err) {
      const backoffMs = backoffErrMs();
      consecutive429Count = 0;
      await persistStatusKeepingPayload(cacheRow, {
        status: null,
        errorText: `network_error ${String(err?.message || err)}`,
        etag: currentEtag,
        updateFetchedAt: false,
      });
      logLine("service_alerts_poller_error_backoff", {
        status: null,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
        etagPresent: !!currentEtag,
      });
      return backoffMs;
    }

    const responseEtag = toTextOrNull(response.headers.get("etag")) || currentEtag;

    if (response.status === 200) {
      const payloadBytes = Buffer.from(await response.arrayBuffer());
      await upsertRtCacheLike(feedKey, payloadBytes, new Date(nowLike()), responseEtag, 200, null);
      resetBackoffState();
      logLine("service_alerts_poller_fetch_200", {
        status: 200,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
      });
      return INTERVAL_MS;
    }

    if (response.status === 304) {
      const updated = await persistStatusKeepingPayload(cacheRow, {
        status: 304,
        errorText: null,
        etag: responseEtag,
        updateFetchedAt: true,
      });
      if (!updated) {
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        logLine("service_alerts_poller_error_backoff", {
          status: 304,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
          etagPresent: !!responseEtag,
        });
        return backoffMs;
      }
      resetBackoffState();
      logLine("service_alerts_poller_fetch_304", {
        status: 304,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
      });
      return INTERVAL_MS;
    }

    const bodySnippet = (await response.text().catch(() => "")).slice(0, 200);

    if (response.status === 429) {
      const backoffMs = backoff429Ms();
      consecutiveErrCount = 0;
      await persistStatusKeepingPayload(cacheRow, {
        status: 429,
        errorText: toTextOrNull(bodySnippet) || "Rate Limit Exceeded",
        etag: responseEtag,
        updateFetchedAt: false,
      });
      logLine("service_alerts_poller_fetch_429_backoff", {
        status: 429,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
        etagPresent: !!responseEtag,
      });
      return backoffMs;
    }

    const backoffMs = backoffErrMs();
    consecutive429Count = 0;
    await persistStatusKeepingPayload(cacheRow, {
      status: response.status,
      errorText: toTextOrNull(bodySnippet) || `HTTP ${response.status}`,
      etag: responseEtag,
      updateFetchedAt: false,
    });
    logLine("service_alerts_poller_error_backoff", {
      status: response.status,
      backoffMs,
      lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
      etagPresent: !!responseEtag,
    });
    return backoffMs;
  }

  async function runForever() {
    for (;;) {
      const waitMs = await tick();
      await sleepLike(waitMs);
    }
  }

  return {
    tick,
    runForever,
    _getStateForTests: () => ({
      consecutive429Count,
      consecutiveErrCount,
    }),
  };
}

async function main() {
  loadDotEnvIfNeeded();
  const token = resolveServiceAlertsApiKey();
  if (!token) {
    throw new Error(
      "Missing API token. Set OPENTDATA_GTFS_SA_KEY, OPENTDATA_API_KEY, GTFS_RT_TOKEN, or OPENDATA_SWISS_TOKEN."
    );
  }
  const poller = createLaServiceAlertsPoller({ token });
  await poller.runForever();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(String(err?.message || err));
    process.exit(1);
  });
}
