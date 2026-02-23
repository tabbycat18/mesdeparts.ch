import { pool } from "../../db.js";

function normalizeSqlText(sql) {
  return typeof sql === "string" ? sql : String(sql?.text || "");
}

function normalizeValues(sql, params) {
  if (Array.isArray(params)) return params;
  if (Array.isArray(sql?.values)) return sql.values;
  return [];
}

function effectiveQueryTimeoutMs(overrideMs) {
  const baseMs = Math.max(
    200,
    Number(
      process.env.STATIONBOARD_DB_QUERY_TIMEOUT_MS ||
        process.env.PG_QUERY_TIMEOUT_MS ||
        "3500"
    )
  );
  if (!Number.isFinite(Number(overrideMs))) return baseMs;
  return Math.max(200, Number(overrideMs));
}

function effectiveStatementTimeoutMs(overrideMs, queryTimeoutMs) {
  if (Number.isFinite(Number(overrideMs))) {
    return Math.max(200, Number(overrideMs));
  }
  const baseMs = Math.max(
    200,
    Number(
      process.env.STATIONBOARD_DB_STATEMENT_TIMEOUT_MS ||
        process.env.PG_STATEMENT_TIMEOUT_MS ||
        String(queryTimeoutMs)
    )
  );
  return baseMs;
}

export async function query(sql, params = [], options = {}) {
  const text = normalizeSqlText(sql);
  const values = normalizeValues(sql, params);
  const queryTimeoutMs = effectiveQueryTimeoutMs(options?.queryTimeoutMs);
  const statementTimeoutMs = effectiveStatementTimeoutMs(
    options?.statementTimeoutMs,
    queryTimeoutMs
  );

  return pool.query({
    text,
    values,
    query_timeout: queryTimeoutMs,
    statement_timeout: statementTimeoutMs,
  });
}

export const db = { query };
