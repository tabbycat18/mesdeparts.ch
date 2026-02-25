import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  LA_GTFS_RT_TRIP_UPDATES_URL,
  resolveTripUpdatesApiKey,
} from "../src/loaders/fetchTripUpdates.js";
import {
  LA_TRIPUPDATES_FEED_KEY,
  getRtCache,
  getRtCachePayloadSha,
  setRtCachePayloadSha,
  updateRtCacheStatus,
  upsertRtCache,
} from "../src/db/rtCache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.GTFS_RT_POLL_INTERVAL_MS || "15000")
);
const FETCH_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.GTFS_RT_FETCH_TIMEOUT_MS || "8000")
);
const BACKOFF_429_BASE_MS = 60_000;
const BACKOFF_429_MAX_MS = 10 * 60_000;
const BACKOFF_ERR_BASE_MS = 15_000;
const BACKOFF_ERR_MAX_MS = 2 * 60_000;
const RT_CACHE_MIN_WRITE_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.RT_CACHE_MIN_WRITE_INTERVAL_MS || "30000")
);
const FEED_KEY = LA_TRIPUPDATES_FEED_KEY;
const FEED_WRITE_LOCK_ID = 7_483_921;
const UPSTREAM_URL =
  String(process.env.LA_GTFS_RT_URL || "").trim() || LA_GTFS_RT_TRIP_UPDATES_URL;

function loadDotEnvIfNeeded() {
  const hasToken =
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

function shouldSkipUnchangedPayloadWrite(cacheRow, payloadBytes, currentAgeMs) {
  if (!cacheRow?.payloadBytes) return false;
  const incomingHash = payloadSha256Hex(payloadBytes);
  const existingHash = payloadSha256Hex(cacheRow.payloadBytes);
  if (!incomingHash || !existingHash) return false;
  return incomingHash === existingHash;
}


function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export function createLaTripUpdatesPoller({
  token,
  fetchLike = fetch,
  getRtCacheLike = getRtCache,
  getRtCachePayloadShaLike = getRtCachePayloadSha,
  setRtCachePayloadShaLike = setRtCachePayloadSha,
  updateRtCacheStatusLike = updateRtCacheStatus,
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
    if (!cacheRow?.payloadBytes) return { updated: false, lockSkipped: false };
    const writeResult = await updateRtCacheStatusLike(
      feedKey,
      updateFetchedAt ? new Date(nowLike()) : cacheRow.fetched_at,
      toTextOrNull(etag) || toTextOrNull(cacheRow.etag),
      status == null ? null : Number(status),
      toTextOrNull(errorText),
      { writeLockId: FEED_WRITE_LOCK_ID }
    );
    return {
      updated: writeResult?.writeSkippedByLock !== true,
      lockSkipped: writeResult?.writeSkippedByLock === true,
    };
  }

  async function fetchTripUpdatesBytes({ etag }) {
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
    const storedPayloadSha = await getRtCachePayloadShaLike(feedKey).catch(() => null);
    const currentAgeMs = calcAgeMs(cacheRow?.fetched_at);
    const currentEtag = toTextOrNull(cacheRow?.etag);

    logLine("poller_tick", {
      status: cacheRow?.last_status ?? null,
      backoffMs: 0,
      lastFetchedAgeMs: currentAgeMs,
      etagPresent: !!currentEtag,
    });

    let response;
    try {
      response = await fetchTripUpdatesBytes({ etag: currentEtag });
    } catch (err) {
      const backoffMs = backoffErrMs();
      consecutive429Count = 0;
      await persistStatusKeepingPayload(cacheRow, {
        status: null,
        errorText: `network_error ${String(err?.message || err)}`,
        etag: currentEtag,
        updateFetchedAt: false,
      });
      logLine("poller_fetch_error_backoff", {
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
      const incomingPayloadSha = payloadSha256Hex(payloadBytes);
      const existingPayloadSha =
        toTextOrNull(storedPayloadSha) || payloadSha256Hex(cacheRow?.payloadBytes);
      const payloadUnchanged =
        !!incomingPayloadSha &&
        !!existingPayloadSha &&
        incomingPayloadSha === existingPayloadSha;

      if (payloadUnchanged || shouldSkipUnchangedPayloadWrite(cacheRow, payloadBytes, currentAgeMs)) {
        if (Number.isFinite(currentAgeMs) && currentAgeMs >= RT_CACHE_MIN_WRITE_INTERVAL_MS) {
          const statusUpdate = await updateRtCacheStatusLike(
            feedKey,
            new Date(nowLike()),
            responseEtag,
            200,
            null,
            { writeLockId: FEED_WRITE_LOCK_ID }
          );
          if (statusUpdate?.writeSkippedByLock === true) {
            resetBackoffState();
            logLine("poller_write_locked_skip", {
              status: 200,
              backoffMs: 0,
              lastFetchedAgeMs: currentAgeMs,
              etagPresent: !!responseEtag,
            });
            return INTERVAL_MS;
          }
        }
        resetBackoffState();
        logLine("poller_skip_write_unchanged", {
          status: 200,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return INTERVAL_MS;
      }
      const writeResult = await upsertRtCacheLike(
        feedKey,
        payloadBytes,
        new Date(nowLike()),
        responseEtag,
        200,
        null,
        { writeLockId: FEED_WRITE_LOCK_ID }
      );
      if (writeResult?.writeSkippedByLock === true) {
        resetBackoffState();
        logLine("poller_write_locked_skip", {
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
      resetBackoffState();
      logLine("poller_fetch_200", {
        status: 200,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
      });
      return INTERVAL_MS;
    }

    if (response.status === 304) {
      if (Number.isFinite(currentAgeMs) && currentAgeMs < RT_CACHE_MIN_WRITE_INTERVAL_MS) {
        resetBackoffState();
        logLine("poller_fetch_304_skip_write", {
          status: 304,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return INTERVAL_MS;
      }

      const persisted = await persistStatusKeepingPayload(cacheRow, {
        status: 304,
        errorText: null,
        etag: responseEtag,
        updateFetchedAt: true,
      });
      if (!persisted.updated) {
        if (persisted.lockSkipped) {
          resetBackoffState();
          logLine("poller_write_locked_skip", {
            status: 304,
            backoffMs: 0,
            lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
            etagPresent: !!responseEtag,
          });
          return INTERVAL_MS;
        }
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        logLine("poller_fetch_error_backoff", {
          status: 304,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheRow?.fetched_at),
          etagPresent: !!responseEtag,
        });
        return backoffMs;
      }
      resetBackoffState();
      logLine("poller_fetch_304", {
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
      logLine("poller_fetch_429_backoff", {
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
    logLine("poller_fetch_error_backoff", {
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
  const token = resolveTripUpdatesApiKey();
  if (!token) {
    throw new Error(
      "Missing API token. Set GTFS_RT_TOKEN, OPENDATA_SWISS_TOKEN, or OPENTDATA_GTFS_RT_KEY."
    );
  }
  const poller = createLaTripUpdatesPoller({ token });
  await poller.runForever();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(String(err?.message || err));
    process.exit(1);
  });
}
