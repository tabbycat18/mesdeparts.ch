function text(value) {
  return String(value || "").trim();
}

function normalizeIdentity(value) {
  return text(value).toLowerCase();
}

function parseBooleanish(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

export function deriveResolvedIdentity(resolved) {
  const resolvedStopId =
    text(resolved?.resolvedStopId) || text(resolved?.canonical?.id) || text(resolved?.id) || null;
  const resolvedRootId =
    text(resolved?.resolvedRootId) || text(resolved?.rootId) || resolvedStopId || null;

  return {
    resolvedStopId,
    resolvedRootId,
  };
}

async function resolveIdentityForInput({ stop_id, stationId, stationName }, deps) {
  const stopId = text(stop_id);
  const sid = text(stationId);
  if (!stopId && !sid) return null;

  const { resolveStopLike, dbQueryLike } = deps || {};
  if (typeof resolveStopLike !== "function") return null;

  try {
    const resolved = await resolveStopLike(
      {
        stop_id: stopId || undefined,
        stationId: sid || undefined,
        stationName: text(stationName) || undefined,
      },
      {
        db: {
          query: typeof dbQueryLike === "function" ? dbQueryLike : async () => ({ rows: [] }),
        },
      }
    );
    return deriveResolvedIdentity(resolved);
  } catch (err) {
    if (err?.code === "unknown_stop" || Number(err?.status) === 400) {
      return null;
    }
    throw err;
  }
}

async function detectStopParamConflict({ stopId, stationId, stationName }, deps) {
  const lhs = await resolveIdentityForInput(
    { stop_id: stopId, stationName },
    deps
  );
  const rhs = await resolveIdentityForInput(
    { stationId, stationName },
    deps
  );

  if (!lhs?.resolvedRootId || !rhs?.resolvedRootId) {
    return {
      hasConflict: false,
      stopIdIdentity: lhs,
      stationIdIdentity: rhs,
    };
  }

  const hasConflict =
    normalizeIdentity(lhs.resolvedRootId) !== normalizeIdentity(rhs.resolvedRootId);

  return {
    hasConflict,
    stopIdIdentity: lhs,
    stationIdIdentity: rhs,
  };
}

export function createStationboardRouteHandler({
  getStationboardLike,
  resolveStopLike,
  dbQueryLike,
  logger = console,
} = {}) {
  if (typeof getStationboardLike !== "function") {
    throw new Error("createStationboardRouteHandler requires getStationboardLike");
  }

  return async function stationboardRouteHandler(req, res) {
    try {
      const stopIdRaw = text(req.query.stop_id);
      const stationIdCamelRaw = text(req.query.stationId);
      const stationIdSnakeRaw = text(req.query.station_id);
      const stationIdRaw = stationIdCamelRaw || stationIdSnakeRaw;
      const effectiveStopId = stopIdRaw || stationIdRaw;
      const stationName = text(req.query.stationName);
      const lang = text(req.query.lang);
      const limit = Number(req.query.limit || "300");
      const windowMinutes = Number(req.query.window_minutes || "0");
      const debug = parseBooleanish(req.query.debug) === true;
      const includeAlertsParsed = parseBooleanish(
        req.query.include_alerts ?? req.query.includeAlerts
      );

      logger?.log?.("[API] /api/stationboard params", {
        stopId: stopIdRaw,
        stationId: stationIdRaw,
        stationName,
        lang,
        limit,
        windowMinutes,
        debug,
        includeAlerts: includeAlertsParsed,
      });

      if (!effectiveStopId) {
        return res.status(400).json({
          error: "missing_stop_id",
          expected: ["stop_id", "stationId"],
        });
      }

      if (stopIdRaw && stationIdRaw) {
        const conflict = await detectStopParamConflict(
          {
            stopId: stopIdRaw,
            stationId: stationIdRaw,
            stationName,
          },
          { resolveStopLike, dbQueryLike }
        );

        if (conflict.hasConflict) {
          return res.status(400).json({
            error: "conflicting_stop_id",
            detail: "stop_id and stationId/station_id resolve to different canonical roots",
            precedence: "stop_id",
            received: {
              stop_id: stopIdRaw,
              stationId: stationIdRaw,
            },
            resolved: {
              stop_id: {
                stop: conflict.stopIdIdentity?.resolvedStopId || null,
                root: conflict.stopIdIdentity?.resolvedRootId || null,
              },
              stationId: {
                stop: conflict.stationIdIdentity?.resolvedStopId || null,
                root: conflict.stationIdIdentity?.resolvedRootId || null,
              },
            },
          });
        }
      }

      const result = await getStationboardLike({
        stopId: effectiveStopId,
        stationId: stationIdRaw,
        stationName,
        lang,
        acceptLanguage: req.headers["accept-language"],
        limit,
        windowMinutes,
        includeAlerts: includeAlertsParsed == null ? undefined : includeAlertsParsed,
        debug,
      });
      return res.json(result);
    } catch (err) {
      logger?.error?.("[API] /api/stationboard failed:", err);
      if (err?.code === "unknown_stop" || Number(err?.status) === 400) {
        return res.status(400).json({
          error: "unknown_stop",
          tried: Array.isArray(err?.tried) ? err.tried : [],
        });
      }
      if (process.env.NODE_ENV !== "production") {
        return res.status(500).json({
          error: "stationboard_failed",
          detail: String(err?.message || err),
        });
      }
      return res.status(500).json({ error: "stationboard_failed" });
    }
  };
}

