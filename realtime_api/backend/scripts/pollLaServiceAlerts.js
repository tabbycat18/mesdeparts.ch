import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

import {
  LA_GTFS_RT_SERVICE_ALERTS_URL,
  resolveServiceAlertsApiKey,
} from "../src/loaders/fetchServiceAlerts.js";
import {
  LA_SERVICEALERTS_FEED_KEY,
  ensureRtCacheMetadataRow,
  getRtCacheMeta,
  getRtCachePayloadSha,
  setRtCachePayloadSha,
  updateRtCacheStatus,
} from "../src/db/rtCache.js";
import { persistParsedServiceAlertsSnapshot } from "../src/rt/persistParsedArtifacts.js";

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
const RT_CACHE_MIN_WRITE_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.RT_CACHE_MIN_WRITE_INTERVAL_MS || "30000")
);
const RT_PARSED_RETENTION_HOURS = Math.max(
  1,
  Number(process.env.RT_PARSED_RETENTION_HOURS || "6")
);
const FEED_KEY = LA_SERVICEALERTS_FEED_KEY;
const FEED_WRITE_LOCK_ID = 7_483_922;
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

function payloadSha256Hex(payloadBytes) {
  const payloadBuffer = Buffer.isBuffer(payloadBytes)
    ? payloadBytes
    : Buffer.from(payloadBytes || []);
  if (!payloadBuffer.length) return null;
  return createHash("sha256").update(payloadBuffer).digest("hex");
}

function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function decodeServiceAlertsFeed(payloadBytes) {
  const buffer = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes || []);
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
}

export function createLaServiceAlertsPoller({
  token,
  fetchLike = fetch,
  getRtCacheMetaLike = getRtCacheMeta,
  ensureRtCacheMetadataRowLike = ensureRtCacheMetadataRow,
  getRtCachePayloadShaLike = getRtCachePayloadSha,
  setRtCachePayloadShaLike = setRtCachePayloadSha,
  updateRtCacheStatusLike = updateRtCacheStatus,
  persistParsedServiceAlertsSnapshotLike = persistParsedServiceAlertsSnapshot,
  decodeFeedLike = decodeServiceAlertsFeed,
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

  function logLine(
    event,
    { status = null, backoffMs = 0, lastFetchedAgeMs = null, etagPresent = false, extra = {} } = {}
  ) {
    logLike({
      event,
      nowISO: new Date(nowLike()).toISOString(),
      status,
      backoffMs,
      lastFetchedAgeMs,
      etagPresent: etagPresent === true,
      ...extra,
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

  async function persistStatusMetadata(cacheMeta, { status, errorText, etag, updateFetchedAt }) {
    const fetchedAtValue = updateFetchedAt ? new Date(nowLike()) : cacheMeta?.fetched_at || new Date(nowLike());
    if (!cacheMeta) {
      const ensured = await ensureRtCacheMetadataRowLike(feedKey, {
        fetchedAt: fetchedAtValue,
        etag: toTextOrNull(etag),
        last_status: status == null ? null : Number(status),
        last_error: toTextOrNull(errorText),
        writeLockId: FEED_WRITE_LOCK_ID,
      });
      if (ensured?.writeSkippedByLock === true) {
        return { updated: false, lockSkipped: true };
      }
    }
    const writeResult = await updateRtCacheStatusLike(
      feedKey,
      fetchedAtValue,
      toTextOrNull(etag) || toTextOrNull(cacheMeta?.etag),
      status == null ? null : Number(status),
      toTextOrNull(errorText),
      { writeLockId: FEED_WRITE_LOCK_ID }
    );
    return {
      updated: writeResult?.writeSkippedByLock !== true,
      lockSkipped: writeResult?.writeSkippedByLock === true,
    };
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
    const cacheMeta = await getRtCacheMetaLike(feedKey);
    const storedPayloadSha = await getRtCachePayloadShaLike(feedKey).catch(() => null);
    const currentAgeMs = calcAgeMs(cacheMeta?.fetched_at);
    const currentEtag = toTextOrNull(cacheMeta?.etag);

    logLine("service_alerts_poller_tick", {
      status: cacheMeta?.last_status ?? null,
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
      await persistStatusMetadata(cacheMeta, {
        status: null,
        errorText: `network_error ${String(err?.message || err)}`,
        etag: currentEtag,
        updateFetchedAt: false,
      });
      logLine("service_alerts_poller_error_backoff", {
        status: null,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
        etagPresent: !!currentEtag,
      });
      return backoffMs;
    }

    const responseEtag = toTextOrNull(response.headers.get("etag")) || currentEtag;

    if (response.status === 200) {
      const payloadBytes = Buffer.from(await response.arrayBuffer());
      const incomingPayloadSha = payloadSha256Hex(payloadBytes);
      const existingPayloadSha = toTextOrNull(storedPayloadSha);
      const payloadUnchanged =
        !!incomingPayloadSha &&
        !!existingPayloadSha &&
        incomingPayloadSha === existingPayloadSha;

      if (payloadUnchanged) {
        if (Number.isFinite(currentAgeMs) && currentAgeMs >= RT_CACHE_MIN_WRITE_INTERVAL_MS) {
          const statusPersisted = await persistStatusMetadata(cacheMeta, {
            status: 200,
            errorText: null,
            etag: responseEtag,
            updateFetchedAt: true,
          });
          if (statusPersisted?.lockSkipped) {
            resetBackoffState();
            logLine("service_alerts_poller_write_locked_skip", {
              status: 200,
              backoffMs: 0,
              lastFetchedAgeMs: currentAgeMs,
              etagPresent: !!responseEtag,
            });
            return INTERVAL_MS;
          }
        }
        resetBackoffState();
        logLine("service_alerts_poller_skip_write_unchanged", {
          status: 200,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return INTERVAL_MS;
      }
      let parsedWrite;
      try {
        const decodedFeed = decodeFeedLike(payloadBytes);
        parsedWrite = await persistParsedServiceAlertsSnapshotLike(decodedFeed, {
          writeLockId: FEED_WRITE_LOCK_ID,
          retentionHours: RT_PARSED_RETENTION_HOURS,
        });
      } catch (err) {
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        await persistStatusMetadata(cacheMeta, {
          status: 200,
          errorText: `parse_error ${String(err?.message || err)}`,
          etag: responseEtag,
          updateFetchedAt: false,
        });
        logLine("service_alerts_poller_error_backoff", {
          status: 200,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
          etagPresent: !!responseEtag,
        });
        return backoffMs;
      }

      if (parsedWrite?.writeSkippedByLock === true) {
        resetBackoffState();
        logLine("service_alerts_poller_write_locked_skip", {
          status: 200,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return INTERVAL_MS;
      }
      if (incomingPayloadSha) {
        await setRtCachePayloadShaLike(feedKey, incomingPayloadSha, {
          writeLockId: FEED_WRITE_LOCK_ID,
        }).catch(() => {});
      }
      await persistStatusMetadata(cacheMeta, {
        status: 200,
        errorText: null,
        etag: responseEtag,
        updateFetchedAt: true,
      });
      resetBackoffState();
      logLine("service_alerts_poller_fetch_200", {
        status: 200,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
        extra: {
          retentionHours: RT_PARSED_RETENTION_HOURS,
          parsedAlertRowsInserted: Number(parsedWrite?.alertRows || 0),
          parsedAlertRowsDeletedBySnapshot: Number(parsedWrite?.deletedBySnapshotAlertRows || 0),
          parsedAlertRowsDeletedByRetention: Number(parsedWrite?.deletedByRetentionAlertRows || 0),
        },
      });
      return INTERVAL_MS;
    }

    if (response.status === 304) {
      if (Number.isFinite(currentAgeMs) && currentAgeMs < RT_CACHE_MIN_WRITE_INTERVAL_MS) {
        resetBackoffState();
        logLine("service_alerts_poller_fetch_304_skip_write", {
          status: 304,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return INTERVAL_MS;
      }

      const persisted = await persistStatusMetadata(cacheMeta, {
        status: 304,
        errorText: null,
        etag: responseEtag,
        updateFetchedAt: true,
      });
      if (!persisted.updated) {
        if (persisted.lockSkipped) {
          resetBackoffState();
          logLine("service_alerts_poller_write_locked_skip", {
            status: 304,
            backoffMs: 0,
            lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
            etagPresent: !!responseEtag,
          });
          return INTERVAL_MS;
        }
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        logLine("service_alerts_poller_error_backoff", {
          status: 304,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
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
      await persistStatusMetadata(cacheMeta, {
        status: 429,
        errorText: toTextOrNull(bodySnippet) || "Rate Limit Exceeded",
        etag: responseEtag,
        updateFetchedAt: false,
      });
      logLine("service_alerts_poller_fetch_429_backoff", {
        status: 429,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
        etagPresent: !!responseEtag,
      });
      return backoffMs;
    }

    const backoffMs = backoffErrMs();
    consecutive429Count = 0;
    await persistStatusMetadata(cacheMeta, {
      status: response.status,
      errorText: toTextOrNull(bodySnippet) || `HTTP ${response.status}`,
      etag: responseEtag,
      updateFetchedAt: false,
    });
    logLine("service_alerts_poller_error_backoff", {
      status: response.status,
      backoffMs,
      lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
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
