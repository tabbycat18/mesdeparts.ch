import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

import {
  LA_GTFS_RT_TRIP_UPDATES_URL,
  resolveTripUpdatesApiKey,
} from "../src/loaders/fetchTripUpdates.js";
import {
  LA_TRIPUPDATES_FEED_KEY,
  ensureRtCacheMetadataRow,
  getRtCacheMeta,
  getRtCachePayloadSha,
  setRtCachePayloadSha,
  updateRtCacheStatus,
} from "../src/db/rtCache.js";
import { persistParsedTripUpdatesSnapshot } from "../src/rt/persistParsedArtifacts.js";
import {
  touchPollerHeartbeatError,
  touchTripUpdatesHeartbeat,
} from "../src/db/rtPollerHeartbeat.js";

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
const BACKOFF_ERR_MAX_MS = 120_000;
const BACKOFF_NONTRANSIENT_BASE_MS = 120_000;
const BACKOFF_NONTRANSIENT_MAX_MS = 10 * 60_000;
const RT_CACHE_MIN_WRITE_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.RT_CACHE_MIN_WRITE_INTERVAL_MS || "30000")
);
const RT_PARSED_RETENTION_HOURS = Math.max(
  1,
  Number(process.env.RT_PARSED_RETENTION_HOURS || "6")
);
const RT_LOCK_SKIP_WARN_STREAK = Math.max(
  2,
  Number(process.env.RT_POLLER_LOCK_SKIP_WARN_STREAK || "6")
);
const RT_LOCK_SKIP_WARN_AGE_MS = Math.max(
  30_000,
  Number(process.env.RT_POLLER_LOCK_SKIP_STALE_AGE_MS || "90000")
);
const FEED_KEY = LA_TRIPUPDATES_FEED_KEY;
const FEED_WRITE_LOCK_ID = 7_483_921;
const UPSTREAM_URL =
  String(process.env.LA_GTFS_RT_URL || "").trim() || LA_GTFS_RT_TRIP_UPDATES_URL;
const TRANSIENT_ERROR_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
]);

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

function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function classifyPollerError(err) {
  const code = toTextOrNull(err?.code)?.toUpperCase() || null;
  const message = toTextOrNull(err?.message || err) || "unknown_error";
  const lower = message.toLowerCase();
  const transientByCode = !!code && TRANSIENT_ERROR_CODES.has(code);
  const transientByMessage =
    lower.includes("connection timeout") ||
    lower.includes("connection terminated") ||
    lower.includes("database") ||
    lower.includes("could not connect") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout");
  const isTransient = transientByCode || transientByMessage;
  return {
    errorCode: code,
    errorMessage: message,
    errorClass: isTransient ? "transient" : "non_transient",
    transient: isTransient,
  };
}

function decodeTripUpdatesFeed(payloadBytes) {
  const buffer = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes || []);
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
}

export function createLaTripUpdatesPoller({
  token,
  fetchLike = fetch,
  getRtCacheMetaLike = getRtCacheMeta,
  ensureRtCacheMetadataRowLike = ensureRtCacheMetadataRow,
  getRtCachePayloadShaLike = getRtCachePayloadSha,
  setRtCachePayloadShaLike = setRtCachePayloadSha,
  updateRtCacheStatusLike = updateRtCacheStatus,
  persistParsedTripUpdatesSnapshotLike = persistParsedTripUpdatesSnapshot,
  decodeFeedLike = decodeTripUpdatesFeed,
  touchTripUpdatesHeartbeatLike = touchTripUpdatesHeartbeat,
  touchPollerHeartbeatErrorLike = touchPollerHeartbeatError,
  sleepLike = sleep,
  nowLike = () => Date.now(),
  feedKey = FEED_KEY,
  upstreamUrl = UPSTREAM_URL,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  heartbeatEnabled = process.env.RT_POLLER_HEARTBEAT_ENABLED !== "0",
  logLike = (payload) => console.log(JSON.stringify(payload)),
} = {}) {
  if (!token) {
    throw new Error("poller_missing_token");
  }

  let consecutive429Count = 0;
  let consecutiveErrCount = 0;
  let consecutiveNonTransientErrCount = 0;
  let consecutiveWriteLockSkips = 0;
  let lockSkipWarningEmitted = false;
  let lastSuccessfulPollAtMs = null;

  function logLine(
    event,
    { status = null, backoffMs = 0, lastFetchedAgeMs = null, etagPresent = false, extra = {} } = {}
  ) {
    const successAtIso = Number.isFinite(lastSuccessfulPollAtMs)
      ? new Date(lastSuccessfulPollAtMs).toISOString()
      : null;
    const successAgeMs = Number.isFinite(lastSuccessfulPollAtMs)
      ? Math.max(0, Number(nowLike()) - lastSuccessfulPollAtMs)
      : null;
    logLike({
      event,
      nowISO: new Date(nowLike()).toISOString(),
      status,
      backoffMs,
      lastFetchedAgeMs,
      etagPresent: etagPresent === true,
      lastSuccessfulPollAt: successAtIso,
      lastSuccessfulPollAgeMs: successAgeMs,
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

  function backoffNonTransientMs() {
    consecutiveNonTransientErrCount += 1;
    return Math.min(
      BACKOFF_NONTRANSIENT_BASE_MS * 2 ** (consecutiveNonTransientErrCount - 1),
      BACKOFF_NONTRANSIENT_MAX_MS
    );
  }

  function resetBackoffState() {
    consecutive429Count = 0;
    consecutiveErrCount = 0;
    consecutiveNonTransientErrCount = 0;
  }

  function resetWriteLockSkipState() {
    consecutiveWriteLockSkips = 0;
    lockSkipWarningEmitted = false;
  }

  function logWriteLockSkip({ status, lastFetchedAgeMs, etagPresent }) {
    consecutiveWriteLockSkips += 1;
    logLine("poller_write_locked_skip", {
      status,
      backoffMs: 0,
      lastFetchedAgeMs,
      etagPresent,
      extra: {
        consecutiveWriteLockSkips,
        warnStreak: RT_LOCK_SKIP_WARN_STREAK,
        warnAgeMs: RT_LOCK_SKIP_WARN_AGE_MS,
      },
    });
    if (
      !lockSkipWarningEmitted &&
      consecutiveWriteLockSkips >= RT_LOCK_SKIP_WARN_STREAK &&
      Number.isFinite(lastFetchedAgeMs) &&
      lastFetchedAgeMs >= RT_LOCK_SKIP_WARN_AGE_MS
    ) {
      lockSkipWarningEmitted = true;
      logLine("poller_write_lock_contention_warning", {
        status,
        backoffMs: 0,
        lastFetchedAgeMs,
        etagPresent,
        extra: {
          consecutiveWriteLockSkips,
          warnStreak: RT_LOCK_SKIP_WARN_STREAK,
          warnAgeMs: RT_LOCK_SKIP_WARN_AGE_MS,
        },
      });
    }
  }

  async function writeSuccessHeartbeat() {
    if (!heartbeatEnabled) return;
    try {
      await touchTripUpdatesHeartbeatLike({ at: new Date(nowLike()) });
    } catch (err) {
      const classified = classifyPollerError(err);
      logLine("poller_heartbeat_write_failed", {
        status: null,
        backoffMs: 0,
        lastFetchedAgeMs: null,
        etagPresent: false,
        extra: {
          reconnecting: false,
          errorClass: classified.errorClass,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
        },
      });
    }
  }

  async function writeErrorHeartbeat(errorMessage) {
    if (!heartbeatEnabled) return;
    try {
      await touchPollerHeartbeatErrorLike({
        at: new Date(nowLike()),
        errorMessage,
      });
    } catch (err) {
      const classified = classifyPollerError(err);
      logLine("poller_heartbeat_write_failed", {
        status: null,
        backoffMs: 0,
        lastFetchedAgeMs: null,
        etagPresent: false,
        extra: {
          reconnecting: false,
          errorClass: classified.errorClass,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
        },
      });
    }
  }

  async function persistStatusMetadata(cacheMeta, { status, errorText, etag, updateFetchedAt }) {
    const fetchedAtValue = updateFetchedAt
      ? new Date(nowLike())
      : cacheMeta?.fetched_at || new Date(nowLike());
    try {
      if (!cacheMeta) {
        const ensured = await ensureRtCacheMetadataRowLike(feedKey, {
          fetchedAt: fetchedAtValue,
          etag: toTextOrNull(etag),
          last_status: status == null ? null : Number(status),
          last_error: toTextOrNull(errorText),
          writeLockId: FEED_WRITE_LOCK_ID,
        });
        if (ensured?.writeSkippedByLock === true) {
          logLine("poller_db_write_ok", {
            status,
            backoffMs: 0,
            lastFetchedAgeMs: calcAgeMs(fetchedAtValue),
            etagPresent: !!toTextOrNull(etag),
            extra: { lockSkipped: true, updateFetchedAt: updateFetchedAt === true },
          });
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
      logLine("poller_db_write_ok", {
        status,
        backoffMs: 0,
        lastFetchedAgeMs: calcAgeMs(fetchedAtValue),
        etagPresent: !!toTextOrNull(etag) || !!toTextOrNull(cacheMeta?.etag),
        extra: {
          lockSkipped: writeResult?.writeSkippedByLock === true,
          updateFetchedAt: updateFetchedAt === true,
        },
      });
      return {
        updated: writeResult?.writeSkippedByLock !== true,
        lockSkipped: writeResult?.writeSkippedByLock === true,
      };
    } catch (err) {
      const classified = classifyPollerError(err);
      logLine("poller_db_write_failed", {
        status,
        backoffMs: 0,
        lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
        etagPresent: !!toTextOrNull(etag) || !!toTextOrNull(cacheMeta?.etag),
        extra: {
          reconnecting: true,
          errorClass: classified.errorClass,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
        },
      });
      throw err;
    }
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
    let txLifecycle = {
      transactionClientUsed: false,
      transactionCommitted: false,
      clientReleased: false,
    };
    const returnWithTxDiagnostics = (waitMs) => {
      logLine("poller_tx_client_lifecycle", {
        status: null,
        backoffMs: 0,
        lastFetchedAgeMs: null,
        etagPresent: false,
        extra: txLifecycle,
      });
      return waitMs;
    };

    const cacheMeta = await getRtCacheMetaLike(feedKey);
    const storedPayloadSha = await getRtCachePayloadShaLike(feedKey).catch(() => null);
    const currentAgeMs = calcAgeMs(cacheMeta?.fetched_at);
    const currentEtag = toTextOrNull(cacheMeta?.etag);

    logLine("poller_tick", {
      status: cacheMeta?.last_status ?? null,
      backoffMs: 0,
      lastFetchedAgeMs: currentAgeMs,
      etagPresent: !!currentEtag,
    });

    let response;
    try {
      response = await fetchTripUpdatesBytes({ etag: currentEtag });
    } catch (err) {
      const classified = classifyPollerError(err);
      const backoffMs = backoffErrMs();
      consecutive429Count = 0;
      resetWriteLockSkipState();
      await persistStatusMetadata(cacheMeta, {
        status: null,
        errorText: `network_error ${String(err?.message || err)}`,
        etag: currentEtag,
        updateFetchedAt: false,
      });
      await writeErrorHeartbeat(
        `[tripupdates] fetch_failed ${classified.errorCode || ""} ${classified.errorMessage}`.trim()
      );
      logLine("poller_fetch_error_backoff", {
        status: null,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
        etagPresent: !!currentEtag,
        extra: {
          reconnecting: true,
          errorClass: classified.errorClass,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
        },
      });
      return returnWithTxDiagnostics(backoffMs);
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
            logWriteLockSkip({
              status: 200,
              lastFetchedAgeMs: currentAgeMs,
              etagPresent: !!responseEtag,
            });
            return returnWithTxDiagnostics(INTERVAL_MS);
          }
        }
        lastSuccessfulPollAtMs = Number(nowLike());
        resetBackoffState();
        resetWriteLockSkipState();
        logLine("poller_skip_write_unchanged", {
          status: 200,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return returnWithTxDiagnostics(INTERVAL_MS);
      }
      let parsedWrite;
      try {
        const decodedFeed = decodeFeedLike(payloadBytes);
        parsedWrite = await persistParsedTripUpdatesSnapshotLike(decodedFeed, {
          writeLockId: FEED_WRITE_LOCK_ID,
          retentionHours: RT_PARSED_RETENTION_HOURS,
        });
        txLifecycle = {
          transactionClientUsed:
            parsedWrite?.txDiagnostics?.transactionClientUsed === true,
          transactionCommitted:
            parsedWrite?.txDiagnostics?.transactionCommitted === true,
          clientReleased:
            parsedWrite?.txDiagnostics?.clientReleased === true,
        };
      } catch (err) {
        txLifecycle = {
          transactionClientUsed:
            err?.txDiagnostics?.transactionClientUsed === true,
          transactionCommitted:
            err?.txDiagnostics?.transactionCommitted === true,
          clientReleased:
            err?.txDiagnostics?.clientReleased === true,
        };
        const classified = classifyPollerError(err);
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        resetWriteLockSkipState();
        await persistStatusMetadata(cacheMeta, {
          status: 200,
          errorText: `parse_error ${String(err?.message || err)}`,
          etag: responseEtag,
          updateFetchedAt: false,
        });
        await writeErrorHeartbeat(
          `[tripupdates] parse_or_db_failed ${classified.errorCode || ""} ${classified.errorMessage}`.trim()
        );
        logLine("poller_fetch_error_backoff", {
          status: 200,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
          etagPresent: !!responseEtag,
          extra: {
            reconnecting: true,
            errorClass: classified.errorClass,
            errorCode: classified.errorCode,
            errorMessage: classified.errorMessage,
          },
        });
        return returnWithTxDiagnostics(backoffMs);
      }

      if (parsedWrite?.writeSkippedByLock === true) {
        resetBackoffState();
        logWriteLockSkip({
          status: 200,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return returnWithTxDiagnostics(INTERVAL_MS);
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
      await writeSuccessHeartbeat();
      lastSuccessfulPollAtMs = Number(nowLike());
      resetBackoffState();
      resetWriteLockSkipState();
      logLine("poller_fetch_200", {
        status: 200,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
        extra: {
          retentionHours: RT_PARSED_RETENTION_HOURS,
          parsedTripRowsInserted: Number(parsedWrite?.tripRows || 0),
          parsedStopRowsInserted: Number(parsedWrite?.stopRows || 0),
          parsedTripRowsDeletedBySnapshot: Number(parsedWrite?.deletedBySnapshotTripRows || 0),
          parsedStopRowsDeletedBySnapshot: Number(parsedWrite?.deletedBySnapshotStopRows || 0),
          parsedTripRowsDeletedByRetention: Number(parsedWrite?.deletedByRetentionTripRows || 0),
          parsedStopRowsDeletedByRetention: Number(parsedWrite?.deletedByRetentionStopRows || 0),
        },
      });
      return returnWithTxDiagnostics(INTERVAL_MS);
    }

    if (response.status === 304) {
      if (Number.isFinite(currentAgeMs) && currentAgeMs < RT_CACHE_MIN_WRITE_INTERVAL_MS) {
        resetBackoffState();
        resetWriteLockSkipState();
        logLine("poller_fetch_304_skip_write", {
          status: 304,
          backoffMs: 0,
          lastFetchedAgeMs: currentAgeMs,
          etagPresent: !!responseEtag,
        });
        return returnWithTxDiagnostics(INTERVAL_MS);
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
          logWriteLockSkip({
            status: 304,
            lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
            etagPresent: !!responseEtag,
          });
          return returnWithTxDiagnostics(INTERVAL_MS);
        }
        const backoffMs = backoffErrMs();
        consecutive429Count = 0;
        logLine("poller_fetch_error_backoff", {
          status: 304,
          backoffMs,
          lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
          etagPresent: !!responseEtag,
        });
        return returnWithTxDiagnostics(backoffMs);
      }
      resetBackoffState();
      resetWriteLockSkipState();
      lastSuccessfulPollAtMs = Number(nowLike());
      logLine("poller_fetch_304", {
        status: 304,
        backoffMs: 0,
        lastFetchedAgeMs: 0,
        etagPresent: !!responseEtag,
      });
      return returnWithTxDiagnostics(INTERVAL_MS);
    }

    const bodySnippet = (await response.text().catch(() => "")).slice(0, 200);

    if (response.status === 429) {
      const backoffMs = backoff429Ms();
      consecutiveErrCount = 0;
      resetWriteLockSkipState();
      await persistStatusMetadata(cacheMeta, {
        status: 429,
        errorText: toTextOrNull(bodySnippet) || "Rate Limit Exceeded",
        etag: responseEtag,
        updateFetchedAt: false,
      });
      await writeErrorHeartbeat(
        `[tripupdates] upstream_429 ${toTextOrNull(bodySnippet) || "Rate Limit Exceeded"}`
      );
      logLine("poller_fetch_429_backoff", {
        status: 429,
        backoffMs,
        lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
        etagPresent: !!responseEtag,
      });
      return returnWithTxDiagnostics(backoffMs);
    }

    const backoffMs = backoffErrMs();
    consecutive429Count = 0;
    resetWriteLockSkipState();
    await persistStatusMetadata(cacheMeta, {
      status: response.status,
      errorText: toTextOrNull(bodySnippet) || `HTTP ${response.status}`,
      etag: responseEtag,
      updateFetchedAt: false,
    });
    await writeErrorHeartbeat(
      `[tripupdates] upstream_error ${response.status} ${toTextOrNull(bodySnippet) || ""}`.trim()
    );
    logLine("poller_fetch_error_backoff", {
      status: response.status,
      backoffMs,
      lastFetchedAgeMs: calcAgeMs(cacheMeta?.fetched_at),
      etagPresent: !!responseEtag,
    });
    return returnWithTxDiagnostics(backoffMs);
  }

  async function runForever() {
    for (;;) {
      const loopStartedMs = Number(nowLike());
      let waitMs = INTERVAL_MS;
      try {
        const waitMsRaw = await tick();
        waitMs = Number.isFinite(Number(waitMsRaw))
          ? Math.max(0, Number(waitMsRaw))
          : INTERVAL_MS;
      } catch (err) {
        const classified = classifyPollerError(err);
        const backoffMs = classified.transient ? backoffErrMs() : backoffNonTransientMs();
        consecutive429Count = 0;
        resetWriteLockSkipState();
        await writeErrorHeartbeat(
          `[tripupdates] tick_failed ${classified.errorCode || ""} ${classified.errorMessage}`.trim()
        );
        logLine("poller_tick_failed_backoff", {
          status: null,
          backoffMs,
          lastFetchedAgeMs: null,
          etagPresent: false,
          extra: {
            reconnecting: true,
            errorClass: classified.errorClass,
            errorCode: classified.errorCode,
            errorMessage: classified.errorMessage,
          },
        });
        waitMs = backoffMs;
      }
      const elapsedMs = Number.isFinite(loopStartedMs)
        ? Math.max(0, Number(nowLike()) - loopStartedMs)
        : 0;
      const sleepMs = Math.max(0, waitMs - elapsedMs);
      await sleepLike(sleepMs);
    }
  }

  return {
    tick,
    runForever,
    _getStateForTests: () => ({
      consecutive429Count,
      consecutiveErrCount,
      consecutiveNonTransientErrCount,
      consecutiveWriteLockSkips,
      lockSkipWarningEmitted,
      lastSuccessfulPollAtMs,
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
