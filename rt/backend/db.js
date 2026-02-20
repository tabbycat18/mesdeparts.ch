// backend/db.js
import pg from "pg";

const { Pool } = pg;

// Neon requires a full connection string with sslmode=require.
// Example:
// export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require"

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[DB] ERROR: DATABASE_URL is missing. Set it before running the server.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
  ...(process.env.PG_CONNECTION_TIMEOUT_MS
    ? {
        connectionTimeoutMillis: Math.max(
          1000,
          Number(process.env.PG_CONNECTION_TIMEOUT_MS || "0")
        ),
      }
    : {}),
  ...(process.env.PG_QUERY_TIMEOUT_MS
    ? {
        query_timeout: Math.max(
          1000,
          Number(process.env.PG_QUERY_TIMEOUT_MS || "0")
        ),
      }
    : {}),
  ...(process.env.PG_STATEMENT_TIMEOUT_MS
    ? {
        statement_timeout: Math.max(
          1000,
          Number(process.env.PG_STATEMENT_TIMEOUT_MS || "0")
        ),
      }
    : {}),
});

if (process.env.DEBUG_DB_CONNECT === "1") {
  pool.on("connect", () => {
    console.log("[DB] Connected to Neon PostgreSQL");
  });
}
