/**
 * Testable route handler factory for /api/_dbinfo.
 * Debug-only diagnostic endpoint.
 */

function text(value) {
  return String(value || "").trim();
}

function queryWantsDebug(req) {
  return text(req?.query?.debug) === "1";
}

export function createDbInfoRouteHandler({
  dbQueryLike,
  isDebugLike = queryWantsDebug,
} = {}) {
  if (typeof dbQueryLike !== "function") {
    throw new Error("createDbInfoRouteHandler requires dbQueryLike");
  }

  return async (req, res) => {
    if (!isDebugLike(req)) {
      return res.status(404).json({ error: "not_found" });
    }

    try {
      const result = await dbQueryLike(
        `
          SELECT
            now() AS now,
            current_database() AS current_database,
            inet_server_addr() AS inet_server_addr,
            inet_server_port() AS inet_server_port,
            current_setting('application_name') AS application_name
        `
      );
      const row = result?.rows?.[0] || {};
      return res.json({
        now: row.now || null,
        current_database: row.current_database || null,
        inet_server_addr: row.inet_server_addr || null,
        inet_server_port: Number.isFinite(Number(row.inet_server_port))
          ? Number(row.inet_server_port)
          : null,
        application_name: row.application_name || null,
      });
    } catch (err) {
      return res.status(500).json({
        error: "dbinfo_failed",
        detail: String(err?.message || err),
      });
    }
  };
}
