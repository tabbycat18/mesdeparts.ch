/**
 * Testable route handler factory for /api/stops/search.
 *
 * All external dependencies are injected so the handler can be tested
 * without a real DB or HTTP server (same pattern as stationboardRoute.js).
 */

const MIN_QUERY_LEN = 2;
const DEFAULT_LIMIT = 20;

function text(value) {
  return String(value || "").trim();
}

function parseBooleanish(value) {
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(50, Math.max(1, Math.round(parsed)));
}

/**
 * Create an Express-compatible route handler for stop search.
 *
 * @param {object} deps
 * @param {(q: string, limit: number) => Promise<Array>} deps.searchFn
 *   Primary search function. Must return an array of stop objects.
 * @param {((q: string, limit: number) => Promise<{stops: Array, debug: object}>)|null} [deps.searchDebugFn]
 *   Debug-mode variant. When null, searchFn is used even in debug mode.
 * @param {((q: string, limit: number, reason: string) => Promise<Array>)|null} [deps.fallbackFn]
 *   Fallback search when primary fails or returns nothing.
 * @param {((res: object, reason: string) => void)|null} [deps.setFallbackHeadersFn]
 *   Sets response headers indicating a fallback was used.
 * @param {((promise: Promise) => Promise)|null} [deps.wrapWithTimeoutFn]
 *   Optional wrapper that adds a timeout to the search promise.
 *   Defaults to identity (no timeout). The outer server layer handles
 *   the overall request timeout independently.
 * @param {object} [deps.logger]
 *   Logger with log/warn/error methods.
 * @returns Express-compatible (req, res) => Promise<void>
 */
export function createStopSearchRouteHandler({
  searchFn,
  searchDebugFn = null,
  fallbackFn = null,
  setFallbackHeadersFn = null,
  wrapWithTimeoutFn = null,
  logger = { log() {}, warn() {}, error() {} },
} = {}) {
  const wrapTimeout = typeof wrapWithTimeoutFn === "function" ? wrapWithTimeoutFn : (p) => p;

  return async (req, res) => {
    const q = text(req.query?.q || req.query?.query);
    const limit = clampLimit(req.query?.limit);
    const debug = parseBooleanish(req.query?.debug);

    logger.log?.("[API] /api/stops/search params", { q, limit, debug });

    // Reject queries that are too short before touching the DB.
    if (q.length < MIN_QUERY_LEN) {
      return res.status(400).json({
        error: "query_too_short",
        message: `Search query must be at least ${MIN_QUERY_LEN} characters`,
        minLength: MIN_QUERY_LEN,
      });
    }

    const doSearch = debug && typeof searchDebugFn === "function"
      ? searchDebugFn(q, limit)
      : searchFn(q, limit);

    let searchResult;
    try {
      searchResult = await wrapTimeout(doSearch);
    } catch (err) {
      const reason = String(err?.code || err?.message || "error");
      logger.warn?.("[API] /api/stops/search degraded fallback", { q, limit, reason });
      const fallbackStops = typeof fallbackFn === "function"
        ? await fallbackFn(q, limit, reason)
        : [];
      setFallbackHeadersFn?.(res, reason);
      return res.json({ stops: fallbackStops });
    }

    let stops = Array.isArray(searchResult)
      ? searchResult
      : (searchResult?.stops || []);

    // Secondary fallback: if primary returned nothing, try the fast fallback.
    if (stops.length === 0 && q.length >= MIN_QUERY_LEN && typeof fallbackFn === "function") {
      try {
        const fallbackStops = await fallbackFn(q, limit, "empty_primary");
        if (fallbackStops.length > 0) {
          setFallbackHeadersFn?.(res, "empty_primary");
          stops = fallbackStops;
        }
      } catch {
        // Ignore fallback errors — best-effort only.
      }
    }

    if (debug && searchResult?.debug) {
      const rankedTop = Array.isArray(searchResult.debug.rankedTop)
        ? searchResult.debug.rankedTop
        : [];
      logger.log?.("[API] /api/stops/search debug top_candidates", {
        query: searchResult.debug.query || q,
        queryNorm: searchResult.debug.queryNorm || null,
        candidateLimit: searchResult.debug.candidateLimit || null,
        rawRows: searchResult.debug.rawRows || 0,
        top: rankedTop.slice(0, 10),
      });
    }

    return res.json({ stops });
  };
}
